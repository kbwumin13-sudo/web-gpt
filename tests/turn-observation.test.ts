import { expect, test } from "bun:test";
import { parseConversationFrame } from "../src/adapters/chatgpt-web/wire/conversation-events";
import { decodeSseStream } from "../src/adapters/chatgpt-web/wire/sse-frames";
import { observeConversationEvents, observeWireStream } from "../src/adapters/chatgpt-web/wire/turn-observation";
import type { ChatGptWireStream } from "../src/adapters/chatgpt-web/wire/wire-collector";

/** Build a stream the way the collector would, so tests exercise the live path end to end. */
function stream(sse: string, overrides: Partial<ChatGptWireStream> = {}): ChatGptWireStream {
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

const sse = (...payloads: unknown[]): string => payloads
  .map(payload => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
  .join("");

const observe = (...payloads: unknown[]) => observeConversationEvents(
  decodeSseStream(sse(...payloads)).map(parseConversationFrame),
);

/** A message entering the stream, exactly as a live turn announces one. */
const addMessage = (message: Record<string, unknown>) => ({ p: "", o: "add", v: { message } });
const append = (index: number, text: string) => ({ p: `/message/content/parts/${index}`, o: "append", v: text });
const finish = () => ({
  p: "",
  o: "patch",
  v: [
    { p: "/message/status", o: "replace", v: "finished_successfully" },
    { p: "/message/end_turn", o: "replace", v: true },
  ],
});

test("the shape of a real turn folds into its answer", () => {
  // The frame sequence below is the one recorded from a live turn: a protocol marker, system
  // messages, the user echo, the assistant message, its deltas, the completion patch, and the
  // stream-complete envelope.
  const observation = observe(
    // The marker arrives JSON-encoded, as `data: "v1"`.
    "\"v1\"",
    { type: "resume_conversation_token", conversation_id: "conv_1", kind: "k", token: "t" },
    addMessage({ id: "sys1", author: { role: "system" }, content: { content_type: "text", parts: [""] } }),
    addMessage({ id: "usr1", author: { role: "user" }, recipient: "all", content: { content_type: "text", parts: ["Reply with OK only."] } }),
    addMessage({ id: "asst1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    { type: "message_marker", conversation_id: "conv_1", message_id: "asst1", event: "x", marker: "y" },
    append(0, "OK"),
    finish(),
    { type: "message_stream_complete", conversation_id: "conv_1" },
    "[DONE]",
  );
  expect(observation.answer).toBe("OK");
  expect(observation.endedTurn).toBeTrue();
  expect(observation.sawDone).toBeTrue();
  expect(observation.error).toBeUndefined();
  expect(observation.conversationId).toBe("conv_1");
  expect(observation.counts.unrecognized).toBe(0);
  expect(observation.unappliedDeltas).toBe(0);
});

/** The completion patch ChatGPT sends for a message that is *not* the end of the turn. */
const finishWithoutEndingTurn = () => ({
  p: "",
  o: "patch",
  v: [
    { p: "/message/status", o: "replace", v: "finished_successfully" },
    { p: "/message/end_turn", o: "replace", v: false },
  ],
});

test("progress narration before a tool call is not part of the answer", () => {
  // A turn that calls tools speaks more than once: ChatGPT announces what it is about to do, calls
  // the tool, and answers at the end. Joining everything the model addressed to the user overstated
  // the answer by exactly that narration — on one recorded turn, 2738 chars against the 1967 the
  // page showed — and the overstatement grew with the number of tool calls.
  const observation = observe(
    addMessage({ id: "n1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "I'll check the repository first."),
    finishWithoutEndingTurn(),
    addMessage({ id: "call1", author: { role: "assistant" }, recipient: "functions.exec", content: { content_type: "text", parts: [""] } }),
    append(0, "ls"),
    finishWithoutEndingTurn(),
    addMessage({ id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "There are 97 files."),
    finish(),
    "[DONE]",
  );
  expect(observation.answer).toBe("There are 97 files.");
  expect(observation.answer).not.toContain("I'll check");
  expect(observation.endedTurn).toBeTrue();
  expect(observation.toolCallCount).toBe(1);
  expect(observation.unappliedDeltas).toBe(0);
});

/** Closing a segment: the model pauses to call a tool and will keep appending to this message. */
const pauseSegment = () => ({ p: "/message/end_turn", o: "replace", v: false });

test("narration and answer appended to one message are separated by the pauses between them", () => {
  // ChatGPT does not always open a new message to narrate. On a recorded turn it appended two lines
  // of narration and then the answer to a single `parts[0]`, marking each pause with
  // `end_turn: false` while it called a tool. Reading the whole part gave 685 chars against the
  // 528 the page showed; reading the segment after the last pause gives exactly 528.
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "I'll run each step separately."),
    pauseSegment(),
    append(0, "One call was blocked; narrowing it."),
    pauseSegment(),
    append(0, "Exploration complete."),
    finish(),
    "[DONE]",
  );
  expect(observation.answer).toBe("Exploration complete.");
  expect(observation.endedTurn).toBeTrue();
  // The narration is commentary, not the answer, and is kept where Codex renders commentary.
  expect(observation.reasoning).toContain("I'll run each step separately.");
  expect(observation.reasoning).toContain("One call was blocked");
  expect(observation.unappliedDeltas).toBe(0);
});

test("a message re-announced mid-turn keeps the segments it already closed", () => {
  // The stream re-states a message as its status changes. That restates the message, not the
  // narration it already finished, so the segments must survive the re-announcement.
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "Checking."),
    pauseSegment(),
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] }, status: "in_progress" }),
    append(0, "Done."),
    finish(),
  );
  expect(observation.answer).toBe("Done.");
  expect(observation.reasoning).toBe("Checking.");
});

