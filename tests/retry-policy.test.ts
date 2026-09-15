import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptWebTurnRetryPolicy,
  MAX_CHATGPT_WEB_TURN_RETRIES,
  MAX_RETAINED_RESUME_RETRIES,
} from "../src/adapters/chatgpt-web/retry-policy";

function transientError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("ChatGPT response observation temporarily stopped", {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_submitted_turn_failed",
    retryable: true,
  });
}

test("the retained-resume allowance is smaller than the overall retry budget", () => {
  // Otherwise the allowance could never be reached before retries ran out entirely.
  expect(MAX_RETAINED_RESUME_RETRIES).toBeLessThan(MAX_CHATGPT_WEB_TURN_RETRIES);
});

test("the retry count reports recorded failures for one turn and ignores others", () => {
  const policy = new ChatGptWebTurnRetryPolicy();
  expect(policy.retryCount("turn-a")).toBe(0);
  policy.recordRetryableFailure("turn-a", transientError());
  expect(policy.retryCount("turn-a")).toBe(1);
  expect(policy.retryCount("turn-b")).toBe(0);
  policy.recordRetryableFailure("turn-a", transientError());
  expect(policy.retryCount("turn-a")).toBe(2);
});

test("the allowance permits exactly one retained resume before a rebuild is due", () => {
  const policy = new ChatGptWebTurnRetryPolicy();
  const rebuildDue = () => policy.retryCount("turn") > MAX_RETAINED_RESUME_RETRIES;

  expect(rebuildDue()).toBeFalse();          // first attempt
  policy.recordRetryableFailure("turn", transientError());
  expect(rebuildDue()).toBeFalse();          // first retry still resumes
  policy.recordRetryableFailure("turn", transientError());
  expect(rebuildDue()).toBeTrue();           // a second failure condemns the conversation
});

test("a cleared turn starts over and an expired one is pruned", () => {
  const policy = new ChatGptWebTurnRetryPolicy(1_000);
  policy.recordRetryableFailure("turn", transientError(), 0);
  expect(policy.retryCount("turn", 0)).toBe(1);
  policy.clear("turn");
  expect(policy.retryCount("turn", 0)).toBe(0);

  policy.recordRetryableFailure("turn", transientError(), 0);
  expect(policy.retryCount("turn", 999)).toBe(1);
  expect(policy.retryCount("turn", 1_000)).toBe(0);
});
