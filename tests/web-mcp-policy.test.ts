import { expect, test } from "bun:test";
import {
  assertNativeSpawnAgentArguments,
  execGatewayProgram,
  isWebAgentRunnerToolName,
} from "../src/adapters/chatgpt-web/mcp-server";

test("Web model policy rejects missing and Web spawn models but accepts explicit native models", () => {
  expect(() => assertNativeSpawnAgentArguments("collaboration__spawn_agent", {})).toThrow("explicit native model");
  expect(() => assertNativeSpawnAgentArguments("collaboration__spawn_agent", { model: "chatgpt-web/high" })).toThrow("Web subagents");
  expect(() => assertNativeSpawnAgentArguments("collaboration__spawn_agent", { model: "gpt-5.6-sol" })).not.toThrow();
});

test("the exec gateway carries the same spawn-agent guard and hides the Runner tool", () => {
  const program = execGatewayProgram("collaboration__spawn_agent", false, { arguments: { task: "x" } }, []);
  expect(program).toContain("spawn_agent requires an explicit native model");
  expect(program).toContain("cannot spawn Web subagents");
  expect(isWebAgentRunnerToolName("mcp__web_agent_runner__web_agent_run")).toBeTrue();
  expect(isWebAgentRunnerToolName("other__web_agent_run")).toBeTrue();
});
