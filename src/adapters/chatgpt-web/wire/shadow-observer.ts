import type { Page } from "playwright-core";
import { observeWireStream, type ChatGptWireObservation } from "./turn-observation";
import { buildWireTranscript, wireTranscriptsEnabled, writeWireTranscript } from "./transcript-store";
import { ChatGptWireCollector, type ChatGptWireStream } from "./wire-collector";
import { attachChatGptWireTap } from "./wire-tap-host";

/**
 * Runs the wire observer alongside the DOM one without giving it any authority.
 *
 * The DOM path decides every turn exactly as before. This watches the same turn over ChatGPT's own
 * transport and records where the two disagree. Until that disagreement rate is known and
 * understood, moving decisions to the wire would be a guess; measuring first is what makes the move
 * afterwards an informed one rather than a second act of faith.
 *
 * The comparison is deliberately shaped around the failure that motivated it: a DOM classification
 * error returns an empty answer without raising anything, so "the DOM saw nothing and the wire saw
 * a reply" is called out as its own outcome rather than folded into a generic mismatch.
 */

/** Normalised lengths closer than this ratio count as agreement; the two paths format Markdown differently. */
const LENGTH_AGREEMENT_RATIO = 0.8;

export type ChatGptWireComparison =
  | "agreed"
  /** The DOM produced nothing while the wire carried a reply: the silent-failure signature. */
  | "dom_empty"
  /** The wire produced nothing the DOM did find, which means this observer is still missing something. */
  | "wire_empty"
  | "length_mismatch"
  | "error_mismatch"
  /** No conversation stream was observed at all, so there was nothing to compare. */
  | "not_observed";

export interface ChatGptWireTelemetrySnapshot {
  /** Turns where the observer was attached. */
  turns_observed: number;
  /** Turns where a conversation stream was actually seen. */
  streams_observed: number;
  comparisons: Record<ChatGptWireComparison, number>;
  /**
   * Frames whose shape this build does not recognise. The private payload schema is the one moving
   * part above framing, so this is the number that says whether the understanding still holds.
   * The target is zero.
   */
  unrecognized_frames: number;
  /** Shapes behind those frames, named by their keys so they can be implemented rather than guessed at. */
  unrecognized_shapes: string[];
  /** Patches the fold could not apply. Also targets zero. */
  unapplied_deltas: number;
  /** Taps that could not be installed. A refusal degrades to no observation, never to a failed turn. */
  attach_failures: number;
  /** Records the page sent that this host refused as malformed. */
  rejected_records: number;
  /**
   * Backend-API paths observed during turns, without query strings. Naming the conversation
   * endpoint in advance would make a renamed one indistinguishable from a turn that produced
   * nothing, so the endpoint is discovered here instead of assumed.
   */
  observed_paths: string[];
  /** Of those, the ones that actually carried event-stream frames. This is where a turn's answer travels. */
  streaming_paths: string[];
  /** Control envelope types seen, so a new one is visible before it becomes a missing fact. */
  control_types: string[];
  /**
   * Event-stream observations dropped by retention. Ordinary requests are evicted first, so a
   * non-zero value means a turn's own stream was lost rather than never seen. Targets zero.
   */
  evicted_with_frames: number;
  /**
   * Turns whose two readings were character-for-character identical after whitespace folding.
   * `agreed` only means the lengths are within 20% of each other, which was enough to hide a fold
   * that returned a turn's progress narration along with its answer. Exactness is the measure a
   * cutover needs; agreement is the measure that a turn was not lost.
   */
  exact: number;
  /**
   * Turns the DOM read as empty where the wire held a complete answer and the observation was
   * used instead. This is the failure the whole layer exists to catch, so it is counted rather
   * than only logged.
   */
  dom_rescues: number;
  /**
   * Failed turns reported with ChatGPT's own words instead of an inference drawn from the page.
   */
  server_statements: number;
}

const MAX_TRACKED_SHAPES = 32;
const MAX_TRACKED_PATHS = 48;
/**
 * Traces whose latest outcome is remembered so a retried turn counts once. A turn can make several
 * browser attempts, each concluding separately; counting all of them made the failing attempts of
 * one turn look like several disagreeing turns, and the share is the number a cutover is judged on.
 */
