import { mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const repo = process.cwd();
const root = mkdtempSync(join(tmpdir(), "native-acceptance-order-"));
const originalCwd = process.cwd();
let workspace = "";
mock.module(`${repo}/src/config.ts`, () => ({ atomicWriteFile: (path: string, data: string) => writeFileSync(path, data), loadConfig: () => ({
  host: "127.0.0.1", port: 1, releaseVersion: "probe",
}) }));
mock.module(`${repo}/src/service.ts`, () => ({ startService() {}, async waitForBackendReady() {} }));
mock.module(`${repo}/scripts/smoke-installed.ts`, () => ({ AppServerClient: class {
  async request(method: string, args: { cwd?: string } = {}) {
    if (method === "thread/start") { workspace = args.cwd!; return { thread: { id: "thread-probe" } }; }
    if (method === "turn/start") return { turn: { id: "turn-probe" } };
    return {};
  }
  notify() {}
  async waitForTurn(evidence: { observe(value: unknown): void }, _timeout: number,
    onNotification: (value: unknown) => void) {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "result.json"), JSON.stringify({ score_total: 85, names: ["Di", "Bo", "Ada", "Eve", "Cy"] }));
    writeFileSync(join(workspace, "process.py"), "# synthetic probe\n");
    onNotification({ method: "item/completed", params: { threadId: "thread-probe", turnId: "turn-probe",
      item: { type: "agentMessage", phase: "commentary" } } });
    for (let index = 0; index < 9; index += 1) onNotification({ method: "item/completed",
      params: { threadId: "thread-probe", turnId: "turn-probe", item: { type: "commandExecution" } } });
    onNotification({ method: "item/completed", params: { threadId: "thread-probe", turnId: "turn-probe",
      item: { type: "fileChange" } } });
    onNotification({ method: "item/completed", params: { threadId: "thread-probe", turnId: "turn-probe",
      item: { type: "agentMessage", phase: "commentary" } } });
    evidence.observe({ method: "turn/completed", params: {
      threadId: "thread-probe", turn: { id: "turn-probe", status: "completed", items: [
        ...Array.from({ length: 9 }, (_, i) => ({ id: `command-${i}`, type: "commandExecution", status: "completed", exitCode: 0 })),
        { id: "patch", type: "fileChange", status: "completed" },
        { id: "final", type: "agentMessage", phase: "final",
          text: `DONE_85\n[result.json](<${join(workspace, "result.json")}>)` },
      ] },
    } });
  }
  async close() { return "stream disconnected - retrying sampling request"; }
} }));
globalThis.fetch = (async () => Response.json({ build: { bundleId: "synthetic-bundle", version: "probe" } })) as unknown as typeof fetch;
process.env.CODEX_APP_SERVER_EXECUTABLE = process.execPath;
process.argv.push("--run");
process.chdir(root);
try {
  let rejection = "";
  try { await import(`${repo}/scripts/acceptance-native-task.ts`); }
  catch (error) { rejection = String(error); }
  const report = JSON.parse(readFileSync(join(root, "output", "native-task-probe", "acceptance.json"), "utf8"));
  if (!rejection.includes("implicit sampling retry") || report.status !== "failed") throw new Error("Probe did not reproduce the accurate failed acceptance artifact");
  process.stdout.write(JSON.stringify({ reproduced: true, thrown: "implicit sampling retry", persisted_status: report.status }) + "\n");
} finally {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
