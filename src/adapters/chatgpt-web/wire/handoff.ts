/** Reassemble a handed-off SSE stream from page-external WebSocket records. */
import type { SseFrame } from "./sse-frames";

export const STREAM_HANDOFF = "stream_handoff";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export interface HandoffBinding {
  conversationId: string;
  /** Web topic IDs explicitly offered by this handoff. */
  topicIds: readonly string[];
  /** An exchange ID is Web-owned; it is never a Codex turn ID. */
  turnExchangeId?: string;
}

/** Only the handoff envelope can authorize a WS topic. Missing or conflicting envelopes do not bind. */
export function handoffBinding(frames: readonly SseFrame[]): HandoffBinding | undefined {
  const handoffs: RecordValue[] = [];
  for (const frame of frames) {
    try {
      const value: unknown = JSON.parse(frame.data);
      if (record(value) && value.type === STREAM_HANDOFF) handoffs.push(value);
    } catch { /* Other SSE frames carry deltas or [DONE]. */ }
  }
  if (handoffs.length !== 1) return undefined;
  const handoff = handoffs[0]!;
  if (!nonempty(handoff.conversation_id) || !nonempty(handoff.turn_exchange_id) || !Array.isArray(handoff.options)) return undefined;
  const topicIds = handoff.options.filter(record)
    .filter(option => option.type === "subscribe_ws_topic" && nonempty(option.topic_id))
    .map(option => option.topic_id as string);
  if (topicIds.length === 0) return undefined;
  return {
    conversationId: handoff.conversation_id,
    topicIds: [...new Set(topicIds)],
    turnExchangeId: handoff.turn_exchange_id,
  };
}

interface StreamItem {
  topicId: string;
  conversationId: string;
  turnId?: string;
  offset: string;
  encoded: string;
}

function streamItem(value: unknown): StreamItem | undefined {
  if (!record(value) || value.type !== "message" || !nonempty(value.topic_id) || !nonempty(value.offset)) return undefined;
  const outer = value.payload;
  if (!record(outer) || outer.type !== "conversation-turn-stream") return undefined;
  const item = outer.payload;
  if (!record(item) || item.type !== "stream-item" || !nonempty(item.conversation_id) || !nonempty(item.encoded_item)) return undefined;
  return {
    topicId: value.topic_id,
    conversationId: item.conversation_id,
    ...(nonempty(item.turn_id) ? { turnId: item.turn_id } : {}),
    offset: value.offset,
    encoded: item.encoded_item,
  };
}

function itemsOfMessage(line: string): StreamItem[] {
  try {
    let value: unknown = JSON.parse(line);
    if (typeof value === "string") value = JSON.parse(value);
    return (Array.isArray(value) ? value : [value]).map(streamItem).filter((item): item is StreamItem => item !== undefined);
  } catch { return []; }
}

const offsetPattern = /^(\d+)-(\d+)$/;
function compareOffsets(a: string, b: string): number {
  const left = offsetPattern.exec(a);
  const right = offsetPattern.exec(b);
  if (!left || !right) return !left && !right ? a.localeCompare(b) : left ? 1 : -1;
  const milliseconds = BigInt(left[1]!) - BigInt(right[1]!);
  if (milliseconds !== 0n) return milliseconds < 0n ? -1 : 1;
  const sequence = BigInt(left[2]!) - BigInt(right[2]!);
  return sequence === 0n ? 0 : sequence < 0n ? -1 : 1;
}

export interface ResumedStream {
  stream: string;
  /** A collision invalidates the whole candidate, including any apparent final answer. */
  conflict: boolean;
  /** Explicit Web turn identity found on the selected topic, when supplied. */
  webTurnId?: string;
}

/**
 * A bound handoff requires its offered topic and conversation, with exactly one Web turn on that
 * topic. `turn_exchange_id` and WebSocket `turn_id` name different protocol fields; equality is not
 * assumed. Browser authority still has to associate this evidence with its own Codex turn.
 */
export function resumeHandoffStream(raw: string, binding: HandoffBinding): ResumedStream {
  const items = raw.split("\n").flatMap(line => line ? itemsOfMessage(line) : [])
    .filter(item => item.conversationId === binding.conversationId && binding.topicIds.includes(item.topicId));
  const ids = [...new Set(items.map(item => item.turnId).filter(nonempty))];
  if (ids.length > 1) return { stream: "", conflict: true };
  const webTurnId = ids[0];
  if (!webTurnId || items.some(item => item.turnId === undefined)) return { stream: "", conflict: false };
  const selected = items.filter(item => item.turnId === webTurnId);
  if (selected.length === 0) return { stream: "", conflict: false };
  const offsets = new Map<string, string>();
  for (const item of selected) {
    const previous = offsets.get(item.offset);
    if (previous !== undefined && previous !== item.encoded) return { stream: "", conflict: true };
    offsets.set(item.offset, item.encoded);
  }
  return {
    stream: [...offsets].sort(([a], [b]) => compareOffsets(a, b)).map(([, encoded]) => encoded).join(""),
    conflict: false,
    ...(webTurnId ? { webTurnId } : {}),
  };
}

/** Legacy diagnostic selection: only a single conversation/topic/Web-turn group can be returned. */
export function resumedConversationStream(raw: string, conversationId?: string): string {
  const items = raw.split("\n").flatMap(line => line ? itemsOfMessage(line) : [])
    .filter(item => conversationId === undefined || item.conversationId === conversationId);
  const groups = new Map<string, HandoffBinding>();
  for (const item of items) {
    const key = JSON.stringify([item.conversationId, item.topicId, item.turnId]);
    groups.set(key, { conversationId: item.conversationId, topicIds: [item.topicId], ...(item.turnId ? { turnExchangeId: item.turnId } : {}) });
  }
  if (groups.size !== 1) return "";
  return resumeHandoffStream(raw, [...groups.values()][0]!).stream;
}
