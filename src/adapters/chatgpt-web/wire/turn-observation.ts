import {
  countConversationEvents,
  parseConversationFrame,
  type ChatGptConversationEvent,
  type ChatGptConversationEventCounts,
  type ChatGptPatch,
} from "./conversation-events";
import type { ChatGptWireStream } from "./wire-collector";
import { decodeSseStream, type SseFrame } from "./sse-frames";

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
  channel?: string;
  hidden: boolean;
  hiddenByMessage: boolean;
  hiddenByMetadata: boolean;
  recipient?: string;
  authorName?: string;
  connectorPayloadShape?: string;
  connectorTarget?: string;
  invokedAction?: string;
  toolResponseText?: string;
  contentType?: string;
  parts: string[];
  /**
   * Segments the model already closed with `end_turn: false`, oldest first. These are the progress
   * narration it spoke before each tool call; `parts` holds whatever it is saying now.
   */
  priorSegments: string[];
  status?: string;
  endTurn: boolean;
}

export interface ChatGptWireObservation {
  /** Text the model addressed to the user, in message order. */
  answer: string;
  /** Reasoning and status commentary, which native Codex renders separately from the answer. */
  reasoning: string;
  /** Visible commentary blocks; hidden reasoning and tool payloads are excluded. */
  commentaryBlocks?: readonly { id: string; text: string; complete: boolean }[];
  /** Messages addressed to a tool rather than to the user. */
  toolCallCount: number;
  /** Bounded, content-free routing facts. A generic tool call is not proof of a Native2 action. */
  toolRoutes?: readonly ChatGptWireToolRoute[];
  /** The server marked a message as ending the turn. */
  endedTurn: boolean;
  /** The stream reached its terminal sentinel or its completion envelope. */
  sawDone: boolean;
  /** An error the server reported inside the stream. */
  error?: string;
  conversationId?: string;
  inputMessageIds: string[];
  messageIds: string[];
  counts: ChatGptConversationEventCounts;
  /** Patches whose target or operation this fold does not understand. Zero means the schema is covered. */
  unappliedDeltas: number;
}

export interface ChatGptWireToolRoute {
  kind: "call" | "result";
  recipient: "connector" | "functions.exec" | "other";
  /** A payload shape is only a hint; an action is confirmed by a tool result's resource URI. */
  payloadShape?: "codex_exec" | "query" | "context_read" | "other";
  targetWireName?: string;
  action?: string;
  status?: "finished_successfully" | "failed" | "other";
  errorClass?: "schema" | "auth" | "unavailable" | "delivery" | "safety_blocked" | "other";
}

const NATIVE_ACTIONS = [
  "codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image",
  "codex_tool_inventory", "codex_tool_call", "codex_context_search", "codex_context_read",
] as const;

function knownAction(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  return NATIVE_ACTIONS.find(name => new RegExp(`(?:^|/)${name}(?:$|[/?#])`).test(uri));
}

function connectorPayload(payload: unknown): { shape?: MessageState["connectorPayloadShape"]; target?: string } {
  if (typeof payload !== "string" || payload.length > 200_000) return {};
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const target = typeof record.wire_name === "string" && NATIVE_ACTIONS.includes(record.wire_name as typeof NATIVE_ACTIONS[number])
      ? record.wire_name : undefined;
    if (typeof record.cmd === "string" && typeof record.turn_token === "string") return { shape: "codex_exec", target };
    // Inventory and context search share these fields, so this is deliberately not an action name.
    if (typeof record.query === "string" && typeof record.turn_token === "string") return { shape: "query", target };
    if (Array.isArray(record.message_indices) && typeof record.turn_token === "string") return { shape: "context_read", target };
    return { shape: "other", target };
  } catch { return {}; }
}

function actionFromCallText(text: unknown): string | undefined {
  if (typeof text !== "string" || text.length > 200_000) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return knownAction((value as Record<string, unknown>).path);
  } catch { return undefined; }
}

