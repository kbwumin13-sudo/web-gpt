import { namespacedToolName, type CodexTool } from "../../types";

/**
 * Long-term memory reaches the Web model only through the Runtime, so the bridge has to recognise
 * which of the outer turn's tools are memory operations and what each one does. Retrieval can then
 * be named exactly instead of hunted for, and read and write can be governed differently.
 *
 * Classification is by namespace and operation rather than by product, because the outer harness
 * decides what it registers and under what name.
 */
const MEMORY_NAMESPACE = /(^|_)(memory|openviking|viking)(_|$)/i;

/** Operations that only observe. Anything outside this set is not treated as a read. */
const READ_OPERATIONS = new Set([
  "search", "read", "find", "grep", "glob", "list", "get", "query", "recall", "inventory", "stat",
]);

/** Operations that create, change, or destroy stored memory. */
const WRITE_OPERATIONS = new Set([
  "remember", "write", "edit", "forget", "delete", "remove", "update", "append", "commit", "put",
  "save", "store", "merge", "rename", "move", "clear", "reset", "prune", "compact",
]);

export type MemoryCapabilityKind = "read" | "write" | "unclassified";

export interface MemoryCapability {
  wireName: string;
  kind: MemoryCapabilityKind;
}

function operationOf(tool: CodexTool): string {
  // A flattened MCP tool keeps its operation in `name`; the namespace carries the server identity.
  return tool.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").split("_").filter(Boolean).at(-1) ?? "";
}

export function isMemoryTool(tool: CodexTool): boolean {
  return MEMORY_NAMESPACE.test(tool.namespace ?? "");
}

/**
 * Unclassified memory operations are deliberately neither read nor write. Treating an unknown
 * operation as a read would name it as retrieval the model can rely on; treating it as a write
 * would hide it from a governance boundary that never decided anything about it.
 */
export function classifyMemoryTool(tool: CodexTool): MemoryCapabilityKind {
  const operation = operationOf(tool);
  if (READ_OPERATIONS.has(operation)) return "read";
  if (WRITE_OPERATIONS.has(operation)) return "write";
  return "unclassified";
}

export function memoryCapabilities(tools: readonly CodexTool[]): MemoryCapability[] {
  return tools.filter(isMemoryTool).map(tool => ({
    wireName: namespacedToolName(tool.namespace, tool.name),
    kind: classifyMemoryTool(tool),
  }));
}

/**
 * Whether a capability may be reached by the Web model. Only a classified read may: an operation
 * that creates, changes, or destroys memory is the Runtime's to perform, and an unclassified one is
 * refused because nothing has decided what it does. Hiding a read costs a lookup the model can make
 * another way; exposing a write costs long-term memory that nothing will announce as corrupted.
 */
export function memoryCapabilityIsReachable(tool: CodexTool): boolean {
  return !isMemoryTool(tool) || classifyMemoryTool(tool) === "read";
}

/**
 * The same rule for a capability discovered through the exec gateway, where only the wire name is
 * known. A namespace may itself contain the separator, so the last segment is the operation.
 */
export function memoryWireNameIsReachable(wire: string): boolean {
  const segments = wire.split("__").filter(Boolean);
  if (segments.length < 2) return true;
  const namespace = segments.slice(0, -1).join("__");
  if (!MEMORY_NAMESPACE.test(namespace)) return true;
  return classifyMemoryTool({
    name: segments.at(-1)!,
    namespace,
    description: "",
    parameters: {},
  }) === "read";
}

/** Exact retrieval capabilities available to this turn, so the prompt can name them. */
export function memoryReadCapabilityNames(tools: readonly CodexTool[]): string[] {
  return memoryCapabilities(tools)
    .filter(capability => capability.kind === "read")
    .map(capability => capability.wireName)
    .sort();
}

/**
 * Whether memory retrieval was actually registered, counted per turn. The bridge reports what the
 * outer harness exposes and cannot conjure a capability it never registered, so the dependency is
 * real. Counting it is what keeps it from being silent: a harness that stopped registering
 * retrieval otherwise looks identical to one whose memory happens to be empty.
 */
export interface MemoryRetrievalSnapshot {
  turns_with_retrieval: number;
  turns_without_retrieval: number;
  last_capabilities: string[];
}

let turnsWithRetrieval = 0;
let turnsWithoutRetrieval = 0;
let lastCapabilities: string[] = [];

export function recordMemoryRetrievalAvailability(capabilities: readonly string[]): void {
  if (capabilities.length > 0) {
    turnsWithRetrieval += 1;
    lastCapabilities = [...capabilities];
  } else {
    turnsWithoutRetrieval += 1;
  }
}

export function memoryRetrievalSnapshot(): MemoryRetrievalSnapshot {
  return {
    turns_with_retrieval: turnsWithRetrieval,
    turns_without_retrieval: turnsWithoutRetrieval,
    last_capabilities: [...lastCapabilities],
  };
}

/** Test seam: the counters are process-wide, like the rest of the daemon's telemetry. */
export function resetMemoryRetrievalTelemetry(): void {
  turnsWithRetrieval = 0;
  turnsWithoutRetrieval = 0;
  lastCapabilities = [];
}
