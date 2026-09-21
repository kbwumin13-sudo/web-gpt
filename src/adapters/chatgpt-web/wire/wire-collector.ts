import { SseFrameDecoder, type SseFrame } from "./sse-frames";
import { WEBSOCKET_METHOD, type ChatGptWireRecord } from "./page-tap";

/**
 * Host-side assembly of the records a tapped page emits.
 *
 * Deliberately free of any browser dependency: everything here is decided by the record sequence
 * alone, so a recorded transcript replays through exactly this code. That is what makes a live
 * failure reproducible offline instead of only describable.
 */

/**
 * How a stream's bytes divide into frames. A `fetch` response is event-stream framed; a socket
 * message is already one payload, and running it through event-stream framing would discard it.
 */
export type ChatGptWireFraming = "sse" | "message";

export interface ChatGptWireStream {
  id: string;
  method: string;
  framing: ChatGptWireFraming;
  url: string;
  status?: number;
  startedAt: number;
  endedAt?: number;
  /** Set when the page's own request failed, or when the tap could not observe it. */
  error?: string;
  /** Whether the stream reached a terminal record rather than being abandoned. */
  closed: boolean;
  frames: SseFrame[];
  /** Bytes exactly as received, for replay. Capped; `truncated` says when the cap was reached. */
  raw: string;
  truncated: boolean;
  /** Total observed length, including anything past the cap. */
  observedLength: number;
}

export interface ChatGptWireCollectorOptions {
  /** Raw text retained per stream. Frames keep being decoded past this; only the replay copy stops growing. */
  maxRawCharsPerStream: number;
  /** Completed streams retained for inspection before the oldest is evicted. */
  maxRetainedStreams: number;
  onFrame?: (stream: ChatGptWireStream, frame: SseFrame) => void;
  onStreamClosed?: (stream: ChatGptWireStream) => void;
}

export const DEFAULT_WIRE_COLLECTOR_OPTIONS: Omit<ChatGptWireCollectorOptions, "onFrame" | "onStreamClosed"> = {
  maxRawCharsPerStream: 4 * 1024 * 1024,
  // A turn page issues dozens of ordinary backend requests around the one that carries the turn.
  // A cap of 16 evicted the conversation stream behind them, which showed up as a turn that was
  // observed and produced nothing — the exact silent failure this observer exists to catch.
  maxRetainedStreams: 64,
};

interface StreamState extends ChatGptWireStream {
  /** Absent for message framing, where each record is already a complete frame. */
  decoder?: SseFrameDecoder;
}

/** Records arriving for a stream that never opened, or after it closed, are counted rather than dropped silently. */
export interface ChatGptWireCollectorCounters {
  unmatchedRecords: number;
  recordsAfterClose: number;
  tapErrors: number;
  /**
   * Streams that carried event-stream frames and were evicted anyway. Ordinary requests are dropped
   * first, so this is only non-zero when a turn produced more event-streams than the cap holds, and
   * it is the number that says an observation was lost rather than merely absent.
   */
  evictedWithFrames: number;
}

export class ChatGptWireCollector {
  private readonly options: ChatGptWireCollectorOptions;
  private readonly streams = new Map<string, StreamState>();
  private readonly order: string[] = [];
  private readonly counters: ChatGptWireCollectorCounters = {
    unmatchedRecords: 0,
    recordsAfterClose: 0,
    tapErrors: 0,
    evictedWithFrames: 0,
  };

  constructor(options: Partial<ChatGptWireCollectorOptions> = {}) {
    this.options = { ...DEFAULT_WIRE_COLLECTOR_OPTIONS, ...options };
  }

  record(record: ChatGptWireRecord): void {
    // The tap reports its own faults under a reserved id rather than inventing a stream.
    if (record.kind === "error" && record.id === "tap") {
      this.counters.tapErrors += 1;
      return;
    }
    if (record.kind === "request") {
      this.open(record.id, record.method, record.url, record.at);
      return;
    }
    const stream = this.streams.get(record.id);
    if (!stream) {
      this.counters.unmatchedRecords += 1;
      return;
    }
    if (stream.closed) {
      this.counters.recordsAfterClose += 1;
      return;
    }
    if (record.kind === "response") {
      stream.status = record.status;
      return;
    }
    if (record.kind === "chunk") {
      this.append(stream, record.text);
      return;
    }
    if (record.kind === "error") {
      stream.error = record.message;
      this.close(stream, record.at);
      return;
    }
    this.close(stream, record.at);
  }

