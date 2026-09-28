import type { Page } from "playwright-core";
import type { ChatGptWireCollector } from "./wire-collector";
import { WEBSOCKET_METHOD, type ChatGptWireRecord } from "./wire-record";

/**
 * Watches ChatGPT's backend traffic from outside the page, over the DevTools protocol.
 *
 * The observer used to be an init script that replaced the page's `fetch` and `WebSocket` and put a
 * binding on its global object, in every frame. Every script on the page could see those edits,
 * Cloudflare's challenge included: on 2026-09-28 a browser carrying them failed a Cloudflare
 * managed challenge on every run, while the same browser without them passed on every run. Reading
 * the network from the protocol side leaves the page's JavaScript world as ChatGPT built it.
 *
 * It only reads. The network domain is enabled on a session of its own, and a response body is
 * either streamed as it arrives or fetched once it finished; no request is held, changed or sent.
 *
 * The records keep the meaning the in-page observer gave them, because everything downstream was
 * tuned against it: a request that failed before any response is an `error`; one whose body broke
 * off after the response is abandoned, never closed, exactly as a page reader that stopped reading.
 */

/**
 * Observed traffic: the whole backend API rather than a guessed conversation path. Naming the exact
 * endpoint would make a renamed one look like a turn that produced nothing; picking the
 * conversation stream out of what was observed happens above, where a wrong guess is visible.
 */
export const OBSERVED_PATH_PREFIXES = ["/backend-api/"];

/** Records accepted from one page before the tap stops recording. Bounds a page that misbehaves. */
export const MAX_WIRE_RECORDS_PER_PAGE = 200_000;

const MAX_ERROR_MESSAGE_CHARS = 2_048;

/** Resource types the page's own client uses for API calls; documents and assets are not API traffic. */
const OBSERVED_RESOURCE_TYPES = new Set(["Fetch", "XHR", "EventSource"]);

/** WebSocket data frames: text, and binary that ChatGPT fills with UTF-8 JSON. */
const TEXT_OPCODE = 1;
const BINARY_OPCODE = 2;

/** Reserved record id for the observer's own faults; the collector counts these instead of opening a stream. */
const TAP_FAULT_ID = "tap";

/** The slice of a DevTools session this tap uses, so the translation runs without a browser in tests. */
export interface WireTapSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: never) => void): unknown;
}

interface RequestWillBeSent { requestId: string; type?: string; request: { url: string; method: string } }
interface ResponseReceived { requestId: string; response: { status: number } }
interface DataReceived { requestId: string; data?: string }
interface LoadingFinished { requestId: string }
interface LoadingFailed { requestId: string; errorText: string }
interface WebSocketCreated { requestId: string; url: string }
interface WebSocketFrameReceived { requestId: string; response: { opcode: number; payloadData: string } }
interface WebSocketFrameError { requestId: string; errorMessage: string }
interface WebSocketClosed { requestId: string }

interface ObservedRequest {
  /**
   * Every step for one request runs in order on this chain. Streaming is switched on by a command,
   * and its reply (carrying the bytes buffered so far) can be processed after the first streamed
   * event; the chain keeps those bytes ahead of everything that followed them.
   */
  chain: Promise<void>;
  decoder: TextDecoder;
  responded: boolean;
  streaming: boolean;
}