test("the flag decides the answer, not the position", () => {
  // Recorded streams patch `end_turn` once per message. On the turn measured above it was patched
  // 40 times: 39 false and exactly one true. Selecting the last message that carried text would
  // agree here by accident; the server's own flag is what is being read.
  const observation = observe(
    addMessage({ id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "The answer."),
    finish(),
    addMessage({ id: "recap", author: { role: "assistant" }, recipient: "all", content: { content_type: "reasoning_recap", parts: [""] } }),
    append(0, "Thought about it."),
    finishWithoutEndingTurn(),
  );
  expect(observation.answer).toBe("The answer.");
  expect(observation.reasoning).toBe("Thought about it.");
});

test("a stream that never ends its turn still reports what the model was saying", () => {
  // A cut-off stream is where the fold understands least, so it must not fall back to joining every
  // message and restoring the overstatement exactly there.
  const observation = observe(
    addMessage({ id: "n1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "Looking into it."),
    finishWithoutEndingTurn(),
    addMessage({ id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "Partial ans"),
  );
  expect(observation.answer).toBe("Partial ans");
  expect(observation.endedTurn).toBeFalse();
});

test("a frame carrying only a value continues the last addressed target", () => {
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    append(0, "Hel"),
    { c: 4, v: "lo" },
    { c: 5, v: " world" },
  );
  expect(observation.answer).toBe("Hello world");
  expect(observation.unappliedDeltas).toBe(0);
});

test("reasoning is kept apart from the answer by content type, not by position", () => {
  // The DOM path decided this from document order and computed style, and silently reclassified
  // answer text as commentary when a second tool call opened another status container.
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, content: { content_type: "thoughts", parts: ["considering"] } }),
    addMessage({ id: "m2", author: { role: "assistant" }, recipient: "browser", content: { content_type: "code", parts: ["search(...)"] } }),
    addMessage({ id: "m3", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["answer one"] } }),
    addMessage({ id: "m4", author: { role: "assistant" }, recipient: "browser", content: { content_type: "code", parts: ["search(...)"] } }),
    addMessage({ id: "m5", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["answer two"] } }),
    finish(),
  );
  // `m3` is the narration before the second tool call, not half of the answer. This assertion used
  // to read "answer one\n\nanswer two", which is the shape that overstated every real turn.
  expect(observation.answer).toBe("answer two");
  expect(observation.reasoning).toBe("considering");
  expect(observation.toolCallCount).toBe(2);
});

test("a re-announced message continues rather than duplicating", () => {
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["Hello"] } }),
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["Hello"] }, status: "in_progress" }),
    append(0, " world"),
  );
  expect(observation.answer).toBe("Hello world");
  expect(observation.messageIds).toEqual(["m1"]);
});

