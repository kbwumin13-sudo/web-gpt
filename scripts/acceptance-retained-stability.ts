import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { requireChatGptWebModelRoute } from "../src/chatgpt-web-models";
import { loadConfig } from "../src/config";
import { startService, stopService, waitForBackendReady } from "../src/service";
import { AppServerClient } from "./smoke-installed";
import { InstalledTurnEvidence, visibleFinalText } from "./installed-turn-evidence";

type Tier = "light" | "medium" | "high" | "extra-high";
type Kind = "remember" | "recall" | "tool" | "coding" | "image" | "retained-compaction" | "lost-session-compaction";
type Step = { tier: Tier; kind: Kind };
const slots: Step[][] = [
  [{ tier: "light", kind: "remember" }],
  [{ tier: "medium", kind: "remember" }],
  [{ tier: "high", kind: "remember" }],
  [{ tier: "extra-high", kind: "remember" }],
  [{ tier: "light", kind: "tool" }],
  [{ tier: "medium", kind: "coding" }],
  [{ tier: "high", kind: "image" }, { tier: "light", kind: "recall" }],
  [{ tier: "extra-high", kind: "tool" }, { tier: "medium", kind: "recall" }],
  [{ tier: "high", kind: "recall" }],
  [{ tier: "extra-high", kind: "recall" }],
  [{ tier: "light", kind: "recall" }, { tier: "medium", kind: "recall" }],
  [{ tier: "medium", kind: "retained-compaction" }],
  [{ tier: "high", kind: "recall" }],
  [{ tier: "extra-high", kind: "recall" }, { tier: "light", kind: "recall" }],
  [{ tier: "medium", kind: "recall" }],
  [{ tier: "high", kind: "lost-session-compaction" }],
];
const EXPECTED_ROUNDS = 20;
const DURATION_MS = 120 * 60_000;
const SLOT_GAP_MS = DURATION_MS / (slots.length - 1);
if (slots.flat().length !== EXPECTED_ROUNDS) throw new Error("Retained stability plan must contain exactly 20 turns");
const args = process.argv.slice(2);
if (args.includes("--plan")) {
  process.stdout.write(`${JSON.stringify({ minutes: 120, rounds: EXPECTED_ROUNDS, slots }, null, 2)}\n`);
  process.exit(0);
}
if (!args.includes("--run")) throw new Error("Pass --plan or --run");
const recordFlag = args.indexOf("--record");
const recordPath = resolve(recordFlag >= 0 ? args[recordFlag + 1] ?? "" : "output/web-recovery-retained-stability.jsonl");
if (recordFlag >= 0 && (!args[recordFlag + 1] || args[recordFlag + 1]!.startsWith("--"))) throw new Error("--record requires a path");
mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
const record = (entry: Record<string, unknown>): void => appendFileSync(recordPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
const config = loadConfig();
const executable = process.env.CODEX_APP_SERVER_EXECUTABLE?.trim() || Bun.which("codex") || resolve("/Applications/ChatGPT.app/Contents/Resources/codex");
const backendUrl = `http://${config.host}:${config.port}/healthz`;
const gatewayUrl = `http://${config.host}:${config.nativeGatewayPort}/healthz`;
const gateway = await (await fetch(gatewayUrl, { signal: AbortSignal.timeout(3_000) })).json() as {
  build?: { bundleId?: string }; backend_build?: { bundleId?: string };
};
const backend = await (await fetch(backendUrl, { signal: AbortSignal.timeout(3_000) })).json() as {
  build?: { bundleId?: string; version?: string };
};
const gatewayBundleId = gateway.build?.bundleId;
const bundleId = backend.build?.bundleId;
if (!gatewayBundleId || !bundleId || backend.build?.version !== config.releaseVersion
  || gateway.backend_build?.bundleId !== bundleId) {
  throw new Error("Gateway route and installed backend candidate identity mismatch");
}
const markers: Record<Tier, string> = {
  light: "STABILITY_LIME_618", medium: "STABILITY_COBALT_527",
  high: "STABILITY_GARNET_904", "extra-high": "STABILITY_IVORY_263",
};
const redPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAMAjAsK7+PTMRPLhGQd7QJnESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ES53Vg6wNShQF/fRSLfgAAAABJRU5ErkJggg==", "base64");
type Owner = { client: AppServerClient; threadId: string; workspace: string; tier: Tier };
const owners = new Map<Tier, Owner>();
let passed = 0;
const beganAt = Date.now();
record({ type: "start", at: new Date(beganAt).toISOString(), version: config.releaseVersion,
  bundle_id: bundleId, gateway_bundle_id: gatewayBundleId, expected_rounds: EXPECTED_ROUNDS, duration_minutes: 120 });

async function backendMetrics(): Promise<{ delivered: number; fresh_rounds: number; failed: number; abandoned: number }> {
  const response = await fetch(backendUrl, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Backend health returned HTTP ${response.status}`);
  const body = await response.json() as { compaction?: { delivered?: number; fresh_rounds?: number; failed?: number; abandoned?: number } };
  const metrics = body.compaction;
  if (!metrics || ![metrics.delivered, metrics.fresh_rounds, metrics.failed, metrics.abandoned].every(Number.isInteger)) {
    throw new Error("Backend compaction metrics are incomplete");
  }
  return metrics as { delivered: number; fresh_rounds: number; failed: number; abandoned: number };
}

async function ownerFor(tier: Tier): Promise<Owner> {
  const existing = owners.get(tier);
  if (existing) return existing;
  const client = new AppServerClient(executable);
  const workspace = mkdtempSync(join(tmpdir(), `codex-web-stability-${tier}-`));
  const marker = markers[tier];
  writeFileSync(join(workspace, "input.txt"), `${marker}\n`, { mode: 0o600 });
  writeFileSync(join(workspace, "red.png"), redPng, { mode: 0o600 });
  const pending = { client, threadId: "", workspace, tier };
  owners.set(tier, pending);
  await client.request("initialize", { clientInfo: { name: "codex-web-retained-stability", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized");
  const started = await client.request("thread/start", { cwd: workspace, model: `chatgpt-web/${tier}`, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true }) as { thread?: { id?: unknown } };
  if (typeof started.thread?.id !== "string") throw new Error(`${tier} thread/start returned no ID`);
  pending.threadId = started.thread.id;
  return pending;
}

async function compact(owner: Owner, kind: "retained-compaction" | "lost-session-compaction", slot: number): Promise<void> {
  if (kind === "lost-session-compaction") {
    const health = await (await fetch(backendUrl)).json() as { active_http_turns?: number; active_browser_turns?: number };
    if (health.active_http_turns !== 0 || health.active_browser_turns !== 0) throw new Error("Lost-session test requires idle backend turns");
    await stopService(config);
    startService();
    await waitForBackendReady(config);
  }
  const before = await backendMetrics();
  await owner.client.request("thread/compact/start", { threadId: owner.threadId }, 600_000);
  const compactedTurnId = await owner.client.waitForCompaction(owner.threadId);
  const after = await backendMetrics();
  const freshDelta = kind === "lost-session-compaction" ? 1 : 0;
  if (after.delivered !== before.delivered + 1 || after.fresh_rounds !== before.fresh_rounds + freshDelta
    || after.failed !== before.failed || after.abandoned !== before.abandoned) {
    throw new Error(`${kind} used the wrong compaction path: before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
  }
  record({ type: "compaction", slot, tier: owner.tier, mode: freshDelta ? "fresh" : "retained", turn_id: compactedTurnId, at: new Date().toISOString() });
}

async function runStep(step: Step, slot: number, concurrent: boolean): Promise<void> {
  const owner = await ownerFor(step.tier);
  const marker = markers[step.tier];
  if (step.kind === "retained-compaction" || step.kind === "lost-session-compaction") await compact(owner, step.kind, slot);
  const input = step.kind === "remember"
    ? `Remember ${marker} for this task. Reply READY_${marker} only.`
    : step.kind === "tool"
      ? "Call the attached Codex Native2 codex_exec tool to read input.txt in this workspace, using the turn_token from the task context. Reply with only the exact stdout without the trailing newline."
      : step.kind === "coding"
        ? `Read input.txt, create result.txt containing exactly '${marker}: verified' followed by a newline, then run a command that reads result.txt. Reply VERIFIED_${marker} only after the command succeeds.`
        : step.kind === "image"
          ? "Identify the dominant color of this attached square. Reply RED only."
          : "What exact marker did I ask you to remember in the first round? Reply with only that marker.";
  const expected = step.kind === "remember" ? `READY_${marker}`
    : step.kind === "coding" ? `VERIFIED_${marker}`
      : step.kind === "image" ? "RED" : marker;
  const startedAt = Date.now();
  const turn = await owner.client.request("turn/start", {
    threadId: owner.threadId,
    input: [{ type: "text", text: input }, ...(step.kind === "image" ? [{ type: "localImage", path: join(owner.workspace, "red.png"), detail: "high" }] : [])],
  }) as { turn?: { id?: unknown } };
  if (typeof turn.turn?.id !== "string") throw new Error(`${step.tier} turn/start returned no ID`);
  const evidence = new InstalledTurnEvidence(owner.threadId, turn.turn.id);
  await owner.client.waitForTurn(evidence, 240_000);
  const outcome = evidence.outcome();
  const answer = visibleFinalText(outcome.answer);
  if (outcome.status !== "completed" || answer !== expected) {
    throw new Error(`Slot ${slot} ${step.tier} ${step.kind} failed exact answer (status=${outcome.status}, chars=${answer.length})`);
  }
  if (step.kind === "tool") {
    const read = outcome.toolItems.some(item => item.type === "commandExecution" && item.status === "completed"
      && item.exitCode === 0 && typeof item.command === "string" && item.command.includes("input.txt")
      && typeof item.aggregatedOutput === "string" && item.aggregatedOutput.includes(marker));
    if (!read) throw new Error(`Slot ${slot} ${step.tier} has no successful exact file-read receipt`);
  }
  if (step.kind === "coding") {
    if (readFileSync(join(owner.workspace, "result.txt"), "utf8") !== `${marker}: verified\n`
      || !outcome.toolItems.some(item => item.type === "commandExecution" && item.status === "completed"
        && typeof item.command === "string" && item.command.includes("result.txt"))) {
      throw new Error(`Slot ${slot} coding file or verification command mismatch`);
    }
  }
  if (!concurrent) {
    const response = await fetch(backendUrl);
    const health = await response.json() as { web_readiness?: { status?: string; last_successful_turn_at?: string | null; last_successful_model?: string | null; last_successful_effort?: string | null } };
    const route = requireChatGptWebModelRoute(`chatgpt-web/${step.tier}`, config);
    const ready = health.web_readiness;
    if (ready?.status !== "ready" || !ready.last_successful_turn_at || Date.parse(ready.last_successful_turn_at) < startedAt
      || ready.last_successful_model !== route.backendModel || ready.last_successful_effort !== route.adapterEffort) {
      throw new Error(`Slot ${slot} ${step.tier} lacks matching browser model/effort evidence`);
    }
  }
  passed += 1;
  record({ type: "round", slot, at: new Date(startedAt).toISOString(), ended_at: new Date().toISOString(),
    tier: step.tier, kind: step.kind, thread_id: owner.threadId, turn_id: evidence.turnId,
    answer_sha256: createHash("sha256").update(answer).digest("hex"), status: "passed", bundle_id: bundleId });
}

let failure: unknown;
try {
  let lastSlotFinishedAt = 0;
  for (const [index, steps] of slots.entries()) {
    // Pace from the previous completed slot. If macOS sleeps, wakeup cannot run missed slots in
    // a burst and create a new Cloudflare rate block.
    const nextAt = lastSlotFinishedAt + SLOT_GAP_MS;
    if (index > 0 && nextAt > Date.now()) await Bun.sleep(nextAt - Date.now());
    const results = await Promise.allSettled(steps.map(step => runStep(step, index + 1, steps.length > 1)));
    const rejected = results.find(result => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    lastSlotFinishedAt = Date.now();
  }
  if (passed !== EXPECTED_ROUNDS || Date.now() - beganAt < DURATION_MS) {
    throw new Error(`Stability run ended early: passed=${passed}, elapsedMs=${Date.now() - beganAt}`);
  }
  const finalGateway = await (await fetch(gatewayUrl)).json() as { build?: { bundleId?: string } };
  const finalBackend = await (await fetch(backendUrl)).json() as { build?: { bundleId?: string } };
  if (finalGateway.build?.bundleId !== gatewayBundleId
    || (finalGateway as { backend_build?: { bundleId?: string } }).backend_build?.bundleId !== bundleId
    || finalBackend.build?.bundleId !== bundleId) {
    throw new Error("Gateway or candidate backend identity changed during stability run");
  }
} catch (error) {
  failure = error;
} finally {
  const stderr = await Promise.all([...owners.values()].map(async owner => {
    try { return await owner.client.close(); }
    finally { rmSync(owner.workspace, { recursive: true, force: true }); }
  }));
  if (stderr.some(chunk => /stream disconnected - retrying sampling request/.test(chunk))) {
    failure ??= new Error("A Codex turn required an implicit sampling retry");
  }
}
if (failure) {
  record({ type: "failed", at: new Date().toISOString(), passed_rounds: passed, elapsed_ms: Date.now() - beganAt, error: String(failure) });
  throw failure;
}
record({ type: "complete", at: new Date().toISOString(), passed_rounds: passed, elapsed_ms: Date.now() - beganAt, bundle_id: bundleId });
process.stdout.write(`RETAINED_STABILITY_OK rounds=${passed} elapsedMs=${Date.now() - beganAt} bundleId=${bundleId}\n`);
