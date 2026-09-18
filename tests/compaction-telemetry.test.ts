import { beforeEach, expect, test } from "bun:test";
import {
  chatGptCompactionTelemetrySnapshot,
  recordChatGptCompactionFreshReason,
  recordChatGptCompactionSettled,
  recordChatGptCompactionStarted,
  resetChatGptCompactionTelemetry,
} from "../src/adapters/chatgpt-web/compaction-telemetry";

beforeEach(() => {
  resetChatGptCompactionTelemetry();
});

test("a round that summarised correctly and reached nobody is its own outcome", () => {
  // The case that produced a user reporting compaction "failed" with nothing on disk agreeing: the
  // round ran four and a half minutes, the browser turn completed, the two readings of it agreed
  // exactly, and the caller had already given up. The branch that discarded it said nothing.
  recordChatGptCompactionStarted("key_1", "fresh", 1_000);
  const line = recordChatGptCompactionSettled("key_1", "abandoned", 0, 271_000);
  expect(line).toBe("[chatgpt-web] compaction abandoned mode=fresh durationMs=270000 summaryChars=0");
  expect(chatGptCompactionTelemetrySnapshot()).toMatchObject({
    rounds: 1,
    fresh_rounds: 1,
    delivered: 0,
    abandoned: 1,
    failed: 0,
    longest_ms: 270_000,
  });
});

test("a delivered round reports what it produced and how long the caller waited", () => {
  recordChatGptCompactionStarted("key_1", "retained", 1_000);
  expect(recordChatGptCompactionSettled("key_1", "delivered", 4_830, 31_000))
    .toBe("[chatgpt-web] compaction delivered mode=retained durationMs=30000 summaryChars=4830");
  expect(chatGptCompactionTelemetrySnapshot()).toMatchObject({ delivered: 1, abandoned: 0, longest_ms: 30_000 });
});

test("why a round could not use a retained conversation is counted on its own", () => {
  // Every compaction in the managed-browser deployment fell back for the same reason. Counting it
  // makes a structural limit a number rather than a line someone has to notice in a log.
  recordChatGptCompactionFreshReason("managed_browser_no_retained_surface");
  recordChatGptCompactionFreshReason("managed_browser_no_retained_surface");
  recordChatGptCompactionFreshReason("handoff_timeout");
  expect(chatGptCompactionTelemetrySnapshot().fresh_reasons).toEqual({
    handoff_timeout: 1,
    managed_browser_no_retained_surface: 2,
  });
});

test("a round that produced nothing is counted apart from one nobody collected", () => {
  recordChatGptCompactionStarted("key_1", "fresh");
  recordChatGptCompactionSettled("key_1", "failed", 0);
  expect(chatGptCompactionTelemetrySnapshot()).toMatchObject({ failed: 1, abandoned: 0, delivered: 0 });
});

test("a settlement for a round that was never tracked still counts but reports no line", () => {
  // The round can be adopted by a reconnecting caller after this process forgot it; the totals
  // must not silently drop that outcome.
  expect(recordChatGptCompactionSettled("unknown", "delivered", 12)).toBeUndefined();
  expect(chatGptCompactionTelemetrySnapshot()).toMatchObject({ delivered: 1, rounds: 0 });
});

test("rounds that never settle do not accumulate without bound", () => {
  for (let index = 0; index < 100; index += 1) recordChatGptCompactionStarted(`key_${index}`, "fresh");
  expect(chatGptCompactionTelemetrySnapshot()).toMatchObject({ rounds: 100, fresh_rounds: 100 });
  expect(recordChatGptCompactionSettled("key_0", "delivered", 1)).toBeUndefined();
  expect(recordChatGptCompactionSettled("key_99", "delivered", 1)).toBeDefined();
});
