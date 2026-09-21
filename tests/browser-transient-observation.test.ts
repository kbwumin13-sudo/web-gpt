import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, ChatGptBrowserObservationTimeoutError, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

function worker() {
  return Object.create(ChatGptBrowserWorker.prototype) as any;
}
const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
const page = { isClosed: () => false, locator: () => hidden };

test("managed browser retains an accepted turn across one transient DOM timeout", async () => {
  const w = worker();
  let probes = 0;
  w.submissionDomState = async () => {
    if (++probes === 1) throw new ChatGptBrowserObservationTimeoutError(5_000);
    return { turnIdentities: ["answer"], userIdentities: [], responseIdentities: ["answer"] };
  };
  const result = await w.waitForNewAssistantTurn(page, { initialTurnIdentities: [], domCache: {} }, Date.now() + 10_000);
  expect(result.identity).toBe("answer");
  expect(probes).toBe(2);
});

test("managed submission observation retries without sending the prompt again", async () => {
  const w = worker();
  let probes = 0;
  w.waitForSubmissionAccepted = async () => {
    if (++probes === 1) throw new ChatGptBrowserObservationTimeoutError(5_000);
    return "generation_running";
  };
  expect(await w.waitForSubmissionAcceptedWithRecovery(page, {})).toBe("generation_running");
  expect(probes).toBe(2);
});

test("managed observation timeout recovery is bounded and preserves cancellation", async () => {
  const w = worker();
  let probes = 0;
  w.submissionDomState = async () => { probes++; throw new ChatGptBrowserObservationTimeoutError(5_000); };
  await expect(w.waitForNewAssistantTurn(page, { domCache: {} }, Date.now() + 10_000)).rejects.toThrow("DOM");
  expect(probes).toBe(3);
  const abort = new AbortController();
  w.waitForSubmissionAccepted = async () => { abort.abort(); throw new ChatGptBrowserObservationTimeoutError(5_000); };
  await expect(w.waitForSubmissionAcceptedWithRecovery(page, {}, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("new reasoning after tool results resets the empty final watchdog but a frozen spinner does not", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1000, 500, 750, 1200);
  const state = { responsePresent: true, running: true, currentText: "", completionActionVisible: false, postToolAnswerExpected: true, reasoningText: "checking results" };
  expect(tracker.update(state, 1000)).toBeUndefined();
  expect(tracker.update({ ...state, reasoningText: "comparing the evidence" }, 2100)).toBeUndefined();
  expect(tracker.update({ ...state, reasoningText: "comparing the evidence" }, 2200)).toBeUndefined();
  expect(tracker.update({ ...state, reasoningText: "comparing the evidence" }, 3300)).toContain("no final answer");
});
