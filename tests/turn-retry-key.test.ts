import { expect, test } from "bun:test";
import { chatGptCompactionEpochFingerprint } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptTurnRetryKey } from "../src/adapters/chatgpt-web/turn-execution";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const THREAD_ID = "thread_retry_budget";
/** Codex keeps one turn id across a compaction boundary; that reuse is the whole point here. */
const TURN_ID = "turn_reused_across_compaction";

function request(input: unknown[], compactionRequest = false): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/high",
    context: { messages: [] },
    stream: true,
    options: { reasoning: "high" },
    _rawBody: {
      model: "chatgpt-web/high",
      input,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: THREAD_ID, turn_id: TURN_ID }),
      },
    },
    ...(compactionRequest ? { _compactionRequest: true } : {}),
  };
}

const userMessage = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const compactionRecord = (summary: string) => ({ type: "compaction", encrypted_content: summary });
const v1Summary = (summary: string) => ({ role: "user", content: `${SUMMARY_PREFIX}\n${summary}` });

test("the retry budget of a reused turn id is scoped to its compaction epoch", () => {
  // The same Codex turn, before and after it compacted. A budget keyed on turn id alone charged
  // the pre-compaction conversation's failures to the fresh post-compaction one, which then failed
  // immediately with a non-retryable error before any browser work.
  const before = chatGptTurnRetryKey(request([userMessage("work on the task")]));
  const after = chatGptTurnRetryKey(request([
    userMessage("work on the task"),
    compactionRecord("checkpoint-1"),
  ]));
  expect(after).not.toBe(before);
});

test("a v1 summary opens a new epoch for the budget as well", () => {
  const before = chatGptTurnRetryKey(request([userMessage("work on the task")]));
  const after = chatGptTurnRetryKey(request([
    userMessage("work on the task"),
    v1Summary("checkpoint-1"),
  ]));
  expect(after).not.toBe(before);
});

test("consecutive epochs of one turn each get their own budget", () => {
  const first = chatGptTurnRetryKey(request([userMessage("task"), compactionRecord("checkpoint-1")]));
  const second = chatGptTurnRetryKey(request([
    userMessage("task"),
    compactionRecord("checkpoint-1"),
    compactionRecord("checkpoint-2"),
  ]));
  expect(second).not.toBe(first);
});

test("retries accumulate within one epoch, so appending ordinary turns keeps the same budget", () => {
  // Otherwise the budget would reset on every message and never bound anything.
  const first = chatGptTurnRetryKey(request([userMessage("task"), compactionRecord("checkpoint-1")]));
  const later = chatGptTurnRetryKey(request([
    userMessage("task"),
    compactionRecord("checkpoint-1"),
    userMessage("follow-up"),
  ]));
  expect(later).toBe(first);
});

test("a compaction request and the response turn that follows it hold separate budgets", () => {
  const input = [userMessage("task")];
  expect(chatGptTurnRetryKey(request(input, true))).not.toBe(chatGptTurnRetryKey(request(input)));
});

test("the epoch fingerprint ignores transport ids that carry no semantic change", () => {
  // Codex can rebuild the same checkpoint under a new item id; rotating the budget for that would
  // hand a still-failing conversation a fresh allowance.
  const withId = request([userMessage("task"), { ...compactionRecord("checkpoint-1"), id: "item_1" }]);
  const reissued = request([userMessage("task"), { ...compactionRecord("checkpoint-1"), id: "item_2" }]);
  expect(chatGptCompactionEpochFingerprint(reissued)).toBe(chatGptCompactionEpochFingerprint(withId));
  expect(chatGptTurnRetryKey(reissued)).toBe(chatGptTurnRetryKey(withId));
});

test("a turn without native turn id metadata still fails closed", () => {
  const anonymous: CodexParsedRequest = {
    modelId: "chatgpt-web/high",
    context: { messages: [] },
    stream: true,
    options: { reasoning: "high" },
    _rawBody: { model: "chatgpt-web/high", input: [] },
  };
  expect(() => chatGptTurnRetryKey(anonymous)).toThrow("turn_id");
});
