import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  ChatGptCdpWireTranslator,
  MAX_WIRE_RECORDS_PER_PAGE,
  attachChatGptWireTap,
  type WireTapSession,
} from "../src/adapters/chatgpt-web/wire/cdp-wire-tap";
import { ChatGptWireCollector } from "../src/adapters/chatgpt-web/wire/wire-collector";
import type { ChatGptWireRecord } from "../src/adapters/chatgpt-web/wire/wire-record";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

test("request attribution retains only valid user message ids, never prompt or headers", () => {
  const { session, records } = harness();
  session.fire("Network.requestWillBeSent", {
    requestId: "current", type: "Fetch", request: {
      url: "https://chatgpt.com/backend-api/f/conversation", method: "POST",
      postData: JSON.stringify({ messages: [
        { id: "assistant-id", author: { role: "assistant" }, content: { parts: ["PRIVATE"] } },
        { id: "user-input-123", author: { role: "user" }, content: { parts: ["PRIVATE"] } },
      ] }), headers: { authorization: "PRIVATE" },
    },
  });
  expect(records[0]).toMatchObject({ kind: "request", inputMessageIds: ["user-input-123"] });
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});

/** Only reads: the observer must never run anything in, or inject anything into, the page. */
const READ_ONLY_METHODS = new Set(["Network.enable", "Network.streamResourceContent", "Network.getResponseBody"]);

class FakeSession implements WireTapSession {
  readonly sent: string[] = [];
  readonly streamReplies = new Map<string, () => Promise<unknown>>();
  readonly bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  private readonly listeners = new Map<string, ((params: never) => void)[]>();

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push(method);
    const requestId = String(params.requestId);
    if (method === "Network.enable") return {};
    if (method === "Network.streamResourceContent") {
      const reply = this.streamReplies.get(requestId);
      if (reply) return await reply();
      return { bufferedData: "" };
    }
    if (method === "Network.getResponseBody") {
      const body = this.bodies.get(requestId);
      if (!body) throw new Error("No resource with given identifier found");
      return body;
    }
    throw new Error(`unexpected command ${method}`);
  }

  on(event: string, listener: (params: never) => void): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
    return this;
  }

  fire(event: string, params: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(params as never);
  }
}

function harness(): { session: FakeSession; records: ChatGptWireRecord[]; translator: ChatGptCdpWireTranslator } {
  const session = new FakeSession();
  const records: ChatGptWireRecord[] = [];
  const translator = new ChatGptCdpWireTranslator(session, record => records.push(record), () => 1);
  translator.listen(session);
  return { session, records, translator };
}

const request = (session: FakeSession, requestId: string, url: string, type = "Fetch", method = "POST"): void =>
  session.fire("Network.requestWillBeSent", { requestId, type, request: { url, method } });
const kinds = (records: ChatGptWireRecord[]): string[] => records.map(record => record.kind);
const text = (records: ChatGptWireRecord[], id: string): string => records
  .filter((record): record is Extract<ChatGptWireRecord, { kind: "chunk" }> => record.kind === "chunk" && record.id === id)
  .map(record => record.text)
  .join("");

test("only the page's backend API calls are observed", async () => {
  const { session, records } = harness();
  request(session, "doc", "https://chatgpt.com/?temporary-chat=true", "Document", "GET");
  request(session, "js", "https://chatgpt.com/backend-api/not-really.js", "Script", "GET");
  request(session, "cdn", "https://cdn.oaistatic.com/assets/app.js", "Fetch", "GET");
  request(session, "api", "https://chatgpt.com/backend-api/me", "XHR", "GET");
  request(session, "conversation", "https://chatgpt.com/backend-api/f/conversation", "Fetch");
  expect(records.filter(record => record.kind === "request").map(record => record.id)).toEqual(["api", "conversation"]);
});

test("a streamed conversation arrives in order with the bytes buffered before streaming first", async () => {
  // The reply that switches streaming on carries the bytes received so far, and it can be
  // processed after the first streamed event. Emitting in arrival order would scramble the stream.
  const { session, records, translator } = harness();
  let release: () => void = () => {};
  session.streamReplies.set("r1", () => new Promise(resolve => {
    release = () => resolve({ bufferedData: b64("data: first\n\n") });
  }));
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
  session.fire("Network.dataReceived", { requestId: "r1", dataLength: 13, data: b64("data: second\n\n") });
  session.fire("Network.loadingFinished", { requestId: "r1" });
  // Let the command go out; everything that arrived meanwhile must wait behind its reply.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(kinds(records)).toEqual(["request", "response"]);
  release();
  await translator.settled();

  expect(kinds(records)).toEqual(["request", "response", "chunk", "chunk", "end"]);
  expect(text(records, "r1")).toBe("data: first\n\ndata: second\n\n");
});

