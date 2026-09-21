import type { SseFrame } from "./sse-frames";

/**
 * Interpretation of ChatGPT's conversation frames.
 *
 * Unlike the framing below it, this payload schema is private and unversioned. The shapes modelled
 * here were read off a recorded live turn rather than assumed, and anything that does not match
 * becomes an explicit `unrecognized` event naming its keys — never a silently mis-parsed one. The
 * share of unrecognized frames over real traffic is the measure of whether this understanding still
 * holds, and it is reported rather than hidden.
 *
 * The stream is a sequence of patches against a document, not a sequence of whole messages: a turn
 * opens with `{"p":"","o":"add","v":{"message":{…}}}` and then narrows to
 * `{"p":"/message/content/parts/0","o":"append","v":"…"}`. `p` and `o` are sticky, so a frame
 * carrying only `v` repeats the last path and operation. Reading `message` at the top level — the
 * obvious guess — matches none of it.
 *
 * Nothing here decides turn outcomes. Folding events into a conclusion is the next layer's job, so
 * a schema gap surfaces as a missing fact instead of a wrong one.
 */

/** Operations observed in the stream. Anything else is reported rather than guessed at. */
export type ChatGptPatchOperation = "add" | "append" | "replace" | "patch" | "remove";

export interface ChatGptPatch {
  /** JSON-Pointer-style path. Empty means the document root. */
  path: string;
  operation: ChatGptPatchOperation;
  value: unknown;
}

export type ChatGptConversationEvent =
  /** ChatGPT's terminal sentinel for the stream. */
  | { kind: "done" }
  /** The bare protocol marker that opens a stream. */
  | { kind: "protocol"; version: string }
  /** A typed control envelope: stream completion, markers, tokens, conversation metadata. */
  | { kind: "control"; type: string; conversationId?: string }
  /**
   * One or more patches against the document.
   *
   * `p` and `o` are sticky *per frame*: a frame carrying only `v` repeats the frame-level path and
   * operation last stated. `framePath` and `frameOperation` are therefore what the frame itself
   * said, which is not the same as what its patches target — a batch carries absolute sub-paths
   * that must not become the sticky position, or every later frame lands on the last field the
   * batch happened to touch.
   */
  | {
    kind: "patch";
    patches: ChatGptPatch[];
    /** True when the patches carry their own absolute targets rather than the frame's. */
    batch: boolean;
    framePath?: string;
    frameOperation?: ChatGptPatchOperation;
    sequence?: number;
  }
  /** An error the server reported inside the stream. */
  | { kind: "error"; message: string }
  /**
   * A frame whose shape is not understood. Only key names are retained: they describe the schema,
   * while the values would be conversation content.
   */
  | { kind: "unrecognized"; reason: string; keys: string[] };

const DONE_SENTINEL = "[DONE]";
/** Observed protocol markers. A new one is reported rather than accepted silently. */
const PROTOCOL_VERSIONS = new Set(["v1"]);
const OPERATIONS = new Set<ChatGptPatchOperation>(["add", "append", "replace", "patch", "remove"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return stringField(value, "message") ?? stringField(value, "detail") ?? stringField(value, "code");
}

function operationOf(value: unknown): ChatGptPatchOperation | undefined {
  return typeof value === "string" && OPERATIONS.has(value as ChatGptPatchOperation)
    ? value as ChatGptPatchOperation
    : undefined;
}

/** Expand a `patch` operation whose value is a list of sub-patches into individual patches. */
function expandPatches(path: string, value: unknown): ChatGptPatch[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const patches: ChatGptPatch[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const operation = operationOf(entry.o);
    if (!operation) return undefined;
    patches.push({ path: stringField(entry, "p") ?? path, operation, value: entry.v });
  }
  return patches;
}

/**
 * Read one frame. `[DONE]`, the protocol marker, and malformed JSON are decided before any schema
 * matching, so a non-JSON frame is reported as such instead of being matched against a shape.
 */
export function parseConversationFrame(frame: SseFrame): ChatGptConversationEvent {
  const data = frame.data.trim();
  if (data === DONE_SENTINEL) return { kind: "done" };
  if (data.length === 0) return { kind: "unrecognized", reason: "empty frame", keys: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return { kind: "unrecognized", reason: "frame data is not JSON", keys: [] };
  }
  if (typeof payload === "string") {
    return PROTOCOL_VERSIONS.has(payload)
      ? { kind: "protocol", version: payload }
      : { kind: "unrecognized", reason: `unknown protocol marker ${JSON.stringify(payload)}`, keys: [] };
  }
  if (!isRecord(payload)) {
    return { kind: "unrecognized", reason: `frame data is ${Array.isArray(payload) ? "an array" : typeof payload}`, keys: [] };
  }
  const keys = Object.keys(payload).sort();
  // An error is read before any other shape: a frame can carry both a partial message and the
  // error that ended it, and the error is the fact that decides the turn.
  const failure = errorMessage(payload.error) ?? (payload.error === null ? undefined : errorMessage(payload.detail));
  if (failure !== undefined) return { kind: "error", message: failure };
  const type = stringField(payload, "type");
  if (type !== undefined) {
    return {
      kind: "control",
      type,
      ...(stringField(payload, "conversation_id") ? { conversationId: stringField(payload, "conversation_id") } : {}),
    };
  }
  if ("v" in payload) {
    const path = stringField(payload, "p");
    const operation = operationOf(payload.o);
    const sequence = typeof payload.c === "number" ? { sequence: payload.c } : {};
    if (operation === "patch") {
      const expanded = expandPatches(path ?? "", payload.v);
      // A batch names every target explicitly, so it neither reads nor sets the sticky position.
      return expanded
        ? { kind: "patch", patches: expanded, batch: true, ...sequence }
        : { kind: "unrecognized", reason: "patch operation without a list of patches", keys };
    }
    return {
      kind: "patch",
      patches: [{ path: path ?? "", operation: operation ?? "append", value: payload.v }],
      batch: false,
      ...(path === undefined ? {} : { framePath: path }),
      ...(operation === undefined ? {} : { frameOperation: operation }),
      ...sequence,
    };
  }
  return { kind: "unrecognized", reason: "no known frame shape matched", keys };
}

/** Per-stream tally, so a schema that stopped matching is visible as a number rather than a symptom. */
export interface ChatGptConversationEventCounts {
  total: number;
  unrecognized: number;
  byKind: Record<ChatGptConversationEvent["kind"], number>;
  /** Key sets of unrecognized frames, deduplicated; these name the shapes still to be understood. */
  unrecognizedShapes: string[];
  /** Control envelope types seen, which is how a new one becomes visible. */
  controlTypes: string[];
}

export function countConversationEvents(events: readonly ChatGptConversationEvent[]): ChatGptConversationEventCounts {
  const byKind: Record<ChatGptConversationEvent["kind"], number> = {
    done: 0,
    protocol: 0,
    control: 0,
    patch: 0,
    error: 0,
    unrecognized: 0,
  };
  const shapes = new Set<string>();
  const controlTypes = new Set<string>();
  for (const event of events) {
    byKind[event.kind] += 1;
    if (event.kind === "unrecognized") shapes.add(`${event.reason}${event.keys.length > 0 ? `: ${event.keys.join(",")}` : ""}`);
    if (event.kind === "control") controlTypes.add(event.type);
  }
  return {
    total: events.length,
    unrecognized: byKind.unrecognized,
    byKind,
    unrecognizedShapes: [...shapes].sort(),
    controlTypes: [...controlTypes].sort(),
  };
}
