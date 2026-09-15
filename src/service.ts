import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { assertDurableRuntimeCommand, atomicWriteFile, getConfigDir } from "./config";
import { macOsLaunchdProxyEnvironment, runCommand, runChecked } from "./process";

const LABEL = "io.github.codex-chatgpt-web.daemon";
const GATEWAY_LABEL = "io.github.codex-chatgpt-web.gateway";

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  definitionPath?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function gatewayPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${GATEWAY_LABEL}.plist`);
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${launchDomain()}/${LABEL}`;
}

function gatewayServiceTarget(): string {
  return `${launchDomain()}/${GATEWAY_LABEL}`;
}

async function bootstrapService(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown launchctl bootstrap failure";
  while (Date.now() < deadline) {
    const result = runCommand("launchctl", ["bootstrap", launchDomain(), path]);
    if (result.status === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`launchctl bootstrap ${launchDomain()} ${path} failed after ${timeoutMs}ms: ${lastError}`);
}

async function waitForServiceUnloaded(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getServiceStatus().loaded && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (getServiceStatus().loaded) throw new Error(`launchd did not unload ${LABEL} after ${timeoutMs}ms`);
}

export async function waitForPortReleased(
  host: string,
  port: number,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "port is still in use";
  while (Date.now() < deadline) {
    const available = await new Promise<boolean>((resolveAvailable, rejectAvailable) => {
      const probe = createServer();
      probe.once("error", error => {
        probe.close();
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          resolveAvailable(false);
        } else {
          rejectAvailable(error);
        }
      });
      probe.listen(port, host, () => {
        probe.close(error => error ? rejectAvailable(error) : resolveAvailable(true));
      });
    });
    if (available) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Port ${host}:${port} was not released after ${timeoutMs}ms: ${lastError}`);
}

export function backendServiceDefinition(config: AppConfig): string {
  const logDir = join(getConfigDir(), "logs");
  const args = [...config.runtimeCommand, "backend"];
  const environment = macOsLaunchdProxyEnvironment();
  const proxyEnvironment = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
    .flatMap(key => typeof environment[key] === "string" && environment[key]!.trim()
      ? [`    <key>${key}</key>`, `    <string>${xml(environment[key]!)}</string>`]
      : [])
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_CHATGPT_WEB_HOME</key>
    <string>${xml(getConfigDir())}</string>
${proxyEnvironment}
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "daemon.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function backendServiceDefinitionMatches(config: AppConfig): boolean {
  const path = plistPath();
  return existsSync(path) && readFileSync(path, "utf8") === backendServiceDefinition(config);
}

export function gatewayServiceDefinition(config: AppConfig): string {
  const logDir = join(getConfigDir(), "logs");
  const args = [...config.runtimeCommand, "gateway"];
  const environment = macOsLaunchdProxyEnvironment();
  const proxyEnvironment = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
    .flatMap(key => typeof environment[key] === "string" && environment[key]!.trim()
      ? [`    <key>${key}</key>`, `    <string>${xml(environment[key]!)}</string>`]
      : [])
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${GATEWAY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_CHATGPT_WEB_HOME</key>
    <string>${xml(getConfigDir())}</string>
${proxyEnvironment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "gateway.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "gateway.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function gatewayServiceDefinitionMatches(config: AppConfig): boolean {
  const path = gatewayPlistPath();
  return existsSync(path) && readFileSync(path, "utf8") === gatewayServiceDefinition(config);
}

function plist(config: AppConfig): string {
  return backendServiceDefinition(config);
}

function assertMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "Terminal-managed background services require macOS. "
      + "Use the Codex Web GPT launcher on Windows or Linux.",
    );
  }
}

export function getServiceStatus(): ServiceStatus {
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false, running: false, label: LABEL };
  const path = plistPath();
  const result = runCommand("launchctl", ["print", serviceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
    label: LABEL,
    definitionPath: path,
  };
}

export function getGatewayServiceStatus(): ServiceStatus {
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false, running: false, label: GATEWAY_LABEL };
  const path = gatewayPlistPath();
  const result = runCommand("launchctl", ["print", gatewayServiceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
    label: GATEWAY_LABEL,
    definitionPath: path,
  };
}

export async function waitForBackendReady(
  config: Pick<AppConfig, "host" | "port">,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "backend health endpoint is unavailable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(1_000, Math.max(1, timeoutMs)));
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (body.status === "ok" && body.service === "codex-chatgpt-web" && body.accepting_turns === true) return;
        lastError = "backend health endpoint returned an invalid readiness payload";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Backend did not become ready after ${timeoutMs}ms: ${lastError}`);
}

