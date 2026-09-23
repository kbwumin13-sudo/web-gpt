/**
 * Hierarchical fresh compaction.
 *
 * A retained compaction is cheap: the ChatGPT conversation that holds the task is still open, so
 * the checkpoint request is a ~1.5k-character instruction and the model summarises context it
 * already has. That path is unchanged and remains preferred.
 *
 * A *fresh* compaction has no such conversation. The whole canonical Codex history has to be
 * transported to a new ChatGPT chat before anything can be summarised, and that is where the old
 * design broke. It reused Bigger Context multipart staging, whose contract is "store this payload
 * and reply with exactly CODEX_MULTIPART_ACK <id> <i>/<n> <sha256>". Observed on a 298k-token
 * history: part 1 carried ~102k tokens, ChatGPT accepted the submission, and then never produced
 * the acknowledgement. The round died at the 180s stage deadline with summaryChars=0, and retrying
 * reproduced it exactly, because a retry re-sent the same oversized part.
 *
 * The acknowledgement is the fragile part, not the transport. So this module removes it: the
 * history is cut into ordered segments that each fit one ChatGPT message, every segment is
 * summarised by an ordinary turn in its own temporary chat, and one small merge turn folds the
 * segment summaries into the final checkpoint.
 *
 *     canonical history ──┬─▶ segment 1 ──▶ own temporary chat ──▶ summary 1 ──┐
 *                         ├─▶ segment 2 ──▶ own temporary chat ──▶ summary 2 ──┼─▶ merge ──▶ checkpoint
 *                         └─▶ segment n ──▶ own temporary chat ──▶ summary n ──┘
 *
 * Every leaf asks for a normal answer, which is the thing ChatGPT is reliably willing to produce,
 * and a leaf that fails is the only work that has to be retried.
 *
 * This module is pure: it plans requests and never touches a browser. The caller runs the leaves.
 */

import { COMPACT_PROMPT, isOnePixelPngDataUrl } from "../../responses/compaction";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexContentPart, CodexMessage, CodexParsedRequest } from "../../types";
import { estimateChatGptWebImageTokens } from "./input-tokens";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  chatGptPromptJsonBytes,
  compileChatGptWebPrompt,
  type CompiledChatGptWebPrompt,
} from "./prompt";

/**
 * JSON-byte ceiling for one leaf message.
 *
 * The legacy single-message compaction budget is 110,000 bytes, described in prompt.ts as the point
 * where ChatGPT's `/backend-api/f/conversation` edge rejects an inline body. Live evidence says that
 * figure is stale for the current edge: multipart staging on this machine submitted a 376,516-char
 * part and the edge accepted it — what failed afterwards was the acknowledgement, not the send. So a
 * leaf is allowed materially more than the legacy inline budget, with margin below the largest body
 * observed to be accepted. The legacy constant still governs the legacy inline path.
 */
export const CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET = 300_000;

/**
 * Tokens of visible prompt one leaf may carry.
 *
 * This is a model-reliability bound rather than a transport bound, and in practice it binds first.
 * Two live data points frame it: a ~19k-token staged message was answered in 17 seconds, and a
 * ~102k-token staged message produced nothing in 180 seconds. 45k sits between them, nearer the
 * side that is known to work, and a leaf asks for an ordinary summary rather than an exact echo,
 * which is strictly easier than the request that succeeded at 19k.
 */
export const CHATGPT_COMPACTION_LEAF_TOKEN_BUDGET = 45_000;

/**
 * Upper bound on leaves in one plan.
 *
 * Each leaf is a separate temporary chat, and opening many in quick succession is what triggers
 * Cloudflare's interactive challenge — which only blocks the automated browser, so it cannot be
 * cleared from inside a turn. Eight leaves at the token budget above covers roughly 360k tokens of
 * history, more than the largest failure observed. Beyond that the oldest segments are dropped, the
 * same recovery native Codex performs when a compaction request does not fit, and the merge turn is
 * told they are missing instead of being left to infer a gap.
 */
