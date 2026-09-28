import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient } from "./smoke-installed";
import { InstalledTurnEvidence, visibleFinalText } from "./installed-turn-evidence";
import { getConfigDir, loadConfig } from "../src/config";

const config = loadConfig();
const executable = process.env.CODEX_APP_SERVER_EXECUTABLE?.trim() || Bun.which("codex");
if (!executable) throw new Error("Codex app-server executable is unavailable");
const workspace = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cancel-live-"));
const daemonLog = join(getConfigDir(), "logs", "daemon.stdout.log");
writeFileSync(join(workspace, "input.txt"), "alpha\n", { mode: 0o600 });
const client = new AppServerClient(executable);

async function backendHealth(): Promise<{ active_http_turns?: number; active_browser_turns?: number; web_readiness?: {
  last_successful_turn_at?: string; last_successful_effort?: string; last_successful_model?: string;
} }> {
  const response = await fetch(`http://${config.host}:${config.port}/healthz`);
  if (!response.ok) throw new Error(`Backend health returned HTTP ${response.status}`);
  return response.json();
}

try {
  await client.request("initialize", {
    clientInfo: { name: "codex-chatgpt-web-real-cancel-acceptance", version: "1" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
  const started = await client.request("thread/start", {
    cwd: workspace,
    model: "chatgpt-web/high",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: true,
  }) as { thread?: { id?: unknown } };
  const threadId = started.thread?.id;
  if (typeof threadId !== "string") throw new Error("Cancellation test received no thread ID");
  const logStart = statSync(daemonLog).size;
  const turnStarted = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Use the attached Codex Native2 codex_exec tool to run `sleep 25; cat input.txt`, then report the file content. The command is part of this cancellation test." }],
  }) as { turn?: { id?: unknown } };
  const cancelledTurnId = turnStarted.turn?.id;
  if (typeof cancelledTurnId !== "string") throw new Error("Cancellation test received no turn ID");
  const acceptedDeadline = Date.now() + 80_000;
  let accepted = false;
  while (Date.now() < acceptedDeadline) {
    const recent = readFileSync(daemonLog, "utf8").slice(logStart);
    if (recent.includes("submission accepted evidence=")) { accepted = true; break; }
    await Bun.sleep(100);
  }
  if (!accepted) throw new Error("Web prompt was not accepted before the cancellation deadline");
  await client.request("turn/interrupt", { threadId, turnId: cancelledTurnId }, 20_000);
  const afterInterruptLogOffset = statSync(daemonLog).size;
  const cancelledEvidence = new InstalledTurnEvidence(threadId, cancelledTurnId);
  await client.waitForTurn(cancelledEvidence, 30_000);
  const cancelled = cancelledEvidence.outcome();
  if (cancelled.status === "completed") throw new Error("Interrupted Web turn completed as if it were normal");
  const releaseDeadline = Date.now() + 15_000;
  let released = false;
  while (Date.now() < releaseDeadline) {
    const health = await backendHealth();
    if (health.active_http_turns === 0 && health.active_browser_turns === 0) { released = true; break; }
    await Bun.sleep(100);
  }
  if (!released) throw new Error("Cancelled Web turn left active HTTP or browser work");
  await Bun.sleep(500);
  const afterInterrupt = readFileSync(daemonLog, "utf8").slice(afterInterruptLogOffset);
  if (afterInterrupt.includes("queued call=") || afterInterrupt.includes("stage=browser_page started")) {
    throw new Error("Cancelled Web turn created a browser page or queued a new tool call after interruption");
  }
  const resumedAt = Date.now();
  const nextStarted = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with OK only." }],
  }) as { turn?: { id?: unknown } };
  const nextTurnId = nextStarted.turn?.id;
  if (typeof nextTurnId !== "string") throw new Error("Post-cancel turn returned no ID");
  const nextEvidence = new InstalledTurnEvidence(threadId, nextTurnId);
  await client.waitForTurn(nextEvidence);
  const next = nextEvidence.outcome();
  if (next.status !== "completed" || visibleFinalText(next.answer) !== "OK") {
    throw new Error(`Post-cancel Web turn failed (status=${next.status}, answerChars=${next.answer.length})`);
  }
  const ready = (await backendHealth()).web_readiness;
  if (!ready?.last_successful_turn_at || Date.parse(ready.last_successful_turn_at) < resumedAt
    || ready.last_successful_model !== "gpt-5.6-sol" || ready.last_successful_effort !== "high") {
    throw new Error("Post-cancel Web readiness does not match the High turn");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    thread_id: threadId,
    cancelled_turn_id: cancelledTurnId,
    cancel_status: cancelled.status,
    accepted_before_interrupt: accepted,
    no_new_page_or_tool_after_interrupt: true,
    resources_released: true,
    next_turn_id: nextTurnId,
    next_answer: "OK",
  })}\n`);
} finally {
  const stderr = await client.close();
  if (/stream disconnected - retrying sampling request/.test(stderr)) {
    process.stderr.write("Codex app-server attempted a sampling retry during cancellation acceptance\n");
    process.exitCode = 1;
  }
  rmSync(workspace, { recursive: true, force: true });
}