export async function waitForGatewayReady(
  config: Pick<AppConfig, "host" | "nativeGatewayPort">,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "gateway health endpoint is unavailable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(1_000, Math.max(1, timeoutMs)));
    try {
      const response = await fetch(`http://${config.host}:${config.nativeGatewayPort}/healthz`, { signal: controller.signal });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (body.status === "ok" && body.service === "codex-chatgpt-web-gateway") return;
        lastError = "gateway health endpoint returned an invalid readiness payload";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Native Codex gateway did not become ready after ${timeoutMs}ms: ${lastError}`);
}

export function installService(config: AppConfig): ServiceStatus {
  assertMacOs();
  assertDurableRuntimeCommand(config.runtimeCommand);
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  const next = plist(config);
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  return startService();
}

export function installGatewayService(config: AppConfig): ServiceStatus {
  assertMacOs();
  assertDurableRuntimeCommand(config.runtimeCommand);
  const path = gatewayPlistPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  const next = gatewayServiceDefinition(config);
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  const status = getGatewayServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  return startGatewayService();
}

export function startService(): ServiceStatus {
  assertMacOs();
  const path = plistPath();
  if (!existsSync(path)) throw new Error(`Service is not installed: ${path}`);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  const loaded = getServiceStatus();
  if (!loaded.running) runChecked("launchctl", ["kickstart", "-k", serviceTarget()]);
  return getServiceStatus();
}

export function startGatewayService(): ServiceStatus {
  assertMacOs();
  const path = gatewayPlistPath();
  if (!existsSync(path)) throw new Error(`Gateway service is not installed: ${path}`);
  const status = getGatewayServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  const loaded = getGatewayServiceStatus();
  if (!loaded.running) runChecked("launchctl", ["kickstart", "-k", gatewayServiceTarget()]);
  return getGatewayServiceStatus();
}

export interface DrainLease {
  release: () => Promise<void>;
}

async function control(config: AppConfig, action: "drain" | "resume" | "cancel-turns"): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function interruptActiveTurn(
  config: AppConfig,
  identity: { threadId: string; turnId: string },
): Promise<{ cancelledHttpTurns: number; cancelledBrowserTurns: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(identity),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as Record<string, unknown>;
    const cancelledHttpTurns = result.cancelled_http_turns;
    const cancelledBrowserTurns = result.cancelled_browser_turns;
    if (result.status !== "ok"
      || !Number.isInteger(cancelledHttpTurns) || (cancelledHttpTurns as number) < 0
      || !Number.isInteger(cancelledBrowserTurns) || (cancelledBrowserTurns as number) < 0) {
      throw new Error("daemon returned an invalid interrupt acknowledgement");
    }
    return {
      cancelledHttpTurns: cancelledHttpTurns as number,
      cancelledBrowserTurns: cancelledBrowserTurns as number,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function cancelActiveTurns(config: AppConfig): Promise<{
  cancelledHttpTurns: number;
  cancelledBrowserTurns: number;
}> {
  const result = await control(config, "cancel-turns");
  const cancelledHttpTurns = result.cancelled_http_turns;
  const cancelledBrowserTurns = result.cancelled_browser_turns;
  if (!Number.isInteger(cancelledHttpTurns) || (cancelledHttpTurns as number) < 0
    || !Number.isInteger(cancelledBrowserTurns) || (cancelledBrowserTurns as number) < 0
    || result.active_http_turns !== 0 || result.active_browser_turns !== 0) {
    throw new Error("daemon did not acknowledge complete active-turn cancellation");
  }
  return {
    cancelledHttpTurns: cancelledHttpTurns as number,
    cancelledBrowserTurns: cancelledBrowserTurns as number,
  };
}

export async function negotiateDrain(
  controlAction: (action: "drain" | "resume") => Promise<Record<string, unknown>>,
): Promise<DrainLease> {
  let drained = false;
  let drainAttempted = false;
  try {
    drainAttempted = true;
    const health = await controlAction("drain");
    drained = true;
    const activeHttp = health.active_http_turns;
    const activeBrowser = health.active_browser_turns;
    if (!Number.isInteger(activeHttp) || !Number.isInteger(activeBrowser) || health.accepting_turns !== false) {
      throw new Error("daemon did not acknowledge the drain contract");
    }
    if ((activeHttp as number) > 0 || (activeBrowser as number) > 0) {
      throw new Error(`daemon has ${activeHttp} active HTTP turn(s) and ${activeBrowser} active browser turn(s)`);
    }
    return { release: async () => { if (drained) { await controlAction("resume"); drained = false; } } };
  } catch (error) {
    let resumeError: unknown;
    if (drainAttempted) {
      try {
        await controlAction("resume");
        drained = false;
      } catch (caught) {
        resumeError = caught;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const compensation = resumeError
      ? `; compensating resume also failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`
      : "";
    throw new Error(`Refusing to stop or restart because atomic idleness could not be proven: ${message}${compensation}`);
  }
}

async function acquireDrain(config: AppConfig): Promise<DrainLease> {
  const status = getServiceStatus();
  if (!status.loaded || !status.running) return { release: async () => {} };
  return negotiateDrain(action => control(config, action));
}

async function releaseDrainAfterFailure(lease: DrainLease, failure: unknown): Promise<never> {
  try {
    await lease.release();
  } catch (resumeError) {
    const primary = failure instanceof Error ? failure.message : String(failure);
    const compensation = resumeError instanceof Error ? resumeError.message : String(resumeError);
    throw new Error(`${primary}; compensating daemon resume also failed: ${compensation}`);
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}

export async function assertServiceIdle(config: AppConfig): Promise<void> {
  const lease = await acquireDrain(config);
  await lease.release();
}

export async function restartService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs();
  if (!getServiceStatus().loaded) return startService();
  const lease = await acquireDrain(config);
  try {
    runChecked("launchctl", ["bootout", serviceTarget()]);
    await waitForServiceUnloaded();
    await waitForPortReleased(config.host, config.port);
    await bootstrapService(plistPath());
  } catch (error) {
    return releaseDrainAfterFailure(lease, error);
  }
  return startService();
}

export function removeLegacyRuntimeArtifacts(config: AppConfig): void {
  const legacyWrapper = join(getConfigDir(), "bin", "serve-with-playwright.sh");
  const legacyVendor = join(getConfigDir(), "vendor");
  if (config.runtimeCommand.some(part => part === legacyWrapper || part.startsWith(`${legacyVendor}/`))) {
    throw new Error("Refusing to remove legacy runtime artifacts while the active service still references them");
  }
  rmSync(legacyWrapper, { force: true });
  rmSync(legacyVendor, { recursive: true, force: true });
}

export async function stopService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs();
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      runChecked("launchctl", ["bootout", serviceTarget()]);
      await waitForServiceUnloaded();
      await waitForPortReleased(config.host, config.port);
    } catch (error) {
      return releaseDrainAfterFailure(lease, error);
    }
  }
  return getServiceStatus();
}

export async function uninstallService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs();
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      runChecked("launchctl", ["bootout", serviceTarget()]);
      await waitForServiceUnloaded();
    } catch (error) {
      return releaseDrainAfterFailure(lease, error);
    }
  }
  rmSync(plistPath(), { force: true });
  return getServiceStatus();
}

async function gatewayControl(
  config: Pick<AppConfig, "host" | "nativeGatewayPort" | "controlToken">,
  action: "drain" | "resume",
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://${config.host}:${config.nativeGatewayPort}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function stopGatewayService(
  config: Pick<AppConfig, "host" | "nativeGatewayPort" | "controlToken">,
): Promise<ServiceStatus> {
  assertMacOs();
  let drained = false;
  let bootedOut = false;
  if (getGatewayServiceStatus().loaded) {
    try {
      const drain = await gatewayControl(config, "drain");
      if (drain.status !== "ok" || drain.accepting_requests !== false) throw new Error("Gateway did not acknowledge drain");
      drained = true;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const health = await fetch(`http://${config.host}:${config.nativeGatewayPort}/healthz`);
        const body = await health.json() as Record<string, unknown>;
        if (body.active_requests === 0) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      const finalHealth = await fetch(`http://${config.host}:${config.nativeGatewayPort}/healthz`);
      const finalBody = await finalHealth.json() as Record<string, unknown>;
      if (finalBody.active_requests !== 0) throw new Error("Gateway active requests did not drain");
      runChecked("launchctl", ["bootout", gatewayServiceTarget()]);
      bootedOut = true;
      const unloadDeadline = Date.now() + 20_000;
      while (getGatewayServiceStatus().loaded && Date.now() < unloadDeadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      if (getGatewayServiceStatus().loaded) throw new Error(`launchd did not unload ${GATEWAY_LABEL}`);
      await waitForPortReleased("127.0.0.1", config.nativeGatewayPort);
    } catch (error) {
      if (drained && !bootedOut) {
        try { await gatewayControl(config, "resume"); } catch {}
      }
      throw error;
    }
  }
  return getGatewayServiceStatus();
}

export async function uninstallGatewayService(
  config: Pick<AppConfig, "host" | "nativeGatewayPort" | "controlToken">,
): Promise<ServiceStatus> {
  await stopGatewayService(config);
  rmSync(gatewayPlistPath(), { force: true });
  return getGatewayServiceStatus();
}