export const MAX_CHATGPT_COMPACTION_LEAVES = 8;

/** Marker wrapping the ordered segment summaries handed to the merge turn. */
export const CHATGPT_COMPACTION_SEGMENTS_TAG = "codex_compaction_segments";

/** Placeholder capability value; a leaf is read-only, so this is only ever a compile-time stand-in. */
const LEAF_TURN_TOKEN = "turn_00000000000000000000000000000000";

/** Floors for a shortened record, so eliding can never reduce one to an unreadable stub. */
const MIN_ELIDED_RECORD_CHARS = 2_000;
const MIN_ELIDED_PART_CHARS = 400;

/** Shown in place of text removed from a single record too large to carry whole. */
function elisionNote(removed: number): string {
  return `\n[... ${removed.toLocaleString("en-US")} characters elided from this record so the segment could be summarized ...]\n`;
}

export interface ChatGptCompactionLeaf {
  /** 1-based position in chronological order. */
  index: number;
  total: number;
  /** A complete summarization request the caller runs as an ordinary browser turn. */
  request: CodexParsedRequest;
  messageCount: number;
  /** Records whose text had to be shortened to fit this leaf. */
  elidedRecords: number;
}

export interface ChatGptCompactionPlan {
  leaves: readonly ChatGptCompactionLeaf[];
  /** Oldest history records left out because the plan hit {@link MAX_CHATGPT_COMPACTION_LEAVES}. */
  droppedMessages: number;
  elidedRecords: number;
  /** Build the final checkpoint request from the leaf summaries, in leaf order. */
  merge(summaries: readonly string[]): CodexParsedRequest;
}

