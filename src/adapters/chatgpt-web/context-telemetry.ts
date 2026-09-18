/**
 * Whether a turn that was sent an incomplete packet went and read the rest.
 *
 * A compact bootstrap sends the current task and the exchange before it, and leaves everything
 * earlier canonical in the Codex Runtime for the model to retrieve through `codex_context_search`
 * and `codex_context_read`. That trade is only sound if the retrieval actually happens, and nothing
 * measured whether it did: a turn where the model answered from the packet alone and a turn where
 * it read what it needed looked identical from here.
 *
 * They are not identical to the person reading the answer. One live turn asked about a book named
 * eighty times in the stored conversation; the model searched once, missed, went through the
 * filesystem instead, and answered about three unrelated books. The bridge held the answer the
 * whole time and said nothing, because it had nothing to say it with.
 *
 * `omitted_without_retrieval` is the count that makes that visible. It is a signal rather than a
 * verdict — a follow-up can be answerable from the packet alone, and then not retrieving is
 * correct — so it is reported next to the totals it is drawn from rather than as a failure.
 */

export interface ChatGptContextTelemetrySnapshot {
  /**
   * Turns that answered from a packet which left earlier records to retrieval. Turns that failed
   * before the model replied are not counted: they cannot have retrieved anything, and counting
   * them made an upstream capacity refusal read as a model trusting an incomplete packet.
   */
  omitted_turns: number;
  /** Records those turns left out, summed. */
  omitted_records: number;
  /** Of those turns, the ones that made at least one retrieval call. */
  retrieved_turns: number;
  /** `codex_context_search` and `codex_context_read` calls, across all turns. */
  searches: number;
  reads: number;
  /**
   * Turns handed an incomplete packet that answered without reading any of the rest. High counts
   * mean the compact packet is being trusted as if it were complete.
   */
  omitted_without_retrieval: number;
}

let omittedTurns = 0;
let omittedRecords = 0;
let retrievedTurns = 0;
let searches = 0;
let reads = 0;

/**
 * Turns still open, and whether each has retrieved anything yet. Bounded because a turn that never
 * concludes — a crash, a lost page — must not accumulate here forever.
 */
const MAX_TRACKED_TURNS = 256;
const openTurns = new Map<string, { omitted: number; retrieved: boolean }>();

export function chatGptContextTelemetrySnapshot(): ChatGptContextTelemetrySnapshot {
  return {
    omitted_turns: omittedTurns,
    omitted_records: omittedRecords,
    retrieved_turns: retrievedTurns,
    searches,
    reads,
    omitted_without_retrieval: omittedTurns - retrievedTurns,
  };
}

/** Test seam. Process-wide totals are cumulative for the life of a daemon. */
export function resetChatGptContextTelemetry(): void {
  omittedTurns = 0;
  omittedRecords = 0;
  retrievedTurns = 0;
  searches = 0;
  reads = 0;
  openTurns.clear();
}

/** A turn was sent a packet that left `omitted` earlier records behind. */
export function recordChatGptContextOmitted(traceId: string, omitted: number): void {
  if (omitted <= 0) return;
  openTurns.set(traceId, { omitted, retrieved: false });
  if (openTurns.size > MAX_TRACKED_TURNS) {
    const oldest = openTurns.keys().next();
    if (!oldest.done) openTurns.delete(oldest.value);
  }
}

/** The turn read some of what its packet left out. Counted once per turn, however many calls. */
export function recordChatGptContextRetrieval(traceId: string, action: "search" | "read"): void {
  if (action === "search") searches += 1;
  else reads += 1;
  const open = openTurns.get(traceId);
  if (open) open.retrieved = true;
}

/**
 * Settle a turn that answered, and return the line describing its trade.
 *
 * Counting happens here rather than when the packet was built, because a turn that never reached
 * the model cannot have retrieved anything. Counting at build time made the first two turns this
 * shipped with — both refused upstream for capacity before generation began — read as two turns
 * that trusted an incomplete packet, which is the opposite of what happened. The question this
 * answers is only about turns that produced an answer: when the model replied, had it read what it
 * was not sent.
 */
export function chatGptContextLog(traceId: string): string | undefined {
  const open = openTurns.get(traceId);
  if (!open) return undefined;
  openTurns.delete(traceId);
  omittedTurns += 1;
  omittedRecords += open.omitted;
  if (open.retrieved) retrievedTurns += 1;
  return `[chatgpt-web] context trace=${traceId} omittedRecords=${open.omitted} retrieved=${open.retrieved}`;
}