const MAX_TRACKED_TRACES = 256;

let turnsObserved = 0;
let streamsObserved = 0;
let unrecognizedFrames = 0;
let unappliedDeltas = 0;
let attachFailures = 0;
let rejectedRecords = 0;
let evictedWithFrames = 0;
let exactMatches = 0;
let domRescues = 0;
let serverStatements = 0;
const lastComparisonByTrace = new Map<string, ChatGptWireComparison>();
const unrecognizedShapes = new Set<string>();
const observedPaths = new Set<string>();
const streamingPaths = new Set<string>();
const controlTypes = new Set<string>();
const comparisons: Record<ChatGptWireComparison, number> = {
  agreed: 0,
  dom_empty: 0,
  wire_empty: 0,
  length_mismatch: 0,
  error_mismatch: 0,
  not_observed: 0,
};

export function chatGptWireTelemetrySnapshot(): ChatGptWireTelemetrySnapshot {
  return {
    turns_observed: turnsObserved,
    streams_observed: streamsObserved,
    comparisons: { ...comparisons },
    unrecognized_frames: unrecognizedFrames,
    unrecognized_shapes: [...unrecognizedShapes].sort(),
    unapplied_deltas: unappliedDeltas,
    attach_failures: attachFailures,
    rejected_records: rejectedRecords,
    observed_paths: [...observedPaths].sort(),
    streaming_paths: [...streamingPaths].sort(),
    control_types: [...controlTypes].sort(),
    evicted_with_frames: evictedWithFrames,
    exact: exactMatches,
    dom_rescues: domRescues,
    server_statements: serverStatements,
  };
}

/**
 * Record a turn's outcome, replacing whatever that trace last reported.
 *
 * A retried turn concludes once per browser attempt. Counting each attempt turned one turn that
 * eventually succeeded into two failures and a success, which is not what the share of agreeing
 * turns is meant to say.
 */
function recordComparison(traceId: string, comparison: ChatGptWireComparison): void {
  const previous = lastComparisonByTrace.get(traceId);
  if (previous !== undefined) comparisons[previous] -= 1;
  comparisons[comparison] += 1;
  lastComparisonByTrace.set(traceId, comparison);
  // Forgetting the oldest trace only stops it from being corrected later; its count stays.
  if (lastComparisonByTrace.size > MAX_TRACKED_TRACES) {
    const oldest = lastComparisonByTrace.keys().next();
    if (!oldest.done) lastComparisonByTrace.delete(oldest.value);
  }
}