function toolErrorClass(text: string | undefined): ChatGptWireToolRoute["errorClass"] {
  if (!text || text.length > 200_000) return undefined;
  if (/^此工具调用被 OpenAI 的安全检查屏蔽/.test(text.trim())
    || /^This tool call was blocked by OpenAI'?s safety check/i.test(text.trim())) return "safety_blocked";
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // ChatGPT's app result often wraps a textual MCP failure as {text: "Error ..."}.
  // Inspect only an explicit error prefix; a normal command's stdout is arbitrary user content.
  const wrappedError = typeof record.text === "string"
    && /^(?:Error\b|MCP error\b|Tool (?:call|invocation) failed\b)/i.test(record.text.trim())
    ? record.text.trim() : undefined;
  if (record.isError !== true && record.error === undefined && record.code === undefined && !wrappedError) return undefined;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown> : undefined;
  const code = [error?.code, record.code, typeof record.error === "string" ? record.error : undefined, wrappedError]
    .find(candidate => typeof candidate === "string");
  if (typeof code !== "string") return "other";
  if (/schema|argument|validation|parameter/i.test(code)) return "schema";
  if (/auth|forbidden|permission|credential/i.test(code)) return "auth";
  if (/unavailable|not_found|unknown_tool|unsupported/i.test(code)) return "unavailable";
  if (/timeout|network|connection|tunnel|transport/i.test(code)) return "delivery";
  return "other";
}

function routeRecipient(recipient: string | undefined): ChatGptWireToolRoute["recipient"] {
  if (recipient === "api_tool.call_tool") return "connector";
  if (recipient === "functions.exec") return "functions.exec";
  return "other";
}

function emptyMessage(): MessageState {
  return { parts: [], priorSegments: [], endTurn: false, hidden: false,
    hiddenByMessage: false, hiddenByMetadata: false };
}

/**
 * The answer, out of everything the model addressed to the user.
 *
 * A turn that calls tools speaks more than once: ChatGPT emits a short line of progress narration
 * before each batch of calls ("I'll check X first"), and the answer only at the end. Joining all of
 * them overstated the answer by exactly that narration — on one recorded turn, 2738 chars against
 * the 1967 the page showed, with the four narration messages accounting for 737 of the difference.
 * The overstatement grew with the number of tool calls, which is why short turns agreed and real
 * ones did not.
 *
 * ChatGPT marks the distinction itself: in that same stream `end_turn` was patched 40 times, 39 of
 * them `false` and exactly one `true`. That flag is the server's own statement of which message
 * ends the turn, so it decides here rather than a heuristic about ordering or length.
 *
 * The same narration also appears *inside* one message. ChatGPT keeps appending to a single
 * `parts[0]` across tool calls, marking each pause with `end_turn: false`, so one message can hold
 * two lines of narration and then the answer. `applyMessageField` closes a segment on each of those
 * pauses, which leaves `parts` holding the final one — the answer.
 *
 * When no message carries the flag the stream did not reach its end, and the last thing the model
 * was saying is the closest thing to an answer that exists. Falling back to the join would restore
 * the overstatement precisely in the case where the fold understands the stream least.
 */
function answerOf(spoken: readonly MessageState[]): string {
  const ended = spoken.filter(message => message.endTurn);
  const chosen = ended.at(-1) ?? spoken.at(-1);
  return chosen?.parts.join("") ?? "";
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
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown> : undefined;
  const invokedResource = metadata?.invoked_resource && typeof metadata.invoked_resource === "object"
    && !Array.isArray(metadata.invoked_resource) ? metadata.invoked_resource as Record<string, unknown> : undefined;
  const connector = connectorPayload(metadata?.connector_tool_payload);
  const invokedAction = knownAction(invokedResource?.resource_uri)
    ?? actionFromCallText(author?.role === "assistant" ? content?.text : undefined);
  const parts = Array.isArray(content?.parts)
    ? content.parts.filter((part): part is string => typeof part === "string")
    : [];
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof author?.role === "string" ? { role: author.role } : {}),
    ...(typeof author?.name === "string" ? { authorName: author.name } : {}),
    ...(typeof record.channel === "string" ? { channel: record.channel } : {}),
    hidden: record.is_hidden === true || metadata?.is_visually_hidden_from_conversation === true,
    hiddenByMessage: record.is_hidden === true,
    hiddenByMetadata: metadata?.is_visually_hidden_from_conversation === true,
    ...(typeof record.recipient === "string" ? { recipient: record.recipient } : {}),
    ...(connector.shape ? { connectorPayloadShape: connector.shape } : {}),
    ...(connector.target ? { connectorTarget: connector.target } : {}),
    ...(invokedAction ? { invokedAction } : {}),
    ...(typeof content?.text === "string" && author?.role === "tool" ? { toolResponseText: content.text } : {}),
    ...(typeof content?.content_type === "string" ? { contentType: content.content_type } : {}),
    parts,
    priorSegments: [],
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    endTurn: record.end_turn === true,
  };
}