test("a multi-byte character split across network chunks is decoded once", async () => {
  const { session, records, translator } = harness();
  const bytes = Buffer.from("答", "utf8");
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
  session.fire("Network.dataReceived", { requestId: "r1", data: bytes.subarray(0, 1).toString("base64") });
  session.fire("Network.dataReceived", { requestId: "r1", data: bytes.subarray(1).toString("base64") });
  session.fire("Network.loadingFinished", { requestId: "r1" });
  await translator.settled();
  expect(text(records, "r1")).toBe("答");
});

test("a response that finished before streaming could start is read whole once it completes", async () => {
  const { session, records, translator } = harness();
  session.streamReplies.set("p", async () => {
    throw new Error("No resource with given identifier found");
  });
  session.bodies.set("p", { body: b64("{\"status\":\"ok\"}"), base64Encoded: true });
  request(session, "p", "https://chatgpt.com/backend-api/f/conversation/prepare");
  session.fire("Network.responseReceived", { requestId: "p", response: { status: 200 } });
  session.fire("Network.loadingFinished", { requestId: "p" });
  await translator.settled();
  expect(kinds(records)).toEqual(["request", "response", "chunk", "end"]);
  expect(text(records, "p")).toBe("{\"status\":\"ok\"}");
});

test("a body the browser no longer holds is counted as an observer fault and the stream still closes", async () => {
  const { session, records, translator } = harness();
  session.streamReplies.set("gone", async () => {
    throw new Error("finished");
  });
  request(session, "gone", "https://chatgpt.com/backend-api/me", "Fetch", "GET");
  session.fire("Network.responseReceived", { requestId: "gone", response: { status: 204 } });
  session.fire("Network.loadingFinished", { requestId: "gone" });
  await translator.settled();
  expect(records.map(record => `${record.kind}:${record.id}`)).toEqual(["request:gone", "response:gone", "error:tap", "end:gone"]);
});

test("a request that failed before any response is reported as the page's request failing", async () => {
  const { session, records, translator } = harness();
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_CONNECTION_CLOSED" });
  await translator.settled();
  expect(records.at(-1)).toEqual({ kind: "error", id: "r1", message: "net::ERR_CONNECTION_CLOSED", at: 1 });
});

test("a body that broke off after the response is left open, as the page reader left it", async () => {
  // The in-page observer recorded nothing when a response body errored mid-read. The shadow logic
  // was tuned on that meaning, so a break-off must not turn into a failed or a finished stream.
  const { session, records, translator } = harness();
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
  session.fire("Network.dataReceived", { requestId: "r1", data: b64("data: partial\n\n") });
  session.fire("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_ABORTED", canceled: true });
  await translator.settled();
  expect(kinds(records)).toEqual(["request", "response", "chunk"]);
});

test("an error status is observed with its body, because the body carries ChatGPT's reason", async () => {
  const { session, records, translator } = harness();
  session.streamReplies.set("r1", async () => ({ bufferedData: b64("{\"detail\":\"Too many requests\"}") }));
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.responseReceived", { requestId: "r1", response: { status: 429 } });
  session.fire("Network.loadingFinished", { requestId: "r1" });
  await translator.settled();
  expect(records[1]).toEqual({ kind: "response", id: "r1", status: 429, at: 1 });
  expect(text(records, "r1")).toContain("Too many requests");
});

test("a redirect continues the stream already open instead of opening another", () => {
  const { session, records } = harness();
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation?retry=1");
  expect(kinds(records)).toEqual(["request"]);
});

