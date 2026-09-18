/**
 * What happened to a compaction round, from the request that asked for one to the summary that
 * reached — or did not reach — whoever was waiting.
 *
 * A compaction that produced a correct summary and delivered it to nobody looked, from every log
 * this daemon kept, exactly like one that worked. Observed live: the round ran for four and a half
 * minutes, the browser turn completed, the two readings of it agreed character for character, and
 * the caller had already given up. The only trace was an absence — no further response was ever
 * recorded — and the branch that discarded the result rethrew without saying anything.
 *
 * The expensive part of a compaction is the browser round, and it is shared: a caller that detaches
 * does not cancel it, and a canonical reconnect can still collect the result. So a detached caller
 * is not by itself a failure. It is only unobservable, which is worse, because the first sign of it
 * is a user reporting that compaction "failed" with nothing on disk that agrees.
 */

export type ChatGptCompactionMode = "retained" | "fresh";

export interface ChatGptCompactionTelemetrySnapshot {
  /** Rounds that ran a browser turn. */
  rounds: number;
  /** Of those, the ones that could not use a retained conversation and summarised from scratch. */
  fresh_rounds: number;
  /** Why a round had to be fresh, counted by reason. */
  fresh_reasons: Record<string, number>;
  /** Rounds whose summary was handed to the caller that asked for it. */
  delivered: number;
  /** Rounds that produced a summary nobody was still waiting for. */
  abandoned: number;
  /** Rounds that failed to produce a summary at all. */
  failed: number;
  /** Longest round observed, in milliseconds. A caller's patience is finite and this is what it faces. */
  longest_ms: number;
}

let rounds = 0;
let freshRounds = 0;
let delivered = 0;
let abandoned = 0;
let failed = 0;
let longestMs = 0;
const freshReasons = new Map<string, number>();

/** Rounds in flight, bounded so a round that never settles cannot accumulate forever. */
const MAX_TRACKED_ROUNDS = 64;
const openRounds = new Map<string, { startedAt: number; mode: ChatGptCompactionMode }>();

export function chatGptCompactionTelemetrySnapshot(): ChatGptCompactionTelemetrySnapshot {
  return {
    rounds,
    fresh_rounds: freshRounds,
    fresh_reasons: Object.fromEntries([...freshReasons].sort(([a], [b]) => a.localeCompare(b))),
    delivered,
    abandoned,
    failed,
    longest_ms: longestMs,
  };
}

/** Test seam. Process-wide totals are cumulative for the life of a daemon. */
export function resetChatGptCompactionTelemetry(): void {
  rounds = 0;
  freshRounds = 0;
  delivered = 0;
  abandoned = 0;
  failed = 0;
  longestMs = 0;
  freshReasons.clear();
  openRounds.clear();
}

export function recordChatGptCompactionStarted(key: string, mode: ChatGptCompactionMode, now = Date.now()): void {
  rounds += 1;
  if (mode === "fresh") freshRounds += 1;
  openRounds.set(key, { startedAt: now, mode });
  if (openRounds.size > MAX_TRACKED_ROUNDS) {
    const oldest = openRounds.keys().next();
    if (!oldest.done) openRounds.delete(oldest.value);
  }
}

/** Why a retained round was not possible. Counted apart from the round itself so it can be read alone. */
export function recordChatGptCompactionFreshReason(reason: string): void {
  freshReasons.set(reason, (freshReasons.get(reason) ?? 0) + 1);
}

export type ChatGptCompactionOutcome = "delivered" | "abandoned" | "failed";

/** Settle a round and return the line describing it, or undefined when the round was not tracked. */
export function recordChatGptCompactionSettled(
  key: string,
  outcome: ChatGptCompactionOutcome,
  summaryChars: number,
  now = Date.now(),
): string | undefined {
  if (outcome === "delivered") delivered += 1;
  else if (outcome === "abandoned") abandoned += 1;
  else failed += 1;
  const open = openRounds.get(key);
  if (!open) return undefined;
  openRounds.delete(key);
  const elapsed = Math.max(0, now - open.startedAt);
  longestMs = Math.max(longestMs, elapsed);
  return `[chatgpt-web] compaction ${outcome} mode=${open.mode} durationMs=${elapsed} summaryChars=${summaryChars}`;
}
