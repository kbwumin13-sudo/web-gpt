import { describe, expect, test } from "bun:test";
import { TUNNEL_VERSION, parseTunnelStatus, tunnelClientInstallAction, tunnelCommandOutput, tunnelConnectLaunchError, tunnelHealthFileFromInventory, tunnelStopReachedTerminalState } from "../src/tunnel";
import { macOsSystemProxyEnvironment } from "../src/process";

test("pins the fixed tunnel-client and migrates only the previously shipped version", () => {
  expect(TUNNEL_VERSION).toBe("0.0.12");
  expect(tunnelClientInstallAction("0.0.12")).toBe("reuse");
  expect(tunnelClientInstallAction("0.0.10")).toBe("upgrade");
  expect(() => tunnelClientInstallAction("0.0.11")).toThrow("not a trusted upgrade source");
  expect(() => tunnelClientInstallAction("9.9.9")).toThrow("not a trusted upgrade source");
});

test("CLI tunnel startup derives the active macOS HTTPS proxy without overriding explicit settings", () => {
  const detected = macOsSystemProxyEnvironment({ NO_PROXY: "example.test" }, `
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}
`, "darwin");
  expect(detected.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  expect(detected.HTTP_PROXY).toBe("http://127.0.0.1:7890");
  expect(detected.NO_PROXY).toContain("example.test");
  expect(detected.NO_PROXY).toContain("127.0.0.1");

  const explicit = macOsSystemProxyEnvironment({
    HTTPS_PROXY: "http://explicit:8443",
  }, "", "darwin");
  expect(explicit.HTTPS_PROXY).toBe("http://explicit:8443");
});

test("local tunnel readiness discovery accepts only the exact alias and an absolute health file", () => {
  const absolute = process.platform === "win32"
    ? "C:\\Users\\Example\\tunnel-health.url"
    : "/Users/example/tunnel-health.url";
  const inventory = JSON.stringify({
    aliases: [
      { alias: "other", health_url_file: "/tmp/unrelated.url" },
      { alias: "codex-chatgpt-web", health_url_file: absolute },
    ],
  });
  expect(tunnelHealthFileFromInventory(inventory, "codex-chatgpt-web")).toBe(absolute);
  expect(tunnelHealthFileFromInventory(inventory, "missing")).toBeUndefined();
  expect(tunnelHealthFileFromInventory(JSON.stringify({
    aliases: [{ alias: "codex-chatgpt-web", health_url_file: "relative.url" }],
  }), "codex-chatgpt-web")).toBeUndefined();
});

test("tunnel stop accepts a nonzero native result only when its structured state is terminal", () => {
  expect(tunnelStopReachedTerminalState(JSON.stringify({
    process_running: false,
    runtime_state: "stopped",
    stopped: false,
    error: "process 123 did not exit after SIGTERM",
  }))).toBeTrue();
  expect(tunnelStopReachedTerminalState(JSON.stringify({
    process_running: true,
    runtime_state: "stopping",
    stopped: false,
  }))).toBeFalse();
  expect(tunnelStopReachedTerminalState("not json")).toBeFalse();
});

describe("tunnel status boundary", () => {
  test("requires the managed runtime process, health, and readiness together", () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: true,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }))).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    });
    expect(parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }))).toMatchObject({ ok: false, processRunning: false, healthy: true, ready: true });
  });

  test("redacts tunnel ids and keys from safe diagnostics", () => {
    const result = parseTunnelStatus(
      "failed tunnel_0123456789abcdef0123456789abcdef with sk-secretsecretsecret",
      1,
    );
    expect(result.detail).toBe("failed [tunnel-id] with [redacted-key]");
    expect(result.detail).not.toContain("0123456789abcdef");
  });

  test("surfaces and redacts an immediate managed-runtime launch failure", () => {
    const detail = tunnelConnectLaunchError(JSON.stringify({
      running: false,
      healthy: false,
      ready: false,
      exit_code: 1,
      launch_diagnostics: {
        log_tail: "403 for tunnel_0123456789abcdef0123456789abcdef using sk-secretsecretsecret",
      },
    }));

    expect(detail).toBe(
      "running=false; healthy=false; ready=false; exit_code=1; runtime_log=403 for [tunnel-id] using [redacted-key]",
    );
  });

  test("accepts a healthy managed launch while setup waits for control-plane readiness", () => {
    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: true,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: false,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: false,
      ready: false,
    }))).toContain("running=true; healthy=false; ready=false");

    expect(tunnelConnectLaunchError("not json")).toBe("tunnel-client returned non-JSON connect output");
  });

  test("includes the managed runtime log tail in stopped status diagnostics", () => {
    const result = parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: false,
      ready: false,
      runtime_state: "stopped",
      local: {
        issues: ["recorded process pid is not running"],
        log: {
          tail: "runtime startup failed with sk-secretsecretsecret",
        },
      },
    }));

    expect(result.detail).toContain("runtime_log=runtime startup failed with [redacted-key]");
    expect(result.detail).not.toContain("sk-secret");
  });

  test("status diagnostics do not discard stderr when a failed command also wrote stdout", () => {
    expect(tunnelCommandOutput({
      status: 1,
      stdout: '{"partial":true}',
      stderr: "runtime process exited with status 1",
    })).toBe('runtime process exited with status 1\n{"partial":true}');
    expect(tunnelCommandOutput({
      status: 0,
      stdout: '{"ready":true}',
      stderr: "non-fatal warning",
    })).toBe('{"ready":true}');
  });
});
