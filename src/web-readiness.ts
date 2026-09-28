import { randomUUID } from "node:crypto";

export type WebReadinessStatus = "unverified" | "ready" | "needs_login" | "challenged" | "ui_unavailable";

interface WebReadinessSnapshot {
  status: WebReadinessStatus;
  session_generation: string;
  checked_at: string | null;
  evidence_code: string;
  last_successful_turn_at: string | null;
  last_successful_model: string | null;
  last_successful_effort: string | null;
}

let state: WebReadinessSnapshot = {
  status: "unverified",
  session_generation: randomUUID(),
  checked_at: null,
  evidence_code: "not_checked",
  last_successful_turn_at: null,
  last_successful_model: null,
  last_successful_effort: null,
};

// Codex retries a failed SSE response before the person can react. Hold those immediate replays
// after a confirmed Cloudflare challenge so they cannot create more Temporary Chats. A successful
// Web turn clears the hold; a new browser session alone does not prove the challenged API recovered.
export const CLOUDFLARE_RETRY_PAUSE_MS = 90_000;
let lastCloudflareChallengeAt = 0;

export function cloudflareRetryPauseActive(now = Date.now()): boolean {
  return lastCloudflareChallengeAt > 0 && now - lastCloudflareChallengeAt < CLOUDFLARE_RETRY_PAUSE_MS;
}

export function beginWebBrowserSession(): void {
  state = {
    ...state,
    status: "unverified",
    session_generation: randomUUID(),
    checked_at: null,
    evidence_code: "browser_reopened",
  };
}

export function markWebReadiness(
  status: Exclude<WebReadinessStatus, "unverified">,
  evidenceCode: string,
  completed?: { model: string; effort: string },
): void {
  const now = new Date().toISOString();
  if (status === "challenged" && evidenceCode === "cloudflare_challenge") lastCloudflareChallengeAt = Date.now();
  if (status === "ready") lastCloudflareChallengeAt = 0;
  state = {
    ...state,
    status,
    checked_at: now,
    evidence_code: evidenceCode,
    ...(status === "ready" ? {
      last_successful_turn_at: now,
      ...(completed ? { last_successful_model: completed.model, last_successful_effort: completed.effort } : {}),
    } : {}),
  };
}

export function webReadinessSnapshot(): WebReadinessSnapshot {
  return { ...state };
}