/** Every character of a record a reader would see, across both content shapes. */
function textOf(message: CodexMessage): string {
  if (message.role === "assistant") {
    return message.content
      .map(part => (part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : ""))
      .join("");
  }
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** The compaction instruction server.ts appends as the final user message, if it is still there. */
function compactionInstructionIndex(messages: readonly CodexMessage[]): number {
  const last = messages.length - 1;
  if (last < 0) return -1;
  const message = messages[last]!;
  return message.role === "user" && textOf(message).trim() === COMPACT_PROMPT.trim() ? last : -1;
}

function userMessage(text: string, timestamp: number): CodexMessage {
  return { role: "user", content: text, timestamp };
}

/**
 * Shorten one record's text to `keepChars`, from the middle.
 *
 * The head carries what the record is, the tail carries how it ended; a tool result's middle is the
 * part a checkpoint is least likely to need verbatim. Images are structural and are kept whole.
 */
export function elideCodexMessageText(message: CodexMessage, keepChars: number): CodexMessage {
  const budget = Math.max(keepChars, MIN_ELIDED_RECORD_CHARS);
  const shorten = (text: string, allowance: number): string => {
    if (text.length <= allowance) return text;
    const half = Math.max(Math.floor((allowance - 200) / 2), 200);
    if (half * 2 >= text.length) return text;
    return `${text.slice(0, half)}${elisionNote(text.length - half * 2)}${text.slice(text.length - half)}`;
  };
  const share = (carriers: number): number => Math.max(Math.floor(budget / carriers), MIN_ELIDED_PART_CHARS);
  if (message.role === "assistant") {
    const carriers = message.content.filter(part => part.type === "text" || part.type === "thinking").length;
    if (carriers === 0) return message;
    const allowance = share(carriers);
    return {
      ...message,
      content: message.content.map(part => (part.type === "text"
        ? { ...part, text: shorten(part.text, allowance) }
        : part.type === "thinking"
          ? { ...part, thinking: shorten(part.thinking, allowance) }
          : part)),
    };
  }
  if (typeof message.content === "string") {
    return { ...message, content: shorten(message.content, budget) };
  }
  const parts: CodexContentPart[] = message.content;
  const carriers = parts.filter(part => part.type === "text").length;
  if (carriers === 0) return message;
  const allowance = share(carriers);
  const content = parts.map(part => (part.type === "text"
    ? { ...part, text: shorten(part.text, allowance) }
    : part));
  return { ...message, content };
}

/**
 * Cheap stand-in for a record's compiled weight; the real compile confirms each closed leaf.
 *
 * An image never reaches the prompt text. `compileChatGptWebPrompt` lifts it into an attachment and
 * leaves behind `{"type":"image_attachment","attachment_ref":"codex-input-image-N"}` — about sixty
 * characters. Weighing the record with its `data:` URL therefore charged a ~1 MB screenshot as
 * ~1.4 million bytes of prompt it does not occupy. Observed live: every image-bearing record was
 * judged to fill a whole segment on its own, each segment then carried almost nothing, the plan hit
 * its segment ceiling, and 571 records were dropped from a checkpoint that reported itself complete.
 * An image's real costs — the attachment limit and its token reserve — are counted separately.
 */
function recordWeight(message: CodexMessage, modelId: string): { bytes: number; tokens: number } {
  const serialized = JSON.stringify(message, (key, value) => (
    key === "imageUrl" && typeof value === "string"
      ? `{"type":"image_attachment","attachment_ref":"codex-input-image-000"}`
      : value
  ));
  return { bytes: chatGptPromptJsonBytes(serialized), tokens: estimateTokens(serialized, modelId) };
}

/** Attachments a record will claim against one message's {@link CHATGPT_MAX_INPUT_IMAGES} slots. */
function recordImages(message: CodexMessage): number {
  if (message.role === "assistant" || typeof message.content === "string") return 0;
  return message.content.filter(part => (
    part.type === "image" && !isOnePixelPngDataUrl(part.imageUrl)
  )).length;
}

function leafRequest(
  parsed: CodexParsedRequest,
  history: readonly CodexMessage[],
  index: number,
  total: number,
): CodexParsedRequest {
  const timestamp = history.at(-1)?.timestamp ?? Date.now();
  return {
    ...parsed,
    // A segment summary is read by the merge turn, never by a model resuming the task, so it does
    // not need Codex's system instructions — the resuming model receives those fresh. Carrying them
    // into every leaf would also spend a large fixed share of each leaf's budget on identical text.
    context: {
      messages: [...history, userMessage(leafInstruction(index, total), timestamp)],
    },
    _compactionRequest: true,
  };
}

export function leafInstruction(index: number, total: number): string {
  return [
    `You are summarizing SEGMENT ${index} OF ${total} of one Codex task transcript.`,
    "The transcript was too large to summarize in a single pass, so it was split at message boundaries. The other segments are being summarized separately and all segment summaries will then be merged into one checkpoint.",
    "Summarize only what this segment actually contains. Do not speculate about what the other segments hold, and do not describe this segment as the whole task.",
    "Preserve concrete detail the next model cannot reconstruct: file paths, commands and their outcomes, decisions and the reasons for them, identifiers, values, errors, and anything still unresolved when the segment ends.",
    "Write compact structured prose or bullets, under 900 words. Do not call tools. Return only the segment summary.",
  ].join("\n");
}

export function mergeInstruction(total: number, droppedMessages: number): string {
  return [
    `The Codex task transcript was too large to summarize in one pass, so it was split into ${total} ordered segment${total === 1 ? "" : "s"} and each was summarized separately.`,
    `The segment summaries below appear in chronological order and together stand in for the complete transcript. Treat them as one continuous history, not as ${total} separate task${total === 1 ? "" : "s"}.`,
    ...(droppedMessages > 0
      ? [`The oldest ${droppedMessages.toLocaleString("en-US")} record${droppedMessages === 1 ? "" : "s"} of the transcript exceeded the checkpoint budget and were not summarized. Say so in the checkpoint rather than presenting the history as complete.`]
      : []),
    "Resolve contradictions between segments in favour of the later segment, because it reflects the more recent state.",
    "",
    COMPACT_PROMPT,
  ].join("\n");
}

export function formatCompactionSegments(summaries: readonly string[]): string {
  return [
    `<${CHATGPT_COMPACTION_SEGMENTS_TAG}>`,
    ...summaries.map((summary, index) => [
      `### Segment ${index + 1} of ${summaries.length}`,
      summary.trim(),
    ].join("\n")),
    `</${CHATGPT_COMPACTION_SEGMENTS_TAG}>`,
  ].join("\n\n");
}

function mergeRequest(
  parsed: CodexParsedRequest,
  summaries: readonly string[],
  droppedMessages: number,
): CodexParsedRequest {
  if (summaries.length === 0) throw new Error("Hierarchical ChatGPT compaction merge requires at least one segment summary");
  const timestamp = Date.now();
  return {
    ...parsed,
    context: {
      messages: [
        userMessage(formatCompactionSegments(summaries), timestamp),
        userMessage(mergeInstruction(summaries.length, droppedMessages), timestamp),
      ],
    },
    _compactionRequest: true,
  };
}

function compileLeaf(
  request: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
): CompiledChatGptWebPrompt {
  const mode = resolveChatGptWebModelMode(request.modelId, request.options.reasoning, capabilities);
  return compileChatGptWebPrompt(
    request,
    capabilities,
    mode.localTools ? LEAF_TURN_TOKEN : undefined,
    { compactionPromptJsonByteBudget: CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET },
  );
}

/**
 * Whether one compiled leaf is inside every limit that governs a single ChatGPT message: the
 * composer's character limit, the model's per-message token budget, the leaf byte ceiling, and the
 * reliability bound above. A compiled prompt that reports `trimmedCompactionMessages` already had to
 * discard history to fit, which is exactly the silent loss this planner exists to avoid.
 */
function leafFits(
  compiled: CompiledChatGptWebPrompt,
  request: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
): boolean {
  if (compiled.multipart || compiled.trimmedCompactionMessages !== undefined) return false;
  const mode = resolveChatGptWebModelMode(request.modelId, request.options.reasoning, capabilities);
  const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    CHATGPT_WEB_BACKEND_MODEL, mode.effort, capabilities,
  );
  if (browserComposerCharLimit !== undefined && compiled.text.length > browserComposerCharLimit) return false;
  if (chatGptPromptJsonBytes(compiled.text) > CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET) return false;
  const tokens = estimateTokens(compiled.text, request.modelId);
  if (tokens > CHATGPT_COMPACTION_LEAF_TOKEN_BUDGET) return false;
  const messageBudget = resolveChatGptWebMessageTokenBudget(
    CHATGPT_WEB_BACKEND_MODEL, mode.effort, capabilities, estimateChatGptWebImageTokens(compiled),
  );
  return tokens <= messageBudget;
}

