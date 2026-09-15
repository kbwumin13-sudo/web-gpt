import { expect, test } from "bun:test";
import { BackendHost } from "../src/backend-host";
import { defaultConfig } from "../src/config";

function fakeServer(events: string[]) {
  return {
    port: 17841,
    stop() {},
    async shutdown() { events.push("server.stop"); },
  };
}

test("Backend Host owns tunnel startup before the Responses server", async () => {
  const events: string[] = [];
  const config = { ...defaultConfig("full"), browserHost: "managed-chrome" as const };
  const host = new BackendHost(config, {
    connectTunnel: () => { events.push("tunnel.start"); },
    waitForTunnelReady: async () => {
      events.push("tunnel.ready");
      return { ok: true, processRunning: true, healthy: true, ready: true, detail: "ready" };
    },
    startServer: () => {
      events.push("server.start");
      return fakeServer(events);
    },
    stopTunnel: () => { events.push("tunnel.stop"); },
  });

  await expect(host.start()).resolves.toMatchObject({ state: "ready", tunnelReady: true });
  expect(events).toEqual(["tunnel.start", "tunnel.ready", "server.start"]);
  await host.stop();
  expect(events).toEqual(["tunnel.start", "tunnel.ready", "server.start", "server.stop", "tunnel.stop"]);
});

test("Backend Host cleans up a tunnel when readiness fails", async () => {
  const events: string[] = [];
  const config = { ...defaultConfig("full"), browserHost: "managed-chrome" as const };
  const host = new BackendHost(config, {
    connectTunnel: () => { events.push("tunnel.start"); },
    waitForTunnelReady: async () => ({
      ok: false,
      processRunning: true,
      healthy: false,
      ready: false,
      detail: "not ready",
    }),
    startServer: () => {
      events.push("server.start");
      return fakeServer(events);
    },
    stopTunnel: () => { events.push("tunnel.stop"); },
  });

  await expect(host.start()).rejects.toThrow("Tunnel runtime did not become ready");
  expect(events).toEqual(["tunnel.start", "tunnel.stop"]);
  expect(host.currentStatus().state).toBe("failed");
});

test("Backend Host cleans up a partially started tunnel when connect fails", async () => {
  const events: string[] = [];
  const config = { ...defaultConfig("full"), browserHost: "managed-chrome" as const };
  const host = new BackendHost(config, {
    connectTunnel: () => {
      events.push("tunnel.start");
      throw new Error("connect failed");
    },
    startServer: () => fakeServer(events),
    stopTunnel: () => { events.push("tunnel.stop"); },
  });

  await expect(host.start()).rejects.toThrow("connect failed");
  expect(events).toEqual(["tunnel.start", "tunnel.stop"]);
});

test("Backend Host refuses Launcher-owned browser state", async () => {
  const host = new BackendHost({ ...defaultConfig(), browserHost: "launcher" });
  await expect(host.start()).rejects.toThrow("requires managed-chrome");
});
