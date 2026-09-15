import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * GUI apps and launchd do not reliably inherit the proxy selected in macOS System Settings.
 * Tunnel-client uses Go's standard proxy environment, so derive only the active HTTPS proxy when
 * the caller has not already supplied any proxy variables. The returned values contain no
 * credentials and loopback health checks always bypass the proxy.
 */
export function macOsSystemProxyEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  proxyOutput?: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  const hasExplicitProxy = [
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
  ].some(name => typeof environment[name] === "string" && environment[name]!.trim());
  if (hasExplicitProxy || (platform !== "darwin" && proxyOutput === undefined)) return environment;

  let output = proxyOutput;
  if (output === undefined) {
    const discovered = spawnSync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    if (discovered.status !== 0 || typeof discovered.stdout !== "string") return environment;
    output = discovered.stdout;
  }
  const field = (name: string): string | undefined => (
    output!.match(new RegExp(`^\\s*${name}\\s*:\\s*([^\\r\\n]+?)\\s*$`, "m"))?.[1]?.trim()
  );
  if (field("HTTPSEnable") !== "1") return environment;
  const host = field("HTTPSProxy");
  const port = Number(field("HTTPSPort"));
  if (!host || /[\s/@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return environment;
  }
  const proxyHost = host.includes(":") ? `[${host}]` : host;
  const proxyUrl = `http://${proxyHost}:${port}`;
  environment.HTTPS_PROXY = proxyUrl;
  environment.HTTP_PROXY = proxyUrl;
  const noProxy = new Set(String(environment.NO_PROXY || environment.no_proxy || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean));
  for (const value of ["127.0.0.1", "localhost", "::1"]) noProxy.add(value);
  environment.NO_PROXY = [...noProxy].join(",");
  return environment;
}

function proxyPort(value: string | undefined): { host: string; port: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (parsed.protocol !== "http:" || !parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    return { host: parsed.hostname, port };
  } catch {
    return undefined;
  }
}

function loopbackProxyReachable(value: string | undefined): boolean | undefined {
  const endpoint = proxyPort(value);
  if (!endpoint || !["127.0.0.1", "localhost", "::1"].includes(endpoint.host)) return undefined;
  const probe = spawnSync("/usr/bin/nc", ["-G", "1", "-z", endpoint.host, String(endpoint.port)], {
    stdio: "ignore",
    timeout: 1_500,
  });
  return probe.status === 0;
}

export function macOsLaunchdProxyEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  proxyOutput?: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  if (platform !== "darwin") return macOsSystemProxyEnvironment(environment, proxyOutput, platform);
  const explicit = environment.HTTPS_PROXY || environment.https_proxy
    || environment.HTTP_PROXY || environment.http_proxy
    || environment.ALL_PROXY || environment.all_proxy;
  const reachable = loopbackProxyReachable(explicit);
  if (reachable === false) {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
      delete environment[name];
    }
  }
  return macOsSystemProxyEnvironment(environment, proxyOutput, platform);
}

export function processRunning(
  pid: unknown,
  probe: (pid: number, signal: 0) => void = process.kill,
): boolean {
  if (!Number.isInteger(pid) || (pid as number) < 1) return false;
  try {
    probe(pid as number, 0);
    return true;
  } catch (error) {
    // Windows and hardened Unix environments can deny signalling an existing process. EPERM is
    // existence evidence, not proof that the launcher/browser/tunnel owner disappeared.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function runCommand(command: string, args: string[], options: SpawnSyncOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") ?? "",
  };
}

export function runChecked(command: string, args: string[], options: SpawnSyncOptions = {}): CommandResult {
  const result = runCommand(command, args, options);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}
