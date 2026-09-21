/**
 * The in-page observer for ChatGPT's conversation transport.
 *
 * ChatGPT's own client streams each turn over `fetch`. Reading that stream is how the page knows
 * what the model said, so it is also the most direct thing this bridge can know — far more direct
 * than re-deriving the same facts from the rendered DOM afterwards.
 *
 * Three properties make this safe to run inside a live session:
 *
 * - **Nothing is forged.** The page's own client builds and sends every request, so anti-automation
 *   tokens, headers, and fingerprints stay exactly as ChatGPT produced them. This observes; it does
 *   not synthesise traffic.
 * - **Nothing is perturbed.** The response passes through a `TransformStream` rather than being
 *   `clone()`d or `tee()`d, so no second consumer exists and no backpressure is added. Observation
 *   happens on the page's own read, at the moment the page itself receives the bytes.
 * - **Nothing propagates.** Every observation path is wrapped, so a fault here cannot surface as a
 *   failed request in the page.
 */

/**
 * Transport a stream arrived on. `fetch` responses are event-stream framed; socket messages are
 * already one payload each and must not be run through event-stream framing.
 */
export const WEBSOCKET_METHOD = "WS";

/** Records emitted to the host, one conversation stream at a time. */
export type ChatGptWireRecord =
  | { kind: "request"; id: string; method: string; url: string; at: number }
  | { kind: "response"; id: string; status: number; at: number }
  | { kind: "chunk"; id: string; text: string; at: number }
  | { kind: "end"; id: string; at: number }
  | { kind: "error"; id: string; message: string; at: number };

export interface ChatGptWireTapOptions {
  /** Name of the host-installed function on the page's global object. */
  bindingName: string;
  /** Only requests whose URL path starts with one of these are observed. */
  pathPrefixes: string[];
  /** Records held while the binding is not yet installed. Bounded so a missing host cannot grow the page's memory. */
  maxQueuedRecords: number;
}

/**
 * Injected by serialising this function with `toString()`, so it must be entirely self-contained:
 * no imports, no module-scope constants, no closure over anything outside its own parameters. The
 * test suite injects it through that same serialisation, so a captured reference fails there rather
 * than in a live session.
 */
