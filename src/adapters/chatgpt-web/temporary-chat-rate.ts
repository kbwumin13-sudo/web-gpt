/**
 * Pacing for new Temporary Chat documents.
 *
 * Opening a Temporary Chat is what Cloudflare rate-limits: each one is a fresh session on
 * chatgpt.com, and enough of them in a short window draws an interactive "verify you are human"
 * challenge that no automated turn can pass. Measured twice on this machine — 2026-09-18 (eight to
 * nine chats in 25 minutes) and 2026-09-23 (a hierarchical compaction opening nine in about four
 * minutes) — both ended in a challenge that blocked every turn until the rate decayed.
 *
 * The existing mitigation was to run compaction segments sequentially, but sequential is not the
 * same as paced: nine sequential chats still averaged one every 28 seconds. This adds the missing
 * dimension.
 */

/**
 * Floor between two Temporary Chats on the healthy path. Small on purpose — a human-driven turn
 * takes far longer than this to arrive, so it is invisible in normal use and only bites the
 * machine-gun case (a multi-segment compaction).
 */
export const MIN_TEMPORARY_CHAT_INTERVAL_MS = 10_000;

/**
 * Floor applied after a challenge was seen. Chosen to stay well inside the 150s
 * `temporaryChatPreparation` stage budget once page navigation is added on top.
 */
export const GUARDED_TEMPORARY_CHAT_INTERVAL_MS = 60_000;

/** How long a sighting keeps the guarded pace in force. */
export const CHALLENGE_MEMORY_MS = 30 * 60_000;

export class TemporaryChatRateLimiter {
  private lastOpenedAt = 0;
  private lastChallengeAt = 0;

  constructor(
    private readonly minIntervalMs = MIN_TEMPORARY_CHAT_INTERVAL_MS,
    private readonly guardedIntervalMs = GUARDED_TEMPORARY_CHAT_INTERVAL_MS,
    private readonly challengeMemoryMs = CHALLENGE_MEMORY_MS,
  ) {}

  /** Record that Cloudflare challenged this browser, switching to the guarded pace. */
  noteChallenge(now = Date.now()): void {
    this.lastChallengeAt = now;
  }

  private intervalMs(now: number): number {
    const guarded = this.lastChallengeAt > 0 && now - this.lastChallengeAt < this.challengeMemoryMs;
    return guarded ? this.guardedIntervalMs : this.minIntervalMs;
  }

  /** Milliseconds the next Temporary Chat must wait. Zero when it may open immediately. */
  delayBeforeOpen(now = Date.now()): number {
    if (this.lastOpenedAt === 0) return 0;
    const elapsed = now - this.lastOpenedAt;
    return Math.max(0, this.intervalMs(now) - elapsed);
  }

  /**
   * Wait out the pacing floor, then claim the slot. The timestamp is taken after the wait so that
   * concurrent callers queue behind each other instead of all passing on the same stale reading.
   */
  async acquire(options: { signal?: AbortSignal; now?: () => number } = {}): Promise<void> {
    const now = options.now ?? Date.now;
    const delay = this.delayBeforeOpen(now());
    if (delay > 0) {
      this.lastOpenedAt = now() + delay;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error("aborted"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return;
    }
    this.lastOpenedAt = now();
  }
}

/**
 * Process-wide instance. Cloudflare rate-limits the account and address, not a worker object, so
 * every Temporary Chat opened by this process has to queue against the same pacing state.
 */
export const sharedTemporaryChatRateLimiter = new TemporaryChatRateLimiter();