/**
 * Plan a fresh compaction.
 *
 * Returns `undefined` when the request already fits one ChatGPT message. That is the common case and
 * it keeps its existing single-turn path untouched; hierarchy is recovery, not the default.
 */
export function planHierarchicalCompaction(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
): ChatGptCompactionPlan | undefined {
  if (!parsed._compactionRequest) return undefined;
  // Zero Risk's transport is a person pasting one prompt into their own tab. Splitting a checkpoint
  // into eight pastes would make the recovery worse than the failure, and the size limit that
  // breaks an automated turn is not the one a person is subject to.
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) return undefined;
  const messages = parsed.context.messages;
  const instructionAt = compactionInstructionIndex(messages);
  const history = instructionAt < 0 ? [...messages] : messages.slice(0, instructionAt);
  if (history.length === 0) return undefined;

  // Measure the request exactly as the single-turn path would send it — its own system prompt and
  // its own compaction instruction — so "this already fits" is a statement about that path and not
  // about a segment shape it will never use.
  if (leafFits(compileLeaf(parsed, capabilities), parsed, capabilities)) return undefined;

  // Fixed cost of a leaf before any history: contracts, the segment instruction, the envelope.
  const empty = compileLeaf(leafRequest(parsed, [], 1, MAX_CHATGPT_COMPACTION_LEAVES), capabilities);
  const overheadBytes = chatGptPromptJsonBytes(empty.text);
  const overheadTokens = estimateTokens(empty.text, parsed.modelId);
  // Pack against a fraction of the room so the estimate's error is absorbed without a repack; the
  // verify pass below is what makes the result exact.
  const byteRoom = Math.max((CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET - overheadBytes) * 0.75, 4_000);
  const tokenRoom = Math.max((CHATGPT_COMPACTION_LEAF_TOKEN_BUDGET - overheadTokens) * 0.75, 1_000);

  let elidedRecords = 0;
  const groups: CodexMessage[][] = [];
  let current: CodexMessage[] = [];
  let bytes = 0;
  let tokens = 0;
  let images = 0;
  for (const message of history) {
    let record = message;
    let weight = recordWeight(record, parsed.modelId);
    if (weight.bytes > byteRoom || weight.tokens > tokenRoom) {
      // One record larger than a whole leaf. Native Codex drops such an item outright; shortening it
      // keeps the fact that it happened, and what it was about, inside the summary. Only shorten
      // when there is text to shorten: a record that is heavy for some other reason would otherwise
      // be counted as elided while nothing changed, which reports a loss that did not happen.
      const text = textOf(record).length;
      if (text > 0) {
        record = elideCodexMessageText(record, Math.max(Math.floor(text * Math.min(
          byteRoom / Math.max(weight.bytes, 1),
          tokenRoom / Math.max(weight.tokens, 1),
        ) * 0.8), MIN_ELIDED_RECORD_CHARS));
        const shortened = recordWeight(record, parsed.modelId);
        if (shortened.bytes < weight.bytes) elidedRecords += 1;
        weight = shortened;
      }
    }
    // ChatGPT accepts at most CHATGPT_MAX_INPUT_IMAGES attachments on one message, and the compiler
    // drops the oldest overflow silently. Closing the leaf first keeps every image the segment was
    // given, at the cost of a shorter segment.
    const claims = recordImages(record);
    if (current.length > 0 && (
      bytes + weight.bytes > byteRoom
      || tokens + weight.tokens > tokenRoom
      || images + claims > CHATGPT_MAX_INPUT_IMAGES
    )) {
      groups.push(current);
      current = [];
      bytes = 0;
      tokens = 0;
      images = 0;
    }
    current.push(record);
    bytes += weight.bytes;
    tokens += weight.tokens;
    images += claims;
  }
  if (current.length > 0) groups.push(current);

  // Verify every group against the real compiler, moving overflow forward in time rather than
  // discarding it. Chronological order is preserved because a popped record is the group's newest.
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    while (group.length > 1) {
      const candidate = leafRequest(parsed, group, index + 1, groups.length);
      if (leafFits(compileLeaf(candidate, capabilities), candidate, capabilities)) break;
      const overflow = group.pop()!;
      const next = groups[index + 1];
      if (next) next.unshift(overflow);
      else groups.push([overflow]);
    }
  }

  // Keep the newest segments: a checkpoint that describes where the task is now is more useful than
  // one that describes where it started.
  const kept = groups.slice(-MAX_CHATGPT_COMPACTION_LEAVES);
  const droppedMessages = groups.slice(0, groups.length - kept.length)
    .reduce((total, group) => total + group.length, 0);

  const leaves = kept.map((group, index) => ({
    index: index + 1,
    total: kept.length,
    request: leafRequest(parsed, group, index + 1, kept.length),
    messageCount: group.length,
    elidedRecords: 0,
  }));

  return {
    leaves,
    droppedMessages,
    elidedRecords,
    merge: summaries => {
      if (summaries.length !== leaves.length) {
        throw new Error(
          `Hierarchical ChatGPT compaction expected ${leaves.length} segment summaries but received ${summaries.length}`,
        );
      }
      return mergeRequest(parsed, summaries, droppedMessages);
    },
  };
}
