import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendServiceDefinition, backendServiceDefinitionMatches, backendStartupGatePath, gatewayServiceDefinition, negotiateDrain, releaseBackendStartupGate, waitForPortReleased, writeBackendStartupGate } from "../src/service";
import { defaultConfig } from "../src/config";
import { armCandidateRuntime, backendCutoverIdle, candidateClosed, candidateRollbackSafe, gatewayCandidateIdentity, gatewayPreviousIdentity } from "../scripts/install-local-candidate";

describe("service drain lifecycle", () => {
  test("candidate gate persists until the matching bundle releases it", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-gate-"));
    const bundle = "a".repeat(64);
    try {
      writeBackendStartupGate(bundle, root);
      expect(JSON.parse(readFileSync(backendStartupGatePath(root), "utf8"))).toEqual({ schemaVersion: 1, bundleId: bundle });
      expect(() => writeBackendStartupGate(bundle, root)).toThrow("already exists");
      expect(() => releaseBackendStartupGate("b".repeat(64), root)).toThrow("identity changed");
      releaseBackendStartupGate(bundle, root);
      expect(() => readFileSync(backendStartupGatePath(root))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("gateway prestart observes the closed candidate gate before the stable link changes", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-race-"));
    const link = join(root, "cli");
    const bundle = "c".repeat(64);
    try {
      symlinkSync("old-runtime", link);
      armCandidateRuntime(link, "new-runtime", bundle, root, () => {}, (path, target) => {
        // This callback stands in for a gateway prestart at the link replacement boundary.
        expect(readlinkSync(path)).toBe("old-runtime");
        expect(JSON.parse(readFileSync(backendStartupGatePath(root), "utf8"))).toEqual({ schemaVersion: 1, bundleId: bundle });
        symlinkSync(target, `${path}.new`);
        renameSync(`${path}.new`, path);
        expect(readlinkSync(path)).toBe("new-runtime");
        expect(readFileSync(backendStartupGatePath(root), "utf8")).toContain(bundle);
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("candidate is released only after backend and preserved gateway identities agree", () => {
    const old = "a".repeat(64);
    const next = "b".repeat(64);
    const backend = { service: "codex-chatgpt-web", build: { bundleId: next }, accepting_turns: false, deployment_gate: { status: "closed", bundleId: next } };
    const gateway = { service: "codex-chatgpt-web-gateway", build: { bundleId: old }, backend_build: { bundleId: next }, pid: 123 };
    expect(candidateClosed(backend, next)).toBeTrue();
    expect(candidateClosed({ ...backend, accepting_turns: true }, next)).toBeFalse();
    expect(gatewayCandidateIdentity(gateway, backend, 123, old, next)).toBeTrue();
    expect(gatewayCandidateIdentity({ ...gateway, pid: 124 }, backend, 123, old, next)).toBeFalse();
  });

  test("a second backend-only upgrade accepts the older preserved gateway", () => {
    const gateway = { service: "codex-chatgpt-web-gateway", pid: 123,
      build: { bundleId: "gateway-v1" }, backend_build: { bundleId: "backend-v2" } };
    expect(gatewayPreviousIdentity(gateway, "backend-v2")).toBeTrue();
    expect(gatewayPreviousIdentity(gateway, "gateway-v1")).toBeFalse();
    expect(gatewayPreviousIdentity({ ...gateway, pid: undefined }, "backend-v2")).toBeFalse();
  });

  test("native Codex traffic through the preserved gateway does not block a Web backend cutover", () => {
    const gateway = { service: "codex-chatgpt-web-gateway", active_requests: 3 };
    const backend = { service: "codex-chatgpt-web", active_http_turns: 0, active_browser_turns: 0 };
    expect(backendCutoverIdle(gateway, backend)).toBeTrue();
    expect(backendCutoverIdle(gateway, { ...backend, active_browser_turns: 1 })).toBeFalse();
  });

  test("downgrade reads the persisted V1 intent set and fails closed on malformed state", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-intents-"));
    const statePath = join(root, "turn-results.json");
    try {
      expect(candidateRollbackSafe(statePath)).toBeFalse();
      writeFileSync(statePath, JSON.stringify({ version: 1, records: [], intents: [] }));
      expect(candidateRollbackSafe(statePath)).toBeTrue();
      writeFileSync(statePath, JSON.stringify({ version: 1, records: [], intents: [{ executionKey: "turn-1", createdAt: 1 }] }));
      expect(candidateRollbackSafe(statePath)).toBeFalse();
      writeFileSync(statePath, JSON.stringify({ version: 1, records: [], intents: "redacted" }));
      expect(candidateRollbackSafe(statePath)).toBeFalse();
      writeFileSync(statePath, JSON.stringify({ version: 2, records: [], intents: [] }));
      expect(candidateRollbackSafe(statePath)).toBeFalse();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
