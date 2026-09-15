import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { backendServiceDefinition, backendServiceDefinitionMatches, gatewayServiceDefinition, negotiateDrain, waitForPortReleased } from "../src/service";
import { defaultConfig } from "../src/config";

describe("service drain lifecycle", () => {
  test("the managed daemon definition starts the Backend Host", () => {
    const definition = backendServiceDefinition(defaultConfig("browser-only"));
    expect(definition).toContain("<string>backend</string>");
    expect(definition).not.toContain("<string>serve</string>");
    expect(definition).toContain("<key>RunAtLoad</key>\n  <false/>");
    expect(definition).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(backendServiceDefinitionMatches(defaultConfig("browser-only"))).toBe(false);
  });

  test("the native gateway definition is independent and always available", () => {
    const definition = gatewayServiceDefinition(defaultConfig("browser-only"));
    expect(definition).toContain("<string>gateway</string>");
    expect(definition).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(definition).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  test("compensates when a drain may have reached the daemon before the client times out", async () => {
    const actions: string[] = [];
    let acceptingTurns = true;
    const control = async (action: "drain" | "resume") => {
      actions.push(action);
      acceptingTurns = action === "resume";
      if (action === "drain") throw new Error("request timed out after delivery");
      return { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
    };

    await expect(negotiateDrain(control)).rejects.toThrow("atomic idleness could not be proven");
    expect(actions).toEqual(["drain", "resume"]);
    expect(acceptingTurns).toBe(true);
  });

  test("releases a verified idle drain", async () => {
    const actions: string[] = [];
    const lease = await negotiateDrain(async action => {
      actions.push(action);
      return action === "drain"
        ? { accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }
        : { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
    });
    expect(actions).toEqual(["drain"]);
    await lease.release();
    expect(actions).toEqual(["drain", "resume"]);
  });

  test("waits for a process to release its port before restart", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no numeric port");

    const release = new Promise<void>((resolveRelease, rejectRelease) => {
      setTimeout(() => server.close(error => error ? rejectRelease(error) : resolveRelease()), 25);
    });
    await waitForPortReleased("127.0.0.1", address.port, 1_000);
    await release;
  });
});
