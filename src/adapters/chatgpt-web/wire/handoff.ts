/**
 * Following a turn that ChatGPT moved off its conversation request.
 *
 * A turn can end its `POST /backend-api/f/conversation` after four frames, the last of them an
 * envelope naming where it continues:
 *
 *     {"type":"stream_handoff","conversation_id":"…","turn_exchange_id":"…",
 *      "options":[{"type":"resume_sse_endpoint","topic_id":"…"},
 *                 {"type":"subscribe_ws_topic","topic_id":"…"}]}
 *
 * The page takes one of the two. Observed live, it subscribes on the WebSocket it already holds
 * open, and the turn arrives there as topic messages that each carry a slice of the very same
 * event-stream text the HTTP response would have carried:
 *
 *     {"type":"message","topic_id":"conversation-turn-…","offset":"1789721328178-0",
 *      "payload":{"type":"conversation-turn-stream",
 *                 "payload":{"type":"stream-item","conversation_id":"…","turn_id":"…",
 *                            "encoded_item":"event: delta\ndata: {…}\n\n"}}}
 *
 * So there is no second protocol to model: unwrapping the envelopes and concatenating
 * `encoded_item` reproduces the stream, and the existing decoder and fold read it unchanged. On the
 * turn this was decoded from, that reassembly yielded 480 frames, no unrecognised shapes, no
 * unapplied patches, and an answer identical to the one the page displayed.
 *
 * The socket is shared: it also carries `conversations`, `app_notifications` and subscription
 * replies. Items are therefore matched on the conversation the handoff named rather than on the
 * topic id, which the envelope and the messages express differently.
 */

/** The envelope type that moves a turn off its conversation request. */
export const STREAM_HANDOFF = "stream_handoff";

interface StreamItem {
  /** Redis-stream style `<milliseconds>-<sequence>`, not a number. */
  offset: string;
  conversationId?: string;
  encoded: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `<milliseconds>-<sequence>`; a malformed offset sorts first rather than throwing. */
function offsetOrder(offset: string): [number, number] {
  const [milliseconds, sequence] = offset.split("-");
  return [Number(milliseconds) || 0, Number(sequence) || 0];
}

function streamItem(message: unknown): StreamItem | undefined {
  if (!isRecord(message) || message.type !== "message") return undefined;
  const outer = message.payload;
  if (!isRecord(outer) || outer.type !== "conversation-turn-stream") return undefined;
  const item = outer.payload;
  if (!isRecord(item) || item.type !== "stream-item") return undefined;
  const encoded = item.encoded_item;
  if (typeof encoded !== "string" || encoded.length === 0) return undefined;
  return {
    offset: typeof message.offset === "string" ? message.offset : "",
    ...(typeof item.conversation_id === "string" ? { conversationId: item.conversation_id } : {}),
    encoded,
  };
}

/** Every stream item inside one recorded socket message, which may itself be a batch. */
function itemsOfMessage(line: string): StreamItem[] {
  let decoded: unknown;
  try {
    // Message framing records one JSON-encoded message per line.
    decoded = JSON.parse(line);
  } catch {
    return [];
  }
  let payload: unknown = decoded;
  if (typeof decoded === "string") {
    try {
      payload = JSON.parse(decoded);
    } catch {
      return [];
    }
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.map(streamItem).filter((item): item is StreamItem => item !== undefined);
}

/**
 * The event-stream text a socket carried for one conversation, or an empty string when it carried
 * none of it.
 *
 * Ordering is by the server's own offsets rather than by arrival. The two agreed on the recorded
 * turn, but agreement observed once is not a guarantee, and reassembling a patch stream out of
 * order would corrupt it silently — every patch would still apply.
 */
export function resumedConversationStream(raw: string, conversationId?: string): string {
  const items: StreamItem[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    for (const item of itemsOfMessage(line)) {
      // An unidentified conversation is kept: the socket only carries turn streams under this
      // shape, and refusing them would lose a turn to a field that happened to be absent.
      if (conversationId !== undefined && item.conversationId !== undefined && item.conversationId !== conversationId) {
        continue;
      }
      items.push(item);
    }
  }
  items.sort((left, right) => {
    const [leftMs, leftSeq] = offsetOrder(left.offset);
    const [rightMs, rightSeq] = offsetOrder(right.offset);
    return leftMs === rightMs ? leftSeq - rightSeq : leftMs - rightMs;
  });
  return items.map(item => item.encoded).join("");
}