export function installChatGptWireTap(scope: unknown, options: ChatGptWireTapOptions): void {
  const target = scope as Record<string, unknown> & {
    fetch?: typeof fetch;
    TextDecoder?: typeof TextDecoder;
    TransformStream?: typeof TransformStream;
    Response?: typeof Response;
    Request?: typeof Request;
  };
  const installedFlag = "__codexChatGptWireTapInstalled__";
  if (target[installedFlag]) return;
  const originalFetch = target.fetch;
  if (typeof originalFetch !== "function"
    || typeof target.TransformStream !== "function"
    || typeof target.TextDecoder !== "function"
    || typeof target.Response !== "function") {
    return;
  }
  target[installedFlag] = true;

  const queued: ChatGptWireRecord[] = [];
  let dropped = 0;
  const emit = (record: ChatGptWireRecord): void => {
    try {
      const binding = target[options.bindingName];
      if (typeof binding !== "function") {
        if (queued.length >= options.maxQueuedRecords) dropped += 1;
        else queued.push(record);
        return;
      }
      while (queued.length > 0) (binding as (value: ChatGptWireRecord) => void)(queued.shift()!);
      if (dropped > 0) {
        const lost = dropped;
        dropped = 0;
        (binding as (value: ChatGptWireRecord) => void)({
          kind: "error",
          id: "tap",
          message: `${lost} records were dropped before the host binding was installed`,
          at: Date.now(),
        });
      }
      (binding as (value: ChatGptWireRecord) => void)(record);
    } catch {
      // An observation fault must never reach the page's request.
    }
  };

  const observedPath = (url: string): boolean => {
    try {
      const path = new URL(url, String((target as { location?: { href?: string } }).location?.href ?? "https://chatgpt.com")).pathname;
      return options.pathPrefixes.some(prefix => path.startsWith(prefix));
    } catch {
      return false;
    }
  };

  const requestUrl = (input: unknown): string => {
    if (typeof input === "string") return input;
    if (input instanceof (target.Request ?? Object)) return String((input as Request).url);
    if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") {
      return (input as { url: string }).url;
    }
    return String(input);
  };

  const requestMethod = (input: unknown, init: RequestInit | undefined): string => {
    if (typeof init?.method === "string") return init.method;
    if (input && typeof input === "object" && typeof (input as { method?: unknown }).method === "string") {
      return (input as { method: string }).method;
    }
    return "GET";
  };

  let sequence = 0;

  target.fetch = async function tappedFetch(this: unknown, input: unknown, init?: RequestInit): Promise<Response> {
    let url: string;
    try {
      url = requestUrl(input);
    } catch {
      return (originalFetch as (...args: unknown[]) => Promise<Response>).call(this, input, init);
    }
    if (!observedPath(url)) {
      return (originalFetch as (...args: unknown[]) => Promise<Response>).call(this, input, init);
    }
    const id = `wire_${++sequence}`;
    emit({ kind: "request", id, method: requestMethod(input, init), url, at: Date.now() });
    let response: Response;
    try {
      response = await (originalFetch as (...args: unknown[]) => Promise<Response>).call(this, input, init);
    } catch (error) {
      emit({ kind: "error", id, message: error instanceof Error ? error.message : String(error), at: Date.now() });
      throw error;
    }
    try {
      emit({ kind: "response", id, status: response.status, at: Date.now() });
      if (!response.body) {
        emit({ kind: "end", id, at: Date.now() });
        return response;
      }
      const decoder = new (target.TextDecoder!)("utf-8");
      const observer = new (target.TransformStream!)<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          // Enqueue first: the page's stream must advance even if observation throws.
          controller.enqueue(chunk);
          try {
            // Streaming decode, because a multi-byte character can straddle two network chunks.
            const text = decoder.decode(chunk, { stream: true });
            if (text.length > 0) emit({ kind: "chunk", id, text, at: Date.now() });
          } catch {
            // Ignored for the same reason the enqueue came first.
          }
        },
        flush() {
          try {
            const text = decoder.decode();
            if (text.length > 0) emit({ kind: "chunk", id, text, at: Date.now() });
          } catch {
            // Ignored.
          }
          emit({ kind: "end", id, at: Date.now() });
        },
      });
      return new (target.Response!)(response.body.pipeThrough(observer), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // Observation could not be attached. The page still gets its untouched response.
      emit({ kind: "error", id, message: error instanceof Error ? error.message : String(error), at: Date.now() });
      return response;
    }
  } as typeof fetch;

  // ChatGPT moved a turn's answer off the HTTP response: `/backend-api/f/conversation/prepare`
  // hands back a `conduit_token` naming a separate channel, and the reply arrives there. Observing
  // only `fetch` therefore saw a turn submit and produce nothing. Sockets are observed by listening
  // to them, never by changing them: `binaryType` is left as the page set it, no listener consumes
  // an event, and nothing is sent.
  const OriginalWebSocket = (target as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof OriginalWebSocket !== "function") return;
  const observeSocket = (socket: WebSocket, rawUrl: unknown): void => {
    const url = typeof rawUrl === "string" ? rawUrl : String((socket as { url?: unknown }).url ?? rawUrl);
    const id = `wire_${++sequence}`;
    let opened = false;
    const open = (): void => {
      if (opened) return;
      opened = true;
      emit({ kind: "request", id, method: "WS", url, at: Date.now() });
    };
    open();
    const deliver = (text: string): void => {
      if (text.length > 0) emit({ kind: "chunk", id, text, at: Date.now() });
    };
    socket.addEventListener("message", event => {
      try {
        const data = (event as MessageEvent).data;
        if (typeof data === "string") {
          deliver(data);
          return;
        }
        if (data instanceof ArrayBuffer) {
          deliver(new (target.TextDecoder!)("utf-8").decode(new Uint8Array(data)));
          return;
        }
        // A Blob is immutable, so reading it here cannot take the payload away from the page.
        if (data && typeof (data as Blob).text === "function") {
          void (data as Blob).text().then(deliver).catch(() => {});
          return;
        }
        // Naming the type this observer cannot read turns "the socket carried nothing" into
        // "the socket carried something of this shape", which is the difference between a dead
        // end and the next thing to implement. The value itself is conversation content and stays
        // in the page.
        emit({
          kind: "error",
          id,
          message: `unobserved socket frame type: ${data === null ? "null" : typeof data === "object"
            ? (data as { constructor?: { name?: string } }).constructor?.name ?? "object"
            : typeof data}`,
          at: Date.now(),
        });
      } catch {
        // An observation fault must never reach the page's socket.
      }
    });
    socket.addEventListener("close", () => emit({ kind: "end", id, at: Date.now() }));
    socket.addEventListener("error", () => {
      emit({ kind: "error", id, message: "websocket error", at: Date.now() });
    });
  };
  // A Proxy keeps the constructor's prototype, statics, and `instanceof` behaviour intact, which a
  // wrapper function would silently break for page code that relies on them.
  (target as { WebSocket?: unknown }).WebSocket = new Proxy(OriginalWebSocket, {
    construct(constructor, args, newTarget) {
      const socket = Reflect.construct(constructor, args, newTarget) as WebSocket;
      try {
        observeSocket(socket, args[0]);
      } catch {
        // Observation is optional; the page's socket is not.
      }
      return socket;
    },
  });
}

/**
 * Traffic the observer watches. Deliberately the whole backend API rather than a guessed
 * conversation path: naming the exact endpoint would make a renamed one look like a turn that
 * produced nothing, which is the same silent failure this replaces. Selecting the conversation
 * stream out of what was observed happens above, where a wrong guess is visible as data.
 */
export const CHATGPT_CONVERSATION_PATH_PREFIXES = ["/backend-api/"];

export const CHATGPT_WIRE_TAP_BINDING = "__codexChatGptWireTap__";

export const DEFAULT_CHATGPT_WIRE_TAP_OPTIONS: ChatGptWireTapOptions = {
  bindingName: CHATGPT_WIRE_TAP_BINDING,
  pathPrefixes: CHATGPT_CONVERSATION_PATH_PREFIXES,
  maxQueuedRecords: 256,
};

/**
 * Source for the browser, produced from the function itself rather than from a copy kept in a
 * string. A separately maintained copy is how injected logic stops being the logic that was tested.
 */
export function chatGptWireTapInitScript(options = DEFAULT_CHATGPT_WIRE_TAP_OPTIONS): string {
  return `(${installChatGptWireTap.toString()})(globalThis, ${JSON.stringify(options)});`;
}
