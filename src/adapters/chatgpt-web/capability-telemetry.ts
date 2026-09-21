/**
 * How often a turn asks the bridge what it can do, and what that asking costs.
 *
 * A native Codex model is handed its tool registry with the request. This one is handed the
 * attached tools and has to run `codex_tool_inventory` for anything deeper, and every inventory
 * call that reaches the nested registry does so by running a JavaScript program through the outer
 * `exec` gateway — a real command execution in the outer Codex task, for a question about what
 * tools exist. Caching that catalog per turn would remove the repeats, and caching it would also
 * make the listing a snapshot rather than a live read.
 *
 * That trade is only worth making if the repeats are real, and nothing here could say: an
 * inventory-driven gateway exec and a command the model ran to do actual work are the same line in
 * the broker's delivery log. `tool_inventory_gateway_execs` against `calls.codex_tool_inventory`
 * says how many of those executions bought a fresh answer, and `max_calls_in_a_turn` says whether
 * any single turn asked more than once at all. A cache whose hit rate would be zero is not worth
 * the staleness it introduces.
 *
 * Counted in the broker rather than the MCP server because the MCP server is a separate process
 * reached over the turn socket, and `/healthz` is served here.
 */

/**
 * Fixed, because these keys come off the wire. An unrecognised name is dropped rather than
 * recorded: this is a counter, not a place for a caller to write to.
 */
const COUNTED_TOOLS = new Set([
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_context_search",
  "codex_context_read",
]);

export interface ChatGptCapabilityTelemetrySnapshot {
  /** Bridge tool calls by name, across all turns. */
  calls: Record<string, number>;
  /** Turns that called at least one bridge tool. */
  turns_with_calls: number;
  /** The most bridge tool calls any one turn made. */
  max_calls_in_a_turn: number;
  /** Inventory calls that ran an outer `exec` to read the nested registry. */
  tool_inventory_gateway_execs: number;
  /** The most inventory calls any one turn made. */
  max_tool_inventory_calls_in_a_turn: number;
}

const calls = new Map<string, number>();
let turnsWithCalls = 0;
let maxCallsInATurn = 0;
let maxInventoryCallsInATurn = 0;
let toolInventoryGatewayExecs = 0;

/** Bounded for the same reason the context telemetry is: a turn that never concludes must not accumulate. */
const MAX_TRACKED_TURNS = 256;
const turnCalls = new Map<string, { total: number; inventory: number }>();

export function chatGptCapabilityTelemetrySnapshot(): ChatGptCapabilityTelemetrySnapshot {
  return {
    calls: Object.fromEntries([...calls.entries()].sort(([left], [right]) => left.localeCompare(right))),
    turns_with_calls: turnsWithCalls,
    max_calls_in_a_turn: maxCallsInATurn,
    tool_inventory_gateway_execs: toolInventoryGatewayExecs,
    max_tool_inventory_calls_in_a_turn: maxInventoryCallsInATurn,
  };
}

/** Test seam. Process-wide totals are cumulative for the life of a daemon. */
export function resetChatGptCapabilityTelemetry(): void {
  calls.clear();
  turnCalls.clear();
  turnsWithCalls = 0;
  maxCallsInATurn = 0;
  maxInventoryCallsInATurn = 0;
  toolInventoryGatewayExecs = 0;
}

/** A turn claimed the bridge for one call of `toolName`. */
export function recordChatGptCapabilityCall(traceId: string, toolName: string): void {
  if (!COUNTED_TOOLS.has(toolName)) return;
  calls.set(toolName, (calls.get(toolName) ?? 0) + 1);
  // Counted as it happens rather than at turn conclusion: unlike the retrieval trade, a call that
  // was made was made, whether or not the turn it belonged to went on to produce an answer.
  const turn = turnCalls.get(traceId) ?? { total: 0, inventory: 0 };
  turn.total += 1;
  if (toolName === "codex_tool_inventory") turn.inventory += 1;
  if (turn.total === 1) turnsWithCalls += 1;
  maxCallsInATurn = Math.max(maxCallsInATurn, turn.total);
  maxInventoryCallsInATurn = Math.max(maxInventoryCallsInATurn, turn.inventory);
  turnCalls.set(traceId, turn);
  if (turnCalls.size > MAX_TRACKED_TURNS) {
    const oldest = turnCalls.keys().next();
    if (!oldest.done) turnCalls.delete(oldest.value);
  }
}

/** An inventory call read the nested registry by running the outer `exec` gateway. */
export function recordChatGptToolInventoryGatewayExec(): void {
  toolInventoryGatewayExecs += 1;
}
