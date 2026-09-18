import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getGatewayServiceStatus, getServiceStatus } from "../src/service";
import { getCodexConfigPath, inspectCodexIntegration } from "../src/codex-integration";
import { loadConfig } from "../src/config";

type RpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notifications: RpcMessage[] = [];
  private buffer = "";
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
            if (message.method) this.notifications.push(message);
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
      for (const pending of this.pending.values()) pending.reject(new Error("Codex app-server exited"));
      this.pending.clear();
    }
  }

  async waitForNotification(method: string, predicate: (message: RpcMessage) => boolean, timeoutMs = 180_000): Promise<RpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.notifications.findIndex(message => message.method === method && predicate(message));
      if (index >= 0) return this.notifications.splice(index, 1)[0]!;
      await Bun.sleep(25);
    }
    throw new Error(`${method} timed out after ${timeoutMs}ms; pending_notifications=${this.notifications.map(message => message.method ?? "unknown").join(",") || "none"}`);
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
  // The default prompt answers in two characters, which never keeps a response stream open long
  // enough to reach ChatGPT's `stream_handoff`. That path stayed uncovered until a real task hit
  // it, so the harness has to be able to ask for a long answer.
  const promptFlag = process.argv.indexOf("--prompt");
  const prompt = promptFlag >= 0 ? process.argv[promptFlag + 1] : undefined;
  if (promptFlag >= 0 && (prompt === undefined || prompt.startsWith("--"))) {
    throw new Error("--prompt requires a value");
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
    if (liveLuna || liveWeb || liveHigh) {
      const liveModel = liveLuna ? "gpt-5.6-luna" : liveHigh ? "chatgpt-web/high" : "chatgpt-web/light";
      const started = await client.request("thread/start", {
        cwd: process.cwd(),
        model: liveModel,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      }) as { thread?: { id?: unknown } };
      const threadId = started.thread?.id;
      if (typeof threadId !== "string") throw new Error("thread/start returned no Luna thread id");
      const turnStarted = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt ?? "Reply with OK only." }],
      }) as { turn?: { id?: unknown } };
      const turnId = turnStarted.turn?.id;
      if (typeof turnId !== "string") throw new Error("turn/start returned no Luna turn id");
      const completed = await client.waitForNotification(
        "turn/completed",
        message => message.method === "turn/completed",
      );
      const status = (completed as RpcMessage & { params?: { turn?: { status?: unknown } } }).params?.turn?.status;
      if (status !== "completed") {
        const turn = (completed as RpcMessage & { params?: { turn?: Record<string, unknown> } }).params?.turn;
        throw new Error(`${liveModel} turn completed with status ${String(status ?? "unknown")}: ${JSON.stringify(turn ?? {})}`);
      }
      liveTurn = { model: liveModel, thread_id: threadId, turn_id: turnId, status, notification: completed.method };
    }
    const backendService = getServiceStatus();
    const gatewayService = getGatewayServiceStatus();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      gateway: { port: config.nativeGatewayPort, service: gatewayService },
      backend: { port: config.port, service: backendService },
      modelList: { nativeLuna: true, webModels: names.filter(name => name.startsWith("chatgpt-web/")) },
      ...(liveTurn ? { liveTurn } : { note: "This gate verifies routing and model discovery; pass --live-luna or --live-web to run a live turn." }),
    }, null, 2)}\n`);
  } finally {
    appServerStderr = await client.close();
    if (appServerStderr.trim()) process.stderr.write(`Codex app-server stderr:\n${appServerStderr.slice(-8_000)}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`installed acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
