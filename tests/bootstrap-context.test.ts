import { expect, test } from "bun:test";
import {
  BOOTSTRAP_RECENT_EXCHANGE_MAX_CHARS,
  bootstrapContractMessages,
} from "../src/adapters/chatgpt-web/prompt";
import type { CodexMessage } from "../src/types";

const text = (role: CodexMessage["role"], body: string, timestamp = 0): CodexMessage => ({
  role,
  content: [{ type: "text", text: body }],
  timestamp,
} as CodexMessage);

const roles = (messages: readonly CodexMessage[]): string[] => messages.map(message => message.role);
const bodies = (messages: readonly CodexMessage[]): string[] => messages.map(message => (
  typeof message.content === "string"
    ? message.content
    : message.content.map(part => ("text" in part && typeof part.text === "string" ? part.text : "")).join("")
));

test("a follow-up carries the exchange it is following up on", () => {
  // "Tell me about this book" contains no term to search for. A packet holding only that sentence
  // left the model searching for words it did not have: one `codex_context_search` and one
  // `codex_context_read` failed to surface a book named eighty times in the stored conversation,
  // and it answered about three unrelated ones it found on disk instead.
  const selected = bootstrapContractMessages([
    text("user", "Turn the PDF into a Skill."),
    text("toolResult", "…hundreds of tool records…"),
    text("assistant", "Done. Built SKILL.md for Women in the Chinese Enlightenment."),
    text("user", "Tell me about this book."),
  ]);
  expect(roles(selected)).toEqual(["user", "assistant", "user"]);
  expect(bodies(selected).at(1)).toContain("Women in the Chinese Enlightenment");
  expect(bodies(selected).at(-1)).toBe("Tell me about this book.");
});

test("tool records stay with retrieval, which is where the bulk of a turn belongs", () => {
  const selected = bootstrapContractMessages([
    text("user", "first"),
    text("toolResult", "a".repeat(50_000)),
    text("assistant", "reply"),
    text("user", "follow-up"),
  ]);
  expect(roles(selected)).toEqual(["user", "assistant", "user"]);
});

test("a previous reply too large to carry is left to retrieval rather than excerpted", () => {
  // A partial record that reads as a whole one is what makes a model answer confidently from half
  // a fact, so an oversized exchange is omitted outright and the contract still points at
  // retrieval.
  const selected = bootstrapContractMessages([
    text("user", "question"),
    text("assistant", "a".repeat(BOOTSTRAP_RECENT_EXCHANGE_MAX_CHARS + 1)),
    text("user", "follow-up"),
  ]);
  expect(roles(selected)).toEqual(["user"]);
  expect(bodies(selected)).toEqual(["follow-up"]);
});

test("the reply is carried even when the question that produced it is not", () => {
  const selected = bootstrapContractMessages([
    text("user", "a".repeat(BOOTSTRAP_RECENT_EXCHANGE_MAX_CHARS)),
    text("assistant", "the reply"),
    text("user", "follow-up"),
  ]);
  expect(roles(selected)).toEqual(["assistant", "user"]);
});

test("a chat the person can already see is not sent its own history again", () => {
  // Zero Risk drives a chat someone is looking at, and the launcher may reuse it.
  const selected = bootstrapContractMessages([
    text("user", "question"),
    text("assistant", "Earlier answer already visible in ChatGPT."),
    text("user", "follow-up"),
  ], 0);
  expect(bodies(selected)).toEqual(["follow-up"]);
});

test("the bootstrap always carries effective developer instructions", () => {
  const selected = bootstrapContractMessages([
    text("developer", "workspace is read-only"),
    text("user", "inspect the repository"),
    text("assistant", "I will inspect it."),
    text("user", "continue"),
  ]);
  expect(roles(selected)).toEqual(["developer", "user", "assistant", "user"]);
  expect(bodies(selected).at(0)).toBe("workspace is read-only");
});

test("the first turn of a conversation carries only itself", () => {
  expect(bodies(bootstrapContractMessages([text("user", "first request")]))).toEqual(["first request"]);
  expect(bootstrapContractMessages([])).toEqual([]);
});

test("a conversation with no task message still yields its last record", () => {
  const selected = bootstrapContractMessages([text("assistant", "orphan")]);
  expect(bodies(selected)).toEqual(["orphan"]);
});
