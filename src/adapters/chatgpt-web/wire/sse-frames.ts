/**
 * Server-sent event framing, per the WHATWG event-stream rules.
 *
 * Framing is the one part of the ChatGPT conversation transport that is publicly specified, so it
 * is decoded exactly rather than guessed. Everything above it — what a frame's payload means — is
 * ChatGPT's private schema and is handled separately, where an unrecognised shape can be reported
 * instead of assumed.
 */

export interface SseFrame {
  /** The `event:` field, absent when the stream used the default event type. */
  event?: string;
  /** `data:` lines joined with newlines, with the trailing newline removed as the spec requires. */
  data: string;
  /** The `id:` field, when the stream set one. */
  id?: string;
}

/** A line is terminated by CRLF, LF, or a lone CR, and a CRLF must never be split into two ends. */
const LINE_END = /\r\n|\r|\n/;

function parseField(line: string): { field: string; value: string } {
  const colon = line.indexOf(":");
  if (colon < 0) return { field: line, value: "" };
  const value = line.slice(colon + 1);
  return { field: line.slice(0, colon), value: value.startsWith(" ") ? value.slice(1) : value };
}

/**
 * Incremental decoder. Network chunks split anywhere, including inside a line or between the two
 * bytes of a CRLF, so the decoder holds a partial line until its terminator actually arrives.
 */
export class SseFrameDecoder {
  private pending = "";
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;

  /** Decode a chunk, returning every frame it completed. */
  push(chunk: string): SseFrame[] {
    this.pending += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = LINE_END.exec(this.pending);
      if (!match) break;
      // A trailing CR may still turn out to be the first half of a CRLF, so it waits for more input.
      if (match[0] === "\r" && match.index + 1 === this.pending.length) break;
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      const frame = this.consumeLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /**
   * Decode whatever a closed stream left behind. A stream that ends without a blank line still
   * carries a complete frame in practice, and discarding it would turn a delivered final answer
   * into a missing one.
   */
  flush(): SseFrame[] {
    // Terminating the remainder rather than consuming it directly keeps one line-parsing path, and
    // correctly reads a trailing lone CR as the end of a line instead of as a field name.
    const frames = this.pending.length > 0 ? this.push("\n") : [];
    const trailing = this.dispatch();
    if (trailing) frames.push(trailing);
    return frames;
  }

  private consumeLine(line: string): SseFrame | undefined {
    if (line.length === 0) return this.dispatch();
    // A line beginning with a colon is a comment, used for stream keep-alives.
    if (line.startsWith(":")) return undefined;
    const { field, value } = parseField(line);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    // `retry` and unknown fields are ignored, as the spec requires.
    return undefined;
  }

  private dispatch(): SseFrame | undefined {
    if (this.data.length === 0) {
      // A blank line with no data resets the event type without dispatching anything.
      this.event = undefined;
      return undefined;
    }
    const frame: SseFrame = {
      ...(this.event === undefined ? {} : { event: this.event }),
      data: this.data.join("\n"),
      ...(this.id === undefined ? {} : { id: this.id }),
    };
    this.data = [];
    this.event = undefined;
    return frame;
  }
}

/** Decode a complete stream held in memory, for replaying a recorded transcript. */
export function decodeSseStream(text: string): SseFrame[] {
  const decoder = new SseFrameDecoder();
  return [...decoder.push(text), ...decoder.flush()];
}