function observedPath(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return OBSERVED_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

/** Turns DevTools network events into wire records. Holds no browser object, only what it was handed. */
export class ChatGptCdpWireTranslator {
  private readonly requests = new Map<string, ObservedRequest>();
  private readonly sockets = new Set<string>();

  constructor(
    private readonly session: Pick<WireTapSession, "send">,
    private readonly emit: (record: ChatGptWireRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  listen(session: Pick<WireTapSession, "on">): void {
    const on = <T>(event: string, handle: (params: T) => void): void => {
      session.on(event, ((params: T) => {
        try {
          handle(params);
        } catch {
          // An observation fault must never surface in the browser's event dispatch.
        }
      }) as (params: never) => void);
    };
    on<RequestWillBeSent>("Network.requestWillBeSent", event => this.requestWillBeSent(event));
    on<ResponseReceived>("Network.responseReceived", event => this.responseReceived(event));
    on<DataReceived>("Network.dataReceived", event => this.dataReceived(event));
    on<LoadingFinished>("Network.loadingFinished", event => this.loadingFinished(event));
    on<LoadingFailed>("Network.loadingFailed", event => this.loadingFailed(event));
    on<WebSocketCreated>("Network.webSocketCreated", event => this.webSocketCreated(event));
    on<WebSocketFrameReceived>("Network.webSocketFrameReceived", event => this.webSocketFrameReceived(event));
    on<WebSocketFrameError>("Network.webSocketFrameError", event => this.webSocketFrameError(event));
    on<WebSocketClosed>("Network.webSocketClosed", event => this.webSocketClosed(event));
  }

  /** Resolves once every step already scheduled has run. Turns never wait on this; tests do. */
  async settled(): Promise<void> {
    await Promise.all([...this.requests.values()].map(request => request.chain));
  }

  requestWillBeSent(event: RequestWillBeSent): void {
    // A redirect reuses the request id; the stream already open continues.
    if (this.requests.has(event.requestId)) return;
    if (!OBSERVED_RESOURCE_TYPES.has(event.type ?? "") || !observedPath(event.request.url)) return;
    this.requests.set(event.requestId, {
      chain: Promise.resolve(),
      decoder: new TextDecoder("utf-8"),
      responded: false,
      streaming: false,
    });
    this.emit({ kind: "request", id: event.requestId, method: event.request.method, url: event.request.url, at: this.now() });
  }

  responseReceived(event: ResponseReceived): void {
    const request = this.requests.get(event.requestId);
    if (!request) return;
    request.responded = true;
    this.emit({ kind: "response", id: event.requestId, status: event.response.status, at: this.now() });
    this.step(request, async () => {
      try {
        const reply = await this.session.send("Network.streamResourceContent", { requestId: event.requestId }) as { bufferedData?: string };
        request.streaming = true;
        this.chunk(event.requestId, request, reply.bufferedData);
      } catch {
        // Already complete, or not streamable. The whole body is read once it finishes.
      }
    });
  }

  dataReceived(event: DataReceived): void {
    const request = this.requests.get(event.requestId);
    if (!request || event.data === undefined) return;
    const data = event.data;
    this.step(request, async () => {
      if (request.streaming) this.chunk(event.requestId, request, data);
    });
  }

  loadingFinished(event: LoadingFinished): void {
    const request = this.requests.get(event.requestId);
    if (!request) return;
    this.step(request, async () => {
      if (request.streaming) {
        const rest = request.decoder.decode();
        if (rest.length > 0) this.emit({ kind: "chunk", id: event.requestId, text: rest, at: this.now() });
      } else {
        try {
          const body = await this.session.send("Network.getResponseBody", { requestId: event.requestId }) as { body: string; base64Encoded: boolean };
          const text = body.base64Encoded ? new TextDecoder("utf-8").decode(Buffer.from(body.body, "base64")) : body.body;
          if (text.length > 0) this.emit({ kind: "chunk", id: event.requestId, text, at: this.now() });
        } catch (error) {
          this.emit({ kind: "error", id: TAP_FAULT_ID, message: `response body unavailable: ${describe(error)}`, at: this.now() });
        }
      }
      this.emit({ kind: "end", id: event.requestId, at: this.now() });
      this.requests.delete(event.requestId);
    });
  }

  loadingFailed(event: LoadingFailed): void {
    const request = this.requests.get(event.requestId);
    if (!request) return;
    this.step(request, async () => {
      // Before a response this is the page's request rejecting; after one, the body broke off and
      // the stream is left open, as a page reader that stopped reading would have left it.
      if (!request.responded) {
        this.emit({ kind: "error", id: event.requestId, message: describe(event.errorText), at: this.now() });
      }
      this.requests.delete(event.requestId);
    });
  }

  webSocketCreated(event: WebSocketCreated): void {
    if (this.sockets.has(event.requestId)) return;
    this.sockets.add(event.requestId);
    this.emit({ kind: "request", id: event.requestId, method: WEBSOCKET_METHOD, url: event.url, at: this.now() });
  }

  webSocketFrameReceived(event: WebSocketFrameReceived): void {
    if (!this.sockets.has(event.requestId)) return;
    const { opcode, payloadData } = event.response;
    let text: string;
    if (opcode === TEXT_OPCODE) text = payloadData;
    else if (opcode === BINARY_OPCODE) text = new TextDecoder("utf-8").decode(Buffer.from(payloadData, "base64"));
    else return;
    if (text.length > 0) this.emit({ kind: "chunk", id: event.requestId, text, at: this.now() });
  }

  webSocketFrameError(event: WebSocketFrameError): void {
    if (!this.sockets.has(event.requestId)) return;
    this.emit({ kind: "error", id: event.requestId, message: describe(event.errorMessage), at: this.now() });
  }

  webSocketClosed(event: WebSocketClosed): void {
    if (!this.sockets.delete(event.requestId)) return;
    this.emit({ kind: "end", id: event.requestId, at: this.now() });
  }

  private step(request: ObservedRequest, action: () => Promise<void>): void {
    request.chain = request.chain.then(action).catch(() => {});
  }

  private chunk(id: string, request: ObservedRequest, base64?: string): void {
    if (!base64) return;
    // Streaming decode: a multi-byte character can straddle two network chunks.
    const text = request.decoder.decode(Buffer.from(base64, "base64"), { stream: true });
    if (text.length > 0) this.emit({ kind: "chunk", id, text, at: this.now() });
  }
}

export interface ChatGptWireTapAttachment {
  /** Whether the observer was installed. A refusal is reported, never thrown into a turn. */
  attached: boolean;
  /** Why it could not be installed, when it could not. */
  reason?: string;
  /** Records refused past the per-page cap since this attach. */
  overflowed(): number;
}

interface PageTap {
  /** The collector records currently go to; swapped when a new turn attaches. */
  current: ChatGptWireCollector;
  overflowed: number;
  accepted: number;
}

/**
 * A retained ChatGPT conversation serves many turns from one page. The session is therefore opened
 * once per page and the *collector* rotates, so every turn observes its own records instead of the
 * second turn silently reporting into the first turn's collector.
 */
const taps = new WeakMap<Page, PageTap>();

/**
 * Start observing a page. This runs in shadow mode: the DOM remains the authority for every turn
 * decision, so a tap that cannot attach degrades to no observation rather than to a failed turn.
 * Attach before navigating and the first request of the new document is covered.
 */
export async function attachChatGptWireTap(
  page: Page,
  collector: ChatGptWireCollector,
  onFault?: (message: string) => void,
): Promise<ChatGptWireTapAttachment> {
  const existing = taps.get(page);
  if (existing) {
    existing.current = collector;
    const baseline = existing.overflowed;
    return { attached: true, overflowed: () => existing.overflowed - baseline };
  }
  const tap: PageTap = { current: collector, overflowed: 0, accepted: 0 };
  try {
    const session = await page.context().newCDPSession(page);
    // Playwright types each protocol method separately; the translator needs only this generic slice.
    const protocol = session as unknown as WireTapSession;
    const translator = new ChatGptCdpWireTranslator(protocol, record => {
      if (tap.accepted >= MAX_WIRE_RECORDS_PER_PAGE) {
        tap.overflowed += 1;
        return;
      }
      tap.accepted += 1;
      tap.current.record(record);
    });
    translator.listen(protocol);
    await session.send("Network.enable");
    taps.set(page, tap);
    return { attached: true, overflowed: () => tap.overflowed };
  } catch (error) {
    const reason = describe(error);
    onFault?.(reason);
    return { attached: false, reason, overflowed: () => 0 };
  }
}
