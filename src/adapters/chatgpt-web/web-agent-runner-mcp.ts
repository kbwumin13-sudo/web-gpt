import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { VERSION } from "../../version";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebAgentRunner, WEB_AGENT_MODELS, webAgentApprovalMessage, type WebAgentApprovalRequest } from "./web-agent-runner";

const runnerInput = {
  task: z.string().min(1).max(5_000_000),
  model: z.enum(WEB_AGENT_MODELS),
  purpose: z.enum(["design", "execute"]),
  cwd: z.string().min(1).max(16_384),
  workspace_roots: z.array(z.string().min(1).max(16_384)).max(64).optional(),
  timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
};

export async function runWebAgentRunnerMcpServer(): Promise<void> {
  const server = new McpServer({ name: "web_agent_runner", version: VERSION });
  server.registerTool(
    "web_agent_run",
    {
      title: "Run a selected ChatGPT Web model",
      description: "Start one ephemeral Codex App Server task using the explicitly selected chatgpt-web model. design is read-only; execute uses workspace-write and forwards every approval to the current Codex client.",
      inputSchema: runnerInput,
      outputSchema: {
        run_id: z.string(),
        status: z.enum(["completed", "failed", "cancelled"]),
        model: z.string(),
        answer: z.string().optional(),
        cleanup_warnings: z.array(z.object({ code: z.literal("cleanup_warning"), stage: z.string(), message: z.string() })),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => {
      const runner = new WebAgentRunner();
      const value = await runner.run(input, extra.signal, async (request: WebAgentApprovalRequest) => {
        // MCP elicitation is the only approval bridge. If the current Codex client does not
        // implement it, fail closed and let the child App Server deny the operation.
        try {
          const response = await extra.sendRequest({
            method: "elicitation/create",
            params: {
              mode: "form",
              message: webAgentApprovalMessage(request),
              requestedSchema: {
                type: "object",
                properties: {
                  decision: { type: "string", enum: ["allow", "reject"], title: "Decision" },
                },
                required: ["decision"],
              },
            },
          }, ElicitResultSchema);
          return response.action === "accept" && response.content?.decision === "allow";
        } catch {
          return false;
        }
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value as unknown as Record<string, unknown>,
      };
    },
  );
  await server.connect(new StdioServerTransport());
}
