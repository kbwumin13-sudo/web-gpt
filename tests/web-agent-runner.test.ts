import { expect, test } from "bun:test";
import {
  WebAgentRunner,
  WEB_AGENT_MODELS,
  validateWebAgentModel,
  type AppServerClient,
  type AppServerStartOptions,
} from "../src/adapters/chatgpt-web/web-agent-runner";

class FakeAppServer implements AppServerClient {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private requestHandler?: (request: { id: string | number; method: string; params?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  private notificationHandler?: (method: string, params: Record<string, unknown>) => void;
  private turnId = "turn_fake";

  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requests.push({ method, params });
    if (method === "thread/start") return Promise.resolve({ thread: { id: "thread_fake" } });
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.notificationHandler?.("item/agentMessage/delta", { delta: "Web answer" });
        this.notificationHandler?.("turn/completed", { turn: { id: this.turnId, status: "completed" } });
      });
      return Promise.resolve({ turn: { id: this.turnId } });
    }
    if (method === "turn/interrupt") {
      this.notificationHandler?.("turn/completed", { turn: { id: this.turnId, status: "interrupted" } });
    }
    return Promise.resolve({});
  }

  notify(method: string): void { this.requests.push({ method }); }

  onRequest(handler: (request: { id: string | number; method: string; params?: Record<string, unknown> }) => Promise<Record<string, unknown>>): void {
    this.requestHandler = handler;
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  async close(): Promise<void> {}

  async askApproval(method: string): Promise<Record<string, unknown>> {
    return this.requestHandler!({ id: 1, method, params: { command: "touch approved" } });
  }
}

function fakeDependencies(fake: FakeAppServer, availableModels = new Set(WEB_AGENT_MODELS)) {
  return {
    availableModels,
    createAppServer: async (_options: AppServerStartOptions) => fake,
  };
}

test("runner sends an exact selected model and maps design to read-only", async () => {
  const fake = new FakeAppServer();
  const result = await new WebAgentRunner(fakeDependencies(fake)).run({
    task: "Design the architecture",
    model: "chatgpt-web/high",
    purpose: "design",
    cwd: "/workspace/project",
  });
  expect(result).toMatchObject({ status: "completed", model: "chatgpt-web/high", answer: "Web answer" });
  const thread = fake.requests.find(request => request.method === "thread/start")!;
  expect(thread.params).toMatchObject({ model: "chatgpt-web/high", approvalPolicy: "never", sandbox: "read-only", ephemeral: true, allowProviderModelFallback: false });
  expect(fake.requests.find(request => request.method === "initialize")?.params).toMatchObject({ capabilities: { experimentalApi: true, requestAttestation: false } });
  expect(fake.requests.find(request => request.method === "turn/start")?.params).toMatchObject({ model: "chatgpt-web/high" });
});

test("runner maps execute to workspace-write and routes approvals", async () => {
  const fake = new FakeAppServer();
  let approvalCalls = 0;
  const runner = new WebAgentRunner({
    ...fakeDependencies(fake),
    requestApproval: async () => { approvalCalls += 1; return true; },
  });
  const result = await runner.run({
    task: "Implement the fix",
    model: "chatgpt-web/extra-high",
    purpose: "execute",
    cwd: "/workspace/project",
  });
  expect(result.status).toBe("completed");
  expect(fake.requests.find(request => request.method === "thread/start")?.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  const approval = await fake.askApproval("item/commandExecution/requestApproval");
  expect(approval).toEqual({ decision: "accept" });
  expect(approvalCalls).toBe(1);
});

test("runner fails closed for an unavailable explicit Pro model and rejects unknown slugs", async () => {
  const fake = new FakeAppServer();
  const result = await new WebAgentRunner(fakeDependencies(fake, new Set(["chatgpt-web/high"]))).run({
    task: "Use Pro",
    model: "chatgpt-web/pro",
    purpose: "design",
    cwd: "/workspace/project",
  });
  expect(result).toMatchObject({ status: "failed", model: "chatgpt-web/pro" });
  expect(fake.requests).toHaveLength(0);
  expect(() => validateWebAgentModel("chatgpt-web/unknown")).toThrow("explicit Web models");
});