test("a socket is observed, because a handed-off turn continues on it", () => {
  const { session, records } = harness();
  session.fire("Network.webSocketCreated", { requestId: "ws", url: "wss://ws.chatgpt.com/p4/ws/user/u1" });
  session.fire("Network.webSocketFrameReceived", { requestId: "ws", response: { opcode: 1, payloadData: "{\"type\":\"message\"}" } });
  session.fire("Network.webSocketFrameReceived", { requestId: "ws", response: { opcode: 2, payloadData: b64("[1,2]") } });
  session.fire("Network.webSocketFrameReceived", { requestId: "ws", response: { opcode: 9, payloadData: "" } });
  session.fire("Network.webSocketClosed", { requestId: "ws" });
  expect(records).toEqual([
    { kind: "request", id: "ws", method: "WS", url: "wss://ws.chatgpt.com/p4/ws/user/u1", at: 1 },
    { kind: "chunk", id: "ws", text: "{\"type\":\"message\"}", at: 1 },
    { kind: "chunk", id: "ws", text: "[1,2]", at: 1 },
    { kind: "end", id: "ws", at: 1 },
  ]);
});

test("a socket error is reported on its own stream", () => {
  const { session, records } = harness();
  session.fire("Network.webSocketCreated", { requestId: "ws", url: "wss://ws.chatgpt.com/p4/ws/user/u1" });
  session.fire("Network.webSocketFrameError", { requestId: "ws", errorMessage: "m".repeat(5_000) });
  expect(records[1]).toMatchObject({ kind: "error", id: "ws" });
  expect((records[1] as { message: string }).message).toHaveLength(2_048);
});

test("an event in a shape this build does not expect cannot break the browser's dispatch", () => {
  const { session, records } = harness();
  expect(() => session.fire("Network.requestWillBeSent", { requestId: "x" })).not.toThrow();
  expect(() => session.fire("Network.webSocketFrameReceived", { requestId: "x" })).not.toThrow();
  expect(records).toEqual([]);
});

test("the observer only reads the network and never touches the page", async () => {
  const { session, translator } = harness();
  request(session, "r1", "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
  session.fire("Network.loadingFinished", { requestId: "r1" });
  request(session, "r2", "https://chatgpt.com/backend-api/me", "Fetch", "GET");
  session.streamReplies.set("r2", async () => {
    throw new Error("finished");
  });
  session.fire("Network.responseReceived", { requestId: "r2", response: { status: 200 } });
  session.fire("Network.loadingFinished", { requestId: "r2" });
  await translator.settled();
  expect(session.sent.every(method => READ_ONLY_METHODS.has(method))).toBeTrue();
});

function pageWith(session: FakeSession | Error): { page: Page; opened: () => number } {
  let opened = 0;
  const page = {
    context: () => ({
      newCDPSession: async () => {
        opened += 1;
        if (session instanceof Error) throw session;
        return session;
      },
    }),
  } as unknown as Page;
  return { page, opened: () => opened };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function completeStream(session: FakeSession, requestId: string): void {
  request(session, requestId, "https://chatgpt.com/backend-api/f/conversation");
  session.fire("Network.responseReceived", { requestId, response: { status: 200 } });
  session.fire("Network.dataReceived", { requestId, data: b64(`data: ${requestId}\n\n`) });
  session.fire("Network.loadingFinished", { requestId });
}

test("a reused page opens one session and routes each turn to its own collector", async () => {
  const session = new FakeSession();
  const { page, opened } = pageWith(session);
  const first = new ChatGptWireCollector();
  expect((await attachChatGptWireTap(page, first)).attached).toBeTrue();
  completeStream(session, "turn1");
  await settle();

  const second = new ChatGptWireCollector();
  expect((await attachChatGptWireTap(page, second)).attached).toBeTrue();
  completeStream(session, "turn2");
  await settle();

  expect(opened()).toBe(1);
  expect(session.sent.filter(method => method === "Network.enable")).toHaveLength(1);
  expect(first.snapshot().map(stream => stream.id)).toEqual(["turn1"]);
  expect(second.snapshot().map(stream => stream.id)).toEqual(["turn2"]);
  expect(second.latest()?.raw).toBe("data: turn2\n\n");
});

test("a page that refuses a session degrades to no observation", async () => {
  const { page } = pageWith(new Error("Target page, context or browser has been closed"));
  const faults: string[] = [];
  const attachment = await attachChatGptWireTap(page, new ChatGptWireCollector(), message => faults.push(message));
  expect(attachment).toMatchObject({ attached: false, reason: "Target page, context or browser has been closed" });
  expect(faults).toEqual(["Target page, context or browser has been closed"]);
});

test("a page cannot grow this process without bound", () => {
  expect(MAX_WIRE_RECORDS_PER_PAGE).toBeLessThanOrEqual(1_000_000);
});
