import {
  countConversationEvents,
  parseConversationFrame,
  type ChatGptConversationEvent,
  type ChatGptConversationEventCounts,
  type ChatGptPatch,
} from "./conversation-events";
import type { ChatGptWireStream } from "./wire-collector";

/**
 * Folds conversation events into what a turn produced.
 *
 * Every fact here is read from a field the server sent. The DOM path had to infer the same facts
 * from rendered structure: which block is the answer rather than the reasoning, whether generation
 * is still running, whether the turn ended. Those inferences are what a ChatGPT UI change breaks
 * silently, and they are what this replaces.
 *
 * The stream patches a document rather than delivering whole messages, so this applies those
 * patches. Where the private schema is not fully understood, the fold *counts* what it could not
 * apply instead of approximating it: `unappliedDeltas` and the unrecognized frame tally are the
 * honest measure of how complete this understanding is, and both are reported.
 */

/** ChatGPT addresses a user-visible answer to `all`; any other recipient is a tool invocation. */
const USER_RECIPIENT = "all";
/** Content types that carry the model's thinking rather than its answer. */
const REASONING_CONTENT_TYPES = new Set(["thoughts", "reasoning_recap"]);
/** The control envelope that ends a turn's stream. */
const STREAM_COMPLETE = "message_stream_complete";
const MESSAGE_PATH = /^\/message(\/.*)?$/;
const PARTS_PATH = /^\/message\/content\/parts\/(\d+)$/;

interface MessageState {
  id?: string;
  role?: string;
  recipient?: string;
  contentType?: string;
  parts: string[];
  status?: string;
  endTurn: boolean;
}

export interface ChatGptWireObservation {
  /** Text the model addressed to the user, in message order. */
  answer: string;
  /** Reasoning and status commentary, which native Codex renders separately from the answer. */
  reasoning: string;
  /** Messages addressed to a tool rather than to the user. */
  toolCallCount: number;
  /** The server marked a message as ending the turn. */
  endedTurn: boolean;
  /** The stream reached its terminal sentinel or its completion envelope. */
  sawDone: boolean;
  /** An error the server reported inside the stream. */
  error?: string;
  conversationId?: string;
  messageIds: string[];
  counts: ChatGptConversationEventCounts;
  /** Patches whose target or operation this fold does not understand. Zero means the schema is covered. */
  unappliedDeltas: number;
}

function emptyMessage(): MessageState {
  return { parts: [], endTurn: false };
}

/** A document root carrying `{message: {...}}`, which is how a new message enters the stream. */
function messageFromValue(value: unknown): MessageState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = (value as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  const author = record.author && typeof record.author === "object" && !Array.isArray(record.author)
    ? record.author as Record<string, unknown>
    : undefined;
  const content = record.content && typeof record.content === "object" && !Array.isArray(record.content)
    ? record.content as Record<string, unknown>
    : undefined;
  const parts = Array.isArray(content?.parts)
    ? content.parts.filter((part): part is string => typeof part === "string")
    : [];
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof author?.role === "string" ? { role: author.role } : {}),
    ...(typeof record.recipient === "string" ? { recipient: record.recipient } : {}),
    ...(typeof content?.content_type === "string" ? { contentType: content.content_type } : {}),
    parts,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    endTurn: record.end_turn === true,
  };
}

/** Apply a field replacement inside the current message. Unknown fields are not an error; they are data this fold does not need. */
function applyMessageField(message: MessageState, path: string, value: unknown): boolean {
  if (path === "/message/status" && typeof value === "string") {
    message.status = value;
    return true;
  }
  if (path === "/message/end_turn") {
    if (value === true) message.endTurn = true;
    return true;
  }
  if (path === "/message/recipient" && typeof value === "string") {
    message.recipient = value;
    return true;
  }
  // Timestamps, metadata, and other bookkeeping share these paths. They are understood well enough
  // to be ignored deliberately rather than counted as a gap in the schema.
  return MESSAGE_PATH.test(path);
}

function isReasoning(message: MessageState): boolean {
  return REASONING_CONTENT_TYPES.has(message.contentType ?? "");
}

function isToolCall(message: MessageState): boolean {
  return message.recipient !== undefined && message.recipient !== USER_RECIPIENT;
}

