import { mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenario = process.argv[2];
const directory = mkdtempSync(join(tmpdir(), "tunnel-readiness-test-"));
process.env.CODEX_CHATGPT_WEB_HOME = directory;
const healthFile = join(directory, "health.url");
const requests: string[] = [];
let metricsReads = 0;
let initialPollTimeout: string | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/healthz") return new Response("live");
    if (path === "/readyz") return new Response("ready");
    if (path !== "/metrics") return new Response("not found", { status: 404 });
    metricsReads += 1;
    if (scenario === "missing") return new Response("unrelated_metric 1\n");
    const now = Date.now() / 1000;
    const timestamp = scenario === "never" || (scenario === "recovery" && metricsReads === 1) ? 0
      : scenario === "stale" ? now - 180
        : scenario === "future" ? now + 180 : now;
    return new Response(`commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} ${timestamp}\n`);
  },
});
writeFileSync(healthFile, `http://127.0.0.1:${server.port}`, { mode: 0o600 });
mock.module("../../src/process.ts", () => ({
  macOsLaunchdProxyEnvironment: () => process.env,
  runCommand: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (args[1] === "connect") {
      initialPollTimeout = options?.env?.CONTROL_PLANE_INITIAL_POLL_TIMEOUT;
      return { status: 0, stdout: JSON.stringify({ running: true, healthy: true, ready: true }), stderr: "" };
    }
    return { status: 0, stdout: JSON.stringify({ aliases: [{ alias: "diagnostic-fixture", health_url_file: healthFile }] }), stderr: "" };
  },
  runChecked: () => { throw new Error("unexpected CLI execution"); },
}));

try {
  const { defaultConfig } = await import("../../src/config");
  const { connectTunnel, createTunnelConfig, waitForTunnelReady } = await import("../../src/tunnel");
  const config = { ...defaultConfig("full"), tunnel: createTunnelConfig({
    binaryPath: process.execPath, tunnelId: `tunnel_${"0".repeat(32)}`, runtimeKeyFile: "unused-test-key", alias: "diagnostic-fixture",
  }) };
  connectTunnel(config);
  const status = await waitForTunnelReady(config, scenario === "recovery" ? 2_500 : 0);
  process.stdout.write(JSON.stringify({ status, requests, metricsReads, initialPollTimeout }));
} finally {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
