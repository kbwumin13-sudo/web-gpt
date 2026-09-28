import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { AppServerClient } from "./smoke-installed";
import { InstalledTurnEvidence, visibleFinalText } from "./installed-turn-evidence";

const markers = ["PARALLEL_OLIVE_381", "PARALLEL_RUBY_526", "PARALLEL_SLATE_704", "PARALLEL_IVORY_913", "PARALLEL_AMBER_268"];
// Pro is left out on purpose: its quota is scarce, and five-way isolation does not depend on the tier.
const models = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/medium"];
const config = loadConfig();
const executable = process.env.CODEX_APP_SERVER_EXECUTABLE?.trim() || Bun.which("codex") || resolve("/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(executable)) throw new Error(`Codex app-server executable is missing: ${executable}`);
type Participant = { client: AppServerClient; workspace: string; evidence: InstalledTurnEvidence; marker: string; model: string };
const participants: Participant[] = [];
const appServerErrors: string[] = [];
let acceptedResult: { sixth_rejected: true; outcomes: Array<{ model: string; thread_id: string; turn_id: string; marker: string; answer_chars: number; tool_read: boolean }> } | undefined;

async function start(index: number): Promise<Participant> {
  const client = new AppServerClient(executable);
  const workspace = mkdtempSync(join(tmpdir(), "codex-web-parallel-"));
  const marker = markers[index] ?? "PARALLEL_SIXTH_999";
  const model = models[index] ?? "chatgpt-web/light";
  participants.push({ client, workspace, evidence: new InstalledTurnEvidence("", ""), marker, model });
  writeFileSync(join(workspace, "input.txt"), `${marker}\n`, { mode: 0o600 });
  await client.request("initialize", { clientInfo: { name: "codex-web-parallel-acceptance", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized");
  const started = await client.request("thread/start", { cwd: workspace, model, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true }) as { thread?: { id?: unknown } };
  const threadId = started.thread?.id;
  if (typeof threadId !== "string") throw new Error(`Missing thread ID for ${model}`);
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Use the attached Codex Native2 connector's codex_exec tool to read input.txt in this workspace. Use the turn_token from the task context. After confirming stdout, reply with a 60-line numbered log in your final message, with that exact marker in each line. Do not create or modify any file. Never infer the marker without a successful read." }],
  }) as { turn?: { id?: unknown } };
  const turnId = turn.turn?.id;
  if (typeof turnId !== "string") throw new Error(`Missing turn ID for ${model}`);
  const participant = participants[index]!;
  participant.evidence = new InstalledTurnEvidence(threadId, turnId);
  return participant;
}

async function waitForFiveActive(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(3_000) });
    const health = await response.json() as { active_browser_turns?: number };
    if (health.active_browser_turns === 5) return;
    await Bun.sleep(100);
  }
  throw new Error("Five browser turns were never active together");
}

try {
  const started = await Promise.allSettled(markers.map((_, index) => start(index)));
  const firstFailure = started.find(result => result.status === "rejected");
  if (firstFailure?.status === "rejected") throw firstFailure.reason;
  const firstFive = started.map(result => (result as PromiseFulfilledResult<Participant>).value);
  await waitForFiveActive();
  let sixthRejected = false;
  let sixthError = "";
  try {
    const sixth = await start(5);
    await sixth.client.waitForTurn(sixth.evidence, 120_000);
    const outcome = sixth.evidence.outcome();
    const error = outcome.turn.error as { message?: unknown } | undefined;
    sixthError = String(error?.message ?? "");
    sixthRejected = outcome.status === "failed" && /at most 5 simultaneous browser turns/i.test(sixthError);
  } catch (error) {
    sixthError = String(error);
    sixthRejected = /at most 5 simultaneous browser turns/i.test(sixthError);
  }
  if (!sixthRejected) throw new Error(`Sixth browser turn did not fail by the five-turn contract: ${sixthError.slice(0, 300)}`);
  // Every accepted turn runs to its end before the batch is judged: failing fast here would tear
  // down the other four mid-turn and turn one model's answer into five interrupted turns.
  const settled = await Promise.allSettled(firstFive.map(async participant => {
    await participant.client.waitForTurn(participant.evidence, 240_000);
    const { status, answer, toolItems } = participant.evidence.outcome();
    const text = visibleFinalText(answer);
    const others = markers.filter(marker => marker !== participant.marker);
    const read = toolItems.some(item => item.type === "commandExecution"
      && item.status === "completed" && item.exitCode === 0
      && typeof item.command === "string" && item.command.includes("input.txt")
      && typeof item.aggregatedOutput === "string" && item.aggregatedOutput.includes(participant.marker));
    if (status !== "completed" || !text.includes(participant.marker) || others.some(marker => text.includes(marker)) || !read) {
      // The prompt and marker are synthetic, so the evidence can be shown in full enough to tell a
      // model that answered differently from a bridge that lost or crossed an answer.
      const tools = toolItems.map(item => ({
        type: item.type,
        status: item.status,
        command: typeof item.command === "string" ? item.command.slice(0, 160) : undefined,
      }));
      const error = participant.evidence.outcome().turn.error as { message?: unknown } | undefined;
      throw new Error(`${participant.model} parallel turn failed isolation (status=${status}, answerChars=${answer.length}, read=${read}, `
        + `answer=${JSON.stringify(text.slice(0, 240))}, tools=${JSON.stringify(tools)}`
        + `${error?.message ? `, error=${JSON.stringify(String(error.message).slice(0, 300))}` : ""})`);
    }
    return { model: participant.model, thread_id: participant.evidence.threadId, turn_id: participant.evidence.turnId, marker: participant.marker, answer_chars: answer.length, tool_read: true };
  }));
  const failures = settled.flatMap(result => result.status === "rejected" ? [String((result.reason as Error)?.message ?? result.reason)] : []);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  const outcomes = settled.map(result => (result as PromiseFulfilledResult<{
    model: string; thread_id: string; turn_id: string; marker: string; answer_chars: number; tool_read: boolean;
  }>).value);
  acceptedResult = { sixth_rejected: true, outcomes };
} finally {
  await Promise.all(participants.map(async (participant, index) => {
    try { appServerErrors[index] = await participant.client.close(); }
    finally { rmSync(participant.workspace, { recursive: true, force: true }); }
  }));
}
if (appServerErrors.slice(0, markers.length).some(stderr => /stream disconnected - retrying sampling request/.test(stderr))) {
  throw new Error("One of the five accepted parallel turns required an implicit sampling retry");
}
if (!acceptedResult) throw new Error("The five-way batch produced no accepted result");
const sixthSamplingRetries = (appServerErrors[5]?.match(/stream disconnected - retrying sampling request/g) ?? []).length;
process.stdout.write(`PARALLEL_LIVE_OK ${JSON.stringify({ ...acceptedResult, sixth_sampling_retries: sixthSamplingRetries })}\n`);
