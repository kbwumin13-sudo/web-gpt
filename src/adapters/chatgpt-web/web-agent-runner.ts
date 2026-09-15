import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config";
import { availableChatGptWebModelRoutes } from "../../chatgpt-web-models";
import { catalogMatchesExpected, expectedWebModelEfforts, expectedWebModels } from "../../readiness";
import type { CodexUsage } from "../../types";
import type { CleanupWarning } from "./compaction-core";

export const WEB_AGENT_MODELS = [
  "chatgpt-web/light",
  "chatgpt-web/medium",
  "chatgpt-web/high",
  "chatgpt-web/extra-high",
  "chatgpt-web/pro",
] as const;

export type WebAgentModel = typeof WEB_AGENT_MODELS[number];
export type WebAgentPurpose = "design" | "execute";

export interface WebAgentRunRequest {
  task: string;
  model: WebAgentModel;
  purpose: WebAgentPurpose;
  cwd: string;
  workspace_roots?: string[];
  timeout_ms?: number;
}

export interface WebAgentRunResult {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  model: string;
  answer?: string;
  usage?: CodexUsage;
  cleanup_warnings: CleanupWarning[];
}

export interface WebAgentApprovalRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface WebAgentRunnerDependencies {
  availableModels?: ReadonlySet<string>;
  createAppServer?: (options: AppServerStartOptions) => Promise<AppServerClient>;
  requestApproval?: (request: WebAgentApprovalRequest) => Promise<boolean>;
  executable?: string;
  defaultTimeoutMs?: number;
}

export interface AppServerStartOptions {
  executable: string;
  cwd: string;
}

export interface AppServerClient {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  onRequest(handler: (request: WebAgentApprovalRequest & { id: string | number }) => Promise<Record<string, unknown>>): void;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const CANCEL_SETTLEMENT_TIMEOUT_MS = 10_000;

export function validateWebAgentModel(value: string): WebAgentModel {
  if (!(WEB_AGENT_MODELS as readonly string[]).includes(value)) {
    throw new Error(`web_agent_run requires one of the explicit Web models: ${WEB_AGENT_MODELS.join(", ")}`);
  }
  return value as WebAgentModel;
}

function validateRequest(request: WebAgentRunRequest): WebAgentRunRequest {
  if (!request.task.trim()) throw new Error("web_agent_run task is required");
  validateWebAgentModel(request.model);
  if (request.purpose !== "design" && request.purpose !== "execute") {
    throw new Error("web_agent_run purpose must be design or execute");
  }
  if (!isAbsolute(request.cwd)) throw new Error("web_agent_run cwd must be an absolute path");
  const roots = request.workspace_roots ?? [request.cwd];
  if (roots.length === 0 || roots.some(root => !isAbsolute(root))) {
    throw new Error("web_agent_run workspace_roots must contain absolute paths");
  }
  if (!roots.some(root => root === request.cwd || request.cwd.startsWith(`${root}/`))) {
    throw new Error("web_agent_run cwd must be inside workspace_roots");
  }
  if (request.timeout_ms !== undefined
    && (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1_000 || request.timeout_ms > 60 * 60_000)) {
    throw new Error("web_agent_run timeout_ms must be between 1000 and 3600000");
  }
  return { ...request, workspace_roots: [...roots] };
}

async function defaultAvailableModels(): Promise<ReadonlySet<string>> {
  try {
    const config = loadConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    timer.unref?.();
    let response: Response;
    try {
      response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return new Set();
    const health = await response.json() as Record<string, unknown>;
    const expected = expectedWebModels(config);
    const published = Array.isArray(health.published_web_models)
      ? health.published_web_models.filter((value): value is string => typeof value === "string")
      : [];
    const publishedEfforts = health.published_web_model_efforts && typeof health.published_web_model_efforts === "object"
      ? health.published_web_model_efforts as Record<string, string>
      : {};
    if (health.catalog_ready !== true || !catalogMatchesExpected({
      expectedWebModels: expected,
      publishedWebModels: published,
      expectedWebModelEfforts: expectedWebModelEfforts(config),
      publishedWebModelEfforts: publishedEfforts,
    })) return new Set();
    return new Set(availableChatGptWebModelRoutes(config).map(route => route.slug));
  } catch {
    return new Set();
  }
}

function approvalDescription(request: WebAgentApprovalRequest): string {
  const params = request.params ?? {};
  const action = request.method.includes("fileChange") ? "file changes" : "command execution";
  const detail = typeof params.command === "string"
    ? `\nCommand: ${params.command}`
    : typeof params.reason === "string" ? `\nReason: ${params.reason}` : "";
  return `The Web Agent Runner requests approval for ${action}.${detail}`;
}

function usageFrom(value: unknown): CodexUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const inputTokens = item.inputTokens ?? item.input_tokens;
  const outputTokens = item.outputTokens ?? item.output_tokens;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return {
    inputTokens: Number(inputTokens),
    outputTokens: Number(outputTokens),
    ...(Number.isFinite(item.totalTokens ?? item.total_tokens) ? { totalTokens: Number(item.totalTokens ?? item.total_tokens) } : {}),
    ...(Number.isFinite(item.cachedInputTokens ?? item.cached_input_tokens) ? { cachedInputTokens: Number(item.cachedInputTokens ?? item.cached_input_tokens) } : {}),
  };
}

function itemAnswer(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const value = item as Record<string, unknown>;
  return value.type === "agentMessage" && typeof value.text === "string" ? value.text : undefined;
}

export class WebAgentRunner {
  private readonly dependencies: Required<Pick<WebAgentRunnerDependencies, "defaultTimeoutMs">> & WebAgentRunnerDependencies;

