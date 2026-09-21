import { expect, test } from "bun:test";
import { ChatGptWireCollector } from "../src/adapters/chatgpt-web/wire/wire-collector";
import type { ChatGptWireRecord } from "../src/adapters/chatgpt-web/wire/page-tap";
import type { SseFrame } from "../src/adapters/chatgpt-web/wire/sse-frames";

const CONVERSATION_URL = "https://chatgpt.com/backend-api/f/conversation";

let clock = 1_000;
const at = () => ++clock;

function open(collector: ChatGptWireCollector, id: string, status = 200): void {
  collector.record({ kind: "request", id, method: "POST", url: CONVERSATION_URL, at: at() });
  collector.record({ kind: "response", id, status, at: at() });
}

function chunk(collector: ChatGptWireCollector, id: string, text: string): void {
  collector.record({ kind: "chunk", id, text, at: at() });
}

function end(collector: ChatGptWireCollector, id: string): void {
  collector.record({ kind: "end", id, at: at() });
}

test("a stream is assembled from its records with framing already decoded", () => {
  const collector = new ChatGptWireCollector();
  open(collector, "w1");
  chunk(collector, "w1", "data: a\n\ndata: ");
  chunk(collector, "w1", "b\n\n");
  end(collector, "w1");

  const stream = collector.latest()!;
  expect(stream).toMatchObject({ id: "w1", method: "POST", url: CONVERSATION_URL, status: 200, closed: true });
  expect(stream.frames).toEqual([{ data: "a" }, { data: "b" }]);
  expect(stream.raw).toBe("data: a\n\ndata: b\n\n");
  expect(stream.truncated).toBeFalse();
});

test("frames are delivered live, not only once the stream closes", () => {
  // A turn has to be observable while it runs; waiting for the close would be a worse DOM poll.
  const seen: SseFrame[] = [];
  const collector = new ChatGptWireCollector({ onFrame: (_stream, frame) => seen.push(frame) });
  open(collector, "w1");
  chunk(collector, "w1", "data: first\n\n");
  expect(seen).toEqual([{ data: "first" }]);
  chunk(collector, "w1", "data: second\n\n");
  expect(seen).toEqual([{ data: "first" }, { data: "second" }]);
});

test("a stream closing without a blank line still yields its last frame", () => {
  const collector = new ChatGptWireCollector();
  open(collector, "w1");
  chunk(collector, "w1", "data: unterminated");
  end(collector, "w1");
  expect(collector.latest()!.frames).toEqual([{ data: "unterminated" }]);
});

test("a failed request is closed with its reason instead of left open forever", () => {
  const collector = new ChatGptWireCollector();
  collector.record({ kind: "request", id: "w1", method: "POST", url: CONVERSATION_URL, at: at() });
  collector.record({ kind: "error", id: "w1", message: "network is down", at: at() });
  expect(collector.latest()).toMatchObject({ closed: true, error: "network is down" });
});

test("the replay copy is capped while framing continues past the cap", () => {
  // Losing the tail of a replay copy is a smaller loss than missing the completion event.
  const collector = new ChatGptWireCollector({ maxRawCharsPerStream: 12 });
  open(collector, "w1");
  chunk(collector, "w1", "data: aaaa\n\n");
  chunk(collector, "w1", "data: bbbb\n\n");
  end(collector, "w1");

  const stream = collector.latest()!;
  expect(stream.raw).toBe("data: aaaa\n\n");
  expect(stream.truncated).toBeTrue();
  expect(stream.observedLength).toBe(24);
  expect(stream.frames).toEqual([{ data: "aaaa" }, { data: "bbbb" }]);
});

test("closed streams are evicted oldest first once the retention limit is reached", () => {
  const collector = new ChatGptWireCollector({ maxRetainedStreams: 2 });
  for (const id of ["w1", "w2", "w3"]) {
    open(collector, id);
    end(collector, id);
  }
  expect(collector.snapshot().map(stream => stream.id)).toEqual(["w2", "w3"]);
  expect(collector.counts().evictedWithFrames).toBe(0);
});

test("the stream carrying a turn outlives the bookkeeping requests around it", () => {
  // A turn page issues dozens of ordinary backend requests after the one that carries the answer.
  // Evicting purely by age dropped the turn behind them, and the turn then looked observed and
  // empty — the exact silent failure this observer exists to catch.
  const collector = new ChatGptWireCollector({ maxRetainedStreams: 3 });
  open(collector, "turn");
  chunk(collector, "turn", "data: the answer\n\n");
  end(collector, "turn");
  for (const id of ["a", "b", "c", "d", "e"]) {
    open(collector, id);
    // Ordinary JSON responses decode to no event-stream frames.
    chunk(collector, id, "{\"status\":\"ok\"}");
    end(collector, id);
  }
  expect(collector.snapshot().map(stream => stream.id)).toContain("turn");
  expect(collector.counts().evictedWithFrames).toBe(0);
});

test("losing a framed stream is counted, so an observation lost is distinguishable from one absent", () => {
  const collector = new ChatGptWireCollector({ maxRetainedStreams: 1 });
  for (const id of ["s1", "s2"]) {
    open(collector, id);
    chunk(collector, id, "data: x\n\n");
    end(collector, id);
  }
  expect(collector.counts().evictedWithFrames).toBe(1);
});

