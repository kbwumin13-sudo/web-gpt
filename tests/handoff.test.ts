import { expect, test } from "bun:test";
import { parseConversationFrame } from "../src/adapters/chatgpt-web/wire/conversation-events";
import { resumedConversationStream } from "../src/adapters/chatgpt-web/wire/handoff";
import { decodeSseStream } from "../src/adapters/chatgpt-web/wire/sse-frames";
import { observeConversationEvents } from "../src/adapters/chatgpt-web/wire/turn-observation";

/**
 * Socket messages as the collector records them: one JSON-encoded message per line. The shapes are
 * the ones a live handed-off turn produced.
 */
const socket = (...messages: unknown[]): string =>
  `${messages.map(message => JSON.stringify(JSON.stringify(message))).join("\n")}\n`;

const item = (offset: string, encoded: string, conversationId = "conv_1") => ({
  type: "message",
  topic_id: "conversation-turn-16528610-5",
  offset,
  payload: {
    type: "conversation-turn-stream",
    payload: { type: "stream-item", conversation_id: conversationId, turn_id: "turn_1", encoded_item: encoded },
  },
});

test("a handed-off turn is reassembled from the socket into the stream it would have been", () => {
  // Each topic message carries a slice of the same event-stream text the HTTP response would have
  // carried, so there is no second protocol to model.
  const raw = socket(
    { id: 1, type: "reply", reply: { type: "connect", subscriptions: {} } },
    item("1789721328178-0", "event: delta_encoding\ndata: \"v1\"\n\n"),
    item("1789721328178-1", `event: delta\ndata: ${JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } },
    })}\n\n`),
    item("1789721328179-0", `event: delta\ndata: ${JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "the answer" })}\n\n`),
    item("1789721328180-0", `event: delta\ndata: ${JSON.stringify({ p: "", o: "patch", v: [{ p: "/message/end_turn", o: "replace", v: true }] })}\n\n`),
    item("1789721328181-0", "data: [DONE]\n\n"),
  );

  const observation = observeConversationEvents(
    decodeSseStream(resumedConversationStream(raw, "conv_1")).map(parseConversationFrame),
  );
  expect(observation.answer).toBe("the answer");
  expect(observation.endedTurn).toBeTrue();
  expect(observation.sawDone).toBeTrue();
  expect(observation.counts.unrecognized).toBe(0);
  expect(observation.unappliedDeltas).toBe(0);
});

test("items are ordered by the server's offsets rather than by arrival", () => {
  // Reassembling a patch stream out of order corrupts it silently: every patch still applies. The
  // two agreed on the recorded turn, which is not a guarantee that they always will.
  const raw = socket(
    item("1789721328180-0", "c"),
    item("1789721328178-0", "a"),
    item("1789721328178-1", "b"),
  );
  expect(resumedConversationStream(raw)).toBe("abc");
});

test("an offset that is not the expected shape does not throw", () => {
  // `offset` is `<milliseconds>-<sequence>` as a string, not a number; a malformed one sorts first.
  expect(resumedConversationStream(socket(item("nonsense", "x"), item("1789721328178-0", "y"))))
    .toBe("xy");
});

test("another conversation sharing the socket is left out", () => {
  // The socket also carries `conversations`, `app_notifications` and subscription replies, and a
  // second turn would carry its own items under the same shape.
  const raw = socket(
    item("1789721328178-0", "mine", "conv_1"),
    item("1789721328179-0", "theirs", "conv_2"),
  );
  expect(resumedConversationStream(raw, "conv_1")).toBe("mine");
  // Without a conversation to match, everything of this shape is taken.
  expect(resumedConversationStream(raw)).toBe("minetheirs");
});

test("traffic that is not a turn stream contributes nothing", () => {
  const raw = socket(
    { id: 1, type: "reply", reply: { type: "subscribe", topic_id: "app_notifications" } },
    { type: "message", topic_id: "conversations", offset: "1-0", payload: { type: "conversation-list-update" } },
    { type: "message", topic_id: "t", offset: "2-0", payload: { type: "conversation-turn-stream", payload: { type: "other" } } },
  );
  expect(resumedConversationStream(raw)).toBe("");
  expect(resumedConversationStream("")).toBe("");
  expect(resumedConversationStream("not json\n{]\n")).toBe("");
});

test("a batch of messages in one socket frame is expanded", () => {
  const raw = `${JSON.stringify(JSON.stringify([item("1-0", "a"), item("1-1", "b")]))}\n`;
  expect(resumedConversationStream(raw)).toBe("ab");
});
