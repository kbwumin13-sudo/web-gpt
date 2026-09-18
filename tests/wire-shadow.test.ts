import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  ChatGptWireShadowSession,
  chatGptWireShadowLog,
  chatGptWireTelemetrySnapshot,
  compareWireToDom,
  resetChatGptWireTelemetry,
} from "../src/adapters/chatgpt-web/wire/shadow-observer";
import {
  MAX_WIRE_RECORDS_PER_PAGE,
  parseWireRecord,
} from "../src/adapters/chatgpt-web/wire/wire-tap-host";
import { CHATGPT_WIRE_TAP_BINDING, type ChatGptWireRecord } from "../src/adapters/chatgpt-web/wire/page-tap";
import {
  WIRE_TRANSCRIPT_ENV,
  buildWireTranscript,
  wireTranscriptsEnabled,
  writeWireTranscript,
} from "../src/adapters/chatgpt-web/wire/transcript-store";
import { observeWireStream } from "../src/adapters/chatgpt-web/wire/turn-observation";
import { decodeSseStream } from "../src/adapters/chatgpt-web/wire/sse-frames";
import type { ChatGptWireStream } from "../src/adapters/chatgpt-web/wire/wire-collector";

const temporaries: string[] = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "wire-shadow-"));
  temporaries.push(directory);
  return directory;
};

