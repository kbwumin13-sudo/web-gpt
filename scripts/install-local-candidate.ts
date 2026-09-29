import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWriteFile, getConfigDir, getConfigPath, loadConfig, saveConfig, type AppConfig } from "../src/config";
import { managedProfileIsVerified } from "../src/browser-login";
import { TurnResultJournal } from "../src/adapters/chatgpt-web/turn-result-journal";
import { backendStartupGatePath, getGatewayServiceStatus, getServiceStatus, negotiateDrain, releaseBackendStartupGate, startService, stopService, waitForBackendReady, writeBackendStartupGate, type DrainLease } from "../src/service";
import { VERSION } from "../src/version";

const require = createRequire(import.meta.url);
const { ensurePackagedRuntime, validateRuntimeBundle } = require("../launcher/electron/runtime-install.cjs") as {
  ensurePackagedRuntime(options: { app: { isPackaged: boolean; getVersion(): string }; coreHome: string; resourcesPath: string }): string;
  validateRuntimeBundle(root: string, identity: { version: string; platform: string; arch: string; bundleId?: string }): string;
};

function run(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr.toString().trim().slice(0, 400)}`);
  }
}

async function health(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Health on port ${port} returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function backendControl(config: AppConfig, action: "drain" | "resume"): Promise<Record<string, unknown>> {
  const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Backend ${action} returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

type Health = Record<string, unknown>;

function bundle(body: Health, field: "build" | "backend_build" = "build"): string | undefined {
  return (body[field] as { bundleId?: string } | undefined)?.bundleId;
}

export function candidateClosed(body: Health, expectedBundle: string): boolean {
  const gate = body.deployment_gate as { status?: unknown; bundleId?: unknown } | undefined;
  return body.service === "codex-chatgpt-web" && bundle(body) === expectedBundle
    && body.accepting_turns === false && gate?.status === "closed" && gate.bundleId === expectedBundle;
}

export function gatewayCandidateIdentity(gateway: Health, backend: Health, gatewayPid: number, gatewayBundle: string, candidateBundle: string): boolean {
  return gateway.service === "codex-chatgpt-web-gateway" && gateway.pid === gatewayPid
    && bundle(gateway) === gatewayBundle && bundle(gateway, "backend_build") === candidateBundle
    && bundle(backend) === candidateBundle;
}

/** The shared gateway keeps serving native Codex requests while only Web backend turns drain. */
export function backendCutoverIdle(gateway: Health, backend: Health): boolean {
  return gateway.service === "codex-chatgpt-web-gateway"
    && backend.service === "codex-chatgpt-web"
    && backend.active_http_turns === 0 && backend.active_browser_turns === 0;
}

/** The old runtime cannot interpret a candidate send intent, so unknown must deny downgrade. */
export function candidateRollbackSafe(statePath: string): boolean {
  if (!existsSync(statePath)) return false;
  try { return new TurnResultJournal(30 * 60_000, 256, { statePath }).unresolvedSendCount() === 0; }
  catch { return false; }
}

async function waitForCandidateClosed(port: number, bundleId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "candidate unavailable";
  while (Date.now() < deadline) {
    try {
      const body = await health(port);
      if (candidateClosed(body, bundleId)) return;
      lastError = `candidate did not acknowledge closed startup gate: ${JSON.stringify({ build: body.build, deployment_gate: body.deployment_gate })}`;
    } catch (error) { lastError = String(error); }
    await Bun.sleep(100);
  }
  throw new Error(lastError);
}

function swapLink(link: string, target: string): void {
  const temporary = `${link}.candidate-${process.pid}`;
  if (existsSync(temporary)) throw new Error(`Unexpected temporary runtime link: ${temporary}`);
  symlinkSync(target, temporary);
  try { renameSync(temporary, link); } catch (error) { rmSync(temporary); throw error; }
}

export function armCandidateRuntime(
  stableLink: string, target: string, bundleId: string, core: string,
  onGateWritten: () => void,
  replaceLink: (link: string, target: string) => void = swapLink,
): void {
  writeBackendStartupGate(bundleId, core);
  onGateWritten();
  replaceLink(stableLink, target);
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Local candidate installation supports macOS only");
  const archive = resolve(process.argv[2] ?? "");
  if (!archive.endsWith(`codex-web-gpt-${VERSION}-mac-${process.arch}.zip`) || !existsSync(archive)) {
    throw new Error(`Pass the signed local ${VERSION} macOS ZIP`);
  }
  const checkOnly = process.argv.includes("--check");
  const core = getConfigDir();
  const current = loadConfig();
  if (current.browserHost !== "managed-chrome") throw new Error("This transaction requires managed Chrome mode");
  const profile = join(dirname(current.storageStatePath), "managed-profile");
  if (!managedProfileIsVerified(profile)) throw new Error("The dedicated Chrome profile has not passed login verification");
  const identity = { version: VERSION, platform: "darwin", arch: process.arch };
  const staging = join(resolve("output"), `local-install-${VERSION}-${process.pid}`);
  if (existsSync(staging)) throw new Error(`Unexpected staging path: ${staging}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const appPath = "/Applications/Codex Web GPT.app";
  const stagedAppPath = `/Applications/Codex Web GPT.${VERSION}.stage.app`;
  const oldAppPath = join(core, "app-archive", `Codex Web GPT-before-${VERSION}.app`);
  const stableLink = join(core, "bin", "codex-chatgpt-web");
  let oldLink: string | undefined;
  let oldConfigBytes: Buffer | undefined;
  let originalBackendBundle: string | undefined;
  let originalGatewayBundle: string | undefined;
  let gatewayPid: number | undefined;
  let appSwapped = false;
  let linkSwapped = false;
  let configChanged = false;
  let gateWritten = false;
  let candidateWasReleased = false;
  let candidateMayHaveStarted = false;
  let candidateBundleId: string | undefined;
  let next: AppConfig = current;
  let oldDrain: DrainLease | undefined;
  try {
    run("ditto", ["-x", "-k", archive, staging]);
    const sourceApp = join(staging, "Codex Web GPT.app");
    const resourcesPath = join(sourceApp, "Contents", "Resources");
    validateRuntimeBundle(join(resourcesPath, "runtime"), identity);
    run("codesign", ["--verify", "--deep", "--strict", sourceApp]);
    const manifest = JSON.parse(readFileSync(join(resourcesPath, "runtime", "manifest.json"), "utf8")) as { bundleId: string; deploymentGate?: string };
    candidateBundleId = manifest.bundleId;
    // The signed package must declare startup gate support before the stable link can point at it.
    if (manifest.deploymentGate !== "backend-file-v1") throw new Error("Signed candidate does not declare backend-file-v1 startup gate support");
    if (existsSync(stagedAppPath) || existsSync(oldAppPath)) throw new Error("App staging or rollback location already exists");
    if (existsSync(backendStartupGatePath(core))) throw new Error("An existing backend startup gate requires recovery before installation");
    if (!existsSync(appPath)) throw new Error("Previous app is unavailable for rollback");
    oldLink = readlinkSync(stableLink);
    oldConfigBytes = readFileSync(getConfigPath());
    const oldRuntime = join(core, "versions", `${current.releaseVersion}-darwin-${process.arch}`);
    const oldManifest = JSON.parse(readFileSync(join(oldRuntime, "manifest.json"), "utf8")) as { bundleId: string };
    validateRuntimeBundle(oldRuntime, { version: current.releaseVersion, platform: "darwin", arch: process.arch, bundleId: oldManifest.bundleId });
    if (realpathSync(stableLink) !== realpathSync(join(oldRuntime, "bin", "codex-chatgpt-web"))) {
      throw new Error("Stable CLI link does not point to the rollback runtime");
    }
    run("codesign", ["--verify", "--deep", "--strict", appPath]);
    validateRuntimeBundle(join(appPath, "Contents", "Resources", "runtime"), {
      version: current.releaseVersion, platform: "darwin", arch: process.arch, bundleId: oldManifest.bundleId,
    });
    if (checkOnly) {
      process.stdout.write(`LOCAL_CANDIDATE_PREFLIGHT_OK ${VERSION} ${manifest.bundleId}\n`);
      return;
    }
    const appRunning = Bun.spawnSync(["pgrep", "-x", "Codex Web GPT"], { stdout: "pipe", stderr: "pipe" });
    if (appRunning.exitCode === 0) throw new Error("Quit the Settings app before updating it");
    if (!getGatewayServiceStatus().running) throw new Error("Native gateway must remain running during installation");
    let gateway = await health(current.nativeGatewayPort);
    gatewayPid = gateway.pid as number;
    originalGatewayBundle = bundle(gateway);
    if (!Number.isSafeInteger(gatewayPid) || !originalGatewayBundle || originalGatewayBundle !== oldManifest.bundleId) {
      throw new Error("Cannot prove original gateway package/process identity");
    }
    // Wake the old backend while the stable link still points at its package.
    startService();
    await waitForBackendReady(current);
    let backend = await health(current.port);
    originalBackendBundle = bundle(backend);
    if (originalBackendBundle !== oldManifest.bundleId) throw new Error("Previous backend does not match rollback package");
    const idleDeadline = Date.now() + 30_000;
    while (!backendCutoverIdle(gateway, backend)
      && Date.now() < idleDeadline) {
      await Bun.sleep(250);
      gateway = await health(current.nativeGatewayPort);
      backend = await health(current.port);
    }
    if (!backendCutoverIdle(gateway, backend)) {
      throw new Error("Active Web backend turns must finish before the local upgrade");
    }
    ensurePackagedRuntime({ app: { isPackaged: true, getVersion: () => VERSION }, coreHome: core, resourcesPath });
    run("ditto", [sourceApp, stagedAppPath]);
    run("codesign", ["--verify", "--deep", "--strict", stagedAppPath]);
    const marker = JSON.parse(readFileSync(join(profile, ".codex-verified.json"), "utf8")) as {
      solAvailable?: boolean; extraHighAvailable?: boolean; proAvailable?: boolean;
    };
    next = {
      ...current,
      releaseVersion: VERSION,
      managedProfilePath: profile,
      solAvailable: marker.solAvailable === true,
      extraHighAvailable: marker.extraHighAvailable === true,
      proAvailable: marker.proAvailable === true,
    };
    const recovery = join(core, "recovery", `before-local-${VERSION}`);
    mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const backup = join(recovery, "config.json");
    writeFileSync(backup, oldConfigBytes, { mode: 0o600 });
    mkdirSync(dirname(oldAppPath), { recursive: true, mode: 0o700 });
    // Refuse new Web turns in the old daemon before changing config or the stable launcher link.
    // The gateway still routes native Codex requests without consulting this backend drain.
    oldDrain = await negotiateDrain(action => backendControl(current, action));
    const installed = join(core, "versions", `${VERSION}-darwin-${process.arch}`, "bin", "codex-chatgpt-web");
    armCandidateRuntime(stableLink, relative(dirname(stableLink), installed), manifest.bundleId, core, () => { gateWritten = true; });
    linkSwapped = true;
    saveConfig(next);
    configChanged = true;
    // Gateway prestart now resolves to the candidate, whose signed startup gate is already closed.
    candidateMayHaveStarted = true;
    await stopService(current);
    oldDrain = undefined;
    renameSync(appPath, oldAppPath);
    try { renameSync(stagedAppPath, appPath); } catch (error) { renameSync(oldAppPath, appPath); throw error; }
    appSwapped = true;
    startService();
    await waitForCandidateClosed(next.port, manifest.bundleId);
    const closedBackend = await health(next.port);
    const closedGateway = await health(next.nativeGatewayPort);
    if (!gatewayCandidateIdentity(closedGateway, closedBackend, gatewayPid, originalGatewayBundle, manifest.bundleId)
      || closedGateway.backend_ready !== false) throw new Error("Candidate or preserved gateway identity mismatch while gated");
    releaseBackendStartupGate(manifest.bundleId, core);
    gateWritten = false;
    candidateWasReleased = true;
    await waitForBackendReady(next);
    const liveBackend = await health(next.port);
    const liveGateway = await health(next.nativeGatewayPort);
    if (!gatewayCandidateIdentity(liveGateway, liveBackend, gatewayPid, originalGatewayBundle, manifest.bundleId)
      || liveGateway.backend_ready !== true) throw new Error("Installed gateway/backend bundle identity mismatch");
    process.stdout.write(`LOCAL_CANDIDATE_INSTALLED ${VERSION} ${manifest.bundleId}\n`);
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (candidateWasReleased && candidateBundleId) {
      try {
        // Freeze new Web sends before reading the journal. The gateway may prestart the candidate
        // at any point until the stable link is restored.
        writeBackendStartupGate(candidateBundleId, core);
        gateWritten = true;
        startService();
        await waitForCandidateClosed(current.port, candidateBundleId);
      } catch (cause) { rollbackErrors.push(`close candidate before rollback: ${String(cause)}`); }
    }
    if (gateWritten || linkSwapped || configChanged || appSwapped) {
      let downgradeSafe = rollbackErrors.length === 0;
      if (downgradeSafe && candidateMayHaveStarted && !candidateWasReleased) {
        // A candidate that honors its signed startup gate cannot create send intents yet.
        try {
          const running = await health(current.port);
          downgradeSafe = bundle(running) === originalBackendBundle || candidateClosed(running, candidateBundleId ?? "");
        } catch { downgradeSafe = true; }
      } else if (downgradeSafe && candidateMayHaveStarted) {
        try {
          const running = await health(current.port);
          downgradeSafe = bundle(running) === originalBackendBundle || candidateRollbackSafe(join(core, "runtime", "turn-results.json"));
        } catch { downgradeSafe = false; }
      }
      if (!downgradeSafe) {
        rollbackErrors.push("candidate send intents are unresolved or unavailable; downgrade denied");
      } else {
        try { if (linkSwapped && getServiceStatus().loaded) await stopService(next); } catch (cause) { rollbackErrors.push(`stop backend: ${String(cause)}`); }
        if (rollbackErrors.length === 0 && candidateWasReleased
          && !candidateRollbackSafe(join(core, "runtime", "turn-results.json"))) {
          rollbackErrors.push("candidate send intents changed or journal became invalid after drain; downgrade denied");
        }
        if (rollbackErrors.length === 0) {
          try { if (linkSwapped && oldLink) swapLink(stableLink, oldLink); } catch (cause) { rollbackErrors.push(`restore runtime link: ${String(cause)}`); }
          try { if (configChanged && oldConfigBytes) atomicWriteFile(getConfigPath(), oldConfigBytes.toString("utf8")); } catch (cause) { rollbackErrors.push(`restore config: ${String(cause)}`); }
          try {
            if (appSwapped) { renameSync(appPath, stagedAppPath); renameSync(oldAppPath, appPath); }
          } catch (cause) { rollbackErrors.push(`restore app: ${String(cause)}`); }
        }
        if (rollbackErrors.length === 0) {
          try {
            if (gateWritten) {
              releaseBackendStartupGate((JSON.parse(readFileSync(backendStartupGatePath(core), "utf8")) as { bundleId: string }).bundleId, core);
              gateWritten = false;
            }
            startService();
            await waitForBackendReady(current);
            const restored = await health(current.port);
            const gateway = await health(current.nativeGatewayPort);
            if (bundle(restored) !== originalBackendBundle || gateway.pid !== gatewayPid || bundle(gateway) !== originalGatewayBundle) {
              throw new Error("Previous backend/gateway identity was not restored");
            }
          } catch (cause) { rollbackErrors.push(`restart previous runtime: ${String(cause)}`); }
        }
      }
    }
    if (oldDrain) {
      try { await oldDrain.release(); } catch (cause) { rollbackErrors.push(`resume old backend: ${String(cause)}`); }
    }
    throw new Error(`Local candidate installation failed: ${String(error)}${rollbackErrors.length ? `; rollback: ${rollbackErrors.join("; ")}` : ""}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!gateWritten && existsSync(stagedAppPath)) rmSync(stagedAppPath, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
