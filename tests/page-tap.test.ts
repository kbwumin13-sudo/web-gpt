import { expect, test } from "bun:test";
import {
  CHATGPT_WIRE_TAP_BINDING,
  DEFAULT_CHATGPT_WIRE_TAP_OPTIONS,
  chatGptWireTapInitScript,
  installChatGptWireTap,
  type ChatGptWireRecord,
  type ChatGptWireTapOptions,
} from "../src/adapters/chatgpt-web/wire/page-tap";

const CONVERSATION_URL = "https://chatgpt.com/backend-api/f/conversation";

/**
 * Install through the same serialisation the browser gets. A reference captured from module scope
 * survives a direct call and fails here, which is the point: the injected code and the tested code
 * must be the same code.
 */
function install(scope: Record<string, unknown>, options: Partial<ChatGptWireTapOptions> = {}): void {
  const source = `return (${installChatGptWireTap.toString()})(scope, options);`;
  // eslint-disable-next-line no-new-func -- exercising the injection path is the purpose of this seam.
  new Function("scope", "options", source)(scope, { ...DEFAULT_CHATGPT_WIRE_TAP_OPTIONS, ...options });
}

function streamingResponse(chunks: Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status, statusText: "OK", headers: { "content-type": "text/event-stream" } });
}

interface Harness {
  scope: Record<string, unknown>;
  records: ChatGptWireRecord[];
  calls: { input: unknown; init: RequestInit | undefined }[];
}

