import type { ChatGptConversationKeyComponents } from "./conversation-key";

/**
 * Why a turn that expected to reuse a retained ChatGPT conversation did not get one. Every miss
 * costs a full bootstrap, so hit rate is the largest lever on transport cost — but only if a miss
 * is observed and attributed rather than inferred from the size of a prompt.
 */
export type ChatGptRetainedMissCause =
  | "first_turn"
  | "model_changed"
  | "reasoning_changed"
  | "system_prompt_changed"
  | "compaction_epoch_changed"
  | "conversation_lost";

/** Why retention was never attempted. These are by-design exclusions, not cache misses. */
export type ChatGptRetainedIneligibleCause =
  | "compaction_request"
  | "rolling_checkpoint_model"
  | "no_local_tools"
  | "no_retained_launcher"
  | "no_thread_identity";

export type ChatGptRetainedOutcome =
  | { kind: "hit" }
  | { kind: "miss"; causes: ChatGptRetainedMissCause[] };

// Bounded so a long-lived daemon cannot accumulate one entry per thread it has ever served.
const MAX_TRACKED_THREADS = 256;
const lastComponents = new Map<string, ChatGptConversationKeyComponents>();

/**
 * Process-wide totals behind `/healthz`. Per-turn causes answer "why did this miss"; these answer
 * "how often, and for which reason" without reading them back out of a log.
 */
export interface ChatGptRetainedTelemetrySnapshot {
  hits: number;
  misses: number;
  /** hits / (hits + misses), or null before any turn expected retention. Excludes ineligible turns. */
  hit_rate: number | null;
  miss_causes: Record<string, number>;
  /**
   * Misses that nothing about the design explains. A hit rate on its own has no target, because
   * most misses are correct: a thread has to start, a new epoch has to open a new chat, and a user
   * switching model or reasoning should rotate the conversation. Only a key that did not change
   * while its conversation disappeared indicates a defect, so this is the number with a target,
   * and the target is zero.
   */
  unexplained_misses: number;
  /** By-design exclusions. Not cache misses, so deliberately outside the rate. */
  ineligible: number;
  ineligible_causes: Record<string, number>;
}

/** The one miss cause that is not a consequence of how the system is meant to work. */
const UNEXPLAINED_MISS_CAUSES = new Set<ChatGptRetainedMissCause>(["conversation_lost"]);

let hits = 0;
let misses = 0;
let ineligible = 0;
const missCauses = new Map<ChatGptRetainedMissCause, number>();
const ineligibleCauses = new Map<ChatGptRetainedIneligibleCause, number>();

function tally<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function asRecord<K extends string>(counts: Map<K, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

export function chatGptRetainedTelemetrySnapshot(): ChatGptRetainedTelemetrySnapshot {
  const expected = hits + misses;
  return {
    hits,
    misses,
    hit_rate: expected === 0 ? null : Math.round((hits / expected) * 1_000) / 1_000,
    miss_causes: asRecord(missCauses),
    unexplained_misses: [...UNEXPLAINED_MISS_CAUSES]
      .reduce((total, cause) => total + (missCauses.get(cause) ?? 0), 0),
    ineligible,
    ineligible_causes: asRecord(ineligibleCauses),
  };
}

/** Counted separately from outcomes: retention was never attempted, so it cannot have missed. */
export function recordChatGptRetainedIneligible(cause: ChatGptRetainedIneligibleCause): void {
  ineligible += 1;
  tally(ineligibleCauses, cause);
}

function remember(components: ChatGptConversationKeyComponents): void {
  const { threadId } = components;
  // Re-insert so the map stays in least-recently-used order for eviction.
  lastComponents.delete(threadId);
  lastComponents.set(threadId, components);
  while (lastComponents.size > MAX_TRACKED_THREADS) {
    const oldest = lastComponents.keys().next();
    if (oldest.done) break;
    lastComponents.delete(oldest.value);
  }
}

function rotatedCauses(
  previous: ChatGptConversationKeyComponents,
  current: ChatGptConversationKeyComponents,
): ChatGptRetainedMissCause[] {
  const causes: ChatGptRetainedMissCause[] = [];
  if (previous.model !== current.model) causes.push("model_changed");
  if (previous.reasoning !== current.reasoning) causes.push("reasoning_changed");
  if (previous.systemPrompt !== current.systemPrompt) causes.push("system_prompt_changed");
  if (previous.compaction !== current.compaction) causes.push("compaction_epoch_changed");
  return causes;
}

/**
 * Record the outcome of a turn that expected a retained conversation. A miss whose key components
 * all match the previous turn's was not caused by rotation: the browser surface itself is gone.
 */
export function recordChatGptRetainedOutcome(
  components: ChatGptConversationKeyComponents,
  reused: boolean,
): ChatGptRetainedOutcome {
  const previous = lastComponents.get(components.threadId);
  remember(components);
  if (reused) {
    hits += 1;
    return { kind: "hit" };
  }
  misses += 1;
  const causes = previous
    ? (() => {
      const rotated = rotatedCauses(previous, components);
      return rotated.length > 0 ? rotated : (["conversation_lost"] as ChatGptRetainedMissCause[]);
    })()
    : (["first_turn"] as ChatGptRetainedMissCause[]);
  for (const cause of causes) tally(missCauses, cause);
  return { kind: "miss", causes };
}

/** Test seam: the tracker is process-wide state shared by every thread the daemon serves. */
export function resetChatGptRetainedTelemetry(): void {
  lastComponents.clear();
  hits = 0;
  misses = 0;
  ineligible = 0;
  missCauses.clear();
  ineligibleCauses.clear();
}

function threadTag(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 12)}…` : threadId;
}

export function chatGptRetainedOutcomeLog(
  outcome: ChatGptRetainedOutcome,
  components: ChatGptConversationKeyComponents,
): string {
  const thread = `thread=${threadTag(components.threadId)}`;
  return outcome.kind === "hit"
    ? `[chatgpt-web] retained_conversation hit ${thread}`
    : `[chatgpt-web] retained_conversation miss cause=${outcome.causes.join("+")} ${thread}`;
}

export function chatGptRetainedIneligibleLog(
  cause: ChatGptRetainedIneligibleCause,
  threadId: string | undefined,
): string {
  const thread = threadId ? ` thread=${threadTag(threadId)}` : "";
  return `[chatgpt-web] retained_conversation ineligible cause=${cause}${thread}`;
}
