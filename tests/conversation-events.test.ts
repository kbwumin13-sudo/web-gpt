import { expect, test } from "bun:test";
import {
  countConversationEvents,
  parseConversationFrame,
  type ChatGptConversationEvent,
} from "../src/adapters/chatgpt-web/wire/conversation-events";

const frame = (payload: unknown) => ({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
const parse = (payload: unknown): ChatGptConversationEvent => parseConversationFrame(frame(payload));

test("the terminal sentinel is recognised as the end of the stream", () => {
  expect(parse("[DONE]")).toEqual({ kind: "done" });
  expect(parse("  [DONE]  ")).toEqual({ kind: "done" });
});

test("the protocol marker that opens a stream is recognised rather than reported as a gap", () => {
  expect(parse("\"v1\"")).toEqual({ kind: "protocol", version: "v1" });
});

test("an unknown protocol marker is reported, because the shape below it may have changed too", () => {
  expect(parse("\"v2\"")).toEqual({ kind: "unrecognized", reason: "unknown protocol marker \"v2\"", keys: [] });
});

test("a message enters the stream as an add at the document root, not as a top-level message", () => {
  // Reading `message` at the top level — the obvious guess — matches none of the real traffic.
  expect(parse({
    p: "",
    o: "add",
    v: { message: { id: "m1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] } } },
    c: 2,
  })).toEqual({
    kind: "patch",
    patches: [{
      path: "",
      operation: "add",
      value: { message: { id: "m1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] } } },
    }],
    batch: false,
    framePath: "",
    frameOperation: "add",
    sequence: 2,
  });
});

test("an answer delta names its exact target", () => {
  expect(parse({ p: "/message/content/parts/0", o: "append", v: "OK" })).toEqual({
    kind: "patch",
    patches: [{ path: "/message/content/parts/0", operation: "append", value: "OK" }],
    batch: false,
    framePath: "/message/content/parts/0",
    frameOperation: "append",
  });
});

test("a frame carrying only a value leaves its path and operation implicit", () => {
  // `p` and `o` are sticky in this stream; the fold resolves them from what was last addressed.
  expect(parse({ c: 3, v: "more text" })).toEqual({
    kind: "patch",
    patches: [{ path: "", operation: "append", value: "more text" }],
    batch: false,
    sequence: 3,
  });
});

test("a batch patch expands into the operations it contains", () => {
  expect(parse({
    p: "",
    o: "patch",
    v: [
      { p: "/message/status", o: "replace", v: "finished_successfully" },
      { p: "/message/end_turn", o: "replace", v: true },
    ],
  })).toEqual({
    kind: "patch",
    patches: [
      { path: "/message/status", operation: "replace", value: "finished_successfully" },
      { path: "/message/end_turn", operation: "replace", value: true },
    ],
    // A batch names every target explicitly, so it neither reads nor sets the sticky position.
    batch: true,
  });
});

test("a batch that is not a list of patches is reported rather than half-applied", () => {
  expect(parse({ o: "patch", v: "not a list" }))
    .toEqual({ kind: "unrecognized", reason: "patch operation without a list of patches", keys: ["o", "v"] });
});

test("typed control envelopes are recognised and named", () => {
  // Observed on a real turn: stream completion, per-message markers, tokens, conversation metadata.
  expect(parse({ type: "message_stream_complete", conversation_id: "conv_1" }))
    .toEqual({ kind: "control", type: "message_stream_complete", conversationId: "conv_1" });
  expect(parse({ type: "message_marker", conversation_id: "conv_1", message_id: "m1", event: "x", marker: "y" }))
    .toMatchObject({ kind: "control", type: "message_marker" });
  expect(parse({ type: "resume_conversation_token", conversation_id: "conv_1", kind: "k", token: "t" }))
    .toMatchObject({ kind: "control", type: "resume_conversation_token" });
});

test("an error is read before any other shape, because it is what decides the turn", () => {
  expect(parse({ type: "message_stream_complete", error: { message: "Something went wrong" } }))
    .toEqual({ kind: "error", message: "Something went wrong" });
  expect(parse({ error: "rate limited" })).toEqual({ kind: "error", message: "rate limited" });
  expect(parse({ detail: "too many requests" })).toEqual({ kind: "error", message: "too many requests" });
});

test("an explicitly null error does not turn a healthy frame into a failure", () => {
  expect(parse({ error: null, type: "message_stream_complete" })).toMatchObject({ kind: "control" });
});

test("an unknown shape is reported by its keys, never matched against a guess", () => {
  expect(parse({ some_new_field: { nested: 1 }, another: "x" }))
    .toEqual({ kind: "unrecognized", reason: "no known frame shape matched", keys: ["another", "some_new_field"] });
});

test("unrecognized frames describe their schema without carrying conversation content", () => {
  expect(JSON.stringify(parse({ unknown_wrapper: "a user's private message text" })))
    .not.toContain("private message text");
});

test("malformed and non-object payloads are reported rather than parsed", () => {
  expect(parse("{ truncated")).toEqual({ kind: "unrecognized", reason: "frame data is not JSON", keys: [] });
  expect(parse("[1,2]")).toEqual({ kind: "unrecognized", reason: "frame data is an array", keys: [] });
  expect(parse("")).toEqual({ kind: "unrecognized", reason: "empty frame", keys: [] });
});

test("the tally names both the shapes still to be understood and the control types seen", () => {
  const counts = countConversationEvents([
    parse("\"v1\""),
    parse({ p: "", o: "add", v: { message: { id: "m" } } }),
    parse({ v: "x" }),
    parse({ type: "message_stream_complete" }),
    parse({ future_field: 1 }),
    parse({ future_field: 2 }),
    parse("[DONE]"),
  ]);
  expect(counts.total).toBe(7);
  expect(counts.unrecognized).toBe(2);
  expect(counts.byKind).toEqual({ done: 1, protocol: 1, control: 1, patch: 2, error: 0, unrecognized: 2 });
  // Two frames of the same unknown shape are one thing to understand, not two.
  expect(counts.unrecognizedShapes).toEqual(["no known frame shape matched: future_field"]);
  expect(counts.controlTypes).toEqual(["message_stream_complete"]);
});
