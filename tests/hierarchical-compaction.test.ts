import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET,
  CHATGPT_COMPACTION_LEAF_TOKEN_BUDGET,
  CHATGPT_COMPACTION_SEGMENTS_TAG,
  MAX_CHATGPT_COMPACTION_LEAVES,
  elideCodexMessageText,
  planHierarchicalCompaction,
} from "../src/adapters/chatgpt-web/hierarchical-compaction";
import { chatGptPromptJsonBytes, compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { COMPACT_PROMPT } from "../src/responses/compaction";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

// A fresh compaction runs read-only: index.ts clears localToolsEnabled for the compaction turn.
const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function compactionRequest(history: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: {
      systemPrompt: ["You are Codex."],
      messages: [...history, { role: "user", content: COMPACT_PROMPT, timestamp: 9_000 }],
    },
    options: { reasoning: "high" },
    _compactionRequest: true,
  };
}

function userTurns(count: number, charsEach: number): CodexMessage[] {
  return Array.from({ length: count }, (_turn, index) => ({
    role: "user" as const,
    content: `record ${index} ${"word ".repeat(Math.floor(charsEach / 5))}`,
    timestamp: index + 1,
  }));
}

function compiledLeafText(request: CodexParsedRequest): string {
  return compileChatGptWebPrompt(request, capabilities, undefined, {
    compactionPromptJsonByteBudget: CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET,
  }).text;
}

test("a history that fits one message keeps the single-turn path", () => {
  expect(planHierarchicalCompaction(compactionRequest(userTurns(3, 400)), capabilities)).toBeUndefined();
});

test("a non-compaction request is never planned", () => {
  const parsed = compactionRequest(userTurns(200, 4_000));
  delete parsed._compactionRequest;
  expect(planHierarchicalCompaction(parsed, capabilities)).toBeUndefined();
});

test("every planned leaf fits one ChatGPT message without the compiler trimming history", () => {
  const plan = planHierarchicalCompaction(compactionRequest(userTurns(90, 6_000)), capabilities);
  expect(plan).toBeDefined();
  expect(plan!.leaves.length).toBeGreaterThan(1);
  for (const leaf of plan!.leaves) {
    const compiled = compileChatGptWebPrompt(leaf.request, capabilities, undefined, {
      compactionPromptJsonByteBudget: CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET,
    });
    // A trim here would mean the leaf silently dropped history, which is the failure the planner
    // exists to replace — not something it may do quietly inside a segment.
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    expect(compiled.multipart).toBeUndefined();
    expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET);
    expect(estimateTokens(compiled.text, leaf.request.modelId)).toBeLessThanOrEqual(CHATGPT_COMPACTION_LEAF_TOKEN_BUDGET);
  }
}, 60_000);

test("leaves carry the whole history exactly once, in order", () => {
  const history = userTurns(60, 6_000);
  const plan = planHierarchicalCompaction(compactionRequest(history), capabilities);
  expect(plan).toBeDefined();
  expect(plan!.droppedMessages).toBe(0);
  const carried = plan!.leaves.flatMap(leaf => leaf.request.context.messages.slice(0, -1));
  expect(carried.map(message => message.timestamp)).toEqual(history.map(message => message.timestamp));
  expect(plan!.leaves.reduce((total, leaf) => total + leaf.messageCount, 0)).toBe(history.length);
}, 60_000);

test("a leaf states its own position so its summary is not written as the whole task", () => {
  const plan = planHierarchicalCompaction(compactionRequest(userTurns(60, 6_000)), capabilities);
  const total = plan!.leaves.length;
  for (const leaf of plan!.leaves) {
    const instruction = leaf.request.context.messages.at(-1)!;
    expect(instruction.content).toContain(`SEGMENT ${leaf.index} OF ${total}`);
    expect(leaf.request._compactionRequest).toBe(true);
    // Codex's system instructions are re-supplied to whichever model resumes the task, so paying
    // for them in every segment would spend the budget on text no segment summary needs.
    expect(leaf.request.context.systemPrompt).toBeUndefined();
  }
}, 60_000);