/** Test seam. Process-wide totals are cumulative for the life of a daemon. */
export function resetChatGptWireTelemetry(): void {
  turnsObserved = 0;
  streamsObserved = 0;
  unrecognizedFrames = 0;
  unappliedDeltas = 0;
  attachFailures = 0;
  rejectedRecords = 0;
  evictedWithFrames = 0;
  exactMatches = 0;
  domRescues = 0;
  serverStatements = 0;
  lastComparisonByTrace.clear();
  unrecognizedShapes.clear();
  observedPaths.clear();
  streamingPaths.clear();
  controlTypes.clear();
  for (const key of Object.keys(comparisons) as ChatGptWireComparison[]) comparisons[key] = 0;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Path-only, never the query: a conversation URL can carry identifiers. */
export function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export function conversationPath(url: string): boolean {
  return requestPath(url).includes("/conversation");
}

/** Compare the two observations of one turn. Lengths only: the texts themselves are conversation content. */
export function compareWireToDom(
  wire: ChatGptWireObservation | undefined,
  dom: { answer: string; failed: boolean },
): { comparison: ChatGptWireComparison; wireChars: number; domChars: number } {
  if (!wire) return { comparison: "not_observed", wireChars: 0, domChars: normalize(dom.answer).length };
  const wireText = normalize(wire.answer);
  const domText = normalize(dom.answer);
  const result = { wireChars: wireText.length, domChars: domText.length };
  if ((wire.error !== undefined) !== dom.failed) return { comparison: "error_mismatch", ...result };
  if (wireText.length === 0 && domText.length === 0) return { comparison: "agreed", ...result };
  if (domText.length === 0) return { comparison: "dom_empty", ...result };
  if (wireText.length === 0) return { comparison: "wire_empty", ...result };
  const ratio = Math.min(wireText.length, domText.length) / Math.max(wireText.length, domText.length);
  return { comparison: ratio >= LENGTH_AGREEMENT_RATIO ? "agreed" : "length_mismatch", ...result };
}

export interface ChatGptWireShadowResult {
  comparison: ChatGptWireComparison;
  wireChars: number;
  domChars: number;
  observation?: ChatGptWireObservation;
  transcriptPath?: string;
  /**
   * The answer to return in place of the DOM's, when the DOM found none and the wire observed a
   * complete one. Absent in every other case, including every case where the DOM produced text —
   * so this can rescue a turn that already failed and cannot change one that worked.
   */
  rescuedAnswer?: string;
  /**
   * What ChatGPT itself said went wrong, when the turn failed and the stream carried a reason.
   *
   * The DOM path can only see that the page is not in a usable state and has to infer why. One real
   * failure was an upstream capacity limit that it read as an expired login — a message that sends
   * the reader to log in again for no reason. The server's own statement is not an inference.
   */
  serverError?: string;
}

/**
 * Whether this observation is complete enough to stand in for a DOM reading that found nothing.
 *
 * A turn that produced no answer is already a failure, so the only question is whether the wire's
 * reading is trustworthy on its own. It is required to be a finished stream — the server marked a
 * message as ending the turn *and* the stream reached its terminal sentinel — with nothing the fold
 * failed to understand. A partial read substituted here would turn a visible failure into a
 * plausible wrong answer, which is worse than the failure.
 */
function completeEnoughToRescue(wire: ChatGptWireObservation): boolean {
  return wire.error === undefined
    && wire.endedTurn
    && wire.sawDone
    && wire.counts.unrecognized === 0
    && wire.unappliedDeltas === 0
    && wire.answer.trim().length > 0;
}

/**
 * One turn's shadow observation. Created per turn because the automatic path opens a fresh page per
 * turn, which makes page, stream, and turn the same thing.
 */
export class ChatGptWireShadowSession {
  private readonly collector = new ChatGptWireCollector();
  private attached = false;
  private rejected: (() => { malformed: number; overflowed: number }) | undefined;

  constructor(
    private readonly traceId: string,
    private readonly transcriptRoot: string,
  ) {}

  /** Install the observer. Never throws: shadow observation must not be able to fail a turn. */
  async attach(page: Page, onFault?: (message: string) => void): Promise<boolean> {
    try {
      const attachment = await attachChatGptWireTap(page, this.collector, onFault);
      this.attached = attachment.attached;
      this.rejected = attachment.rejected;
      if (!attachment.attached) attachFailures += 1;
      else turnsObserved += 1;
      return attachment.attached;
    } catch (error) {
      attachFailures += 1;
      onFault?.(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * The conversation stream this turn produced, if one was observed.
   *
   * The tap watches the whole backend API, so the turn's stream has to be picked out of ordinary
   * page traffic. A path naming a conversation is preferred; otherwise the last stream that
   * actually carried event-stream frames is used, which identifies it by what it did rather than
   * by a path that can be renamed. Last one wins either way: a turn can retry its request, and the
   * final attempt is the one that answered.
   */
  private conversationStream(): ChatGptWireStream | undefined {
    const streams = this.collector.snapshot();
    // Carrying event-stream frames comes first. Selecting by path name instead picked
    // `/f/conversation/prepare` — a small JSON handshake that decodes to no frames — over the
    // request that actually carried the turn, and reported the turn as unobserved while its data
    // sat in the collector. What a request did is the stronger signal than what it is called.
    const streaming = streams.filter(stream => stream.frames.length > 0);
    if (streaming.length > 0) return streaming.at(-1);
    return streams.filter(stream => conversationPath(stream.url)).at(-1);
  }

  /**
   * Fold what was observed and compare it against the DOM's conclusion. Returns the outcome so the
   * caller can log it; nothing here changes what the turn returns.
   */
  conclude(dom: { answer: string; failed: boolean }): ChatGptWireShadowResult {
    try {
      return this.concludeOrThrow(dom);
    } catch {
      // Shadow observation has no authority over a turn, so it must not be able to end one either.
      recordComparison(this.traceId, "not_observed");
      return { comparison: "not_observed", wireChars: 0, domChars: dom.answer.length };
    }
  }

  private concludeOrThrow(dom: { answer: string; failed: boolean }): ChatGptWireShadowResult {
    if (!this.attached) {
      recordComparison(this.traceId, "not_observed");
      return { comparison: "not_observed", wireChars: 0, domChars: dom.answer.length };
    }
    const counts = this.rejected?.();
    if (counts) rejectedRecords += counts.malformed + counts.overflowed;
    evictedWithFrames += this.collector.counts().evictedWithFrames;
    for (const seen of this.collector.snapshot()) {
      const path = requestPath(seen.url);
      if (observedPaths.size < MAX_TRACKED_PATHS) observedPaths.add(path);
      if (seen.frames.length > 0 && streamingPaths.size < MAX_TRACKED_PATHS) streamingPaths.add(path);
    }
    const stream = this.conversationStream();
    const observation = stream ? observeWireStream(stream) : undefined;
    if (observation) {
      streamsObserved += 1;
      unrecognizedFrames += observation.counts.unrecognized;
      unappliedDeltas += observation.unappliedDeltas;
      for (const shape of observation.counts.unrecognizedShapes) {
        if (unrecognizedShapes.size < MAX_TRACKED_SHAPES) unrecognizedShapes.add(shape);
      }
      for (const type of observation.counts.controlTypes) {
        if (controlTypes.size < MAX_TRACKED_SHAPES) controlTypes.add(type);
      }
    }
    const { comparison, wireChars, domChars } = compareWireToDom(observation, dom);
    recordComparison(this.traceId, comparison);
    if (observation && normalize(observation.answer) === normalize(dom.answer)) exactMatches += 1;
    // The DOM read nothing where the wire read a finished answer. That is the silent failure this
    // layer was built to catch, and catching it is worth more than watching it.
    const rescuedAnswer = comparison === "dom_empty" && observation && completeEnoughToRescue(observation)
      ? observation.answer
      : undefined;
    if (rescuedAnswer !== undefined) domRescues += 1;
    // Only when the turn failed: on a successful turn a stream-level error is a fact worth
    // comparing, not a message to show anyone.
    const serverError = dom.failed ? observation?.error : undefined;
    if (serverError !== undefined) serverStatements += 1;
    const transcriptPath = stream && observation && wireTranscriptsEnabled()
      ? writeWireTranscript(this.transcriptRoot, buildWireTranscript(this.traceId, stream, observation, new Date(), dom))
      : undefined;
    return {
      comparison,
      wireChars,
      domChars,
      ...(observation ? { observation } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(rescuedAnswer === undefined ? {} : { rescuedAnswer }),
      ...(serverError === undefined ? {} : { serverError }),
    };
  }
}

/** One line per turn, carrying measurements rather than conversation text. */
export function chatGptWireShadowLog(traceId: string, result: ChatGptWireShadowResult): string {
  const parts = [
    `[chatgpt-web] wire shadow trace=${traceId}`,
    `comparison=${result.comparison}`,
    `wireChars=${result.wireChars}`,
    `domChars=${result.domChars}`,
  ];
  if (result.observation) {
    parts.push(
      `frames=${result.observation.counts.total}`,
      `unrecognized=${result.observation.counts.unrecognized}`,
      `unappliedDeltas=${result.observation.unappliedDeltas}`,
      `toolCalls=${result.observation.toolCallCount}`,
      `endedTurn=${result.observation.endedTurn}`,
    );
  }
  if (result.transcriptPath) parts.push(`transcript=${result.transcriptPath}`);
  return parts.join(" ");
}
