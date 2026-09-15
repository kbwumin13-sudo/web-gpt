import { afterEach, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startGateway, type GatewayServer } from "../src/gateway";

const servers: GatewayServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown();
});

function config() {
  return { ...defaultConfig("browser-only"), nativeGatewayPort: 0, port: 49_999 };
}

test("native gateway forwards native requests without starting the Web backend", async () => {
  let upstreamCalls = 0;
  let backendStarts = 0;
  const server = startGateway(config(), {
    ensureBackend: async () => { backendStarts += 1; },
    fetchUpstream: async request => {
      upstreamCalls += 1;
      expect(new URL(request.url).host).toBe("chatgpt.com");
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: [{ role: "user", content: "ping" }] }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("[DONE]");
  expect(upstreamCalls).toBe(1);
  expect(backendStarts).toBe(0);
});

test("Web model requests start and forward to the independent backend", async () => {
  let backendStarts = 0;
  let forwardedUrl = "";
  const server = startGateway(config(), {
    ensureBackend: async () => { backendStarts += 1; },
    fetchBackend: async request => {
      forwardedUrl = request.url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/high", input: [{ role: "user", content: "ping" }] }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(backendStarts).toBe(1);
  expect(forwardedUrl).toContain(`127.0.0.1:${config().port}/v1/responses`);
});

test("Web model requests remain routed when Codex compresses the JSON body with zstd", async () => {
  let backendStarts = 0;
  let upstreamCalls = 0;
  const server = startGateway(config(), {
    ensureBackend: async () => { backendStarts += 1; },
    fetchUpstream: async () => {
      upstreamCalls += 1;
      return new Response("unexpected native request", { status: 500 });
    },
    fetchBackend: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });
  servers.push(server);
  const encoded = await Bun.zstdCompress(Buffer.from(JSON.stringify({
    model: "chatgpt-web/high",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
  })));
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: encoded as unknown as BodyInit,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(backendStarts).toBe(1);
  expect(upstreamCalls).toBe(0);
});

test("gateway serves the combined model catalog while the Web backend is offline", async () => {
  const server = startGateway(config(), {
    fetchUpstream: async request => {
      expect(new URL(request.url).pathname).toEndWith("/models");
      return Response.json({
        object: "list",
        models: [{
          slug: "gpt-5.6-luna",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "medium", description: "native" }],
          tool_mode: "freeform",
        }],
      });
    },
  });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
    headers: { authorization: "Bearer test-token" },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<{ slug?: string }> };
  expect(body.models.map(model => model.slug)).toContain("gpt-5.6-luna");
  expect(body.models.some(model => model.slug === "chatgpt-web/high")).toBe(true);
});

test("gateway drains active native requests before shutdown", async () => {
  let started!: () => void;
  let finish!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const finishedPromise = new Promise<void>(resolve => { finish = resolve; });
  const gatewayConfig = config();
  const server = startGateway(gatewayConfig, {
    fetchUpstream: async () => {
      started();
      await finishedPromise;
      return new Response("done", { status: 200 });
    },
  });
  servers.push(server);
  const request = fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: [] }),
  });
  await startedPromise;
  const drained = await fetch(`http://127.0.0.1:${server.port}/admin/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayConfig.controlToken}` },
  });
  expect(await drained.json()).toMatchObject({ status: "ok", accepting_requests: false, active_requests: 1 });
  const rejected = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: [] }),
  });
  expect(rejected.status).toBe(503);
  finish();
  expect((await request).status).toBe(200);
  const resumed = await fetch(`http://127.0.0.1:${server.port}/admin/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayConfig.controlToken}` },
  });
  expect(await resumed.json()).toMatchObject({ status: "ok", accepting_requests: true, active_requests: 0 });
});