test("the merge turn receives the segment summaries in order and asks for the real checkpoint", () => {
  const plan = planHierarchicalCompaction(compactionRequest(userTurns(60, 6_000)), capabilities);
  const summaries = plan!.leaves.map(leaf => `summary of segment ${leaf.index}`);
  const merge = plan!.merge(summaries);
  const text = merge.context.messages.map(message => message.content).join("\n");
  expect(merge._compactionRequest).toBe(true);
  expect(text).toContain(`<${CHATGPT_COMPACTION_SEGMENTS_TAG}>`);
  expect(text).toContain(COMPACT_PROMPT);
  for (const [index, summary] of summaries.entries()) {
    expect(text.indexOf(summary)).toBeGreaterThan(index === 0 ? -1 : text.indexOf(summaries[index - 1]!));
  }
  expect(compiledLeafText(merge).length).toBeGreaterThan(0);
}, 60_000);

test("merging a different number of summaries than leaves is refused", () => {
  const plan = planHierarchicalCompaction(compactionRequest(userTurns(60, 6_000)), capabilities);
  expect(() => plan!.merge(["only one"])).toThrow(/expected \d+ segment summaries/);
}, 60_000);

test("a history beyond the leaf cap drops its oldest records and says so in the merge", () => {
  const history = userTurns(400, 6_000);
  const plan = planHierarchicalCompaction(compactionRequest(history), capabilities);
  expect(plan!.leaves.length).toBe(MAX_CHATGPT_COMPACTION_LEAVES);
  expect(plan!.droppedMessages).toBeGreaterThan(0);
  // Keeping the newest is the point: a checkpoint describing where the task is now is worth more
  // than one describing where it started.
  const carried = plan!.leaves.flatMap(leaf => leaf.request.context.messages.slice(0, -1));
  expect(carried.at(-1)!.timestamp).toBe(history.at(-1)!.timestamp);
  expect(carried[0]!.timestamp).toBeGreaterThan(history[0]!.timestamp);
  const merge = plan!.merge(plan!.leaves.map(leaf => `summary ${leaf.index}`));
  expect(merge.context.messages.at(-1)!.content).toContain("were not summarized");
}, 120_000);

test("one record larger than a whole leaf is shortened rather than abandoning the compaction", () => {
  const plan = planHierarchicalCompaction(
    compactionRequest([
      { role: "user", content: "before", timestamp: 1 },
      { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "z".repeat(3_000_000), isError: false, timestamp: 2 },
      { role: "user", content: "after", timestamp: 3 },
    ]),
    capabilities,
  );
  expect(plan).toBeDefined();
  expect(plan!.elidedRecords).toBe(1);
  const carried = plan!.leaves.flatMap(leaf => leaf.request.context.messages.slice(0, -1));
  expect(carried.map(message => message.timestamp)).toEqual([1, 2, 3]);
  const elided = carried.find(message => message.timestamp === 2)!;
  expect(elided.content).toContain("characters elided from this record");
}, 60_000);

test("eliding keeps both ends of a record and never shortens one that already fits", () => {
  const message: CodexMessage = { role: "user", content: `HEAD${"m".repeat(50_000)}TAIL`, timestamp: 1 };
  const elided = elideCodexMessageText(message, 5_000);
  expect(elided.content).toStartWith("HEAD");
  expect(elided.content).toEndWith("TAIL");
  expect((elided.content as string).length).toBeLessThan(6_000);
  expect(elideCodexMessageText({ role: "user", content: "short", timestamp: 1 }, 5_000).content).toBe("short");
});

test("eliding preserves images and shortens assistant thinking alongside its text", () => {
  const withImage = elideCodexMessageText({
    role: "user",
    content: [
      { type: "text", text: "t".repeat(40_000) },
      { type: "image", imageUrl: "data:image/png;base64,AAAA", detail: "high" },
    ],
    timestamp: 1,
  }, 3_000);
  expect((withImage.content as unknown[]).at(-1)).toEqual({ type: "image", imageUrl: "data:image/png;base64,AAAA", detail: "high" });

  const assistant = elideCodexMessageText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "r".repeat(40_000) },
      { type: "text", text: "a".repeat(40_000) },
    ],
    timestamp: 1,
  }, 3_000);
  const parts = assistant.content as { type: string; text?: string; thinking?: string }[];
  expect(parts[0]!.thinking!.length).toBeLessThan(40_000);
  expect(parts[1]!.text!.length).toBeLessThan(40_000);
});
