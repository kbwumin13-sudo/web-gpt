import { expect, test } from "bun:test";
import { SseFrameDecoder, decodeSseStream } from "../src/adapters/chatgpt-web/wire/sse-frames";

test("a blank line dispatches the accumulated frame", () => {
  expect(decodeSseStream("data: hello\n\n")).toEqual([{ data: "hello" }]);
});

test("every line terminator the spec allows ends a line", () => {
  expect(decodeSseStream("data: a\n\ndata: b\r\n\r\ndata: c\r\r")).toEqual([
    { data: "a" },
    { data: "b" },
    { data: "c" },
  ]);
});

test("repeated data lines are joined with newlines, not concatenated", () => {
  expect(decodeSseStream("data: {\ndata:   \"a\": 1\ndata: }\n\n")).toEqual([{ data: "{\n  \"a\": 1\n}" }]);
});

test("exactly one leading space after the colon is stripped", () => {
  expect(decodeSseStream("data:  padded\n\n")).toEqual([{ data: " padded" }]);
  expect(decodeSseStream("data:tight\n\n")).toEqual([{ data: "tight" }]);
});

test("a field with no colon is a field name with an empty value", () => {
  expect(decodeSseStream("data\n\n")).toEqual([{ data: "" }]);
});

test("event and id travel with the frame, and id persists as the last event id", () => {
  expect(decodeSseStream("event: delta\nid: 7\ndata: a\n\ndata: b\n\n")).toEqual([
    { event: "delta", data: "a", id: "7" },
    { data: "b", id: "7" },
  ]);
});

test("comments and unknown fields are ignored without ending the frame", () => {
  expect(decodeSseStream(": keep-alive\ndata: a\nretry: 500\nunknown: x\ndata: b\n\n"))
    .toEqual([{ data: "a\nb" }]);
});

test("a blank line with no data resets the event type without dispatching", () => {
  expect(decodeSseStream("event: delta\n\ndata: a\n\n")).toEqual([{ data: "a" }]);
});

test("a chunk boundary inside a line does not split the line", () => {
  const decoder = new SseFrameDecoder();
  expect(decoder.push("data: hel")).toEqual([]);
  expect(decoder.push("lo\n")).toEqual([]);
  expect(decoder.push("\n")).toEqual([{ data: "hello" }]);
});

test("a chunk boundary between the two bytes of a CRLF is not read as two line ends", () => {
  const decoder = new SseFrameDecoder();
  // Reading the CR as a terminator here would dispatch, and the following LF would dispatch again.
  expect(decoder.push("data: a\r")).toEqual([]);
  expect(decoder.push("\ndata: b\r\n\r\n")).toEqual([{ data: "a\nb" }]);
});

test("a stream that ends without a blank line still yields its last frame", () => {
  // Discarding it would turn a delivered final answer into a missing one.
  expect(decodeSseStream("data: a\n\ndata: unterminated")).toEqual([{ data: "a" }, { data: "unterminated" }]);
});

test("a stream ending on a lone carriage return ends the line rather than naming a field", () => {
  expect(decodeSseStream("data: a\r")).toEqual([{ data: "a" }]);
});

test("a closed stream with nothing buffered yields nothing", () => {
  const decoder = new SseFrameDecoder();
  expect(decoder.push("")).toEqual([]);
  expect(decoder.flush()).toEqual([]);
});

test("the terminal sentinel is delivered as an ordinary frame for the caller to recognise", () => {
  // Framing has no opinion about payloads; `[DONE]` is ChatGPT's convention, not the spec's.
  expect(decodeSseStream("data: [DONE]\n\n")).toEqual([{ data: "[DONE]" }]);
});
