import assert from "node:assert/strict";
import { chromium, type Page, type Locator } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

// Real DOM regression, without a ChatGPT account or network requests.
// Run: bun run scripts/smoke-terminal-tool-boundary.ts
const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true });
const page = await browser.newPage();
const worker = Object.create(ChatGptBrowserWorker.prototype) as {
  waitForNewAssistantTurn(
    page: Page,
    baseline: { initialTurnIdentities: string[]; domCache: Record<string, unknown> },
    deadline: number,
    signal: AbortSignal | undefined,
    progress: ChatGptExternalTurnProgress,
    graceMs: number,
    completionTracker: ChatGptCompletionTracker,
  ): Promise<{ identity: string; locator: Locator }>;
};
const errorText = "Something went wrong. Please contact our help center at help.openai.com.";
const scenarios = ["healthy", "previous-error", "terminal-text", "terminal-action"] as const;
const failures: string[] = [];
try {
  for (const scenario of scenarios) {
    let rejected = 0;
    let acknowledged = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const terminal = scenario.startsWith("terminal-");
      const content = scenario === "terminal-text" ? errorText
        : scenario === "terminal-action" ? '<button data-testid="regenerate-thread-error-button">Retry</button>'
        : "I will inspect the files.";
      await page.setContent(`
        <div data-turn-id-container="old"><section data-testid="conversation-turn-0" data-turn="assistant" data-turn-id="old">${scenario === "previous-error" ? errorText : "Previous answer"}</section></div>
        <div data-turn-id-container="current"><section data-testid="conversation-turn-1" data-turn="assistant" data-turn-id="current"><div class="markdown">${content}</div></section></div>
      `);
      const progress = new ChatGptExternalTurnProgress();
      const revision = progress.recordToolBatch(1);
      const abort = new AbortController();
      const boundary = progress.waitForToolBatchObservation(revision, abort.signal)
        .then(() => { acknowledged += 1; }, () => {});
      try {
        const binding = await worker.waitForNewAssistantTurn(
          page, { initialTurnIdentities: ["old"], domCache: {} }, Date.now() + 5_000,
          undefined, progress, 5_000, new ChatGptCompletionTracker(),
        );
        assert.equal(binding.identity, "current");
        if (terminal) failures.push(`${scenario} #${attempt}: terminal response released its tool batch`);
      } catch (error) {
        if (!terminal || !(error instanceof Error) || !("code" in error) || error.code !== "upstream_server_error") throw error;
        rejected += 1;
      } finally {
        abort.abort();
        await boundary;
      }
    }
    console.log(JSON.stringify({ scenario, attempts: 20, rejected, acknowledged }));
    assert.equal(rejected + acknowledged, 20);
  }
} finally {
  await browser.close();
}
assert.equal(failures.length, 0, failures.join("\n"));
