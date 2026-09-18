import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  chatGptNetworkError,
  chromiumNetworkErrorCode,
  withChatGptServerStatement,
  withoutCallLog,
  withoutPlaywrightCallLog,
} from "../src/adapters/chatgpt-web/network-error";

/** The exact shape a live failure produced, call log and all. */
const LIVE_FAILURE = `goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/?temporary-chat=true
Call log:
  - navigating to "https://chatgpt.com/?temporary-chat=true", waiting until "domcontentloaded"
`;

test("a live transport failure becomes a message that names the cause and what to check", () => {
  const error = chatGptNetworkError(new Error(LIVE_FAILURE))!;
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error.message).toContain("ERR_CONNECTION_CLOSED");
  expect(error.message).toContain("proxy is running but its upstream node is dead");
  expect(error.code).toBe("chatgpt_network_unreachable");
  expect(error.status).toBe(502);
  // Playwright's call log describes its own waiting loop, never the reason the connection failed.
  expect(error.message).not.toContain("Call log");
  expect(error.message).not.toContain("domcontentloaded");
});

test("the original failure is kept as the cause, so nothing is lost by rewriting the message", () => {
  const original = new Error(LIVE_FAILURE);
  expect(chatGptNetworkError(original)!.cause).toBe(original);
});

test("a failure that cannot resolve itself between attempts is not marked retryable", () => {
  // Retrying a refused proxy only delays the message that would have helped; the live failure
  // reconnected five times before giving up.
  expect(chatGptNetworkError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))!.retryable).toBeFalse();
  expect(chatGptNetworkError(new Error("net::ERR_INTERNET_DISCONNECTED"))!.retryable).toBeFalse();
  expect(chatGptNetworkError(new Error("net::ERR_NAME_NOT_RESOLVED"))!.retryable).toBeFalse();
  expect(chatGptNetworkError(new Error("net::ERR_CERT_AUTHORITY_INVALID"))!.retryable).toBeFalse();
  // A dropped or reset connection can be a blip.
  expect(chatGptNetworkError(new Error("net::ERR_CONNECTION_RESET"))!.retryable).toBeTrue();
  expect(chatGptNetworkError(new Error("net::ERR_TIMED_OUT"))!.retryable).toBeTrue();
});

test("each known code says what to check rather than only what happened", () => {
  expect(chatGptNetworkError(new Error("net::ERR_TUNNEL_CONNECTION_FAILED"))!.message)
    .toContain("upstream node is likely unavailable");
  expect(chatGptNetworkError(new Error("net::ERR_NAME_NOT_RESOLVED"))!.message).toContain("DNS");
  expect(chatGptNetworkError(new Error("net::ERR_SSL_PROTOCOL_ERROR"))!.message).toContain("intercepting");
});

test("an unknown code is named rather than explained away", () => {
  // A guess here would be the same mistake as reading the DOM: confident and wrong.
  const error = chatGptNetworkError(new Error("net::ERR_SOMETHING_NEW"))!;
  expect(error.message).toContain("ERR_SOMETHING_NEW");
  expect(error.message).toContain("could not complete the connection");
  expect(error.retryable).toBeTrue();
});

test("a failure that is not a transport one is left to the layer that understands it", () => {
  expect(chatGptNetworkError(new Error("ChatGPT displayed 'Stopped thinking'"))).toBeUndefined();
  expect(chatGptNetworkError(undefined)).toBeUndefined();
  expect(chatGptNetworkError({ message: "net::ERR_CONNECTION_CLOSED" })).toBeUndefined();
});

test("the code is read from a string failure as well as from an Error", () => {
  expect(chromiumNetworkErrorCode("goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/")).toBe("ERR_CONNECTION_CLOSED");
  expect(chromiumNetworkErrorCode(new Error("net::ERR_TIMED_OUT"))).toBe("ERR_TIMED_OUT");
  expect(chromiumNetworkErrorCode("no code here")).toBeUndefined();
});

test("stripping the call log keeps the sentence that states the failure", () => {
  expect(withoutCallLog(LIVE_FAILURE))
    .toBe("goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/?temporary-chat=true");
  expect(withoutCallLog("plain failure")).toBe("plain failure");
});

test("trimming an error keeps its identity, because downstream decisions are made on its type", () => {
  // Abort reasons, retry classification, and the compaction handoff signal are all `instanceof`.
  const abort = new DOMException("waiting failed\nCall log:\n  - waiting for selector", "AbortError");
  const trimmed = withoutPlaywrightCallLog(abort);
  expect(trimmed).toBe(abort);
  expect(trimmed).toBeInstanceOf(DOMException);
  expect(trimmed.name).toBe("AbortError");
  expect(trimmed.message).toBe("waiting failed");
});

test("an error without a call log is returned untouched", () => {
  const error = new Error("something else failed");
  expect(withoutPlaywrightCallLog(error)).toBe(error);
  expect(error.message).toBe("something else failed");
  expect(withoutPlaywrightCallLog("not an error")).toBe("not an error");
});

test("what ChatGPT said leads the message, and the page's reading is kept behind it", () => {
  // A real failure: an upstream capacity limit that the page path read as an expired login. Leading
  // with the inference sends the reader to log in again for nothing; dropping it would hide that
  // the two readings disagreed, and it is what the retry classification was decided on.
  const error = new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
  const reported = withChatGptServerStatement(error, "Selected model is at capacity.");
  expect(reported).toBe(error);
  expect(reported.message).toStartWith("ChatGPT reported: Selected model is at capacity.");
  expect(reported.message).toContain("ChatGPT web login is expired");
});

test("a failure the page already reported correctly is not restated", () => {
  const error = new Error("ChatGPT ended the turn: Selected model is at capacity.");
  expect(withChatGptServerStatement(error, "Selected model is at capacity.").message)
    .toBe("ChatGPT ended the turn: Selected model is at capacity.");
});

test("a turn that failed with nothing on the stream keeps the reading it has", () => {
  const error = new Error("ChatGPT stopped responding after the task started");
  expect(withChatGptServerStatement(error, undefined).message)
    .toBe("ChatGPT stopped responding after the task started");
  expect(withChatGptServerStatement(error, "   ").message)
    .toBe("ChatGPT stopped responding after the task started");
  expect(withChatGptServerStatement("not an error", "something")).toBe("not an error");
});

test("the statement survives an error whose message cannot be assigned", () => {
  // Abort reasons and the compaction handoff are decided by `instanceof`, so the error object has
  // to be the same one; `DOMException.message` is a prototype getter and assignment to it throws.
  const abort = new DOMException("waiting failed\nCall log:\n  - waiting", "AbortError");
  const reported = withChatGptServerStatement(abort, "Something went wrong.");
  expect(reported).toBe(abort);
  expect(reported).toBeInstanceOf(DOMException);
  expect(reported.name).toBe("AbortError");
  expect(reported.message).toBe("ChatGPT reported: Something went wrong. (the page was read as: waiting failed)");
});
