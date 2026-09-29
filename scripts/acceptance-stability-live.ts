import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/config";

type Round = { model: string; mode?: "tool" | "image" | "coding" | "continuity" | "compaction" | "lost-session"; marker?: string };
const slots: Round[][] = [
  [{ model: "light", mode: "tool" }],
  [{ model: "medium" }],
  [{ model: "high", mode: "image" }],
  [{ model: "extra-high", mode: "tool" }],
  [{ model: "high" }],
  [{ model: "light", mode: "continuity" }],
  [{ model: "medium", mode: "coding" }],
  [{ model: "light", marker: "STABILITY_LIME_618" }, { model: "high", marker: "STABILITY_NAVY_274" }],
  [{ model: "extra-high" }],
  [{ model: "medium", mode: "compaction" }],
  [{ model: "high", mode: "lost-session" }],
  [{ model: "medium", mode: "tool" }],
  [{ model: "high" }],
];
const expectedRounds = slots.flat().reduce((sum, round) => sum + (["continuity", "compaction", "lost-session"].includes(round.mode ?? "") ? 3 : 1), 0);
if (expectedRounds !== 20) throw new Error(`Stability plan counts ${expectedRounds} rather than 20 real rounds`);
const durationMs = 120 * 60_000;
const args = process.argv.slice(2);
const recordFlag = args.indexOf("--record");
const record = resolve(recordFlag >= 0 ? args[recordFlag + 1] ?? "" : "output/web-recovery-stability.jsonl");
if (recordFlag >= 0 && (!args[recordFlag + 1] || args[recordFlag + 1]!.startsWith("--"))) throw new Error("--record requires a path");
if (args.includes("--plan")) {
  process.stdout.write(`${JSON.stringify({ duration_minutes: 120, expected_rounds: expectedRounds, slots }, null, 2)}\n`);
  process.exit(0);
}
if (!args.includes("--run")) throw new Error("Pass --plan or --run; live acceptance never starts implicitly");
const config = loadConfig();
const gatewayUrl = `http://${config.host}:${config.nativeGatewayPort}/healthz`;
const backendUrl = `http://${config.host}:${config.port}/healthz`;
const health = await (await fetch(gatewayUrl, { signal: AbortSignal.timeout(3_000) })).json() as {
  build?: { bundleId?: string }; backend_build?: { bundleId?: string };
};
const backend = await (await fetch(backendUrl, { signal: AbortSignal.timeout(3_000) })).json() as {
  build?: { bundleId?: string; version?: string };
};
const gatewayBundleId = health.build?.bundleId;
const bundleId = backend.build?.bundleId;
if (!gatewayBundleId || !bundleId || backend.build?.version !== config.releaseVersion
  || health.backend_build?.bundleId !== bundleId) {
  throw new Error("Installed backend identity does not match the configured candidate and gateway route");
}
mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
const write = (event: Record<string, unknown>): void => appendFileSync(record, `${JSON.stringify(event)}\n`, { mode: 0o600 });
const beganAt = Date.now();
write({ type: "start", at: new Date(beganAt).toISOString(), version: config.releaseVersion,
  bundle_id: bundleId, gateway_bundle_id: gatewayBundleId, expected_rounds: expectedRounds, duration_minutes: 120 });
let completedRounds = 0;

async function runRound(round: Round, slot: number): Promise<void> {
  const command = [process.execPath, resolve("scripts/smoke-installed.ts"), "--live-model", `chatgpt-web/${round.model}`];
  if (round.mode === "tool") command.push("--live-tool-read");
  if (round.mode === "image") command.push("--live-image");
  if (round.mode === "coding") command.push("--live-workspace-task");
  if (round.mode === "continuity" || round.mode === "compaction" || round.mode === "lost-session") command.push("--live-continuity");
  if (round.mode === "compaction" || round.mode === "lost-session") command.push("--live-compact");
  if (round.mode === "lost-session") command.push("--live-lost-session");
  if (round.marker) command.push("--prompt", `Reply with ${round.marker} only.`, "--expect-text", round.marker);
  const startedAt = Date.now();
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const retries = /stream disconnected - retrying sampling request/.test(stderr);
  let result: { ok?: boolean; liveTurn?: { model?: string; status?: string; turn_id?: string; continuity?: { rounds?: unknown[]; compacted_mode?: string; backend_restarted?: boolean }; tool_read?: { verified?: boolean }; image_input?: { verified?: boolean }; workspace_task?: { verified?: boolean } } } | undefined;
  try { result = JSON.parse(stdout); } catch { /* failure is reported below */ }
  const roundCount = ["continuity", "compaction", "lost-session"].includes(round.mode ?? "") ? 3 : 1;
  const valid = exitCode === 0 && !retries && result?.ok === true
    && result.liveTurn?.model === `chatgpt-web/${round.model}` && result.liveTurn.status === "completed"
    && (roundCount === 1 || result.liveTurn.continuity?.rounds?.length === 3)
    && (round.mode !== "compaction" || result.liveTurn.continuity?.compacted_mode === "retained")
    && (round.mode !== "lost-session" || (result.liveTurn.continuity?.compacted_mode === "fresh" && result.liveTurn.continuity.backend_restarted === true))
    && (round.mode !== "tool" || result.liveTurn.tool_read?.verified === true)
    && (round.mode !== "image" || result.liveTurn.image_input?.verified === true)
    && (round.mode !== "coding" || result.liveTurn.workspace_task?.verified === true);
  write({ type: "round", slot, at: new Date(startedAt).toISOString(), ended_at: new Date().toISOString(), model: round.model,
    mode: round.mode ?? "answer", turn_id: result?.liveTurn?.turn_id ?? null, rounds: valid ? roundCount : 0,
    status: valid ? "passed" : "failed", exit_code: exitCode, implicit_retry: retries,
    failure: valid ? undefined : stderr.slice(-500), bundle_id: bundleId });
  if (!valid) throw new Error(`Stability slot ${slot} ${round.model} failed (exit=${exitCode}, retry=${retries}); see ${record}`);
  completedRounds += roundCount;
}

try {
  for (const [index, rounds] of slots.entries()) {
    const target = beganAt + Math.ceil(durationMs * index / (slots.length - 1));
    const wait = target - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    await Promise.all(rounds.map(round => runRound(round, index + 1)));
  }
  if (completedRounds !== expectedRounds || Date.now() - beganAt < durationMs) {
    throw new Error(`Stability gate ended early: rounds=${completedRounds}, elapsedMs=${Date.now() - beganAt}`);
  }
  const finalHealth = await (await fetch(gatewayUrl, { signal: AbortSignal.timeout(3_000) })).json() as { build?: { bundleId?: string } };
  const finalBackend = await (await fetch(backendUrl, { signal: AbortSignal.timeout(3_000) })).json() as { build?: { bundleId?: string } };
  if (finalHealth.build?.bundleId !== gatewayBundleId
    || (finalHealth as { backend_build?: { bundleId?: string } }).backend_build?.bundleId !== bundleId
    || finalBackend.build?.bundleId !== bundleId) {
    throw new Error("Gateway or candidate backend identity changed during the stability window");
  }
  write({ type: "complete", at: new Date().toISOString(), passed_rounds: completedRounds, elapsed_ms: Date.now() - beganAt, bundle_id: bundleId });
  process.stdout.write(`STABILITY_LIVE_OK rounds=${completedRounds} elapsedMs=${Date.now() - beganAt} bundleId=${bundleId}\n`);
} catch (error) {
  write({ type: "failed", at: new Date().toISOString(), passed_rounds: completedRounds, elapsed_ms: Date.now() - beganAt, error: String(error) });
  throw error;
}
