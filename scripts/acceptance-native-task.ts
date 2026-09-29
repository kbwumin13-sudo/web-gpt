import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, loadConfig } from "../src/config";
import { startService, waitForBackendReady } from "../src/service";
import { AppServerClient } from "./smoke-installed";
import { InstalledTurnEvidence, visibleFinalText } from "./installed-turn-evidence";

if (!process.argv.includes("--run")) throw new Error("Pass --run to perform the installed native-tool task");
const config = loadConfig();
startService();
await waitForBackendReady(config);
const backend = await (await fetch(`http://${config.host}:${config.port}/healthz`, {
  signal: AbortSignal.timeout(3_000),
})).json() as { build?: { bundleId?: string; version?: string } };
const bundleId = backend.build?.bundleId;
if (!bundleId || backend.build?.version !== config.releaseVersion) {
  throw new Error("Installed backend identity does not match the configured candidate");
}
const executable = process.env.CODEX_APP_SERVER_EXECUTABLE?.trim()
  || Bun.which("codex") || resolve("/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(executable)) throw new Error(`Codex app-server executable is missing: ${executable}`);
const recordFlag = process.argv.indexOf("--record-dir");
if (recordFlag >= 0 && (!process.argv[recordFlag + 1]
  || process.argv[recordFlag + 1]!.startsWith("--"))) throw new Error("--record-dir requires a path");
const workspace = resolve(recordFlag >= 0 ? process.argv[recordFlag + 1]! : join("output", `native-task-${config.releaseVersion}`));
if (existsSync(workspace)) throw new Error(`Acceptance workspace already exists: ${workspace}`);
mkdirSync(workspace, { recursive: true, mode: 0o700 });
writeFileSync(join(workspace, "input.csv"), "name,score\nAda,14\nBo,21\nCy,9\nDi,31\nEve,10\n", { mode: 0o600 });
const client = new AppServerClient(executable);
let threadId: string | undefined;
let turnId: string | undefined;
let passedReport: Record<string, unknown> | undefined;
let failure: unknown;
try {
  await client.request("initialize", { clientInfo: { name: "codex-web-native-task-acceptance", version: "1" },
    capabilities: { experimentalApi: true } });
  client.notify("initialized");
  const started = await client.request("thread/start", { cwd: workspace, model: "chatgpt-web/light",
    approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true }) as { thread?: { id?: unknown } };
  if (typeof started.thread?.id !== "string") throw new Error("Native task has no thread ID");
  threadId = started.thread.id;
  const prompt = [
    "Complete this local file-processing task through the attached Codex Native2 tools. Use the current Runtime turn token.",
    "Make at least TEN SEPARATE real tool calls during this single turn; each numbered step must be a separate call,",
    "and do not combine shell commands or claim success from chat alone. Work only in this workspace.",
    "1. Print the working directory. 2. List the workspace. 3. Read input.csv.",
    "4. Create process.py that reads input.csv and writes result.json with the score total and descending names.",
    "5. Read process.py. 6. Run process.py. 7. Read result.json. 8. Run a programmatic assertion that",
    "the total is 85 and names are Di,Bo,Ada,Eve,Cy. 9. Compute the SHA-256 of result.json.",
    "10. List both output files. You may make further separate calls if needed.",
    "Show a short commentary update before the first tool and after the last tool. After verification,",
    "reply with DONE_85 followed by a Markdown link labelled result.json whose target is the real absolute result.json path.",
  ].join("\n");
  const turn = await client.request("turn/start", { threadId,
    input: [{ type: "text", text: prompt }] }) as { turn?: { id?: unknown } };
  if (typeof turn.turn?.id !== "string") throw new Error("Native task has no turn ID");
  turnId = turn.turn.id;
  const evidence = new InstalledTurnEvidence(threadId, turnId);
  const startedAt = Date.now();
  const timeline: Array<{ kind: "commentary" | "tool"; elapsed_ms: number }> = [];
  await client.waitForTurn(evidence, 600_000, notification => {
    const params = notification.params as { threadId?: unknown; turnId?: unknown;
      item?: { type?: unknown; phase?: unknown } } | undefined;
    if (!params || params.threadId !== threadId || params.turnId !== turnId) return;
    if (notification.method !== "item/completed") return;
    if (params.item?.type === "agentMessage" && params.item.phase === "commentary") {
      timeline.push({ kind: "commentary", elapsed_ms: Date.now() - startedAt });
    } else if (["commandExecution", "fileChange", "mcpToolCall"].includes(String(params.item?.type))) {
      timeline.push({ kind: "tool", elapsed_ms: Date.now() - startedAt });
    }
  });
  const outcome = evidence.outcome();
  const successfulCommands = outcome.toolItems.filter(item => item.type === "commandExecution"
    && item.status === "completed" && item.exitCode === 0);
  const successfulToolItems = outcome.toolItems.filter(item =>
    (item.type === "commandExecution" && item.status === "completed" && item.exitCode === 0)
    || (["fileChange", "mcpToolCall"].includes(String(item.type)) && item.status === "completed"));
  const result = JSON.parse(readFileSync(join(workspace, "result.json"), "utf8")) as {
    total?: unknown; score_total?: unknown; names?: unknown;
  };
  const validResult = (result.total ?? result.score_total) === 85
    && Array.isArray(result.names) && result.names.join(",") === "Di,Bo,Ada,Eve,Cy";
  const answer = visibleFinalText(outcome.answer);
  const expectedLink = `[result.json](<${join(workspace, "result.json")}>)`;
  const firstTool = timeline.find(item => item.kind === "tool")?.elapsed_ms;
  const lastTool = timeline.findLast(item => item.kind === "tool")?.elapsed_ms;
  const commentary = timeline.filter(item => item.kind === "commentary").map(item => item.elapsed_ms);
  const progressOrdered = firstTool !== undefined && lastTool !== undefined
    && commentary.some(at => at <= firstTool && at <= 90_000)
    && commentary.some(at => at >= lastTool);
  if (outcome.status !== "completed" || !answer.startsWith("DONE_85")
    || !answer.includes(expectedLink) || !progressOrdered
    || successfulToolItems.length < 10 || !existsSync(join(workspace, "process.py")) || !validResult) {
    throw new Error(`Installed native task failed: status=${outcome.status}, toolItems=${successfulToolItems.length}, commands=${successfulCommands.length}, validResult=${validResult}, progressOrdered=${progressOrdered}, answer=${JSON.stringify(outcome.answer.slice(0, 120))}`);
  }
  const resultBytes = readFileSync(join(workspace, "result.json"));
  passedReport = {
    status: "passed", version: config.releaseVersion, bundle_id: bundleId, thread_id: threadId, turn_id: turnId,
    successful_tool_calls: successfulToolItems.length, successful_commands: successfulCommands.length,
    result_sha256: createHash("sha256").update(resultBytes).digest("hex"),
    artifact: join(workspace, "result.json"), final_link: expectedLink,
    commentary_elapsed_ms: commentary, first_tool_elapsed_ms: firstTool, last_tool_elapsed_ms: lastTool,
  };
} catch (error) {
  failure = error;
} finally {
  try {
    const stderr = await client.close();
    if (/stream disconnected - retrying sampling request/.test(stderr)) {
      failure ??= new Error(`Native task required an implicit sampling retry (thread=${threadId}, turn=${turnId})`);
    }
  } catch (error) { failure ??= error; }
}
if (failure || !passedReport) {
  const failed = { status: "failed", version: config.releaseVersion, bundle_id: bundleId,
    thread_id: threadId ?? null, turn_id: turnId ?? null,
    error: failure instanceof Error ? failure.message.slice(0, 500) : String(failure ?? "No validated result") };
  atomicWriteFile(join(workspace, "acceptance.json"), `${JSON.stringify(failed, null, 2)}\n`, { mode: 0o600 });
  throw failure ?? new Error("Native task produced no validated result");
}
atomicWriteFile(join(workspace, "acceptance.json"), `${JSON.stringify(passedReport, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`NATIVE_TASK_OK ${JSON.stringify(passedReport)}\n`);
