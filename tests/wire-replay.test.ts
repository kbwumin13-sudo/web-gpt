import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWireReplay, readWireCapture, replayWireCapture } from "../src/adapters/chatgpt-web/wire/replay";
import { buildWireTranscript } from "../src/adapters/chatgpt-web/wire/transcript-store";
import { observeWireStream } from "../src/adapters/chatgpt-web/wire/turn-observation";
import { decodeSseStream } from "../src/adapters/chatgpt-web/wire/sse-frames";
import type { ChatGptWireStream } from "../src/adapters/chatgpt-web/wire/wire-collector";

const temporaries: string[] = [];
afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

function temporaryFile(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "wire-replay-"));
  temporaries.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

/** The frame shape a live turn actually produces: an add at the document root, then completion. */
const answerStream = (text: string): string => [
  { p: "", o: "add", v: { message: { id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [text] } } } },
  { p: "", o: "patch", v: [{ p: "/message/end_turn", o: "replace", v: true }] },
  "[DONE]",
].map(payload => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("");

function streamOf(sse: string, overrides: Partial<ChatGptWireStream> = {}): ChatGptWireStream {
  return {
    id: "w1",
    method: "POST",
    framing: "sse",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status: 200,
    startedAt: 1,
    endedAt: 2,
    closed: true,
    frames: decodeSseStream(sse),
    raw: sse,
    truncated: false,
    observedLength: sse.length,
    ...overrides,
  };
}

function transcript(sse: string, overrides: Partial<ChatGptWireStream> = {}): string {
  const stream = streamOf(sse, overrides);
  return JSON.stringify(buildWireTranscript("trace_1", stream, observeWireStream(stream)), null, 2);
}

test("a recorded transcript replays to the conclusion recorded with it", () => {
  const replay = replayWireCapture(transcript(answerStream("the answer")));
  expect(replay.source).toBe("transcript");
  expect(replay.observation.answer).toBe("the answer");
  expect(replay.reproducesRecorded).toBeTrue();
});

test("a build that reads the stream differently than the recorder says so", () => {
  // This is the check that catches a regression in the fold itself: the bytes are fixed, so a
  // changed conclusion is a change in this code, not in ChatGPT.
  const recorded = JSON.parse(transcript(answerStream("the answer"))) as { observation: { answer: string } };
  recorded.observation.answer = "what an older build concluded";
  const replay = replayWireCapture(JSON.stringify(recorded));
  expect(replay.reproducesRecorded).toBeFalse();
  expect(formatWireReplay(replay)).toContain("DIVERGES");
});

test("a raw event-stream capture replays without being reshaped first", () => {
  const replay = replayWireCapture(answerStream("captured elsewhere"));
  expect(replay.source).toBe("raw");
  expect(replay.observation.answer).toBe("captured elsewhere");
  expect(replay.reproducesRecorded).toBeUndefined();
});

test("JSON that is not a transcript is replayed as raw bytes rather than rejected", () => {
  const replay = replayWireCapture("{\"unrelated\":true}");
  expect(replay.source).toBe("raw");
  expect(replay.observation.counts.total).toBe(0);
});

test("a truncated recording is flagged, so a mismatch is not read as a defect", () => {
  const replay = replayWireCapture(transcript(answerStream("partial"), { truncated: true }));
  expect(replay.truncated).toBeTrue();
  expect(formatWireReplay(replay)).toContain("hit the retention cap");
});

test("the report names unrecognized shapes so they can be implemented rather than guessed at", () => {
  const replay = replayWireCapture(`data: {"future_frame":1}\n\n${answerStream("answer")}`);
  const report = formatWireReplay(replay);
  expect(report).toContain("unrecognized 1");
  expect(report).toContain("no known frame shape matched: future_frame");
});

test("the report carries measurements, not the conversation", () => {
  const report = formatWireReplay(replayWireCapture(answerStream("a secret answer")));
  expect(report).toContain("answer: 15 chars");
  expect(report).not.toContain("secret answer");
});

test("an errored stream reports its error rather than an empty answer", () => {
  const report = formatWireReplay(replayWireCapture("data: {\"error\":{\"message\":\"Something went wrong\"}}\n\n"));
  expect(report).toContain("error: Something went wrong");
});

test("a capture is read from disk through the same path", () => {
  const path = temporaryFile("capture.json", transcript(answerStream("from disk")));
  expect(readWireCapture(path).observation.answer).toBe("from disk");
});

test("a recorded socket stream replays to the same frames it was observed as", () => {
  const messages = [
    { p: "", o: "add", v: { message: { id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["line one\nline two"] } } } },
    { p: "", o: "patch", v: [{ p: "/message/end_turn", o: "replace", v: true }] },
  ];
  const stream: ChatGptWireStream = {
    ...streamOf(""),
    method: "WS",
    framing: "message",
    url: "wss://chatgpt.com/conduit",
    frames: [],
    // One JSON-encoded message per line, exactly as the collector records a socket stream.
    raw: messages.map(message => `${JSON.stringify(JSON.stringify(message))}\n`).join(""),
  };
  const replay = replayWireCapture(JSON.stringify(buildWireTranscript("trace_1", stream, observeWireStream(stream))));
  expect(replay.observation.answer).toBe("line one\nline two");
  expect(replay.observation.endedTurn).toBeTrue();
  expect(replay.observation.counts.unrecognized).toBe(0);
});
