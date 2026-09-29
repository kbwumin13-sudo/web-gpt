import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getGatewayServiceStatus, getServiceStatus, startService, stopService, waitForBackendReady } from "../src/service";
import { getCodexConfigPath, inspectCodexIntegration } from "../src/codex-integration";
import { loadConfig } from "../src/config";
import { InstalledTurnEvidence, visibleFinalText } from "./installed-turn-evidence";
import { requireChatGptWebModelRoute } from "../src/chatgpt-web-models";

type RpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notifications: RpcMessage[] = [];
  private buffer = "";
  private closed = false;
  private readonly input: Bun.FileSink;
  private readonly output: ReadableStream<Uint8Array>;
  private readonly errors: ReadableStream<Uint8Array>;
  readonly child: ReturnType<typeof Bun.spawn>;

  constructor(executable: string) {
    const providerArgs = process.argv.includes("--custom-provider")
      ? ["-c", 'model_provider="custom"']
      : [];
    const child = Bun.spawn([executable, ...providerArgs, "app-server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdin === "number" || child.stdin === undefined
      || !(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      throw new Error("Codex app-server pipes are unavailable");
    }
    this.child = child;
    this.input = child.stdin;
    this.output = child.stdout;
    this.errors = child.stderr;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = this.output.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as RpcMessage;
          if (typeof message.id !== "number") {
            if (message.method) {
              this.notifications.push(message);
              if (process.argv.includes("--live-compact")
                && (message.method === "thread/compacted" || message.method === "turn/completed"
                  || message.method === "item/completed")) {
                const params = message.params as { turnId?: unknown; turn?: { id?: unknown; status?: unknown }; item?: { type?: unknown } } | undefined;
                process.stderr.write(`compaction_notification ${JSON.stringify({
                  method: message.method,
                  turnId: params?.turnId ?? params?.turn?.id ?? null,
                  status: params?.turn?.status ?? null,
                  itemType: params?.item?.type ?? null,
                })}\n`);
              }
            }
            continue;
          }
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`${message.error.code ?? "RPC"}: ${message.error.message ?? "unknown error"}`));
          else pending.resolve(message.result);
        }
      }
    } finally {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Codex app-server exited"));
      this.pending.clear();
    }
  }

  async waitForTurn(
    evidence: InstalledTurnEvidence,
    timeoutMs = 180_000,
    onNotification?: (message: { method?: string; params?: unknown }) => void,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let completed = false;
      for (const message of this.notifications.splice(0)) {
        onNotification?.(message);
        if (evidence.observe(message)) completed = true;
      }
      if (completed) return;
      if (this.closed) throw new Error(`Codex app-server exited before exact turn ${evidence.turnId} completed`);
      await Bun.sleep(25);
    }
    throw new Error(`Exact turn ${evidence.turnId} timed out after ${timeoutMs}ms`);
  }

  async waitForCompaction(threadId: string, timeoutMs = 600_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let compactionTurnId: string | undefined;
    while (Date.now() < deadline) {
      for (const message of this.notifications.splice(0)) {
        const params = message.params as { threadId?: unknown; turnId?: unknown; turn?: { status?: unknown; id?: unknown; items?: Array<{ type?: unknown }> }; item?: { type?: unknown } } | undefined;
        if (params?.threadId !== threadId) continue;
        if (message.method === "thread/compacted" && typeof params.turnId === "string") return params.turnId;
        if (message.method === "item/completed" && params.item?.type === "contextCompaction"
          && typeof params.turnId === "string") compactionTurnId = params.turnId;
        if (message.method === "turn/completed" && params.turn?.status === "failed") {
          throw new Error(`Compaction turn ${String(params.turn.id)} failed`);
        }
        if (message.method === "turn/completed" && params.turn?.status === "completed"
          && typeof params.turn.id === "string"
          && (params.turn.id === compactionTurnId
            || params.turn.items?.some(item => item.type === "contextCompaction"))) return params.turn.id;
      }
      if (this.closed) throw new Error("Codex app-server exited before compaction completed");
      await Bun.sleep(25);
    }
    throw new Error(`Thread ${threadId} compaction timed out after ${timeoutMs}ms`);
  }

  notify(method: string, params: unknown = {}): void {
    this.input.write(`${JSON.stringify({ method, params })}\n`);
    this.input.flush();
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    this.input.write(`${JSON.stringify({ id, method, params })}\n`);
    this.input.flush();
    const timeout = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    return promise.finally(() => clearTimeout(timeout));
  }

  async close(): Promise<string> {
    this.child.kill();
    const stderr = new Response(this.errors).text();
    await this.child.exited;
    return stderr;
  }
}

function modelNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap(model => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const entry = model as { model?: unknown; id?: unknown; slug?: unknown };
    const name = [entry.model, entry.id, entry.slug].find(candidate => typeof candidate === "string");
    return name ? [name] : [];
  });
}

async function main(): Promise<void> {
  const liveLuna = process.argv.includes("--live-luna");
  const liveWeb = process.argv.includes("--live-web");
  const liveHigh = process.argv.includes("--live-high");
  const liveModelFlag = process.argv.indexOf("--live-model");
  const namedLiveModel = liveModelFlag >= 0 ? process.argv[liveModelFlag + 1] : undefined;
  if (liveModelFlag >= 0 && (!namedLiveModel || namedLiveModel.startsWith("--"))) {
    throw new Error("--live-model requires a chatgpt-web model ID");
  }
  if ([liveLuna, liveWeb, liveHigh, namedLiveModel !== undefined].filter(Boolean).length > 1) {
    throw new Error("Choose only one live model flag");
  }
  const liveWorkspaceTask = process.argv.includes("--live-workspace-task");
  const liveToolRead = process.argv.includes("--live-tool-read");
  const liveContinuity = process.argv.includes("--live-continuity");
  const liveCompact = process.argv.includes("--live-compact");
  const liveLostSession = process.argv.includes("--live-lost-session");
  if (liveCompact && !liveContinuity) throw new Error("--live-compact requires --live-continuity");
  if (liveLostSession && !liveContinuity) throw new Error("--live-lost-session requires --live-continuity");
  const liveImage = process.argv.includes("--live-image");
  if (liveWorkspaceTask && liveToolRead) throw new Error("Choose one live tool task");
  if (liveImage && (liveLuna || liveWorkspaceTask || liveToolRead || liveContinuity || !(liveWeb || liveHigh || namedLiveModel))) {
    throw new Error("--live-image requires one Web model and no other live task mode");
  }
  if (liveContinuity && (liveLuna || liveWorkspaceTask || liveToolRead || !(liveWeb || liveHigh || namedLiveModel))) {
    throw new Error("--live-continuity requires one Web model and no other live task mode");
  }
  if (liveWorkspaceTask && (liveLuna || !(liveWeb || liveHigh || namedLiveModel))) {
    throw new Error("--live-workspace-task requires a Web model route");
  }
  if (liveToolRead && (liveLuna || !(liveWeb || liveHigh || namedLiveModel))) {
    throw new Error("--live-tool-read requires a Web model route");
  }
  // The default prompt answers in two characters, which never keeps a response stream open long
  // enough to reach ChatGPT's `stream_handoff`. That path stayed uncovered until a real task hit
  // it, so the harness has to be able to ask for a long answer.
  const promptFlag = process.argv.indexOf("--prompt");
  const prompt = promptFlag >= 0 ? process.argv[promptFlag + 1] : undefined;
  if (promptFlag >= 0 && (prompt === undefined || prompt.startsWith("--"))) {
    throw new Error("--prompt requires a value");
  }
  const expectedFlag = process.argv.indexOf("--expect-text");
  const expected = expectedFlag >= 0 ? process.argv[expectedFlag + 1]
    : prompt === undefined && liveToolRead ? "FILE_ALPHA"
      : prompt === undefined && liveImage ? "RED"
      : prompt === undefined && !liveWorkspaceTask ? "OK" : undefined;
  if (expectedFlag >= 0 && (expected === undefined || expected.startsWith("--"))) {
    throw new Error("--expect-text requires a value");
  }
  if (liveContinuity && (prompt !== undefined || expectedFlag >= 0)) {
    throw new Error("--live-continuity uses its fixed three-round acceptance prompts");
  }
  const config = loadConfig();
  if (config.browserHost === "launcher") throw new Error("Installed native gateway acceptance requires managed-chrome setup");
  if (config.nativeGatewayPort === config.port) throw new Error("Native gateway and Web backend ports are not isolated");
  if (!existsSync(getCodexConfigPath())) throw new Error("Codex config is missing");
  const integration = inspectCodexIntegration();
  if (!integration.installed || !integration.active) throw new Error("Codex route is not installed and active");
  if (integration.routeUrl !== `http://${config.host}:${config.nativeGatewayPort}/v1`) {
    throw new Error(`Codex route does not target the native gateway: ${integration.routeUrl ?? "missing"}`);
  }
  const gatewayResponse = await fetch(`http://${config.host}:${config.nativeGatewayPort}/healthz`);
  if (!gatewayResponse.ok) throw new Error(`Native gateway returned HTTP ${gatewayResponse.status}`);
  const gateway = await gatewayResponse.json() as Record<string, unknown>;
  if (gateway.service !== "codex-chatgpt-web-gateway" || gateway.status !== "ok") {
    throw new Error("Native gateway returned an invalid health payload");
  }
  const appServerExecutable = process.env.CODEX_APP_SERVER_EXECUTABLE?.trim() || Bun.which("codex") || resolve("/Applications/ChatGPT.app/Contents/Resources/codex");
  if (!existsSync(appServerExecutable)) throw new Error(`Codex executable is missing: ${appServerExecutable}`);
  const client = new AppServerClient(appServerExecutable);
  let appServerStderr = "";
  let acceptanceResult: Record<string, unknown> | undefined;
  let liveWorkspace: string | undefined;
  try {
    await client.request("initialize", {
      clientInfo: { name: "codex-chatgpt-web-installed-acceptance", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const catalog = await client.request("model/list", { includeHidden: false });
    const names = modelNames(catalog);
    if (!names.includes("gpt-5.6-luna")) throw new Error("Codex model/list did not include native gpt-5.6-luna");
    if (!names.some(name => name.startsWith("chatgpt-web/"))) throw new Error("Codex model/list did not include routed Web models");
    let liveTurn: Record<string, unknown> | undefined;
    if (liveLuna || liveWeb || liveHigh || namedLiveModel) {
      const liveModel = liveLuna ? "gpt-5.6-luna" : namedLiveModel ?? (liveHigh ? "chatgpt-web/high" : "chatgpt-web/light");
      if (!names.includes(liveModel)) throw new Error(`Codex model/list did not include ${liveModel}`);
      if (!liveLuna) requireChatGptWebModelRoute(liveModel, config);
      const workspace = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-live-task-"));
      liveWorkspace = workspace;
      if (liveWorkspaceTask || liveToolRead) writeFileSync(join(workspace, "input.txt"), "alpha\n", { mode: 0o600 });
      const redImagePath = join(workspace, "red.png");
      if (liveImage) writeFileSync(redImagePath, Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAMAjAsK7+PTMRPLhGQd7QJnESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ES53Vg6wNShQF/fRSLfgAAAABJRU5ErkJggg==",
        "base64",
      ), { mode: 0o600 });
      const started = await client.request("thread/start", {
        cwd: workspace,
        model: liveModel,
        approvalPolicy: "never",
        sandbox: liveWorkspaceTask || liveToolRead ? "workspace-write" : "read-only",
        ephemeral: true,
      }) as { thread?: { id?: unknown } };
      const threadId = started.thread?.id;
      if (typeof threadId !== "string") throw new Error("thread/start returned no Luna thread id");
      const turnStartedAt = Date.now();
      let lastTurnStartedAt = turnStartedAt;
      const turnStarted = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: liveContinuity
          ? "Remember the phrase COBALT-682 for this task. Reply READY only."
          : liveImage ? "Identify the dominant color of the attached square. Reply RED only if the pixels are red."
          : prompt ?? (liveWorkspaceTask
          ? "Read input.txt. Create result.txt containing exactly `alpha: verified` followed by one newline. Then run a command that reads result.txt to verify it. Finish only after the command succeeds."
          : liveToolRead
            ? "Call the attached Codex Native2 connector's codex_exec tool with a command that reads input.txt in this workspace. Use the turn_token supplied in the task context. If and only if stdout is exactly alpha followed by a newline, reply with FILE_ALPHA only. Do not guess the file contents."
            : "Reply with OK only.") }, ...(liveImage ? [{ type: "localImage", path: redImagePath, detail: "high" }] : [])],
      }) as { turn?: { id?: unknown } };
      const turnId = turnStarted.turn?.id;
      if (typeof turnId !== "string") throw new Error("turn/start returned no Luna turn id");
      const evidence = new InstalledTurnEvidence(threadId, turnId);
      await client.waitForTurn(evidence);
      const { status, answer, toolItems, turn } = evidence.outcome();
      const toolEvidence = toolItems.map(item => ({
        type: item.type,
        status: item.status,
        exitCode: item.exitCode,
      }));
      if (status !== "completed") {
        const error = turn.error && typeof turn.error === "object" && !Array.isArray(turn.error)
          ? (turn.error as { message?: unknown }).message
          : undefined;
        throw new Error(`${liveModel} turn ${turnId} completed with status ${status}: ${typeof error === "string" ? error : "no error detail"}`);
      }
      if (!answer.trim()) throw new Error(`${liveModel} turn ${turnId} completed without a final answer`);
      const firstExpected = liveContinuity ? "READY" : expected;
      if (firstExpected !== undefined && visibleFinalText(answer) !== firstExpected) {
        throw new Error(`${liveModel} turn ${turnId} produced an unexpected final answer`
          + ` (chars=${answer.length}, hasExpected=${answer.includes(firstExpected)}, toolEvidence=${JSON.stringify(toolEvidence)}`
          + `${liveToolRead ? `, deterministicAnswer=${JSON.stringify(answer.slice(0, 160))}` : ""})`);
      }
      const actualToolItems = toolItems.filter(item => item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "functionCallOutput");
      if ((liveWorkspaceTask || liveToolRead) && actualToolItems.length === 0) {
        throw new Error(`${liveModel} turn ${turnId} completed without an observed local tool receipt (answerChars=${answer.length})`);
      }
      const verifiedReadItems = toolItems.filter(item => item.type === "commandExecution"
        && typeof item.command === "string" && item.command.includes("input.txt")
        && item.status === "completed" && item.exitCode === 0
        && typeof item.aggregatedOutput === "string" && item.aggregatedOutput.includes("alpha"));
      if (liveToolRead && verifiedReadItems.length === 0) {
        throw new Error(`${liveModel} turn ${turnId} has no successful command reading input.txt and returning alpha`);
      }
      const continuityRounds: Array<{ turn_id: string; answer_sha256: string }> = [];
      let compactedTurnId: string | undefined;
      let compactedMode: "retained" | "fresh" | undefined;
      if (liveContinuity) {
        continuityRounds.push({ turn_id: turnId, answer_sha256: createHash("sha256").update(answer).digest("hex") });
        for (const [index, [nextPrompt, nextExpected]] of [
          ["What exact phrase did I ask you to remember in the first round? Reply with only that phrase.", "COBALT-682"],
          ["Append -DONE to the phrase from the first round. Reply with only the resulting string.", "COBALT-682-DONE"],
        ].entries()) {
          lastTurnStartedAt = Date.now();
          const nextStarted = await client.request("turn/start", {
            threadId,
            input: [{ type: "text", text: nextPrompt }],
          }) as { turn?: { id?: unknown } };
          const nextTurnId = nextStarted.turn?.id;
          if (typeof nextTurnId !== "string") throw new Error("Continuation turn/start returned no turn ID");
          const nextEvidence = new InstalledTurnEvidence(threadId, nextTurnId);
          await client.waitForTurn(nextEvidence);
          const nextOutcome = nextEvidence.outcome();
          if (nextOutcome.status !== "completed" || visibleFinalText(nextOutcome.answer) !== nextExpected) {
            throw new Error(`${liveModel} continuation ${nextTurnId} failed exact prior-fact recall`
              + ` (status=${nextOutcome.status}, answerChars=${nextOutcome.answer.length})`);
          }
          continuityRounds.push({
            turn_id: nextTurnId,
            answer_sha256: createHash("sha256").update(nextOutcome.answer).digest("hex"),
          });
          if (liveLostSession && index === 0) {
            const beforeRestart = await (await fetch(`http://${config.host}:${config.port}/healthz`)).json() as {
              active_http_turns?: number; active_browser_turns?: number;
            };
            if (beforeRestart.active_http_turns !== 0 || beforeRestart.active_browser_turns !== 0) {
              throw new Error("Lost-session acceptance requires an idle backend before its controlled restart");
            }
            await stopService(config);
            startService();
            await waitForBackendReady(config);
          }
          if (liveCompact && index === 0) {
            const compactionMetrics = async (): Promise<{ delivered: number; fresh_rounds: number; failed: number; abandoned: number }> => {
              const response = await fetch(`http://${config.host}:${config.port}/healthz`);
              if (!response.ok) throw new Error(`Compaction metrics returned HTTP ${response.status}`);
              const health = await response.json() as { compaction?: { delivered?: number; fresh_rounds?: number; failed?: number; abandoned?: number } };
              const metrics = health.compaction;
              if (!metrics || ![metrics.delivered, metrics.fresh_rounds, metrics.failed, metrics.abandoned].every(Number.isInteger)) {
                throw new Error("Backend did not expose complete compaction mode evidence");
              }
              return metrics as { delivered: number; fresh_rounds: number; failed: number; abandoned: number };
            };
            const beforeCompaction = await compactionMetrics();
            await client.request("thread/compact/start", { threadId }, 600_000);
            compactedTurnId = await client.waitForCompaction(threadId);
            const afterCompaction = await compactionMetrics();
            const expectedFreshDelta = liveLostSession ? 1 : 0;
            if (afterCompaction.delivered !== beforeCompaction.delivered + 1
              || afterCompaction.fresh_rounds !== beforeCompaction.fresh_rounds + expectedFreshDelta
              || afterCompaction.failed !== beforeCompaction.failed
              || afterCompaction.abandoned !== beforeCompaction.abandoned) {
              throw new Error(`Compaction completed on the wrong path: expected=${liveLostSession ? "fresh" : "retained"}, before=${JSON.stringify(beforeCompaction)}, after=${JSON.stringify(afterCompaction)}`);
            }
            compactedMode = liveLostSession ? "fresh" : "retained";
          }
        }
      }
      if (!liveLuna) {
        const backendResponse = await fetch(`http://${config.host}:${config.port}/healthz`);
        if (!backendResponse.ok) throw new Error("Web backend health could not be read after the completed turn");
        const backend = await backendResponse.json() as {
          web_readiness?: { status?: string; last_successful_turn_at?: string | null; last_successful_model?: string | null; last_successful_effort?: string | null };
        };
        const expectedRoute = requireChatGptWebModelRoute(liveModel, config);
        const ready = backend.web_readiness;
        if (ready?.status !== "ready"
          || !ready.last_successful_turn_at
          || Date.parse(ready.last_successful_turn_at) < lastTurnStartedAt
          || ready.last_successful_model !== expectedRoute.backendModel
          || ready.last_successful_effort !== expectedRoute.adapterEffort) {
          throw new Error(`${liveModel} completed without matching current-browser model and effort evidence`);
        }
      }
      const workspaceResult = liveWorkspaceTask
        ? (() => {
          const actual = readFileSync(join(workspace, "result.txt"), "utf8");
          if (actual !== "alpha: verified\n") {
            throw new Error(`workspace task wrote unexpected result.txt: ${JSON.stringify(actual)}`);
          }
          return { verified: true };
        })()
        : undefined;
      liveTurn = {
        model: liveModel,
        thread_id: threadId,
        turn_id: turnId,
        status,
        answer_chars: answer.length,
        answer_sha256: createHash("sha256").update(answer).digest("hex"),
        tool_items: toolItems.length,
        ...(liveContinuity ? { continuity: { rounds: continuityRounds, ...(compactedTurnId ? { compacted_turn_id: compactedTurnId, compacted_mode: compactedMode } : {}), ...(liveLostSession ? { backend_restarted: true } : {}) } } : {}),
        ...(liveImage ? { image_input: { verified: true, pixel_color: "red", dimensions: "64x64" } } : {}),
        ...(liveToolRead ? { tool_read: { verified: true, local_tool_items: verifiedReadItems.length } } : {}),
        ...(workspaceResult ? { workspace_task: workspaceResult } : {}),
      };
    }
    const backendService = getServiceStatus();
    const gatewayService = getGatewayServiceStatus();
    acceptanceResult = {
      ok: true,
      gateway: { port: config.nativeGatewayPort, service: gatewayService },
      backend: { port: config.port, service: backendService },
      modelList: { nativeLuna: true, webModels: names.filter(name => name.startsWith("chatgpt-web/")) },
      ...(liveTurn ? { liveTurn } : { note: "This gate verifies routing and model discovery; pass --live-luna or --live-web to run a live turn." }),
    };
  } finally {
    appServerStderr = await client.close();
    if (liveWorkspace) rmSync(liveWorkspace, { recursive: true, force: true });
    if (appServerStderr.trim()) process.stderr.write(`Codex app-server stderr:\n${appServerStderr.slice(-8_000)}\n`);
  }
  if ((liveLuna || liveWeb || liveHigh || namedLiveModel) && /stream disconnected - retrying sampling request/.test(appServerStderr)) {
    throw new Error("The exact Codex turn required an implicit sampling retry; this live acceptance does not pass");
  }
  process.stdout.write(`${JSON.stringify(acceptanceResult, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`installed acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