afterEach(() => {
  resetChatGptWireTelemetry();
  delete process.env[WIRE_TRANSCRIPT_ENV];
  while (temporaries.length > 0) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

/** A page that records what the tap installed, so the host wiring is exercised without a browser. */
function fakePage(): { page: Page; emit: (record: unknown) => void; initScripts: string[] } {
  let binding: ((value: unknown) => void) | undefined;
  const initScripts: string[] = [];
  const page = {
    exposeFunction: async (name: string, callback: (value: unknown) => void) => {
      if (name !== CHATGPT_WIRE_TAP_BINDING) throw new Error(`unexpected binding ${name}`);
      binding = callback;
    },
    addInitScript: async (script: { content: string }) => {
      initScripts.push(script.content);
    },
  } as unknown as Page;
  return { page, emit: value => binding?.(value), initScripts };
}

/** The frame shape a live turn actually produces: an add at the document root, then completion. */
const answerStream = (text: string): string => [
  { p: "", o: "add", v: { message: { id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [text] } } } },
  { p: "", o: "patch", v: [{ p: "/message/end_turn", o: "replace", v: true }] },
  "[DONE]",
].map(payload => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("");

function emitStream(emit: (record: unknown) => void, sse: string, status = 200): void {
  const records: ChatGptWireRecord[] = [
    { kind: "request", id: "w1", method: "POST", url: "https://chatgpt.com/backend-api/f/conversation", at: 1 },
    { kind: "response", id: "w1", status, at: 2 },
    { kind: "chunk", id: "w1", text: sse, at: 3 },
    { kind: "end", id: "w1", at: 4 },
  ];
  for (const record of records) emit(record);
}

test("agreement is decided on normalised length, because the two paths format Markdown differently", () => {
  const wire = {
    answer: "Hello   world",
    reasoning: "",
    toolCallCount: 0,
    endedTurn: true,
    sawDone: true,
    messageIds: [],
    unappliedDeltas: 0,
    counts: {
      total: 0,
      unrecognized: 0,
      byKind: { done: 0, protocol: 0, control: 0, patch: 0, error: 0, unrecognized: 0 },
      unrecognizedShapes: [],
      controlTypes: [],
    },
  };
  expect(compareWireToDom(wire, { answer: "Hello world", failed: false }).comparison).toBe("agreed");
});

test("a DOM that saw nothing while the wire carried a reply is its own outcome", () => {
  // This is the silent-failure signature: a classification error returns an empty answer and
  // raises nothing, so it cannot be found by looking for errors.
  const wire = observeWireStream(streamOf(answerStream("a real answer")));
  expect(compareWireToDom(wire, { answer: "", failed: false }).comparison).toBe("dom_empty");
});

test("a turn the page read as empty is answered from the observed stream", async () => {
  // The silent failure this layer was built to catch. Watching it and then handing the user an
  // empty turn anyway is worth less than recovering it, and the DOM already produced nothing, so
  // there is no working behaviour to put at risk.
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emitStream(emit, answerStream("the answer the page missed"));

  const result = session.conclude({ answer: "", failed: false });
  expect(result.comparison).toBe("dom_empty");
  expect(result.rescuedAnswer).toBe("the answer the page missed");
  expect(chatGptWireTelemetrySnapshot().dom_rescues).toBe(1);
});

test("a turn the page did read is never answered from the observation", async () => {
  // The rescue may only add an answer where there was none. Anything else would let the observer
  // change turns that already work, which is exactly what shadow mode exists to avoid.
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emitStream(emit, answerStream("a".repeat(100)));

  const result = session.conclude({ answer: "a".repeat(10), failed: false });
  expect(result.comparison).toBe("length_mismatch");
  expect(result.rescuedAnswer).toBeUndefined();
  expect(chatGptWireTelemetrySnapshot().dom_rescues).toBe(0);
});

test("an unfinished observation does not stand in for a missing answer", async () => {
  // A partial read substituted here turns a visible failure into a plausible wrong answer, which
  // is worse than the failure. The stream has to have ended the turn and reached its sentinel.
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  const truncated = `data: ${JSON.stringify({
    p: "",
    o: "add",
    v: { message: { id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["half an ans"] } } },
  })}\n\n`;
  emitStream(emit, truncated);

  const result = session.conclude({ answer: "", failed: false });
  expect(result.comparison).toBe("dom_empty");
  expect(result.rescuedAnswer).toBeUndefined();
  expect(chatGptWireTelemetrySnapshot().dom_rescues).toBe(0);
});

test("a retried turn counts once, because the share of agreeing turns is what a cutover is judged on", async () => {
  // One turn can make several browser attempts, each concluding separately. Counting all of them
  // turned a turn that eventually succeeded into two failures and a success.
  const { page, emit } = fakePage();
  const root = temporaryDirectory();
  const failed = new ChatGptWireShadowSession("trace_1", root);
  await failed.attach(page);
  emitStream(emit, answerStream("attempt one"));
  expect(failed.conclude({ answer: "", failed: true }).comparison).toBe("error_mismatch");

  const succeeded = new ChatGptWireShadowSession("trace_1", root);
  await succeeded.attach(page);
  emitStream(emit, answerStream("attempt two"));
  expect(succeeded.conclude({ answer: "attempt two", failed: false }).comparison).toBe("agreed");

  const snapshot = chatGptWireTelemetrySnapshot();
  expect(snapshot.comparisons.agreed).toBe(1);
  expect(snapshot.comparisons.error_mismatch).toBe(0);
});

test("exact agreement is counted apart from agreement, because the tolerance hid a real defect", async () => {
  const { page, emit } = fakePage();
  const root = temporaryDirectory();
  const exact = new ChatGptWireShadowSession("trace_1", root);
  await exact.attach(page);
  emitStream(emit, answerStream("identical text"));
  expect(exact.conclude({ answer: "identical text", failed: false }).comparison).toBe("agreed");
  expect(chatGptWireTelemetrySnapshot().exact).toBe(1);

  const close = new ChatGptWireShadowSession("trace_2", root);
  await close.attach(page);
  emitStream(emit, answerStream("a".repeat(100)));
  // Within the 20% tolerance, so still `agreed` — and not exact.
  expect(close.conclude({ answer: "a".repeat(90), failed: false }).comparison).toBe("agreed");
  expect(chatGptWireTelemetrySnapshot()).toMatchObject({ exact: 1, comparisons: { agreed: 2 } });
});

test("a wire that saw nothing the DOM did find says this observer is still incomplete", () => {
  const wire = observeWireStream(streamOf("data: [DONE]\n\n"));
  expect(compareWireToDom(wire, { answer: "the DOM found this", failed: false }).comparison).toBe("wire_empty");
});

test("disagreement about whether the turn failed is reported before any text comparison", () => {
  const wire = observeWireStream(streamOf(answerStream("answered fine")));
  expect(compareWireToDom(wire, { answer: "", failed: true }).comparison).toBe("error_mismatch");
});

test("materially different lengths are a mismatch even when both paths produced text", () => {
  const wire = observeWireStream(streamOf(answerStream("a".repeat(100))));
  expect(compareWireToDom(wire, { answer: "a".repeat(10), failed: false }).comparison).toBe("length_mismatch");
});

test("two empty answers agree rather than counting as a mutual failure", () => {
  const wire = observeWireStream(streamOf("data: [DONE]\n\n"));
  expect(compareWireToDom(wire, { answer: "", failed: false }).comparison).toBe("agreed");
});

test("a turn with no observation is reported as unobserved, not as agreement", () => {
  expect(compareWireToDom(undefined, { answer: "x", failed: false }).comparison).toBe("not_observed");
});

test("a shadow session observes a turn and reports agreement without changing it", async () => {
  const { page, emit, initScripts } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  expect(await session.attach(page)).toBeTrue();
  expect(initScripts[0]).toContain("__codexChatGptWireTapInstalled__");
  emitStream(emit, answerStream("the answer"));

  const result = session.conclude({ answer: "the answer", failed: false });
  expect(result.comparison).toBe("agreed");
  expect(result.observation?.endedTurn).toBeTrue();
  expect(chatGptWireTelemetrySnapshot()).toMatchObject({
    turns_observed: 1,
    streams_observed: 1,
    unrecognized_frames: 0,
    unapplied_deltas: 0,
    attach_failures: 0,
  });
});

test("a reused page installs once and routes each turn to its own collector", async () => {
  // A retained ChatGPT conversation serves many turns from one page. Re-registering would throw,
  // and leaving the first turn's collector wired up would silently blank every later turn.
  const { page, emit, initScripts } = fakePage();
  const root = temporaryDirectory();
  const first = new ChatGptWireShadowSession("trace_1", root);
  expect(await first.attach(page)).toBeTrue();
  emitStream(emit, answerStream("first answer"));
  expect(first.conclude({ answer: "first answer", failed: false }).comparison).toBe("agreed");

  const second = new ChatGptWireShadowSession("trace_2", root);
  expect(await second.attach(page)).toBeTrue();
  emitStream(emit, answerStream("second answer"));
  const result = second.conclude({ answer: "second answer", failed: false });
  expect(result.comparison).toBe("agreed");
  expect(result.observation?.answer).toBe("second answer");
  // One installation, not one per turn.
  expect(initScripts).toHaveLength(1);
  expect(chatGptWireTelemetrySnapshot().attach_failures).toBe(0);
});

test("a tap that cannot attach degrades to no observation rather than to a failed turn", async () => {
  const page = {
    exposeFunction: async () => {
      throw new Error("binding already registered");
    },
    addInitScript: async () => {},
  } as unknown as Page;
  const faults: string[] = [];
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  expect(await session.attach(page, message => faults.push(message))).toBeFalse();
  expect(faults).toEqual(["binding already registered"]);
  expect(session.conclude({ answer: "x", failed: false }).comparison).toBe("not_observed");
  expect(chatGptWireTelemetrySnapshot().attach_failures).toBe(1);
});

test("unrecognized shapes are accumulated so a schema gap is a number, not a symptom", async () => {
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emitStream(emit, `data: {"future_frame":1}\n\n${answerStream("answer")}`);
  session.conclude({ answer: "answer", failed: false });

  const snapshot = chatGptWireTelemetrySnapshot();
  expect(snapshot.unrecognized_frames).toBe(1);
  expect(snapshot.unrecognized_shapes).toEqual(["no known frame shape matched: future_frame"]);
});

test("records the page sends in an unexpected shape are refused and counted", async () => {
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emit({ kind: "chunk", id: "w1" });
  emit("not an object");
  emit({ kind: "unknown_kind", id: "w1", at: 1 });
  session.conclude({ answer: "", failed: false });
  expect(chatGptWireTelemetrySnapshot().rejected_records).toBe(3);
});

test("the binding validates every field, because it is an entry point from a remote origin", () => {
  const at = 1;
  expect(parseWireRecord({ kind: "request", id: "w1", method: "POST", url: "https://x/y", at }))
    .toEqual({ kind: "request", id: "w1", method: "POST", url: "https://x/y", at });
  expect(parseWireRecord({ kind: "end", id: "w1", at })).toEqual({ kind: "end", id: "w1", at });
  expect(parseWireRecord({ kind: "response", id: "w1", status: 200, at })).toEqual({ kind: "response", id: "w1", status: 200, at });

  expect(parseWireRecord(null)).toBeUndefined();
  expect(parseWireRecord({ kind: "chunk", id: "w1", text: 5, at })).toBeUndefined();
  expect(parseWireRecord({ kind: "chunk", id: "", text: "x", at })).toBeUndefined();
  expect(parseWireRecord({ kind: "chunk", id: "w".repeat(129), text: "x", at })).toBeUndefined();
  expect(parseWireRecord({ kind: "chunk", id: "w1", text: "x", at: Number.NaN })).toBeUndefined();
  expect(parseWireRecord({ kind: "response", id: "w1", status: 1.5, at })).toBeUndefined();
  expect(parseWireRecord({ kind: "request", id: "w1", method: "POST", url: "u".repeat(4_097), at })).toBeUndefined();
});

test("an oversized error message is truncated rather than stored whole", () => {
  const record = parseWireRecord({ kind: "error", id: "w1", message: "m".repeat(5_000), at: 1 });
  expect(record).toMatchObject({ kind: "error" });
  expect((record as { message: string }).message).toHaveLength(2_048);
});

test("a page cannot grow this process without bound", () => {
  expect(MAX_WIRE_RECORDS_PER_PAGE).toBeLessThanOrEqual(1_000_000);
});

test("transcripts are off by default, because a transcript is a copy of the conversation", async () => {
  expect(wireTranscriptsEnabled({})).toBeFalse();
  expect(wireTranscriptsEnabled({ [WIRE_TRANSCRIPT_ENV]: "1" })).toBeTrue();

  const root = temporaryDirectory();
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", root);
  await session.attach(page);
  emitStream(emit, answerStream("private content"));
  expect(session.conclude({ answer: "private content", failed: false }).transcriptPath).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test("an enabled transcript is written owner-only and replays to the same observation", async () => {
  process.env[WIRE_TRANSCRIPT_ENV] = "1";
  const root = join(temporaryDirectory(), "wire-transcripts");
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", root);
  await session.attach(page);
  emitStream(emit, answerStream("recorded answer"));

  const path = session.conclude({ answer: "recorded answer", failed: false }).transcriptPath!;
  expect(path).toBeDefined();
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(root).mode & 0o077).toBe(0);
  }
  const transcript = JSON.parse(readFileSync(path, "utf8")) as { raw: string; observation: { answer: string } };
  // The recorded bytes are what a replay consumes, so they must reproduce the same conclusion.
  expect(observeWireStream(streamOf(transcript.raw)).answer).toBe(transcript.observation.answer);
  expect(transcript.observation.answer).toBe("recorded answer");
});

test("a trace id that is not a safe filename is refused rather than written", () => {
  const root = temporaryDirectory();
  const transcript = buildWireTranscript("../escape", streamOf(answerStream("x")), observeWireStream(streamOf(answerStream("x"))));
  expect(writeWireTranscript(root, transcript)).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test("retained transcripts are bounded so a long-lived daemon does not keep every turn", () => {
  const root = join(temporaryDirectory(), "wire-transcripts");
  const stream = streamOf(answerStream("x"));
  const observation = observeWireStream(stream);
  for (let index = 0; index < 25; index += 1) {
    const transcript = buildWireTranscript(`trace_${index}`, stream, observation, new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
    writeWireTranscript(root, transcript);
  }
  expect(readdirSync(root).length).toBeLessThanOrEqual(20);
});

test("the shadow log reports measurements rather than conversation text", () => {
  const stream = streamOf(answerStream("a secret answer"));
  const line = chatGptWireShadowLog("trace_1", {
    comparison: "agreed",
    wireChars: 15,
    domChars: 15,
    observation: observeWireStream(stream),
  });
  expect(line).toContain("comparison=agreed");
  expect(line).toContain("wireChars=15");
  expect(line).not.toContain("secret answer");
});

function streamOf(sse: string, status = 200): ChatGptWireStream {
  return {
    id: "w1",
    method: "POST",
    framing: "sse",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status,
    startedAt: 1,
    endedAt: 2,
    closed: true,
    frames: decodeSseStream(sse),
    raw: sse,
    truncated: false,
    observedLength: sse.length,
  };
}

test("the conversation stream is picked out of ordinary backend traffic", async () => {
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  // Ordinary page traffic first, then the turn's conversation request.
  emit({ kind: "request", id: "a", method: "GET", url: "https://chatgpt.com/backend-api/me", at: 1 });
  emit({ kind: "response", id: "a", status: 200, at: 2 });
  emit({ kind: "chunk", id: "a", text: "{\"user\":1}", at: 3 });
  emit({ kind: "end", id: "a", at: 4 });
  emitStream(emit, answerStream("the answer"));
  emit({ kind: "request", id: "z", method: "GET", url: "https://chatgpt.com/backend-api/settings", at: 9 });
  emit({ kind: "response", id: "z", status: 200, at: 10 });
  emit({ kind: "end", id: "z", at: 11 });

  const result = session.conclude({ answer: "the answer", failed: false });
  expect(result.comparison).toBe("agreed");
  expect(result.observation?.answer).toBe("the answer");
});

test("a renamed conversation endpoint is still found by what it carried", async () => {
  // Naming the endpoint in advance is what made the first live run report zero frames while the
  // turn itself succeeded. Identifying it by carrying event-stream frames survives a rename.
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emit({ kind: "request", id: "s", method: "POST", url: "https://chatgpt.com/backend-api/v2/some-new-name", at: 1 });
  emit({ kind: "response", id: "s", status: 200, at: 2 });
  emit({ kind: "chunk", id: "s", text: answerStream("renamed endpoint"), at: 3 });
  emit({ kind: "end", id: "s", at: 4 });
  expect(session.conclude({ answer: "renamed endpoint", failed: false }).comparison).toBe("agreed");
});

test("observed and streaming paths are reported without query strings", async () => {
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emit({ kind: "request", id: "a", method: "GET", url: "https://chatgpt.com/backend-api/me?token=secret", at: 1 });
  emit({ kind: "response", id: "a", status: 200, at: 2 });
  emit({ kind: "end", id: "a", at: 3 });
  emitStream(emit, answerStream("x"));
  session.conclude({ answer: "x", failed: false });

  const snapshot = chatGptWireTelemetrySnapshot();
  expect(snapshot.observed_paths).toEqual(["/backend-api/f/conversation", "/backend-api/me"]);
  // Only the request that carried frames; this is where a turn's answer travels.
  expect(snapshot.streaming_paths).toEqual(["/backend-api/f/conversation"]);
  expect(JSON.stringify(snapshot)).not.toContain("secret");
});

test("a JSON handshake on a conversation path does not outrank the request that carried the turn", async () => {
  // `/f/conversation/prepare` returns a small JSON body that decodes to no frames. Selecting by
  // path name picked it over the request holding the answer, and reported the turn as unobserved
  // while its data sat in the collector.
  const { page, emit } = fakePage();
  const session = new ChatGptWireShadowSession("trace_1", temporaryDirectory());
  await session.attach(page);
  emitStream(emit, answerStream("the answer"));
  emit({ kind: "request", id: "p", method: "POST", url: "https://chatgpt.com/backend-api/f/conversation/prepare", at: 5 });
  emit({ kind: "response", id: "p", status: 200, at: 6 });
  emit({ kind: "chunk", id: "p", text: "{\"status\":\"ok\"}", at: 7 });
  emit({ kind: "end", id: "p", at: 8 });

  const result = session.conclude({ answer: "the answer", failed: false });
  expect(result.comparison).toBe("agreed");
  expect(result.observation?.answer).toBe("the answer");
});