test("an open stream is never evicted, because it is still being written to", () => {
  const collector = new ChatGptWireCollector({ maxRetainedStreams: 1 });
  open(collector, "live");
  open(collector, "w2");
  end(collector, "w2");
  expect(collector.snapshot().map(stream => stream.id)).toEqual(["live"]);
  chunk(collector, "live", "data: still here\n\n");
  expect(collector.latest()!.frames).toEqual([{ data: "still here" }]);
});

test("records for an unknown stream are counted rather than dropped silently", () => {
  const collector = new ChatGptWireCollector();
  collector.record({ kind: "chunk", id: "never-opened", text: "data: x\n\n", at: at() });
  expect(collector.counts().unmatchedRecords).toBe(1);
  expect(collector.snapshot()).toEqual([]);
});

test("records arriving after a close are counted rather than reopening the stream", () => {
  const collector = new ChatGptWireCollector();
  open(collector, "w1");
  end(collector, "w1");
  chunk(collector, "w1", "data: late\n\n");
  expect(collector.counts().recordsAfterClose).toBe(1);
  expect(collector.latest()!.frames).toEqual([]);
});

test("a duplicate request id is counted rather than resetting the stream in flight", () => {
  const collector = new ChatGptWireCollector();
  open(collector, "w1");
  chunk(collector, "w1", "data: a\n\n");
  collector.record({ kind: "request", id: "w1", method: "POST", url: CONVERSATION_URL, at: at() });
  expect(collector.counts().unmatchedRecords).toBe(1);
  expect(collector.latest()!.frames).toEqual([{ data: "a" }]);
});

test("the tap's own faults are counted apart from conversation streams", () => {
  const collector = new ChatGptWireCollector();
  collector.record({ kind: "error", id: "tap", message: "3 records were dropped", at: at() });
  expect(collector.counts().tapErrors).toBe(1);
  expect(collector.snapshot()).toEqual([]);
});

test("a closed stream notifies once, with its assembled contents", () => {
  const closed: string[] = [];
  const collector = new ChatGptWireCollector({ onStreamClosed: stream => closed.push(stream.raw) });
  open(collector, "w1");
  chunk(collector, "w1", "data: a\n\n");
  end(collector, "w1");
  end(collector, "w1");
  expect(closed).toEqual(["data: a\n\n"]);
});

test("a snapshot cannot be used to mutate the collector's own state", () => {
  const collector = new ChatGptWireCollector();
  open(collector, "w1");
  chunk(collector, "w1", "data: a\n\n");
  collector.snapshot()[0]!.frames.push({ data: "forged" });
  expect(collector.latest()!.frames).toEqual([{ data: "a" }]);
});

test("a record sequence replays to the same result, which is what makes a failure reproducible", () => {
  const records: ChatGptWireRecord[] = [
    { kind: "request", id: "w1", method: "POST", url: CONVERSATION_URL, at: 1 },
    { kind: "response", id: "w1", status: 200, at: 2 },
    { kind: "chunk", id: "w1", text: "data: a\n\n", at: 3 },
    { kind: "end", id: "w1", at: 4 },
  ];
  const first = new ChatGptWireCollector();
  const second = new ChatGptWireCollector();
  for (const record of records) first.record(record);
  for (const record of records) second.record(record);
  expect(second.snapshot()).toEqual(first.snapshot());
});

test("a socket stream keeps each message whole instead of event-stream framing it", () => {
  // ChatGPT moved a turn's answer onto a separate channel whose messages are already complete
  // payloads. Running them through event-stream framing discards every one of them.
  const collector = new ChatGptWireCollector();
  collector.record({ kind: "request", id: "ws1", method: "WS", url: "wss://chatgpt.com/conduit", at: at() });
  collector.record({ kind: "chunk", id: "ws1", text: "{\"a\":1}", at: at() });
  collector.record({ kind: "chunk", id: "ws1", text: "{\"b\":2}", at: at() });
  collector.record({ kind: "end", id: "ws1", at: at() });

  const stream = collector.latest()!;
  expect(stream.framing).toBe("message");
  expect(stream.frames).toEqual([{ data: "{\"a\":1}" }, { data: "{\"b\":2}" }]);
});

test("a fetch stream is still event-stream framed", () => {
  const collector = new ChatGptWireCollector();
  open(collector, "w1");
  chunk(collector, "w1", "data: a\n\n");
  end(collector, "w1");
  expect(collector.latest()!.framing).toBe("sse");
});

test("a recorded socket stream keeps one message per line so a replay divides it the same way", () => {
  // Concatenating them would merge separate messages into one payload on replay.
  const collector = new ChatGptWireCollector();
  collector.record({ kind: "request", id: "ws1", method: "WS", url: "wss://chatgpt.com/conduit", at: at() });
  collector.record({ kind: "chunk", id: "ws1", text: "first\nwith a newline", at: at() });
  collector.record({ kind: "chunk", id: "ws1", text: "second", at: at() });
  collector.record({ kind: "end", id: "ws1", at: at() });
  expect(collector.latest()!.raw).toBe(`${JSON.stringify("first\nwith a newline")}\n${JSON.stringify("second")}\n`);
});
