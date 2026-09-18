import { beforeEach, expect, test } from "bun:test";
import {
  chatGptCapabilityTelemetrySnapshot,
  recordChatGptCapabilityCall,
  recordChatGptToolInventoryGatewayExec,
  resetChatGptCapabilityTelemetry,
} from "../src/adapters/chatgpt-web/capability-telemetry";

beforeEach(() => {
  resetChatGptCapabilityTelemetry();
});

test("a turn's repeated inventory calls are visible as repeats, not as a total", () => {
  // The question a per-turn maximum answers is whether caching the registry would hit anything.
  // A total cannot: a hundred turns asking once each and one turn asking a hundred times look the
  // same, and only the second is worth a cache.
  recordChatGptCapabilityCall("turn_a", "codex_tool_inventory");
  recordChatGptCapabilityCall("turn_a", "codex_tool_inventory");
  recordChatGptCapabilityCall("turn_a", "codex_exec");
  recordChatGptCapabilityCall("turn_b", "codex_tool_inventory");
  recordChatGptToolInventoryGatewayExec();
  recordChatGptToolInventoryGatewayExec();
  recordChatGptToolInventoryGatewayExec();

  expect(chatGptCapabilityTelemetrySnapshot()).toEqual({
    calls: { codex_exec: 1, codex_tool_inventory: 3 },
    turns_with_calls: 2,
    max_calls_in_a_turn: 3,
    max_tool_inventory_calls_in_a_turn: 2,
    tool_inventory_gateway_execs: 3,
  });
});

test("a name that is not a bridge tool is dropped rather than recorded", () => {
  // These keys arrive over the turn socket. A counter is not a place for a caller to write to.
  recordChatGptCapabilityCall("turn_a", "rm_rf");
  recordChatGptCapabilityCall("turn_a", "__proto__");
  expect(chatGptCapabilityTelemetrySnapshot()).toMatchObject({
    calls: {},
    turns_with_calls: 0,
    max_calls_in_a_turn: 0,
  });
});

test("turns that never conclude do not accumulate without bound", () => {
  for (let index = 0; index < 400; index += 1) {
    recordChatGptCapabilityCall(`turn_${index}`, "codex_exec");
  }
  // Every call is still counted; only the per-turn bookkeeping is bounded.
  expect(chatGptCapabilityTelemetrySnapshot()).toMatchObject({
    calls: { codex_exec: 400 },
    turns_with_calls: 400,
    max_calls_in_a_turn: 1,
  });
});