  constructor(dependencies: WebAgentRunnerDependencies = {}) {
    this.dependencies = { defaultTimeoutMs: DEFAULT_TIMEOUT_MS, ...dependencies };
  }

  async run(
    rawRequest: WebAgentRunRequest,
    signal?: AbortSignal,
    requestApproval?: (request: WebAgentApprovalRequest) => Promise<boolean>,
  ): Promise<WebAgentRunResult> {
    const request = validateRequest(rawRequest);
    const available = this.dependencies.availableModels ?? await defaultAvailableModels();
    if (!available.has(request.model)) {
      return {
        run_id: randomUUID(),
        status: "failed",
        model: request.model,
        cleanup_warnings: [],
      };
    }
    const runId = randomUUID();
    const timeoutMs = request.timeout_ms ?? this.dependencies.defaultTimeoutMs;
    const warnings: CleanupWarning[] = [];
    let client: AppServerClient | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let answer = "";
    let usage: CodexUsage | undefined;
    let terminal: "completed" | "failed" | "cancelled" | undefined;
    let timedOut = false;
    let cancellationStarted = false;
    let cancellationPromise: Promise<void> | undefined;
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>(resolve => { resolveTerminal = resolve; });
    const markTerminal = (status: typeof terminal): void => {
      if (terminal) return;
      terminal = status;
      resolveTerminal();
    };
    const interrupt = async (): Promise<void> => {
      if (cancellationStarted) return cancellationPromise;
      cancellationStarted = true;
      cancellationPromise = (async () => {
        if (client && threadId && turnId) {
          try {
            await client.request("turn/interrupt", { threadId, turnId });
          } catch (error) {
            warnings.push({ code: "cleanup_warning", stage: "turn_interrupt", message: error instanceof Error ? error.message : String(error) });
          }
          await Promise.race([
            terminalPromise,
            new Promise<void>(resolve => {
              const timer = setTimeout(resolve, CANCEL_SETTLEMENT_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
        }
      })();
      return cancellationPromise;
    };

    const onAbort = () => { void interrupt(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; void interrupt(); }, timeoutMs);
    timeout.unref?.();
    try {
      client = await this.createAppServer(request);
      client.onRequest(async childRequest => {
        const approvalHandler = requestApproval ?? this.dependencies.requestApproval;
        const approved = request.purpose === "execute"
          && (approvalHandler ? await approvalHandler(childRequest) : false);
        if (!approved) {
          return { decision: childRequest.method.includes("fileChange") ? "decline" : "decline" };
        }
        return { decision: childRequest.method.includes("fileChange") ? "accept" : "accept" };
      });
      client.onNotification((method, params) => {
        const value = params as Record<string, unknown>;
        if (method === "item/agentMessage/delta" && typeof value.delta === "string") answer += value.delta;
        if (method === "item/completed") answer = itemAnswer(value.item) ?? answer;
        if (method === "thread/tokenUsage/updated") usage = usageFrom(value.tokenUsage ?? value.usage) ?? usage;
        if (method === "turn/completed") {
          const turn = value.turn as Record<string, unknown> | undefined;
          const status = turn?.status;
          markTerminal(status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed");
        }
      });
      await client.request("initialize", {
        clientInfo: { name: "codex-chatgpt-web", version: "runner" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      client.notify("initialized");
      const started = await client.request("thread/start", {
        model: request.model,
        cwd: request.cwd,
        runtimeWorkspaceRoots: request.workspace_roots,
        approvalPolicy: request.purpose === "execute" ? "on-request" : "never",
        sandbox: request.purpose === "execute" ? "workspace-write" : "read-only",
        ephemeral: true,
        allowProviderModelFallback: false,
        developerInstructions: "This is an ephemeral Web Agent Runner task. The web_agent_runner MCP server is disabled for this child. Web-to-Web delegation is forbidden; native Codex subagents require an explicit native model.",
        config: {
          "mcp_servers.web_agent_runner.enabled": false,
          "allow_provider_model_fallback": false,
        },
      });
      const startedThread = started.thread as Record<string, unknown> | undefined;
      threadId = typeof startedThread?.id === "string" ? startedThread.id : typeof started.threadId === "string" ? started.threadId : undefined;
      if (!threadId) throw new Error("Codex App Server did not return an ephemeral thread id");
      const turn = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.task, text_elements: [] }],
        model: request.model,
        approvalPolicy: request.purpose === "execute" ? "on-request" : "never",
        sandboxPolicy: request.purpose === "execute"
          ? {
              type: "workspaceWrite",
              writableRoots: request.workspace_roots,
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            }
          : { type: "readOnly", networkAccess: false },
      });
      const startedTurn = turn.turn as Record<string, unknown> | undefined;
      turnId = typeof startedTurn?.id === "string" ? startedTurn.id : typeof turn.turnId === "string" ? turn.turnId : undefined;
      if (!turnId) throw new Error("Codex App Server did not return a turn id");
      // Cancellation can arrive while thread/start is still in flight. Replay the interrupt once
      // the exact child turn identity exists so the early cancellation cannot leave a live browser.
      if (cancellationStarted && !terminal) {
        cancellationStarted = false;
        cancellationPromise = undefined;
        await interrupt();
      }
      if (signal?.aborted) await interrupt();
      else await Promise.race([terminalPromise, cancellationPromise ?? new Promise<void>(() => {})]);
      if (signal?.aborted) markTerminal("cancelled");
      if (!terminal) markTerminal("failed");
      return {
        run_id: runId,
        status: signal?.aborted ? "cancelled" : timedOut ? "failed" : terminal!,
        model: request.model,
        ...(answer ? { answer } : {}),
        ...(usage ? { usage } : {}),
        cleanup_warnings: warnings,
      };
    } catch (error) {
      if (signal?.aborted) return { run_id: runId, status: "cancelled", model: request.model, cleanup_warnings: warnings };
      warnings.push({ code: "cleanup_warning", stage: "app_server", message: error instanceof Error ? error.message : String(error) });
      return { run_id: runId, status: "failed", model: request.model, cleanup_warnings: warnings };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted || timedOut) await interrupt();
      try { await client?.close(); } catch (error) {
        warnings.push({ code: "cleanup_warning", stage: "app_server_close", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async createAppServer(request: WebAgentRunRequest): Promise<AppServerClient> {
    if (this.dependencies.createAppServer) return this.dependencies.createAppServer({
      executable: this.dependencies.executable ?? process.env.CODEX_CLI_PATH?.trim() ?? "codex",
      cwd: request.cwd,
    });
    return JsonRpcAppServerClient.start({
      executable: this.dependencies.executable ?? process.env.CODEX_CLI_PATH?.trim() ?? "codex",
      cwd: request.cwd,
    });
  }
}

class JsonRpcAppServerClient implements AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private requestHandler?: (request: WebAgentApprovalRequest & { id: string | number }) => Promise<Record<string, unknown>>;
  private notificationHandler?: (method: string, params: Record<string, unknown>) => void;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly lines: Interface,
  ) {
    lines.on("line", line => this.receive(line));
    child.once("error", error => this.fail(error));
    child.once("close", code => {
      if (code !== 0) this.fail(new Error(`Codex App Server exited with code ${code ?? "unknown"}`));
      else this.fail(new Error("Codex App Server closed before completing the request"));
    });
  }

  static async start(options: AppServerStartOptions): Promise<JsonRpcAppServerClient> {
    const child = spawn(options.executable, ["app-server"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_WEB_AGENT_RUNNER_CHILD: "1" },
    });
    return new JsonRpcAppServerClient(child, createInterface({ input: child.stdout }));
  }

  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  onRequest(handler: (request: WebAgentApprovalRequest & { id: string | number }) => Promise<Record<string, unknown>>): void {
    this.requestHandler = handler;
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  async close(): Promise<void> {
    this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise<void>(resolve => this.child.once("close", () => resolve()));
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = message.id as string | number | undefined;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error && typeof message.error === "object") {
        pending.reject(new Error(String((message.error as Record<string, unknown>).message ?? "App Server request failed")));
      } else {
        pending.resolve((message.result as Record<string, unknown> | undefined) ?? {});
      }
      return;
    }
    if (id !== undefined && typeof message.method === "string") {
      void (this.requestHandler
        ? this.requestHandler({ id, method: message.method, params: message.params as Record<string, unknown> | undefined })
          .catch(() => ({ decision: "decline" }))
        : Promise.resolve({ decision: "decline" })).then(result => {
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        });
      return;
    }
    if (typeof message.method === "string") this.notificationHandler?.(message.method, (message.params as Record<string, unknown> | undefined) ?? {});
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function webAgentApprovalMessage(request: WebAgentApprovalRequest): string {
  return approvalDescription(request);
}