function harness(respond: (input: unknown) => Promise<Response> | Response, options: Partial<ChatGptWireTapOptions> = {}): Harness {
  const records: ChatGptWireRecord[] = [];
  const calls: Harness["calls"] = [];
  const scope: Record<string, unknown> = {
    TransformStream,
    TextDecoder,
    Response,
    Request,
    location: { href: "https://chatgpt.com/" },
    fetch: (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return respond(input);
    },
    [CHATGPT_WIRE_TAP_BINDING]: (record: ChatGptWireRecord) => {
      records.push(record);
    },
  };
  install(scope, options);
  return { scope, records, calls };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const tapped = (scope: Record<string, unknown>) => scope.fetch as typeof fetch;
const kinds = (records: ChatGptWireRecord[]): string[] => records.map(record => record.kind);
const chunkText = (records: ChatGptWireRecord[]): string => records
  .filter((record): record is Extract<ChatGptWireRecord, { kind: "chunk" }> => record.kind === "chunk")
  .map(record => record.text)
  .join("");

test("traffic outside the observed paths is passed through untouched", async () => {
  const origin = streamingResponse([encode("irrelevant")]);
  const { scope, records, calls } = harness(() => origin);
  // Asset and session-auth traffic carries no turn and is left alone.
  const response = await tapped(scope)("https://chatgpt.com/api/auth/session");
  expect(response).toBe(origin);
  expect(records).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("the whole backend API is observed rather than one guessed conversation path", async () => {
  // Naming the endpoint in advance made a real turn report zero frames while succeeding: a renamed
  // endpoint was indistinguishable from a turn that produced nothing.
  const { scope, records } = harness(() => streamingResponse([encode("data: a\n\n")]));
  await (await tapped(scope)("https://chatgpt.com/backend-api/v2/some-new-name")).text();
  expect(kinds(records)).toEqual(["request", "response", "chunk", "end"]);
});

test("a conversation stream is observed in order and delivered to the page unchanged", async () => {
  const { scope, records } = harness(() => streamingResponse([encode("data: a\n\n"), encode("data: b\n\n")]));
  const response = await tapped(scope)(CONVERSATION_URL, { method: "POST" });
  expect(await response.text()).toBe("data: a\n\ndata: b\n\n");
  expect(kinds(records)).toEqual(["request", "response", "chunk", "chunk", "end"]);
  expect(chunkText(records)).toBe("data: a\n\ndata: b\n\n");
  expect(records[0]).toMatchObject({ kind: "request", method: "POST", url: CONVERSATION_URL });
  expect(records[1]).toMatchObject({ kind: "response", status: 200 });
});

test("a multi-byte character split across network chunks is decoded once, not twice as replacements", async () => {
  // The bytes of "式" land in two chunks. A non-streaming decode reports U+FFFD for each half.
  const bytes = encode("data: 式\n\n");
  const split = bytes.length - 4;
  const { scope, records } = harness(() => streamingResponse([bytes.slice(0, split), bytes.slice(split)]));
  const response = await tapped(scope)(CONVERSATION_URL);
  expect(await response.text()).toBe("data: 式\n\n");
  expect(chunkText(records)).toBe("data: 式\n\n");
  expect(chunkText(records)).not.toContain("�");
});

test("the page still receives its response when the host binding is absent", async () => {
  const { scope } = harness(() => streamingResponse([encode("data: a\n\n")]));
  delete scope[CHATGPT_WIRE_TAP_BINDING];
  const response = await tapped(scope)(CONVERSATION_URL);
  expect(await response.text()).toBe("data: a\n\n");
});

test("records emitted before the binding exists are delivered once it does", async () => {
  const { scope } = harness(() => streamingResponse([encode("data: a\n\n")]));
  delete scope[CHATGPT_WIRE_TAP_BINDING];
  await (await tapped(scope)(CONVERSATION_URL)).text();

  const records: ChatGptWireRecord[] = [];
  scope[CHATGPT_WIRE_TAP_BINDING] = (record: ChatGptWireRecord) => records.push(record);
  await (await tapped(scope)(CONVERSATION_URL)).text();
  // The first stream's records were held, so both streams are accounted for.
  expect(kinds(records)).toEqual([
    "request", "response", "chunk", "end",
    "request", "response", "chunk", "end",
  ]);
});

test("the pending queue is bounded and says how much it lost", async () => {
  const { scope } = harness(() => streamingResponse([encode("data: a\n\n")]), { maxQueuedRecords: 2 });
  delete scope[CHATGPT_WIRE_TAP_BINDING];
  await (await tapped(scope)(CONVERSATION_URL)).text();

  const records: ChatGptWireRecord[] = [];
  scope[CHATGPT_WIRE_TAP_BINDING] = (record: ChatGptWireRecord) => records.push(record);
  await (await tapped(scope)(CONVERSATION_URL)).text();
  const dropNotice = records.find(record => record.kind === "error" && record.id === "tap");
  expect(dropNotice).toMatchObject({ message: "2 records were dropped before the host binding was installed" });
});

test("a throwing host binding cannot break the page's request", async () => {
  const { scope } = harness(() => streamingResponse([encode("data: a\n\n")]));
  scope[CHATGPT_WIRE_TAP_BINDING] = () => {
    throw new Error("host is gone");
  };
  const response = await tapped(scope)(CONVERSATION_URL);
  expect(await response.text()).toBe("data: a\n\n");
});

test("a failed request is reported and still rejects for the page", async () => {
  const failure = new Error("network is down");
  const { scope, records } = harness(() => Promise.reject(failure));
  await expect(tapped(scope)(CONVERSATION_URL)).rejects.toThrow("network is down");
  expect(kinds(records)).toEqual(["request", "error"]);
});

test("a response with no body is reported as ended rather than left open", async () => {
  const { scope, records } = harness(() => new Response(null, { status: 204 }));
  await tapped(scope)(CONVERSATION_URL);
  expect(kinds(records)).toEqual(["request", "response", "end"]);
});

test("an error status is observed rather than skipped, because the body carries the reason", async () => {
  const { scope, records } = harness(() => streamingResponse([encode("{\"detail\":\"too many requests\"}")], 429));
  const response = await tapped(scope)(CONVERSATION_URL);
  expect(response.status).toBe(429);
  expect(await response.text()).toBe("{\"detail\":\"too many requests\"}");
  expect(chunkText(records)).toBe("{\"detail\":\"too many requests\"}");
  expect(records[1]).toMatchObject({ kind: "response", status: 429 });
});

test("observation is driven by the page's own read, so an unread body produces no chunks", async () => {
  // This is what makes the tap free of backpressure: there is no second consumer pulling the
  // stream along. Bytes the page never reads are bytes the user never saw either.
  const { scope, records } = harness(() => streamingResponse([encode("data: a\n\n")]));
  await tapped(scope)(CONVERSATION_URL);
  expect(kinds(records)).toEqual(["request", "response"]);
});

test("installing twice leaves one tap, so records are not duplicated", async () => {
  const { scope, records } = harness(() => streamingResponse([encode("data: a\n\n")]));
  install(scope);
  await (await tapped(scope)(CONVERSATION_URL)).text();
  expect(kinds(records)).toEqual(["request", "response", "chunk", "end"]);
});

test("a scope without the streaming primitives declines to install instead of breaking fetch", async () => {
  const origin = new Response("plain");
  const original = () => origin;
  const scope: Record<string, unknown> = { fetch: original, location: { href: "https://chatgpt.com/" } };
  install(scope);
  expect(scope.fetch).toBe(original);
});

test("a Request object is read for its url and method", async () => {
  const { scope, records } = harness(() => streamingResponse([encode("data: a\n\n")]));
  await (await tapped(scope)(new Request(CONVERSATION_URL, { method: "POST" }))).text();
  expect(records[0]).toMatchObject({ kind: "request", method: "POST", url: CONVERSATION_URL });
});

test("the init script carries the function itself and targets the page's global object", () => {
  const script = chatGptWireTapInitScript();
  expect(script).toContain("__codexChatGptWireTapInstalled__");
  expect(script).toContain("globalThis");
  expect(script).toContain(JSON.stringify(DEFAULT_CHATGPT_WIRE_TAP_OPTIONS));
});

/** A socket the test drives, standing in for the channel a turn's answer now arrives on. */
class FakeSocket {
  static readonly OPEN = 1;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  binaryType = "blob";
  constructor(readonly url: string, readonly protocols?: unknown) {}
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function socketHarness(): { scope: Record<string, unknown>; records: ChatGptWireRecord[] } {
  const records: ChatGptWireRecord[] = [];
  const scope: Record<string, unknown> = {
    TransformStream,
    TextDecoder,
    Response,
    Request,
    WebSocket: FakeSocket,
    location: { href: "https://chatgpt.com/" },
    fetch: () => new Response("unused"),
    [CHATGPT_WIRE_TAP_BINDING]: (record: ChatGptWireRecord) => records.push(record),
  };
  install(scope);
  return { scope, records };
}

const openSocket = (scope: Record<string, unknown>, url: string): FakeSocket =>
  new (scope.WebSocket as new (url: string) => FakeSocket)(url);

test("a socket is observed, because a turn's answer no longer arrives on the HTTP response", async () => {
  // `/backend-api/f/conversation/prepare` hands back a conduit token naming a separate channel.
  // Observing only fetch saw a turn submit and produce nothing.
  const { scope, records } = socketHarness();
  const socket = openSocket(scope, "wss://chatgpt.com/conduit/abc");
  socket.fire("message", { data: "{\"a\":1}" });
  socket.fire("close", {});

  expect(kinds(records)).toEqual(["request", "chunk", "end"]);
  expect(records[0]).toMatchObject({ kind: "request", method: "WS", url: "wss://chatgpt.com/conduit/abc" });
  expect(chunkText(records)).toBe("{\"a\":1}");
});

test("binary socket frames are decoded without changing how the page receives them", async () => {
  const { scope, records } = socketHarness();
  const socket = openSocket(scope, "wss://chatgpt.com/conduit/abc");
  // Changing binaryType would alter the page's own handling, so the tap reads what the page chose.
  expect(socket.binaryType).toBe("blob");
  socket.fire("message", { data: encode("payload 式").buffer });
  expect(chunkText(records)).toBe("payload 式");
  expect(socket.binaryType).toBe("blob");
});

test("a socket error is reported and the stream is closed rather than left open", async () => {
  const { scope, records } = socketHarness();
  const socket = openSocket(scope, "wss://chatgpt.com/conduit/abc");
  socket.fire("error", {});
  expect(records.at(-1)).toMatchObject({ kind: "error", message: "websocket error" });
});

test("the socket wrapper keeps instanceof and statics intact for the page", async () => {
  const { scope } = socketHarness();
  const socket = openSocket(scope, "wss://chatgpt.com/conduit/abc");
  // A plain wrapper function would silently break page code that relies on either.
  expect(socket).toBeInstanceOf(FakeSocket);
  expect((scope.WebSocket as typeof FakeSocket).OPEN).toBe(1);
});

test("a throwing host binding cannot break the page's socket", async () => {
  const { scope } = socketHarness();
  scope[CHATGPT_WIRE_TAP_BINDING] = () => {
    throw new Error("host is gone");
  };
  const socket = openSocket(scope, "wss://chatgpt.com/conduit/abc");
  expect(() => socket.fire("message", { data: "x" })).not.toThrow();
});

test("a scope without WebSocket still installs the fetch observer", async () => {
  const records: ChatGptWireRecord[] = [];
  const scope: Record<string, unknown> = {
    TransformStream,
    TextDecoder,
    Response,
    Request,
    location: { href: "https://chatgpt.com/" },
    fetch: () => streamingResponse([encode("data: a\n\n")]),
    [CHATGPT_WIRE_TAP_BINDING]: (record: ChatGptWireRecord) => records.push(record),
  };
  install(scope);
  await (await (scope.fetch as typeof fetch)(CONVERSATION_URL)).text();
  expect(kinds(records)).toEqual(["request", "response", "chunk", "end"]);
});