  /** Streams in the order they opened, oldest first. */
  snapshot(): ChatGptWireStream[] {
    return this.order
      .map(id => this.streams.get(id))
      .filter((stream): stream is StreamState => stream !== undefined)
      .map(({ decoder: _decoder, ...stream }) => ({ ...stream, frames: [...stream.frames] }));
  }

  /** The most recent stream, which for a fresh per-turn page is that turn's conversation request. */
  latest(): ChatGptWireStream | undefined {
    return this.snapshot().at(-1);
  }

  counts(): ChatGptWireCollectorCounters {
    return { ...this.counters };
  }

  private open(id: string, method: string, url: string, at: number): void {
    if (this.streams.has(id)) {
      this.counters.unmatchedRecords += 1;
      return;
    }
    const framing: ChatGptWireFraming = method === WEBSOCKET_METHOD ? "message" : "sse";
    this.streams.set(id, {
      id,
      method,
      framing,
      url,
      startedAt: at,
      closed: false,
      frames: [],
      raw: "",
      truncated: false,
      observedLength: 0,
      ...(framing === "sse" ? { decoder: new SseFrameDecoder() } : {}),
    });
    this.order.push(id);
    this.evictOldestClosed();
  }

  private append(stream: StreamState, text: string): void {
    // Message framing records one JSON-encoded message per line, so a recorded stream replays to
    // exactly the frames it was observed as. Concatenating would merge separate messages, and
    // hand-rolled escaping is not reversible: a payload containing a backslash — which every JSON
    // string with a newline does — would decode back into different bytes.
    const recorded = stream.framing === "message" ? `${JSON.stringify(text)}\n` : text;
    stream.observedLength += recorded.length;
    if (!stream.truncated) {
      const room = this.options.maxRawCharsPerStream - stream.raw.length;
      if (recorded.length <= room) {
        stream.raw += recorded;
      } else {
        stream.raw += recorded.slice(0, Math.max(0, room));
        stream.truncated = true;
      }
    }
    // Frames keep being decoded past the raw cap: a truncated replay copy is a smaller loss than a
    // turn whose completion event went unobserved.
    const frames = stream.decoder ? stream.decoder.push(text) : [{ data: text }];
    for (const frame of frames) {
      stream.frames.push(frame);
      this.options.onFrame?.(this.expose(stream), frame);
    }
  }

  private close(stream: StreamState, at: number): void {
    for (const frame of stream.decoder?.flush() ?? []) {
      stream.frames.push(frame);
      this.options.onFrame?.(this.expose(stream), frame);
    }
    stream.closed = true;
    stream.endedAt = at;
    this.options.onStreamClosed?.(this.expose(stream));
    this.evictOldestClosed();
  }

  private expose(stream: StreamState): ChatGptWireStream {
    const { decoder: _decoder, ...rest } = stream;
    return rest;
  }

  /**
   * Ordinary JSON responses decode to no event-stream frames, so "carried frames" separates the
   * request that holds a turn from the bookkeeping around it. Those are dropped first; a framed
   * stream is only evicted when nothing else is left, and that loss is counted.
   */
  private evictOldestClosed(): void {
    while (this.order.length > this.options.maxRetainedStreams) {
      const closed = (id: string): boolean => this.streams.get(id)?.closed === true;
      const index = this.order.findIndex(id => closed(id) && this.streams.get(id)!.frames.length === 0);
      const fallback = index >= 0 ? index : this.order.findIndex(closed);
      // An open stream is still being written to, so eviction waits rather than losing a live turn.
      if (fallback < 0) return;
      const [evicted] = this.order.splice(fallback, 1);
      if ((this.streams.get(evicted)?.frames.length ?? 0) > 0) this.counters.evictedWithFrames += 1;
      this.streams.delete(evicted);
    }
  }
}
