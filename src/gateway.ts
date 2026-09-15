import { isChatGptWebModelSlug } from "./chatgpt-web-models";
import { readCodexModelContextOverride, readCodexSubagentProtocol } from "./codex-integration";
import type { AppConfig } from "./config";
import { formatErrorResponse } from "./bridge";
import { readJsonRequestBody } from "./http-body";
import { forwardNativeCodexRequest, type NativeFetch, type NativeImageEndpoint } from "./native-passthrough";
import { modelsRequest } from "./server";
import { catalogMatchesExpected, expectedWebModelEfforts, expectedWebModels, publishedWebCatalogEvidence } from "./readiness";
import { startService, waitForBackendReady } from "./service";

export interface GatewayServer {
  port: number | undefined;
  stop(force?: boolean): void | Promise<void>;
  shutdown(): Promise<void>;
}

export interface GatewayDependencies {
  fetchUpstream?: NativeFetch;
  fetchBackend?: (request: Request) => Promise<Response>;
  ensureBackend?: () => Promise<void>;
}

type NativeEndpoint = "responses" | "responses/compact" | "alpha/search" | NativeImageEndpoint;

function webModelFromBody(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { model?: unknown }).model === "string"
    && isChatGptWebModelSlug((value as { model: string }).model));
}

async function requestIsWebModel(request: Request): Promise<boolean> {
  try {
    return webModelFromBody(await readJsonRequestBody(request.clone()));
  } catch {
    return false;
  }
}

function endpointForPath(pathname: string): NativeEndpoint | undefined {
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/responses/compact") return "responses/compact";
  if (pathname === "/v1/alpha/search") return "alpha/search";
  if (pathname === "/v1/images/generations") return "images/generations";
  if (pathname === "/v1/images/edits") return "images/edits";
  return undefined;
}

async function defaultEnsureBackend(config: AppConfig): Promise<void> {
  startService();
  await waitForBackendReady(config);
}

async function forwardBackendRequest(
  request: Request,
  config: AppConfig,
  fetchBackend: (request: Request) => Promise<Response>,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `http://${config.host}:${config.port}${incoming.pathname}${incoming.search}`;
  return fetchBackend(new Request(target, request));
}

export function startGateway(
  config: AppConfig,
  dependencies: GatewayDependencies = {},
): GatewayServer {
  const fetchUpstream = dependencies.fetchUpstream;
  const fetchBackend = dependencies.fetchBackend ?? ((request: Request) => fetch(request));
  const ensureBackend = dependencies.ensureBackend ?? (() => defaultEnsureBackend(config));
  const startedAt = Date.now();
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  let publishedWebModels: string[] = [];
  let publishedWebModelEfforts: Record<string, string> = {};
  let modelCatalogContractHash: string | null = null;
  let draining = false;
  let activeRequests = 0;
  const controlAuthorized = (request: Request): boolean => {
    const actual = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${config.controlToken}`;
    return actual === expected;
  };
  const trackRequest = async (action: () => Promise<Response>): Promise<Response> => {
    activeRequests += 1;
    try {
      return await action();
    } finally {
      activeRequests -= 1;
    }
  };
  let shutdownPromise: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: config.host,
    port: config.nativeGatewayPort,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        let backend: Record<string, unknown> | null = null;
        try {
          const response = await fetch(`http://${config.host}:${config.port}/healthz`);
          if (response.ok) backend = await response.json() as Record<string, unknown>;
        } catch {}
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web-gateway",
          version: config.releaseVersion,
          pid: process.pid,
          port: config.nativeGatewayPort,
          backend_port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          backend_ready: backend?.status === "ok" && backend?.accepting_turns === true,
          backend_pid: backend?.pid ?? null,
          accepting_requests: !draining,
          active_requests: activeRequests,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          expected_web_models: expectedWebModels(config),
          expected_web_model_efforts: expectedWebModelEfforts(config),
          published_web_models: publishedWebModels,
          published_web_model_efforts: publishedWebModelEfforts,
          model_catalog_contract_hash: modelCatalogContractHash,
          catalog_ready: catalogMatchesExpected({
            expectedWebModels: expectedWebModels(config),
            publishedWebModels,
            expectedWebModelEfforts: expectedWebModelEfforts(config),
            publishedWebModelEfforts,
          }),
        });
      }
      if (request.method === "POST" && url.pathname === "/admin/drain") {
        if (!controlAuthorized(request)) return new Response("Unauthorized", { status: 401 });
        draining = true;
        return Response.json({ status: "ok", accepting_requests: false, active_requests: activeRequests });
      }
      if (request.method === "POST" && url.pathname === "/admin/resume") {
        if (!controlAuthorized(request)) return new Response("Unauthorized", { status: 401 });
        draining = false;
        return Response.json({ status: "ok", accepting_requests: true, active_requests: activeRequests });
      }
      if (draining) return new Response("codex-chatgpt-web native gateway is draining", { status: 503 });
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return trackRequest(async () => {
          try {
            const catalogConfig = {
              ...config,
              subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol),
            };
            const response = await modelsRequest(
              request,
              catalogConfig,
              fetchUpstream,
              readCodexModelContextOverride,
            );
            if (response.ok) {
              successfulModelCatalogRequests += 1;
              lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
              try {
                const evidence = publishedWebCatalogEvidence(await response.clone().json());
                publishedWebModels = evidence.publishedWebModels;
                publishedWebModelEfforts = evidence.publishedWebModelEfforts;
                modelCatalogContractHash = evidence.contractHash;
              } catch {
                publishedWebModels = [];
                publishedWebModelEfforts = {};
                modelCatalogContractHash = null;
              }
            }
            return response;
          } catch (error) {
            return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
          }
        });
      }
      const endpoint = endpointForPath(url.pathname);
      if (request.method !== "POST" || !endpoint) {
        if (request.method === "GET" && url.pathname === "/v1/responses") {
          return new Response("Responses WebSocket transport is not enabled on this local route", {
            status: 426,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("Not found", { status: 404 });
      }
      if (await requestIsWebModel(request)) {
        return trackRequest(async () => {
          try {
            await ensureBackend();
            return await forwardBackendRequest(request, config, fetchBackend);
          } catch (error) {
            return formatErrorResponse(503, "upstream_error", error instanceof Error ? error.message : String(error));
          }
        });
      }
      return trackRequest(() => forwardNativeCodexRequest(request, endpoint, fetchUpstream).catch(error => (
        formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error))
      )));
    },
  });
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.resolve(server.stop(true));
    await shutdownPromise;
  };
  return Object.assign(server, { shutdown });
}
