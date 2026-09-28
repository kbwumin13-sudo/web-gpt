import { expect, test } from "bun:test";
import { InstalledTurnEvidence, visibleFinalText } from "../scripts/installed-turn-evidence";

test("compares the user-visible final marker after Markdown escaping", () => {
  expect(visibleFinalText("FILE\\_ALPHA")).toBe("FILE_ALPHA");
  expect(visibleFinalText("OK ")).toBe("OK");
});

test("unrelated thread and turn completions cannot satisfy installed acceptance", () => {
  const evidence = new InstalledTurnEvidence("thread_target", "turn_target");
  expect(evidence.observe({ method: "turn/completed", params: { threadId: "thread_other", turn: { id: "turn_target", status: "completed" } } })).toBe(false);
  expect(evidence.observe({ method: "turn/completed", params: { threadId: "thread_target", turn: { id: "turn_other", status: "completed" } } })).toBe(false);
  expect(() => evidence.outcome()).toThrow("exact Codex turn has not completed");
});

test("captures the exact final answer and tool receipt even when terminal items are not loaded", () => {
  const evidence = new InstalledTurnEvidence("thread_target", "turn_target");
  evidence.observe({ method: "item/completed", params: { threadId: "thread_other", turnId: "turn_target", item: { id: "wrong", type: "agentMessage", text: "WRONG" } } });
  evidence.observe({ method: "item/completed", params: { threadId: "thread_target", turnId: "turn_target", item: { id: "tool", type: "commandExecution", status: "completed" } } });
  evidence.observe({ method: "item/completed", params: { threadId: "thread_target", turnId: "turn_target", item: { id: "final", type: "agentMessage", phase: "final", text: "OK" } } });
  expect(evidence.observe({ method: "turn/completed", params: { threadId: "thread_target", turn: { id: "turn_target", status: "completed", itemsView: "notLoaded", items: [] } } })).toBe(true);
  expect(evidence.outcome()).toMatchObject({ status: "completed", answer: "OK", toolItems: [{ id: "tool" }] });
});

test("a completed status without answer evidence remains incomplete", () => {
  const evidence = new InstalledTurnEvidence("thread_target", "turn_target");
  evidence.observe({ method: "turn/completed", params: { threadId: "thread_target", turn: { id: "turn_target", status: "completed", itemsView: "notLoaded", items: [] } } });
  expect(evidence.outcome().answer).toBe("");
});
