import { expect, test } from "bun:test";
import { beginWebBrowserSession, cloudflareRetryPauseActive, CLOUDFLARE_RETRY_PAUSE_MS, markWebReadiness, webReadinessSnapshot } from "../src/web-readiness";

test("a completed Web turn proves readiness only for the current browser generation", () => {
  beginWebBrowserSession();
  const first = webReadinessSnapshot();
  expect(first.status).toBe("unverified");
  markWebReadiness("challenged", "cloudflare_challenge");
  expect(webReadinessSnapshot()).toMatchObject({ status: "challenged", evidence_code: "cloudflare_challenge" });
  const challengedAt = Date.now();
  expect(cloudflareRetryPauseActive(challengedAt)).toBe(true);
  beginWebBrowserSession();
  expect(cloudflareRetryPauseActive(challengedAt + 1)).toBe(true);
  expect(cloudflareRetryPauseActive(challengedAt + CLOUDFLARE_RETRY_PAUSE_MS + 1)).toBe(false);
  markWebReadiness("ready", "completed_web_turn");
  expect(cloudflareRetryPauseActive()).toBe(false);
  const ready = webReadinessSnapshot();
  expect(ready.status).toBe("ready");
  expect(ready.last_successful_turn_at).not.toBeNull();
  beginWebBrowserSession();
  expect(webReadinessSnapshot()).toMatchObject({ status: "unverified", evidence_code: "browser_reopened" });
  expect(webReadinessSnapshot().session_generation).not.toBe(first.session_generation);
  expect(ready.status).toBe("ready");
});