test("bookkeeping patches are applied deliberately rather than counted as a gap", () => {
  // Timestamps and metadata are addressed by the same patches; they are understood and ignored.
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["x"] } }),
    { p: "", o: "patch", v: [
      { p: "/message/create_time", o: "replace", v: 1789661673.49 },
      { p: "/message/metadata/model_slug", o: "replace", v: "gpt-5" },
    ] },
  );
  expect(observation.unappliedDeltas).toBe(0);
  expect(observation.answer).toBe("x");
});

test("a patch this fold does not understand is counted, never approximated", () => {
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } }),
    { p: "/conversation/title", o: "replace", v: "renamed" },
    { p: "", o: "add", v: "not a message document" },
  );
  expect(observation.unappliedDeltas).toBe(2);
  expect(observation.answer).toBe("");
});

test("an error in the stream is the turn's outcome, and the first one is kept", () => {
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["partial"] } }),
    { error: { message: "Something went wrong" } },
    { error: { message: "a later consequence" } },
  );
  expect(observation.error).toBe("Something went wrong");
});

test("the completion envelope ends the turn even without the terminal sentinel", () => {
  const observation = observe(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["done"] } }),
    { type: "message_stream_complete", conversation_id: "conv_1" },
  );
  expect(observation.sawDone).toBeTrue();
});

test("an HTTP failure with no error frame is still reported as a failure", () => {
  // Reporting an empty answer here would present a failed turn as a successful empty one.
  expect(observeWireStream(stream(sse("[DONE]"), { status: 429 })).error)
    .toBe("ChatGPT conversation request returned HTTP 429");
});

test("an error frame outranks the status code, because it says what actually happened", () => {
  expect(observeWireStream(stream(sse({ error: { message: "conversation not found" } }), { status: 404 })).error)
    .toBe("conversation not found");
});

test("a transport failure recorded by the tap becomes the turn's error", () => {
  expect(observeWireStream(stream(sse(), { status: undefined, error: "network is down" })).error)
    .toBe("network is down");
});

test("a turn that never ended is distinguishable from one that did", () => {
  // The DOM path needed a settle grace to guess this; the server states it.
  const truncated = observeWireStream(stream(sse(
    addMessage({ id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["half an ans"] } }),
  )));
  expect(truncated.answer).toBe("half an ans");
  expect(truncated.endedTurn).toBeFalse();
  expect(truncated.sawDone).toBeFalse();
  expect(truncated.error).toBeUndefined();
});

test("a user echo is not mistaken for the model's answer", () => {
  const observation = observe(
    addMessage({ id: "u1", author: { role: "user" }, recipient: "all", content: { content_type: "text", parts: ["my question"] } }),
    addMessage({ id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["my answer"] } }),
  );
  expect(observation.answer).toBe("my answer");
});

test("system scaffolding is not mistaken for the model's answer either", () => {
  // A live turn carries several system messages before the assistant's.
  const observation = observe(
    addMessage({ id: "s1", author: { role: "system" }, content: { content_type: "text", parts: ["system scaffolding"] } }),
    addMessage({ id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["my answer"] } }),
  );
  expect(observation.answer).toBe("my answer");
});

test("an empty stream yields an empty observation rather than a spurious error", () => {
  const observation = observeWireStream(stream(""));
  expect(observation).toMatchObject({ answer: "", reasoning: "", toolCallCount: 0, endedTurn: false, sawDone: false });
  expect(observation.error).toBeUndefined();
});

test("a batch patch does not move the sticky position for the frames after it", () => {
  // Letting sub-patch targets become sticky sent every later frame to the last field the batch
  // touched. Frames applied cleanly, the answer came out empty, and nothing reported a problem.
  const observation = observe(
    addMessage({ id: "u1", author: { role: "user" }, recipient: "all", content: { content_type: "text", parts: ["q"] } }),
    { o: "patch", v: [
      { p: "/message/create_time", o: "replace", v: 1 },
      { p: "/message/metadata", o: "append", v: { k: 1 } },
    ] },
    // No `p`: this must resolve to the document root, not to `/message/metadata`.
    { o: "add", v: { message: { id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] } } } },
    append(0, "OK"),
  );
  expect(observation.answer).toBe("OK");
  expect(observation.unappliedDeltas).toBe(0);
  expect(observation.messageIds).toEqual(["u1", "a1"]);
});
