import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/**
 * Native compaction remains part of the identity of a replayed Codex turn, but transport ids and
 * wrapper metadata do not. Codex can rebuild the same checkpoint with a new item id; hashing the
 * entire raw record would rotate the retained Web conversation for no semantic change.
 */
function compactionEpoch(input: unknown[] | undefined): unknown {
  const item = input?.findLast(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  });
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (record.type === "compaction" || record.type === "compaction_summary" || record.type === "context_compaction") {
    const stable = {
      type: record.type,
      ...(typeof record.encrypted_content === "string" ? { encrypted_content: record.encrypted_content } : {}),
      ...(typeof record.content === "string" ? { content: record.content } : {}),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    };
    return Object.keys(stable).length > 1
      ? stable
      : { ...stable, ...(typeof record.id === "string" ? { id: record.id } : {}) };
  }
  return {
    type: "v1_summary",
    text: messageText(record) ?? "",
  };
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    // Resume prompts intentionally omit the full system bootstrap. If it changes, rotate the
    // retained Web conversation so the next browser turn reconstructs from canonical Codex state.
    systemPrompt: parsed.context.systemPrompt ?? [],
    compaction: compactionEpoch(raw?.input),
  })).digest("hex");
}

function componentFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 12);
}

/** One fingerprint per key component, so a retained miss can name what actually rotated. */
export interface ChatGptConversationKeyComponents {
  threadId: string;
  model: string;
  reasoning: string;
  systemPrompt: string;
  compaction: string;
}

export function chatGptConversationKeyComponents(
  parsed: CodexParsedRequest,
): ChatGptConversationKeyComponents | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return {
    threadId: identity.threadId,
    model: componentFingerprint(parsed.modelId),
    reasoning: componentFingerprint(parsed.options.reasoning),
    systemPrompt: componentFingerprint(parsed.context.systemPrompt ?? []),
    compaction: componentFingerprint(compactionEpoch(raw?.input)),
  };
}

/** Full history remains canonical; a retained epoch receives only the suffix after its last assistant reply. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.slice(lastAssistant + 1),
    },
  };
}

/**
 * Reconnect a prompt whose native request has no assistant suffix yet. The retained ChatGPT tab
 * already owns the accepted user prompt, so retrying the full canonical context would risk sending
 * the task twice. An empty incremental envelope asks the existing conversation to continue while
 * preserving the current turn's tool contract.
 */
export function retainedConversationRecoveryRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest {
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: [],
    },
  };
}
