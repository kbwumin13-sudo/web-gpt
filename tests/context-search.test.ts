import { beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexMessage } from "../src/types";
import {
  chatGptContextLog,
  chatGptContextTelemetrySnapshot,
  recordChatGptContextOmitted,
  resetChatGptContextTelemetry,
} from "../src/adapters/chatgpt-web/context-telemetry";
import { defaultBrokerEndpoint } from "../src/config";

/**
 * Searching the canonical history used to require the stored text to contain the query as one
 * string. A model that asked the right question in its own words got an empty result, and an empty
 * result reads like an empty history: the turn that motivated this searched once, matched nothing,
 * and answered about three books it found on the filesystem instead of the one the conversation
 * named eighty times.
 */

const environment: ChatGptTurnEnvironment = {
  cwd: "/tmp/context-search",
  roots: ["/tmp/context-search"],
  writableRoots: [],
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  tools: [],
};

const messages: CodexMessage[] = [
  { role: "user", content: "Let's read 《三体》 together and take notes.", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "《三体》 is a novel by Liu Cixin." }], timestamp: 2 },
  { role: "user", content: "Now switch to the deployment checklist.", timestamp: 3 },
  { role: "assistant", content: [{ type: "text", text: "The deployment checklist has four steps." }], timestamp: 4 },
];

function endpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

async function withSearch<T>(
  traceId: string,
  body: (
    search: (arguments_: Record<string, unknown>) => Promise<Record<string, unknown>>,
    read: (arguments_: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  const socketPath = endpoint(`cgw-context-search-${process.pid}-${Date.now()}-${traceId}`);
  const broker = TurnBroker.forSocket(socketPath);
  const token = await broker.register(environment, 60_000, traceId, { messages });
  const retrieve = (action: "search" | "read") => (arguments_: Record<string, unknown>) =>
    callTurnBroker<Record<string, unknown>>(socketPath, {
      method: "context_read",
      token,
      contextAction: action,
      arguments: arguments_,
    });
  try {
    return await body(retrieve("search"), retrieve("read"));
  } finally {
    broker.revoke(token);
    await broker.close();
  }
}

beforeEach(() => {
  resetChatGptContextTelemetry();
});

test("a query no single message contains still finds the messages carrying its words", async () => {
  await withSearch("terms", async search => {
    const found = await search({ query: "checklist steps" });
    // No record contains that phrase. Both records carry part of it, and the one carrying more of
    // it ranks first.
    expect(found).toMatchObject({
      total: 2,
      messages: [
        { message_index: 3, matched_terms: ["checklist", "steps"] },
        { message_index: 2, matched_terms: ["checklist"] },
      ],
    });
    expect(found.messages).not.toHaveProperty("0.exact_phrase");
  });
});

test("a phrase that already matched returns what it returned before, ahead of the weaker matches", async () => {
  await withSearch("phrase", async search => {
    const found = await search({ query: "deployment checklist" });
    expect(found).toMatchObject({
      total: 2,
      messages: [
        { message_index: 2, exact_phrase: true },
        { message_index: 3, exact_phrase: true },
      ],
    });
  });
});

test("a CJK query written as one clause matches the records naming its subject", async () => {
  await withSearch("cjk", async search => {
    // CJK separates on nothing, so whole-phrase containment could never match this against a
    // sentence that merely mentions 三体. Character bigrams give it something to match on.
    const found = await search({ query: "三体的作者是谁" });
    expect(found).toMatchObject({
      total: 2,
      messages: [
        { message_index: 0, matched_terms: ["三体"] },
        { message_index: 1, matched_terms: ["三体"] },
      ],
    });
  });
});

test("a query that matches nothing says so and shows what the history does hold", async () => {
  await withSearch("no-match", async search => {
    const found = await search({ query: "kubernetes" });
    expect(found).toMatchObject({
      total: 0,
      messages: [],
      next_offset: null,
      no_match: {
        reason: "No canonical record contained the query or any of its terms.",
        recent_messages: [
          { message_index: 0 },
          { message_index: 1 },
          { message_index: 2 },
          { message_index: 3 },
        ],
      },
    });
  });
});

test("a long query cannot make one search scan the history hundreds of times", async () => {
  await withSearch("term-cap", async search => {
    // 60 distinct Han characters is 59 bigrams, and the query limit allows 500 characters. Each
    // term costs a pass over every stored message, so the terms are capped — whole words first,
    // since they are the more selective of the two.
    const clause = String.fromCodePoint(...Array.from({ length: 60 }, (_, index) => 0x4e00 + index));
    const found = await search({ query: clause });
    const terms = found.query_terms as string[];
    expect(terms).toHaveLength(24);
    expect(terms[0]).toBe(clause);
    expect(terms.slice(1).every(term => [...term].length === 2)).toBe(true);
  });
});

test("an empty query still browses the history in order", async () => {
  await withSearch("browse", async search => {
    const found = await search({ offset: 1, limit: 2 });
    expect(found).toMatchObject({
      total: 4,
      next_offset: 3,
      messages: [{ message_index: 1 }, { message_index: 2 }],
    });
    // Rank means nothing without a query, so nothing is reported about one.
    expect(found).not.toHaveProperty("query_terms");
  });
});

test("a search that found nothing, and one never followed by a read, are counted apart", async () => {
  await withSearch("telemetry", async (search, read) => {
    recordChatGptContextOmitted("telemetry", 40);
    await search({ query: "kubernetes" });
    await search({ query: "checklist" });
    expect(chatGptContextTelemetrySnapshot()).toMatchObject({
      searches: 2,
      search_zero_matches: 1,
      // Still open: whether a read follows is only decided when the turn answers.
      search_without_followup_read: 0,
    });
    await read({ message_indices: [3] });
    chatGptContextLog("telemetry");
    expect(chatGptContextTelemetrySnapshot()).toMatchObject({
      searches: 2,
      reads: 1,
      search_zero_matches: 1,
      search_without_followup_read: 0,
      retrieved_turns: 1,
    });
  });
});

test("a turn that located records and then never opened one is counted", async () => {
  await withSearch("unread", async search => {
    recordChatGptContextOmitted("unread", 40);
    await search({ query: "checklist" });
    chatGptContextLog("unread");
    // The retrieval ran, so `retrieved_turns` counts it. Nothing it found was ever read.
    expect(chatGptContextTelemetrySnapshot()).toMatchObject({
      searches: 1,
      reads: 0,
      retrieved_turns: 1,
      search_without_followup_read: 1,
    });
  });
});

test("a search on a turn sent a complete packet is counted without inventing a trade", async () => {
  await withSearch("complete", async search => {
    await search({ query: "kubernetes" });
    chatGptContextLog("complete");
    expect(chatGptContextTelemetrySnapshot()).toMatchObject({
      omitted_turns: 0,
      retrieved_turns: 0,
      searches: 1,
      search_zero_matches: 1,
      search_without_followup_read: 1,
    });
  });
});
