import { expect, test } from "bun:test";
import { WebTurnAuthority } from "../src/adapters/chatgpt-web/web-turn-authority";
import { chatGptSessionBinding, chatGptTaskScope } from "../src/adapters/chatgpt-web/task-scope";

test("a tool result and broker fence must settle before a Web final can commit", () => {
  const owner = new WebTurnAuthority("execution-1");
  owner.dispatch({ type: "send_activated" });
  owner.dispatch({ type: "submitted" });
  expect(owner.dispatch({ type: "tool_batch", callIds: ["call-a"], revision: 1 }))
    .toEqual([{ type: "capture_tool_boundary", revision: 1 }]);
  owner.dispatch({ type: "final_candidate", answer: "premature", source: "dom" });
  expect(owner.snapshot().candidate).toBeUndefined();
  owner.dispatch({ type: "tool_boundary_observed", revision: 1 });
  owner.dispatch({ type: "tool_result", callId: "call-a" });
  owner.dispatch({ type: "final_candidate", answer: "verified answer", source: "wire" });
  owner.dispatch({ type: "fence_begun", revision: 7 });
  expect(owner.dispatch({ type: "fence_committed", revision: 7, committed: false })).toEqual([]);
  expect(owner.snapshot().terminal).toBeUndefined();
  owner.dispatch({ type: "final_candidate", answer: "verified answer", source: "wire" });
  owner.dispatch({ type: "fence_begun", revision: 8 });
  expect(owner.dispatch({ type: "fence_committed", revision: 8, committed: true }))
    .toEqual([{ type: "commit_final", answer: "verified answer" }]);
  expect(owner.snapshot().terminal).toEqual({ kind: "final", answer: "verified answer" });
});

test("a broker completion fence may settle before the browser serializes its Markdown answer", () => {
  const owner = new WebTurnAuthority("execution-fence-first");
  owner.dispatch({ type: "send_activated" });
  owner.dispatch({ type: "submitted" });
  owner.dispatch({ type: "fence_begun", revision: 3 });
  expect(owner.dispatch({ type: "fence_committed", revision: 3, committed: true })).toEqual([]);
  expect(owner.snapshot().terminal).toBeUndefined();
  expect(owner.dispatch({ type: "final_candidate", answer: "[result](/absolute/path)", source: "wire" }))
    .toEqual([{ type: "commit_final", answer: "[result](/absolute/path)" }]);
});

test("cancel and an accepted compaction handoff survive late browser events and cleanup failure", () => {
  const cancelled = new WebTurnAuthority("execution-cancelled");
  cancelled.dispatch({ type: "send_activated" });
  cancelled.dispatch({ type: "submitted" });
  cancelled.dispatch({ type: "cancelled", reason: "native interrupt" });
  cancelled.dispatch({ type: "final_candidate", answer: "late answer", source: "wire" });
  expect(cancelled.snapshot().terminal).toEqual({ kind: "cancelled", reason: "native interrupt" });

  const compacted = new WebTurnAuthority("execution-compacted");
  compacted.dispatch({ type: "compaction_handoff_accepted", reason: "checkpoint accepted" });
  compacted.dispatch({ type: "failed", reason: "late DOM error" });
  compacted.dispatch({ type: "release_failed", reason: "launcher end not acknowledged" });
  expect(compacted.snapshot()).toMatchObject({
    terminal: { kind: "compaction", reason: "checkpoint accepted" }, physical: "release_failed",
  });
});

test("late or duplicate browser facts cannot enter a rebound turn", () => {
  const owner = new WebTurnAuthority("execution-1");
  expect(owner.observe({ executionKey: "other", browserEpoch: 0, sourceSequence: 1,
    event: { type: "final_candidate", answer: "foreign", source: "wire" } })).toEqual([]);
  expect(owner.snapshot().submission).toBe("prepared");
  owner.dispatch({ type: "send_activated" });
  owner.observe({ executionKey: "execution-1", browserEpoch: 0, sourceSequence: 1,
    event: { type: "final_candidate", answer: "too early", source: "wire" } });
  owner.observe({ executionKey: "execution-1", browserEpoch: 0, sourceSequence: 1,
    event: { type: "final_candidate", answer: "duplicate sequence", source: "wire" } });
  expect(owner.snapshot().submission).toBe("send_activated");
  owner.dispatch({ type: "submitted" });
  owner.dispatch({ type: "browser_rebound", browserEpoch: 1 });
  owner.observe({ executionKey: "execution-1", browserEpoch: 0, sourceSequence: 2,
    event: { type: "final_candidate", answer: "stale page", source: "wire" } });
  expect(owner.snapshot().terminal).toBeUndefined();
  owner.observe({ executionKey: "execution-1", browserEpoch: 1, sourceSequence: 1,
    event: { type: "final_candidate", answer: "current page", source: "wire" } });
  expect(owner.snapshot().submission).toBe("accepted");
  expect(owner.snapshot().candidate?.answer).toBe("current page");
});

test("the authority publishes one append-only answer and refuses late text after cancellation", () => {
  const owner = new WebTurnAuthority("execution-output");
  owner.publishText("[result]", "wire");
  owner.publishText("(</absolute/file>)", "wire");
  expect(owner.output()).toBe("[result](</absolute/file>)");
  expect(owner.outputSource()).toBe("wire");
  owner.dispatch({ type: "cancelled", reason: "native interrupt" });
  expect(() => owner.publishText("late", "dom")).toThrow("terminal Web turn");
});

test("a Web conversation cannot switch underneath one trusted Codex execution", () => {
  const owner = new WebTurnAuthority("execution-bound");
  owner.attachBinding(chatGptSessionBinding(chatGptTaskScope("thread-1", "provider", {
    cwd: "/tmp/project", roots: ["/tmp/project"], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
  }), "chatgpt-web/high", "high", "epoch-1"));
  owner.dispatch({ type: "send_activated" });
  owner.dispatch({ type: "submitted" });
  owner.observe({ executionKey: "execution-bound", browserEpoch: 0, sourceSequence: 1,
    event: { type: "final_candidate", answer: "first", source: "wire", webConversationId: "conversation_one" } });
  expect(owner.sessionBinding()?.webConversationId).toBe("conversation_one");
  expect(() => owner.observe({ executionKey: "execution-bound", browserEpoch: 0, sourceSequence: 2,
    event: { type: "final_candidate", answer: "other", source: "wire", webConversationId: "conversation_two" },
  })).toThrow("identity changed");
  expect(owner.sessionBinding()?.webConversationId).toBe("conversation_one");
});
