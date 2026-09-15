import { beforeEach, expect, test } from "bun:test";
import {
  chatGptRetainedIneligibleLog,
  chatGptRetainedOutcomeLog,
  chatGptRetainedTelemetrySnapshot,
  recordChatGptRetainedIneligible,
  recordChatGptRetainedOutcome,
  resetChatGptRetainedTelemetry,
} from "../src/adapters/chatgpt-web/retained-telemetry";
import type { ChatGptConversationKeyComponents } from "../src/adapters/chatgpt-web/conversation-key";

function components(
  overrides: Partial<ChatGptConversationKeyComponents> = {},
): ChatGptConversationKeyComponents {
  return {
    threadId: "thread_abcdef123456789",
    model: "model-fp",
    reasoning: "reasoning-fp",
    systemPrompt: "system-fp",
    compaction: "compaction-fp",
    ...overrides,
  };
}

beforeEach(() => {
  resetChatGptRetainedTelemetry();
});

test("the first turn of a thread is a miss that is not blamed on rotation", () => {
  expect(recordChatGptRetainedOutcome(components(), false)).toEqual({
    kind: "miss",
    causes: ["first_turn"],
  });
});

test("a reused conversation is a hit and carries no cause", () => {
  recordChatGptRetainedOutcome(components(), false);
  expect(recordChatGptRetainedOutcome(components(), true)).toEqual({ kind: "hit" });
});

test("each rotated key component is named as the cause of the miss", () => {
  const cases: Array<[Partial<ChatGptConversationKeyComponents>, string]> = [
    [{ model: "other" }, "model_changed"],
    [{ reasoning: "other" }, "reasoning_changed"],
    [{ systemPrompt: "other" }, "system_prompt_changed"],
    [{ compaction: "other" }, "compaction_epoch_changed"],
  ];
  for (const [rotated, cause] of cases) {
    resetChatGptRetainedTelemetry();
    recordChatGptRetainedOutcome(components(), true);
    expect(recordChatGptRetainedOutcome(components(rotated), false)).toEqual({
      kind: "miss",
      causes: [cause as never],
    });
  }
});

test("several components rotating at once are all reported", () => {
  recordChatGptRetainedOutcome(components(), true);
  expect(recordChatGptRetainedOutcome(components({ model: "other", systemPrompt: "other" }), false))
    .toEqual({ kind: "miss", causes: ["model_changed", "system_prompt_changed"] });
});

test("an unchanged key that still missed means the browser surface is gone, not rotation", () => {
  recordChatGptRetainedOutcome(components(), true);
  expect(recordChatGptRetainedOutcome(components(), false)).toEqual({
    kind: "miss",
    causes: ["conversation_lost"],
  });
});

test("threads are tracked independently", () => {
  recordChatGptRetainedOutcome(components({ threadId: "thread_one" }), true);
  expect(recordChatGptRetainedOutcome(components({ threadId: "thread_two" }), false)).toEqual({
    kind: "miss",
    causes: ["first_turn"],
  });
  expect(recordChatGptRetainedOutcome(components({ threadId: "thread_one" }), true))
    .toEqual({ kind: "hit" });
});

test("the tracker is bounded so a long-lived daemon cannot grow one entry per thread", () => {
  for (let index = 0; index < 300; index += 1) {
    recordChatGptRetainedOutcome(components({ threadId: `thread_${index}` }), true);
  }
  // The earliest thread was evicted, so its next turn reads as a first turn rather than a rotation.
  expect(recordChatGptRetainedOutcome(components({ threadId: "thread_0" }), false)).toEqual({
    kind: "miss",
    causes: ["first_turn"],
  });
  // A recent thread is still tracked.
  expect(recordChatGptRetainedOutcome(components({ threadId: "thread_299", model: "other" }), false))
    .toEqual({ kind: "miss", causes: ["model_changed"] });
});