/** Apply a field replacement inside the current message. Unknown fields are not an error; they are data this fold does not need. */
function applyMessageField(message: MessageState, path: string, value: unknown): boolean {
  if (path === "/message/author/role" && typeof value === "string") {
    message.role = value;
    return true;
  }
  if (path === "/message/channel" && typeof value === "string") {
    message.channel = value;
    return true;
  }
  if (path === "/message/is_hidden" && typeof value === "boolean") {
    message.hiddenByMessage = value;
    message.hidden = message.hiddenByMessage || message.hiddenByMetadata;
    return true;
  }
  if (path === "/message/metadata/is_visually_hidden_from_conversation" && typeof value === "boolean") {
    message.hiddenByMetadata = value;
    message.hidden = message.hiddenByMessage || message.hiddenByMetadata;
    return true;
  }
  if (path === "/message/metadata" && value && typeof value === "object" && !Array.isArray(value)) {
    const hidden = (value as { is_visually_hidden_from_conversation?: unknown }).is_visually_hidden_from_conversation;
    if (typeof hidden === "boolean") message.hiddenByMetadata = hidden;
    message.hidden = message.hiddenByMessage || message.hiddenByMetadata;
    return true;
  }
  if (path === "/message/status" && typeof value === "string") {
    message.status = value;
    return true;
  }
  if (path === "/message/end_turn") {
    if (typeof value === "boolean") message.endTurn = value;
    // `false` closes a segment rather than a message. ChatGPT keeps appending a turn's narration
    // and its answer to the same `parts[0]`, marking each pause with `end_turn: false` while it
    // calls a tool, and only the text after the last pause is the answer. Closing the segment here
    // keeps `parts` holding the current one, so the fold reads the answer without having to know
    // where the boundaries were.
    if (value === false && message.parts.length > 0) {
      message.priorSegments.push(message.parts.join(""));
      message.parts = [];
    }
    return true;
  }
  if (path === "/message/recipient" && typeof value === "string") {
    message.recipient = value;
    return true;
  }
  if (path === "/message/metadata/connector_tool_payload") {
    const connector = connectorPayload(value);
    message.connectorPayloadShape = connector.shape;
    message.connectorTarget = connector.target;
    return true;
  }
  if (path === "/message/metadata/invoked_resource" && value && typeof value === "object" && !Array.isArray(value)) {
    message.invokedAction = knownAction((value as Record<string, unknown>).resource_uri);
    return true;
  }
  if (path === "/message/content/text" && typeof value === "string" && message.role === "tool") {
    message.toolResponseText = value;
    return true;
  }
  if (path === "/message/content/text" && typeof value === "string" && message.role === "assistant") {
    message.invokedAction = actionFromCallText(value);
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
  return message.role === "assistant" && message.recipient !== undefined && message.recipient !== USER_RECIPIENT;
}

/** Fold a sequence of events. Exported separately from the stream form so a transcript replays through it. */
export function observeConversationEvents(events: readonly ChatGptConversationEvent[]): ChatGptWireObservation {
  const messages: MessageState[] = [];
  let current: MessageState | undefined;
  let conversationId: string | undefined;
  const inputMessageIds: string[] = [];
  let error: string | undefined;
  let sawDone = false;
  let unappliedDeltas = 0;
  // `p` and `o` are sticky across frames that omit them.
  let stickyPath = "";
  let stickyOperation: ChatGptPatch["operation"] = "append";

  const applyPatch = (patch: ChatGptPatch): void => {
    const announcedMessage = patch.path === "" ? messageFromValue(patch.value) : undefined;
    if (announcedMessage) {
      const message = announcedMessage;
      // The same message id can be re-announced; continue it rather than starting a duplicate.
      const existing = message.id ? messages.find(candidate => candidate.id === message.id) : undefined;
      if (existing) {
        Object.assign(existing, {
          ...message,
          parts: message.parts.length > 0 ? message.parts : existing.parts,
          role: message.role ?? existing.role,
          channel: message.channel ?? existing.channel,
          authorName: message.authorName ?? existing.authorName,
          connectorPayloadShape: message.connectorPayloadShape ?? existing.connectorPayloadShape,
          connectorTarget: message.connectorTarget ?? existing.connectorTarget,
          invokedAction: message.invokedAction ?? existing.invokedAction,
          toolResponseText: message.toolResponseText ?? existing.toolResponseText,
          hiddenByMessage: message.hiddenByMessage || existing.hiddenByMessage,
          hiddenByMetadata: message.hiddenByMetadata || existing.hiddenByMetadata,
          hidden: message.hidden || existing.hidden,
          // A re-announcement restates the message, not the segments it already closed.
          priorSegments: existing.priorSegments,
        });
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
      if (event.inputMessageId) inputMessageIds.push(event.inputMessageId);
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
    // A full `{message}` value announces a new document root even when this private protocol
    // omits p/o. Treating it as the previous field's sticky append loses the final answer.
    if (event.framePath === undefined && event.frameOperation === undefined
      && messageFromValue(event.patches[0]!.value)) {
      applyPatch({ path: "", operation: "add", value: event.patches[0]!.value });
      stickyPath = "";
      stickyOperation = "add";
      continue;
    }
    const path = event.framePath ?? stickyPath;
    const operation = event.frameOperation ?? stickyOperation;
    applyPatch({ path, operation, value: event.patches[0]!.value });
    if (event.framePath !== undefined) stickyPath = event.framePath;
    if (event.frameOperation !== undefined) stickyOperation = event.frameOperation;
  }

  const spoken: MessageState[] = [];
  const reasoning: string[] = [];
  const commentaryBlocks: Array<{ id: string; text: string; complete: boolean }> = [];
  const messageIds: string[] = [];
  let toolCallCount = 0;
  const toolRoutes: ChatGptWireToolRoute[] = [];
  let endedTurn = false;
  for (const [position, message] of messages.entries()) {
    if (message.id) messageIds.push(message.id);
    if (toolRoutes.length < 32 && message.role === "tool" && message.authorName) {
      const errorClass = toolErrorClass(message.toolResponseText ?? message.parts.join(""));
      toolRoutes.push({ kind: "result", recipient: routeRecipient(message.authorName),
        ...(message.invokedAction ? { action: message.invokedAction } : {}),
        status: message.status === "finished_successfully" ? "finished_successfully"
          : message.status === "finished_unsuccessfully" ? "failed" : "other",
        ...(errorClass ? { errorClass } : {}),
      });
    }
    const finalToUser = message.role === "assistant" && message.recipient === USER_RECIPIENT
      && (message.channel === undefined || message.channel === "final")
      && !message.hidden && !isReasoning(message);
    if (message.endTurn && finalToUser) endedTurn = true;
    if (isToolCall(message) && toolRoutes.length < 32) {
      toolRoutes.push({ kind: "call", recipient: routeRecipient(message.recipient),
        ...(message.connectorPayloadShape ? { payloadShape: message.connectorPayloadShape as ChatGptWireToolRoute["payloadShape"] } : {}),
        ...(message.connectorTarget ? { targetWireName: message.connectorTarget } : {}),
        ...(message.invokedAction ? { action: message.invokedAction } : {}),
      });
    }
    if (message.hidden) continue;
    if (isToolCall(message)) {
      toolCallCount += 1;
      continue;
    }
    // Closed segments are the progress narration the model spoke before each tool call. They are
    // commentary rather than the answer, and Codex renders commentary separately, so they are kept
    // there instead of being dropped.
    if (message.role === "assistant" && message.contentType !== "thoughts") reasoning.push(...message.priorSegments.filter(segment => segment.length > 0));
    if (message.role === "assistant" && message.channel === "commentary" && !isReasoning(message)) {
      for (const [segmentIndex, segment] of message.priorSegments.entries()) {
        if (!segment) continue;
        commentaryBlocks.push({ id: `${message.id ?? `position:${position}`}:segment:${segmentIndex}`,
          text: segment, complete: true });
      }
    }
    const text = message.parts.join("");
    if (text.length === 0) continue;
    if (message.contentType === "thoughts") continue;
    if (message.contentType === "reasoning_recap") {
      reasoning.push(text);
      continue;
    }
    if (message.role === "assistant" && message.channel === "commentary") {
      reasoning.push(text);
      commentaryBlocks.push({ id: message.id ?? `position:${position}`, text,
        complete: message.status === "finished_successfully" || position < messages.length - 1 });
    }
    else if (finalToUser) spoken.push(message);
  }

  return {
    answer: answerOf(spoken),
    reasoning: reasoning.join("\n\n"),
    commentaryBlocks,
    toolCallCount,
    toolRoutes,
    endedTurn,
    sawDone,
    ...(error === undefined ? {} : { error }),
    ...(conversationId === undefined ? {} : { conversationId }),
    messageIds,
    inputMessageIds,
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

/** A handoff continues one patch document; replay and live observation must fold it identically. */
export function observeHandoffContinuation(
  prefix: readonly SseFrame[],
  continuationSse: string,
): ChatGptWireObservation | undefined {
  const suffix = decodeSseStream(continuationSse).map(parseConversationFrame);
  const tail = observeConversationEvents(suffix);
  if (!tail.sawDone || tail.error !== undefined) return undefined;
  const seen = new Map<number, string>();
  const events: ChatGptConversationEvent[] = [];
  for (const event of [...prefix.map(parseConversationFrame), ...suffix]) {
    if (event.kind === "patch" && event.sequence !== undefined) {
      const encoded = JSON.stringify(event);
      const previous = seen.get(event.sequence);
      if (previous !== undefined) {
        if (previous !== encoded) return undefined;
        continue;
      }
      seen.set(event.sequence, encoded);
    }
    events.push(event);
  }
  const observation = observeConversationEvents(events);
  if (observation.error !== undefined || observation.counts.unrecognized > 0
    || observation.unappliedDeltas > 0 || !observation.endedTurn
    || !observation.sawDone || !observation.answer.trim()) return undefined;
  return observation;
}
