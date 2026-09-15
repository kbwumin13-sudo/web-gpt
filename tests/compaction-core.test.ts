import { expect, test } from "bun:test";
import {
  InProcessStructuredCompactionCore,
  reduceStructuredCompaction,
  type CompactionState,
  type CompactionSelector,
} from "../src/adapters/chatgpt-web/compaction-core";

const selector: CompactionSelector = { namespace: "chatgpt-web", executionKey: "attempt-1" };

test("compaction commit is irreversible and cleanup failure is only a warning", async () => {
  const core = new InProcessStructuredCompactionCore();
  const outcome = await core.compact({
    selector,
    execute: async () => "stable summary",
    cleanup: async () => { throw new Error("target key occupied"); },
  });
  expect(outcome).toMatchObject({ kind: "committed", summary: "stable summary" });
  if (outcome.kind === "committed") expect(outcome.cleanupWarnings[0]).toMatchObject({ stage: "retained_conversation" });
  await expect(core.cancel(selector)).resolves.toMatchObject({ cancelled: false, cleanupOnly: true, phase: "settled" });
  expect(core.state(selector).phase).toBe("settled");
});

test("cancellation before commit prevents a late execute result from committing", async () => {
  const core = new InProcessStructuredCompactionCore();
  const run = core.compact({ selector: { ...selector, executionKey: "cancelled" }, execute: async () => "late result" });
  await core.cancel({ ...selector, executionKey: "cancelled" });
  const outcome = await run;
  expect(outcome.kind).toBe("failed");
  expect(core.state({ ...selector, executionKey: "cancelled" }).phase).toBe("new");
});

test("the reducer ignores browser, disconnect and cancellation failures after commit", () => {
  let state: CompactionState = { phase: "new", replayed: false, cleanupWarnings: [] };
  state = reduceStructuredCompaction(state, { type: "begin", phase: "awaiting_handoff" });
  state = reduceStructuredCompaction(state, { type: "handoff_committed", summary: "summary", replayed: false });
  const committed = state;
  state = reduceStructuredCompaction(state, { type: "failed", error: { code: "browser_error", message: "late" } });
  state = reduceStructuredCompaction(state, { type: "cancelled" });
  expect(state).toEqual(committed);
});
