import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  isChatGptCompactionHandoffRaceCandidate,
  isChatGptRetainedTurnRetryCandidate,
  isChatGptTurnOwnershipFailure,
} from "../src/adapters/chatgpt-web/recovery-policy";

function upstreamError(code = "upstream_server_error"): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("ChatGPT ended the response unexpectedly", {
    status: 502,
    errorType: "server_error",
    code,
    retryable: true,
  });
}

test("the recovery policy treats upstream response errors as a single transient class", () => {
  expect(isChatGptCompactionHandoffRaceCandidate(upstreamError())).toBeTrue();
  expect(isChatGptRetainedTurnRetryCandidate(upstreamError())).toBeTrue();
  expect(isChatGptCompactionHandoffRaceCandidate(new Error("ChatGPT response DOM disappeared"))).toBeTrue();
  expect(isChatGptRetainedTurnRetryCandidate(new Error("ChatGPT browser observation timed out"))).toBeTrue();
});

test("the recovery policy keeps ownership and permanent errors fail-closed", () => {
  expect(isChatGptTurnOwnershipFailure(new Error("Codex Native retired the turn binding before its tool work completed"))).toBeTrue();
  expect(isChatGptCompactionHandoffRaceCandidate(upstreamError("chatgpt_session_expired"))).toBeFalse();
  expect(isChatGptRetainedTurnRetryCandidate(new Error("ChatGPT rate limit: too many requests"))).toBeFalse();
  expect(isChatGptTurnOwnershipFailure(new Error("ChatGPT response DOM disappeared"))).toBeFalse();
});
