import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexHome } from "../src/codex-integration-shared";
import { loadConfig } from "../src/config";
import { stopService } from "../src/service";

const config = loadConfig();
const gatewayUrl = `http://${config.host}:${config.nativeGatewayPort}`;
const backendUrl = `http://${config.host}:${config.port}`;
const health = async (url: string): Promise<Record<string, unknown>> => {
  const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`${url} health returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
};
const beforeGateway = await health(gatewayUrl);
const beforeBackend = await health(backendUrl);
if (beforeGateway.active_requests !== 0 || beforeBackend.active_http_turns !== 0 || beforeBackend.active_browser_turns !== 0) {
  throw new Error("Native isolation acceptance requires idle gateway and backend turns");
}
const bundleId = (beforeGateway.build as { bundleId?: string } | undefined)?.bundleId;
if (!bundleId || (beforeBackend.build as { bundleId?: string } | undefined)?.bundleId !== bundleId) {
  throw new Error("Installed gateway/backend identity mismatch before native isolation acceptance");
}
await stopService(config);
const stopped = await health(gatewayUrl);
if (stopped.backend_ready !== false || stopped.active_requests !== 0) {
  throw new Error("Web backend did not stop while the native gateway remained ready");
}
const auth = JSON.parse(readFileSync(join(getCodexHome(), "auth.json"), "utf8")) as {
  tokens?: { access_token?: string; account_id?: string };
};
const accessToken = auth.tokens?.access_token;
const accountId = auth.tokens?.account_id;
if (!accessToken || !accountId) throw new Error("Codex OAuth token or account ID is unavailable");
const native = await fetch(`${gatewayUrl}/v1/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "codex_cli_rs/0.156.1 (macOS; arm64)",
    originator: "codex_cli_rs",
  },
  body: JSON.stringify({
    model: "gpt-5.6-luna", instructions: "Return only the answer to the current message.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply with OK only." }] }],
    stream: true, store: false, reasoning: { effort: "low" },
  }),
  signal: AbortSignal.timeout(90_000),
});
const body = await native.text();
if (!native.ok) throw new Error(`Native route returned HTTP ${native.status}`);
const events = body.split("\n").flatMap(line => {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return [];
  try { return [JSON.parse(line.slice(6)) as Record<string, unknown>]; } catch { return []; }
});
const answer = events.filter(event => event.type === "response.output_text.delta")
  .map(event => typeof event.delta === "string" ? event.delta : "").join("").trim();
if (answer !== "OK" || !events.some(event => event.type === "response.completed")) {
  throw new Error(`Native route did not complete the exact answer (chars=${answer.length}, events=${events.length})`);
}
if ((await health(gatewayUrl)).backend_ready !== false) {
  throw new Error("Native Luna request restarted the Web backend");
}
// The malformed request proves on-demand activation without sending a prompt to ChatGPT.
const wake = await fetch(`${gatewayUrl}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "chatgpt-web/light", stream: false, input: "invalid" }),
  signal: AbortSignal.timeout(30_000),
});
const rejected = await wake.json() as { status?: string; error?: { message?: string } };
if (rejected.status !== "failed" || !rejected.error?.message?.includes("requires native Codex turn_id metadata")) {
  throw new Error("Malformed Web route was not safely rejected before browser execution");
}
const resumed = await health(gatewayUrl);
if (resumed.backend_ready !== true || (resumed.backend_build as { bundleId?: string } | undefined)?.bundleId !== bundleId) {
  throw new Error("On-demand Web backend did not restore the installed bundle identity");
}
process.stdout.write(`NATIVE_ISOLATION_OK ${JSON.stringify({ bundle_id: bundleId, native_answer: answer, native_events: events.length, web_backend_stopped_for_native: true, on_demand_backend_started: true })}\n`);
