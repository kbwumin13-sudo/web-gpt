import { expect, test } from "bun:test";
import {
  classifyMemoryTool,
  isMemoryTool,
  memoryCapabilities,
  memoryCapabilityIsReachable,
  memoryReadCapabilityNames,
  memoryRetrievalSnapshot,
  memoryWireNameIsReachable,
  recordMemoryRetrievalAvailability,
  resetMemoryRetrievalTelemetry,
} from "../src/adapters/chatgpt-web/memory-capabilities";
import type { CodexTool } from "../src/types";

function tool(namespace: string | undefined, name: string): CodexTool {
  return { name, description: "", parameters: {}, ...(namespace ? { namespace } : {}) };
}

test("memory tools are recognised by namespace, not by product name alone", () => {
  expect(isMemoryTool(tool("mcp__openviking_memory", "search"))).toBeTrue();
  expect(isMemoryTool(tool("mcp__project_memory", "read"))).toBeTrue();
  expect(isMemoryTool(tool("mcp__viking", "grep"))).toBeTrue();
  expect(isMemoryTool(tool("mcp__context7", "search"))).toBeFalse();
  expect(isMemoryTool(tool(undefined, "exec_command"))).toBeFalse();
  // A namespace that merely contains the letters must not match.
  expect(isMemoryTool(tool("mcp__memorabilia", "read"))).toBeFalse();
});

test("operations are classified as read, write, or neither", () => {
  for (const name of ["search", "read", "find", "grep", "glob", "list", "recall"]) {
    expect(classifyMemoryTool(tool("mcp__openviking_memory", name))).toBe("read");
  }
  for (const name of ["remember", "write", "edit", "forget", "delete", "update"]) {
    expect(classifyMemoryTool(tool("mcp__openviking_memory", name))).toBe("write");
  }
  expect(classifyMemoryTool(tool("mcp__openviking_memory", "summarise"))).toBe("unclassified");
});

test("only classified reads are reachable, and non-memory tools are untouched", () => {
  expect(memoryCapabilityIsReachable(tool("mcp__openviking_memory", "search"))).toBeTrue();
  expect(memoryCapabilityIsReachable(tool("mcp__openviking_memory", "remember"))).toBeFalse();
  expect(memoryCapabilityIsReachable(tool("mcp__openviking_memory", "forget"))).toBeFalse();
  // Fail closed: an operation nothing has classified is not assumed to be safe.
  expect(memoryCapabilityIsReachable(tool("mcp__openviking_memory", "summarise"))).toBeFalse();
  expect(memoryCapabilityIsReachable(tool("mcp__context7", "resolve"))).toBeTrue();
  expect(memoryCapabilityIsReachable(tool(undefined, "exec_command"))).toBeTrue();
});

test("the same rule applies to a name discovered through the exec gateway", () => {
  expect(memoryWireNameIsReachable("mcp__openviking_memory__search")).toBeTrue();
  expect(memoryWireNameIsReachable("mcp__openviking_memory__remember")).toBeFalse();
  expect(memoryWireNameIsReachable("mcp__openviking_memory__summarise")).toBeFalse();
  // Non-memory and unnamespaced capabilities are not this rule's business.
  expect(memoryWireNameIsReachable("mcp__context7__search")).toBeTrue();
  expect(memoryWireNameIsReachable("exec_command")).toBeTrue();
});

test("retrieval capabilities are listed exactly and in a stable order", () => {
  const tools = [
    tool("mcp__openviking_memory", "remember"),
    tool("mcp__openviking_memory", "search"),
    tool(undefined, "exec_command"),
    tool("mcp__openviking_memory", "read"),
  ];
  expect(memoryReadCapabilityNames(tools)).toEqual([
    "mcp__openviking_memory__read",
    "mcp__openviking_memory__search",
  ]);
});

test("capabilities report their kind so governance and naming share one classification", () => {
  expect(memoryCapabilities([
    tool("mcp__openviking_memory", "search"),
    tool("mcp__openviking_memory", "forget"),
    tool(undefined, "exec_command"),
  ])).toEqual([
    { wireName: "mcp__openviking_memory__search", kind: "read" },
    { wireName: "mcp__openviking_memory__forget", kind: "write" },
  ]);
});

test("retrieval availability is counted per turn so a silent misconfiguration becomes visible", () => {
  resetMemoryRetrievalTelemetry();
  expect(memoryRetrievalSnapshot()).toEqual({
    turns_with_retrieval: 0,
    turns_without_retrieval: 0,
    last_capabilities: [],
  });

  recordMemoryRetrievalAvailability(["mcp__openviking_memory__search"]);
  recordMemoryRetrievalAvailability([]);
  recordMemoryRetrievalAvailability([]);

  expect(memoryRetrievalSnapshot()).toEqual({
    turns_with_retrieval: 1,
    turns_without_retrieval: 2,
    // The last known capability set survives a turn that had none, so a harness that stopped
    // registering retrieval is distinguishable from one that never did.
    last_capabilities: ["mcp__openviking_memory__search"],
  });
  resetMemoryRetrievalTelemetry();
});