test("log lines are greppable and truncate the thread identity", () => {
  expect(chatGptRetainedOutcomeLog({ kind: "hit" }, components()))
    .toBe("[chatgpt-web] retained_conversation hit thread=thread_abcde…");
  expect(chatGptRetainedOutcomeLog(
    { kind: "miss", causes: ["model_changed", "system_prompt_changed"] },
    components(),
  )).toBe(
    "[chatgpt-web] retained_conversation miss cause=model_changed+system_prompt_changed thread=thread_abcde…",
  );
  expect(chatGptRetainedIneligibleLog("compaction_request", undefined))
    .toBe("[chatgpt-web] retained_conversation ineligible cause=compaction_request");
});

test("the snapshot reports no rate before any turn expected retention", () => {
  expect(chatGptRetainedTelemetrySnapshot()).toEqual({
    hits: 0,
    misses: 0,
    hit_rate: null,
    miss_causes: {},
    unexplained_misses: 0,
    ineligible: 0,
    ineligible_causes: {},
  });
});

test("the snapshot aggregates outcomes into a rate and a cause breakdown", () => {
  recordChatGptRetainedOutcome(components({ threadId: "t1" }), false);          // first_turn
  recordChatGptRetainedOutcome(components({ threadId: "t1" }), true);           // hit
  recordChatGptRetainedOutcome(components({ threadId: "t1" }), true);           // hit
  recordChatGptRetainedOutcome(components({ threadId: "t1" }), false);          // conversation_lost
  recordChatGptRetainedOutcome(components({ threadId: "t2", model: "x" }), false); // first_turn

  const snapshot = chatGptRetainedTelemetrySnapshot();
  expect(snapshot.hits).toBe(2);
  expect(snapshot.misses).toBe(3);
  expect(snapshot.hit_rate).toBe(0.4);
  expect(snapshot.miss_causes).toEqual({ conversation_lost: 1, first_turn: 2 });
});

test("a miss naming several rotated components counts each of them", () => {
  recordChatGptRetainedOutcome(components(), true);
  recordChatGptRetainedOutcome(components({ model: "x", reasoning: "y" }), false);
  expect(chatGptRetainedTelemetrySnapshot().miss_causes)
    .toEqual({ model_changed: 1, reasoning_changed: 1 });
});

test("by-design exclusions are counted apart from the hit rate", () => {
  recordChatGptRetainedIneligible("compaction_request");
  recordChatGptRetainedIneligible("compaction_request");
  recordChatGptRetainedIneligible("rolling_checkpoint_model");
  recordChatGptRetainedOutcome(components(), true);

  const snapshot = chatGptRetainedTelemetrySnapshot();
  expect(snapshot.ineligible).toBe(3);
  expect(snapshot.ineligible_causes).toEqual({ compaction_request: 2, rolling_checkpoint_model: 1 });
  // An exclusion never attempted retention, so it cannot drag the rate down.
  expect(snapshot.hit_rate).toBe(1);
  expect(snapshot.misses).toBe(0);
});

test("misses the design explains do not count as unexplained", () => {
  // Every one of these is the system working: a thread starts, an epoch opens a new chat, and a
  // user switching model or reasoning should rotate the conversation.
  recordChatGptRetainedOutcome(components({ threadId: "a" }), false);                 // first_turn
  recordChatGptRetainedOutcome(components({ threadId: "a" }), true);
  recordChatGptRetainedOutcome(components({ threadId: "a", compaction: "next" }), false);
  recordChatGptRetainedOutcome(components({ threadId: "a", compaction: "next", model: "m2" }), false);

  const snapshot = chatGptRetainedTelemetrySnapshot();
  expect(snapshot.misses).toBe(3);
  expect(snapshot.unexplained_misses).toBe(0);
});

test("a conversation that vanished without its key changing is the number with a target", () => {
  recordChatGptRetainedOutcome(components(), true);
  recordChatGptRetainedOutcome(components(), false);
  recordChatGptRetainedOutcome(components(), false);

  const snapshot = chatGptRetainedTelemetrySnapshot();
  expect(snapshot.miss_causes).toEqual({ conversation_lost: 2 });
  expect(snapshot.unexplained_misses).toBe(2);
});