/** Fold a sequence of events. Exported separately from the stream form so a transcript replays through it. */
export function observeConversationEvents(events: readonly ChatGptConversationEvent[]): ChatGptWireObservation {
  const messages: MessageState[] = [];
  let current: MessageState | undefined;
  let conversationId: string | undefined;
  let error: string | undefined;
  let sawDone = false;
  let unappliedDeltas = 0;
  // `p` and `o` are sticky across frames that omit them.
  let stickyPath = "";
  let stickyOperation: ChatGptPatch["operation"] = "append";

  const applyPatch = (patch: ChatGptPatch): void => {
    if (patch.operation === "add" && patch.path === "") {
      const message = messageFromValue(patch.value);
      if (!message) {
        unappliedDeltas += 1;
        return;
      }
      // The same message id can be re-announced; continue it rather than starting a duplicate.
      const existing = message.id ? messages.find(candidate => candidate.id === message.id) : undefined;
      if (existing) {
        Object.assign(existing, { ...message, parts: message.parts.length > 0 ? message.parts : existing.parts });
        current = existing;
        return;
      }
      messages.push(message);
      current = message;
      return;
    }
    if (!current) {
      current = emptyMessage();
      messages.push(current);
    }
    const partMatch = PARTS_PATH.exec(patch.path);
    if (partMatch && patch.operation === "append" && typeof patch.value === "string") {
      const index = Number(partMatch[1]);
      while (current.parts.length <= index) current.parts.push("");
      current.parts[index] += patch.value;
      return;
    }
    if (partMatch && patch.operation === "replace" && typeof patch.value === "string") {
      const index = Number(partMatch[1]);
      while (current.parts.length <= index) current.parts.push("");
      current.parts[index] = patch.value;
      return;
    }
    // Bookkeeping fields arrive as both replace and append; neither changes what the turn produced.
    if (applyMessageField(current, patch.path, patch.value)) return;
    unappliedDeltas += 1;
  };

  for (const event of events) {
    if (event.kind === "done") {
      sawDone = true;
      continue;
    }
    if (event.kind === "protocol") continue;
    if (event.kind === "control") {
      if (event.type === STREAM_COMPLETE) sawDone = true;
      conversationId ??= event.conversationId;
      continue;
    }
    if (event.kind === "error") {
      // The first error is the one that explains the turn; later frames are consequences of it.
      error ??= event.message;
      continue;
    }
    if (event.kind === "unrecognized") continue;
    if (event.batch) {
      // Sub-patches carry absolute targets. Letting them move the sticky position sent every later
      // frame to the last field the batch touched, which emptied the answer while applying cleanly.
      for (const patch of event.patches) applyPatch(patch);
      continue;
    }
    const path = event.framePath ?? stickyPath;
    const operation = event.frameOperation ?? stickyOperation;
    applyPatch({ path, operation, value: event.patches[0]!.value });
    if (event.framePath !== undefined) stickyPath = event.framePath;
    if (event.frameOperation !== undefined) stickyOperation = event.frameOperation;
  }

  const answer: string[] = [];
  const reasoning: string[] = [];
  const messageIds: string[] = [];
  let toolCallCount = 0;
  let endedTurn = false;
  for (const message of messages) {
    if (message.id) messageIds.push(message.id);
    if (message.endTurn) endedTurn = true;
    if (isToolCall(message)) {
      toolCallCount += 1;
      continue;
    }
    const text = message.parts.join("");
    if (text.length === 0) continue;
    if (isReasoning(message)) reasoning.push(text);
    else if (message.role === "assistant") answer.push(text);
  }

  return {
    answer: answer.join("\n\n"),
    reasoning: reasoning.join("\n\n"),
    toolCallCount,
    endedTurn,
    sawDone,
    ...(error === undefined ? {} : { error }),
    ...(conversationId === undefined ? {} : { conversationId }),
    messageIds,
    counts: countConversationEvents(events),
    unappliedDeltas,
  };
}

/** Fold an assembled stream, which is the live path. */
export function observeWireStream(stream: ChatGptWireStream): ChatGptWireObservation {
  const observation = observeConversationEvents(stream.frames.map(parseConversationFrame));
  if (observation.error !== undefined) return observation;
  // A non-success status whose body carried no error frame still failed; saying so beats reporting
  // an empty answer as if the model had produced one.
  if (stream.status !== undefined && (stream.status < 200 || stream.status >= 300)) {
    return { ...observation, error: `ChatGPT conversation request returned HTTP ${stream.status}` };
  }
  if (stream.error !== undefined) return { ...observation, error: stream.error };
  return observation;
}
