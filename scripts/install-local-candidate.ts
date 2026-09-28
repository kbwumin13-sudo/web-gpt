import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWriteFile, getConfigDir, getConfigPath, loadConfig, saveConfig, type AppConfig } from "../src/config";
import { managedProfileIsVerified } from "../src/browser-login";
import { getGatewayServiceStatus, getServiceStatus, startGatewayService, startService, stopGatewayService, stopService, waitForBackendReady, waitForGatewayReady } from "../src/service";
import { VERSION } from "../src/version";

const require = createRequire(import.meta.url);
const { ensurePackagedRuntime, validateRuntimeBundle } = require("../launcher/electron/runtime-install.cjs") as {
  ensurePackagedRuntime(options: { app: { isPackaged: boolean; getVersion(): string }; coreHome: string; resourcesPath: string }): string;
  validateRuntimeBundle(root: string, identity: { version: string; platform: string; arch: string }): string;
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

function swapLink(link: string, target: string): void {
  const temporary = `${link}.candidate-${process.pid}`;
  if (existsSync(temporary)) throw new Error(`Unexpected temporary runtime link: ${temporary}`);
  symlinkSync(target, temporary);
  renameSync(temporary, link);
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
  const oldLink = readlinkSync(stableLink);
  const oldConfigBytes = readFileSync(getConfigPath());
  let originalBuild: { bundleId?: string } | undefined;
  let appSwapped = false;
  let linkSwapped = false;
  let configChanged = false;
  let backendStopped = false;
  let gatewayStopped = false;
  let mutationStarted = false;
  let next: AppConfig = current;
  try {
    run("ditto", ["-x", "-k", archive, staging]);
    const sourceApp = join(staging, "Codex Web GPT.app");
    const resourcesPath = join(sourceApp, "Contents", "Resources");
    validateRuntimeBundle(join(resourcesPath, "runtime"), identity);
    run("codesign", ["--verify", "--deep", "--strict", sourceApp]);
    const manifest = JSON.parse(readFileSync(join(resourcesPath, "runtime", "manifest.json"), "utf8")) as { bundleId: string };
    if (checkOnly) {
      process.stdout.write(`LOCAL_CANDIDATE_PREFLIGHT_OK ${VERSION} ${manifest.bundleId}\n`);
      return;
    }
    if (existsSync(stagedAppPath) || existsSync(oldAppPath)) throw new Error("App staging or rollback location already exists");
    const appRunning = Bun.spawnSync(["pgrep", "-x", "Codex Web GPT"], { stdout: "pipe", stderr: "pipe" });
    if (appRunning.exitCode === 0) throw new Error("Quit the Settings app before updating it");
    // The backend normally exits when idle; wake it to obtain its build identity and drain it.
    startService();
    await waitForBackendReady(current);
    let gateway = await health(current.nativeGatewayPort);
    let backend = await health(current.port);
    originalBuild = backend.build as { bundleId?: string } | undefined;
    const idleDeadline = Date.now() + 30_000;
    while ((gateway.active_requests !== 0 || backend.active_http_turns !== 0 || backend.active_browser_turns !== 0)
      && Date.now() < idleDeadline) {
      await Bun.sleep(250);
      gateway = await health(current.nativeGatewayPort);
      backend = await health(current.port);
    }
    if (gateway.active_requests !== 0 || backend.active_http_turns !== 0 || backend.active_browser_turns !== 0) {
      throw new Error("Active requests or browser turns must finish before the local upgrade");
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
    const oldStablePath = join(core, "versions", `${current.releaseVersion}-darwin-${process.arch}`);
    if (!existsSync(oldStablePath)) throw new Error("Previous versioned runtime is unavailable for rollback");
    mutationStarted = true;
    await stopGatewayService(current);
    gatewayStopped = true;
    await stopService(current);
    backendStopped = true;
    renameSync(appPath, oldAppPath);
    try { renameSync(stagedAppPath, appPath); } catch (error) { renameSync(oldAppPath, appPath); throw error; }
    appSwapped = true;
    saveConfig(next);
    configChanged = true;
    const installed = join(core, "versions", `${VERSION}-darwin-${process.arch}`, "bin", "codex-chatgpt-web");
    swapLink(stableLink, relative(dirname(stableLink), installed));
    linkSwapped = true;
    startService();
    backendStopped = false;
    await waitForBackendReady(next);
    startGatewayService();
    gatewayStopped = false;
    await waitForGatewayReady(next);
    const liveBackend = await health(next.port);
    const liveGateway = await health(next.nativeGatewayPort);
    if ((liveBackend.build as { bundleId?: string } | undefined)?.bundleId !== manifest.bundleId
      || (liveGateway.build as { bundleId?: string } | undefined)?.bundleId !== manifest.bundleId
      || (liveGateway.backend_build as { bundleId?: string } | undefined)?.bundleId !== manifest.bundleId
      || liveGateway.backend_ready !== true) throw new Error("Installed gateway/backend bundle identity mismatch");
    process.stdout.write(`LOCAL_CANDIDATE_INSTALLED ${VERSION} ${manifest.bundleId}\n`);
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (mutationStarted) {
      try { if (getGatewayServiceStatus().loaded) await stopGatewayService(next); } catch (cause) { rollbackErrors.push(`stop gateway: ${String(cause)}`); }
      try { if (getServiceStatus().loaded) await stopService(next); } catch (cause) { rollbackErrors.push(`stop backend: ${String(cause)}`); }
      try { if (linkSwapped) swapLink(stableLink, oldLink); } catch (cause) { rollbackErrors.push(`restore runtime link: ${String(cause)}`); }
      try { if (configChanged) atomicWriteFile(getConfigPath(), oldConfigBytes.toString("utf8")); } catch (cause) { rollbackErrors.push(`restore config: ${String(cause)}`); }
      try {
        if (appSwapped) {
          renameSync(appPath, stagedAppPath);
          renameSync(oldAppPath, appPath);
        }
      } catch (cause) { rollbackErrors.push(`restore app: ${String(cause)}`); }
      try {
        if (backendStopped || !getServiceStatus().loaded) startService();
        await waitForBackendReady(current);
        if (gatewayStopped || !getGatewayServiceStatus().loaded) startGatewayService();
        await waitForGatewayReady(current);
        const restored = await health(current.port);
        if ((restored.build as { bundleId?: string } | undefined)?.bundleId !== originalBuild?.bundleId) {
          throw new Error("Previous backend bundle ID was not restored");
        }
      } catch (cause) { rollbackErrors.push(`restart previous runtime: ${String(cause)}`); }
    }
    throw new Error(`Local candidate installation failed: ${String(error)}${rollbackErrors.length ? `; rollback: ${rollbackErrors.join("; ")}` : ""}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(stagedAppPath)) rmSync(stagedAppPath, { recursive: true, force: true });
  }
}

await main();
