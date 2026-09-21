import { readFileSync } from "node:fs";
import { decodeSseStream } from "./sse-frames";
import { observeConversationEvents, type ChatGptWireObservation } from "./turn-observation";
import { parseConversationFrame } from "./conversation-events";

/**
 * Replays a recorded conversation stream through the same fold the live path uses.
 *
 * This is what a transcript is for. A live failure previously left a screenshot and a state dump —
 * enough to describe the failure, never enough to reproduce it, so a fix rested on reasoning and a
 * wrong guess brought the bug back. Recorded bytes replayed through the production fold make a
 * failure reproducible offline and turn it into a regression test.
 */

export interface WireReplay {
  source: "transcript" | "raw";
  observation: ChatGptWireObservation;
  /** Present when replaying a transcript that recorded what the live fold concluded. */
  recordedAnswerChars?: number;
  /** Whether replaying the recorded bytes reproduces the conclusion recorded alongside them. */
  reproducesRecorded?: boolean;
  /** A recorded stream that hit the retention cap is incomplete, so a mismatch may be the cap rather than a defect. */
  truncated?: boolean;
}

/**
 * Socket messages are recorded one JSON-encoded message per line, because they are already whole
 * payloads and event-stream framing would discard them. Replay divides them back the same way; a
 * line that is not an encoded string is kept verbatim rather than dropped.
 */
function decodeMessageStream(raw: string): { data: string }[] {
  return raw.split("\n").filter(line => line.length > 0).map(line => {
    try {
      const decoded: unknown = JSON.parse(line);
      return { data: typeof decoded === "string" ? decoded : line };
    } catch {
      return { data: line };
    }
  });
}

function observeRaw(raw: string, framing: "sse" | "message" = "sse"): ChatGptWireObservation {
  const frames = framing === "message" ? decodeMessageStream(raw) : decodeSseStream(raw);
  return observeConversationEvents(frames.map(parseConversationFrame));
}

/**
 * Accepts either a transcript written by the recorder or a raw event-stream capture, so a stream
 * obtained any other way can be replayed through the same code without being reshaped first.
 */
export function replayWireCapture(contents: string): WireReplay {
  const trimmed = contents.trimStart();
  if (!trimmed.startsWith("{")) return { source: "raw", observation: observeRaw(contents) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { source: "raw", observation: observeRaw(contents) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { source: "raw", observation: observeRaw(contents) };
  }
  const record = parsed as { raw?: unknown; observation?: unknown; stream?: unknown };
  if (typeof record.raw !== "string") return { source: "raw", observation: observeRaw(contents) };
  const recordedStream = record.stream && typeof record.stream === "object" && !Array.isArray(record.stream)
    ? record.stream as { truncated?: unknown; framing?: unknown }
    : undefined;
  const observation = observeRaw(record.raw, recordedStream?.framing === "message" ? "message" : "sse");
  const recorded = record.observation && typeof record.observation === "object" && !Array.isArray(record.observation)
    ? record.observation as { answer?: unknown }
    : undefined;
  const truncated = recordedStream ? recordedStream.truncated === true : undefined;
  return {
    source: "transcript",
    observation,
    ...(typeof recorded?.answer === "string"
      ? { recordedAnswerChars: recorded.answer.length, reproducesRecorded: recorded.answer === observation.answer }
      : {}),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

export function readWireCapture(path: string): WireReplay {
  return replayWireCapture(readFileSync(path, "utf8"));
}

/** Measurements and shapes only; the conversation itself stays in the file. */
export function formatWireReplay(replay: WireReplay): string {
  const { observation } = replay;
  const lines = [
    `source: ${replay.source}`,
    `frames: ${observation.counts.total}`,
    `  patch ${observation.counts.byKind.patch}, control ${observation.counts.byKind.control}, `
    + `error ${observation.counts.byKind.error}, done ${observation.counts.byKind.done}, `
    + `unrecognized ${observation.counts.unrecognized}`,
    `answer: ${observation.answer.length} chars`,
    `reasoning: ${observation.reasoning.length} chars`,
    `tool calls: ${observation.toolCallCount}`,
    `ended turn: ${observation.endedTurn}`,
    `saw done: ${observation.sawDone}`,
    `unapplied deltas: ${observation.unappliedDeltas}`,
  ];
  if (observation.error !== undefined) lines.push(`error: ${observation.error}`);
  if (replay.truncated) lines.push("note: the recorded stream hit the retention cap and is incomplete");
  if (replay.reproducesRecorded !== undefined) {
    lines.push(replay.reproducesRecorded
      ? "replay reproduces the recorded conclusion"
      : `replay DIVERGES from the recorded conclusion (recorded ${replay.recordedAnswerChars} chars,`
        + ` replayed ${observation.answer.length} chars): this build reads the stream differently than the one that recorded it`);
  }
  if (observation.counts.controlTypes.length > 0) {
    lines.push(`control types: ${observation.counts.controlTypes.join(", ")}`);
  }
  if (observation.counts.unrecognizedShapes.length > 0) {
    lines.push("unrecognized shapes:", ...observation.counts.unrecognizedShapes.map(shape => `  ${shape}`));
  }
  return `${lines.join("\n")}\n`;
}
