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
 *
 * Having called search is not the same as having found anything, and that turn proves it: the call
 * happened and `retrieved_turns` would have counted it. `search_zero_matches` and
 * `search_without_followup_read` separate a retrieval that worked from one that only occurred. A
 * search that matches nothing, or that the model never follows with a read, is the shape of a turn
 * that asked the history a question and then went somewhere else for the answer.
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
  /** Searches that matched no canonical record. */
  search_zero_matches: number;
  /**
   * Searches a turn never followed with a read. The model located records and then did not open
   * any of them, which is how a retrieval that ran still leaves the answer unread.
   */
  search_without_followup_read: number;
}

let omittedTurns = 0;
let omittedRecords = 0;
let retrievedTurns = 0;
let searches = 0;
let reads = 0;
let searchZeroMatches = 0;
let searchWithoutFollowupRead = 0;

interface OpenTurn {
  omitted: number;
  retrieved: boolean;
  /** Searches since the last read. Folded into the total when the turn answers. */
  pendingSearches: number;
}

/**
 * Turns still open, and whether each has retrieved anything yet. Bounded because a turn that never
 * concludes — a crash, a lost page — must not accumulate here forever.
 */
const MAX_TRACKED_TURNS = 256;
const openTurns = new Map<string, OpenTurn>();

function trackTurn(traceId: string, open: OpenTurn): OpenTurn {
  openTurns.set(traceId, open);
  if (openTurns.size > MAX_TRACKED_TURNS) {
    const oldest = openTurns.keys().next();
    if (!oldest.done) openTurns.delete(oldest.value);
  }
  return open;
}

export function chatGptContextTelemetrySnapshot(): ChatGptContextTelemetrySnapshot {
  return {
    omitted_turns: omittedTurns,
    omitted_records: omittedRecords,
    retrieved_turns: retrievedTurns,
    searches,
    reads,
    omitted_without_retrieval: omittedTurns - retrievedTurns,
    search_zero_matches: searchZeroMatches,
    search_without_followup_read: searchWithoutFollowupRead,
  };
}

/** Test seam. Process-wide totals are cumulative for the life of a daemon. */
export function resetChatGptContextTelemetry(): void {
  omittedTurns = 0;
  omittedRecords = 0;
  retrievedTurns = 0;
  searches = 0;
  reads = 0;
  searchZeroMatches = 0;
  searchWithoutFollowupRead = 0;
  openTurns.clear();
}

/** A turn was sent a packet that left `omitted` earlier records behind. */
export function recordChatGptContextOmitted(traceId: string, omitted: number): void {
  if (omitted <= 0) return;
  // A retried attempt re-sends the packet, so it replaces the discarded attempt's record rather
  // than adding to it: what an abandoned attempt retrieved says nothing about the answer that ships.
  trackTurn(traceId, { omitted, retrieved: false, pendingSearches: 0 });
}

/**
 * The turn read some of what its packet left out. Counted once per turn, however many calls.
 *
 * `matches` is the number of canonical records a search located; omit it for a read.
 */
export function recordChatGptContextRetrieval(
  traceId: string,
  action: "search" | "read",
  matches?: number,
): void {
  if (action === "search") {
    searches += 1;
    if (matches === 0) searchZeroMatches += 1;
  } else reads += 1;
  // A turn sent a complete packet can still search, and whether that search led anywhere is the
  // same question. It has no omission to report, so it is tracked with `omitted` at zero.
  const open = openTurns.get(traceId)
    ?? trackTurn(traceId, { omitted: 0, retrieved: false, pendingSearches: 0 });
  open.retrieved = true;
  if (action === "search") open.pendingSearches += 1;
  else open.pendingSearches = 0;
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
  searchWithoutFollowupRead += open.pendingSearches;
  // A turn that was sent everything has no trade to report. Its searches are still counted above,
  // because looking for something the packet already held is its own signal.
  if (open.omitted <= 0) return undefined;
  omittedTurns += 1;
  omittedRecords += open.omitted;
  if (open.retrieved) retrievedTurns += 1;
  return `[chatgpt-web] context trace=${traceId} omittedRecords=${open.omitted} retrieved=${open.retrieved}`;
}
