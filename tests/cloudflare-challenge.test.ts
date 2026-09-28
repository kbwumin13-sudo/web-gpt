import { describe, expect, test } from "bun:test";
import type { Page, Response } from "playwright-core";
import {
  ChatGptCloudflareApiChallengeWatch,
  chatGptCloudflareApiChallengeWatch,
  cloudflareChallengedChatGptPath,
  isCloudflareChallengePage,
} from "../src/chatgpt-session";
import {
  ChatGptWebAdapterError,
  chatGptCloudflareApiChallengeError,
  chatGptCloudflareChallengeError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  CLOUDFLARE_CHALLENGE_GRACE_MS,
  chatGptCloudflareApiChallengeFailure,
  waitForComposerPastCloudflare,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  clearanceDomainsOf,
  mergeClearedCookies,
  normalChallengeChromeArgs,
} from "../src/cloudflare-challenge";
import {
  GUARDED_TEMPORARY_CHAT_INTERVAL_MS,
  MIN_TEMPORARY_CHAT_INTERVAL_MS,
  TemporaryChatRateLimiter,
} from "../src/adapters/chatgpt-web/temporary-chat-rate";

function pageWithFrames(urls: string[]): Page {
  return { frames: () => urls.map(url => ({ url: () => url })) } as unknown as Page;
}

test("manual recovery opens ordinary Chrome in the verified profile and inherits its proxy", () => {
  const args = normalChallengeChromeArgs("/private/managed-profile", ["--proxy-server=http://127.0.0.1:7891"]);
  expect(args).toContain("--user-data-dir=/private/managed-profile");
  expect(args).toContain("--proxy-server=http://127.0.0.1:7891");
  expect(args.at(-1)).toBe("https://chatgpt.com/?temporary-chat=true");
  expect(args).not.toContain("--enable-automation");
});

describe("isCloudflareChallengePage", () => {
  test("detects the challenge by frame host, not by localized page text", () => {
    // Captured live 2026-09-23; the challenge frame is not reachable as an <iframe> element.
    expect(isCloudflareChallengePage(pageWithFrames([
      "https://chatgpt.com/?temporary-chat=true",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/light/fbE/new/normal?lang=auto",
    ]))).toBe(true);
  });

  test("a healthy ChatGPT page is not a challenge", () => {
    expect(isCloudflareChallengePage(pageWithFrames([
      "https://chatgpt.com/?temporary-chat=true",
    ]))).toBe(false);
  });

  test("ignores blank and unparseable frame urls", () => {
    expect(isCloudflareChallengePage(pageWithFrames(["", "about:blank", "not a url"]))).toBe(false);
  });

  test("a lookalike host does not count as Cloudflare", () => {
    expect(isCloudflareChallengePage(pageWithFrames([
      "https://challenges.cloudflare.com.evil.example/x",
    ]))).toBe(false);
  });
});

describe("chatGptCloudflareChallengeError", () => {
  test("is not retryable, because retrying opens another chat and deepens the block", () => {
    const error = chatGptCloudflareChallengeError();
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("cloudflare_challenge");
  });

  test("tells the operator that re-running login cannot help", () => {
    expect(chatGptCloudflareChallengeError().message).toContain("NOT an expired login");
  });
});

function response(url: string, status = 403, headers: Record<string, string> = { "cf-mitigated": "challenge" }): Response {
  return { url: () => url, status: () => status, headers: () => headers } as unknown as Response;
}

function emittingPage() {
  let listener: ((value: Response) => void) | undefined;
  const page = {
    on: (event: string, handler: (value: Response) => void) => {
      expect(event).toBe("response");
      listener = handler;
    },
    off: (event: string, handler: (value: Response) => void) => {
      expect(event).toBe("response");
      if (listener === handler) listener = undefined;
    },
  };
  return { page: page as unknown as Page, emit: (value: Response) => listener?.(value), listening: () => listener !== undefined };
}

describe("cloudflareChallengedChatGptPath", () => {
  test("names the API path Cloudflare answered with a challenge", () => {
    // Captured live 2026-09-25: the document loaded while this request came back 403 + challenge.
    expect(cloudflareChallengedChatGptPath(response("https://chatgpt.com/backend-api/f/conversation/prepare")))
      .toBe("/backend-api/f/conversation/prepare");
  });

  test("an ordinary 403 is not a challenge", () => {
    expect(cloudflareChallengedChatGptPath(response("https://chatgpt.com/backend-api/f/conversation", 403, {}))).toBeUndefined();
  });

  test("a background request can be challenged without proving the conversation is blocked", () => {
    for (const path of ["/backend-api/tpp/default-tab-recommendation", "/backend-api/amphora/clear_settings_cache"]) {
      expect(cloudflareChallengedChatGptPath(response(`https://chatgpt.com${path}`))).toBe(path);
    }
  });

  test("only ChatGPT's own API counts, not documents, other hosts or lookalikes", () => {
    expect(cloudflareChallengedChatGptPath(response("https://chatgpt.com/?temporary-chat=true"))).toBeUndefined();
    expect(cloudflareChallengedChatGptPath(response("https://cdn.oaistatic.com/backend-api/x"))).toBeUndefined();
    expect(cloudflareChallengedChatGptPath(response("https://chatgpt.com.evil.example/backend-api/x"))).toBeUndefined();
    expect(cloudflareChallengedChatGptPath(response("not a url"))).toBeUndefined();
  });
});

describe("ChatGptCloudflareApiChallengeWatch", () => {
  test("records the first challenged request and settles with it", async () => {
    const { page, emit } = emittingPage();
    const watch = new ChatGptCloudflareApiChallengeWatch();
    watch.observe(page);
    expect(chatGptCloudflareApiChallengeWatch(page)).toBe(watch);
    emit(response("https://chatgpt.com/backend-api/models", 200, {}));
    // 2026-09-27: an editor-ready turn failed in 20 ms on this unrelated endpoint.
    emit(response("https://chatgpt.com/backend-api/tpp/default-tab-recommendation"));
    emit(response("https://chatgpt.com/backend-api/amphora/clear_settings_cache"));
    expect(watch.challengedPath).toBeUndefined();
    emit(response("https://chatgpt.com/backend-api/composer/items/interactions"));
    emit(response("https://chatgpt.com/backend-api/f/conversation/prepare"));
    expect(watch.challengedPath).toBe("/backend-api/composer/items/interactions");
    await expect(watch.challenged).resolves.toBe("/backend-api/composer/items/interactions");
  });

  test("a challenged user-settings request explains a picker that never renders", async () => {
    // 2026-09-27: models was 200 and the editor worked, but settings/user was challenged and
    // no effort control appeared during the whole 70-second wait.
    const { page, emit } = emittingPage();
    const watch = new ChatGptCloudflareApiChallengeWatch();
    watch.observe(page);
    emit(response("https://chatgpt.com/backend-api/models", 200, {}));
    emit(response("https://chatgpt.com/backend-api/settings/user"));
    expect(watch.challengedPath).toBe("/backend-api/settings/user");
    await expect(watch.challenged).resolves.toBe("/backend-api/settings/user");
    watch.dispose();
  });

  test("a later successful response clears the active challenge for the same API path", async () => {
    const { page, emit } = emittingPage();
    const watch = new ChatGptCloudflareApiChallengeWatch();
    watch.observe(page);
    const url = "https://chatgpt.com/backend-api/settings/user";
    emit(response(url));
    expect(watch.challengedPath).toBe("/backend-api/settings/user");
    emit(response(url, 200, {}));
    expect(watch.challengedPath).toBeUndefined();
    await expect(watch.challenged).resolves.toBe("/backend-api/settings/user");
    watch.dispose();
  });

  test("dispose stops listening and releases the page", () => {
    const { page, listening } = emittingPage();
    const watch = new ChatGptCloudflareApiChallengeWatch();
    watch.observe(page);
    watch.dispose();
    expect(listening()).toBe(false);
    expect(chatGptCloudflareApiChallengeWatch(page)).toBeUndefined();
  });

  test("a page that cannot be observed never fails the turn", () => {
    const page = {} as unknown as Page;
    const watch = new ChatGptCloudflareApiChallengeWatch();
    expect(() => watch.observe(page)).not.toThrow();
    expect(chatGptCloudflareApiChallengeWatch(page)).toBeUndefined();
    expect(() => watch.dispose()).not.toThrow();
  });
});

describe("chatGptCloudflareApiChallengeFailure", () => {
  const path = "/backend-api/f/conversation/prepare";

  test("replaces the page's reading of a challenged turn with the block itself", () => {
    // What 2026-09-25's turn reported before: a symptom, which sent the reader to reload ChatGPT.
    const symptom = new ChatGptWebAdapterError("ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.", {
      status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false,
    });
    const reported = chatGptCloudflareApiChallengeFailure(symptom, path);
    expect(reported?.code).toBe("cloudflare_challenge");
    expect(reported?.retryable).toBe(false);
    expect(reported?.message).toContain(path);
    expect(reported?.cause).toBe(symptom);
  });

  test("a plain page failure becomes non-retryable, so Codex stops opening chats into the block", () => {
    const reported = chatGptCloudflareApiChallengeFailure(new Error("ChatGPT composer is unavailable."), path);
    expect(reported?.retryable).toBe(false);
  });

  test("nothing changes when no request was challenged", () => {
    expect(chatGptCloudflareApiChallengeFailure(new Error("x"), undefined)).toBeUndefined();
  });

  test("failures that name their own cause keep it", () => {
    expect(chatGptCloudflareApiChallengeFailure(new DOMException("aborted", "AbortError"), path)).toBeUndefined();
    for (const code of ["rate_limit_exceeded", "chatgpt_session_expired", "prompt_attachment_integrity"]) {
      const error = new ChatGptWebAdapterError(code, { status: 400, errorType: "x", code, retryable: true });
      expect(chatGptCloudflareApiChallengeFailure(error, path)).toBeUndefined();
    }
  });

  test("the API challenge does not misdiagnose a persistent proxy block as short-term rate limiting", () => {
    const message = chatGptCloudflareApiChallengeError(path).message;
    expect(message).toContain("no checkbox");
    expect(message).toContain("page may still open");
    expect(message).toContain("proxy exit");
    expect(message).not.toContain("This is a rate block");
    expect(message).not.toContain("lifts on its own");
    expect(message).not.toContain("clear-challenge");
  });
});

describe("mergeClearedCookies", () => {
  const stored = {
    cookies: [
      { name: "session", domain: "chatgpt.com", path: "/", value: "old" },
      { name: "SID", domain: ".google.com", path: "/", value: "sso" },
    ],
    origins: [{ origin: "https://chatgpt.com" }],
  };

  test("refreshes ChatGPT cookies and adds the new clearance", () => {
    const merged = mergeClearedCookies(stored, {
      cookies: [
        { name: "session", domain: "chatgpt.com", path: "/", value: "new" },
        { name: "cf_clearance", domain: ".chatgpt.com", path: "/", value: "granted" },
      ],
      origins: [],
    });
    expect(merged.cookies.find(c => c.name === "session")?.value).toBe("new");
    expect(clearanceDomainsOf(merged)).toEqual([".chatgpt.com"]);
  });

  test("keeps identity-provider cookies the login whitelist does not cover", () => {
    // A wholesale overwrite here would silently sign the profile out of Google SSO.
    const merged = mergeClearedCookies(stored, { cookies: [], origins: [] });
    expect(merged.cookies.find(c => c.domain === ".google.com")?.value).toBe("sso");
  });

  test("does not let an unrelated domain inject cookies", () => {
    const merged = mergeClearedCookies(stored, {
      cookies: [{ name: "evil", domain: "attacker.example", path: "/", value: "x" }],
      origins: [],
    });
    expect(merged.cookies.some(c => c.domain === "attacker.example")).toBe(false);
  });

  test("preserves the stored origins rather than the throwaway context's", () => {
    const merged = mergeClearedCookies(stored, { cookies: [], origins: [{ origin: "https://other" }] });
    expect(merged.origins).toEqual([{ origin: "https://chatgpt.com" }]);
  });
});

describe("TemporaryChatRateLimiter", () => {
  test("the first Temporary Chat is never delayed", () => {
    expect(new TemporaryChatRateLimiter().delayBeforeOpen(1_000)).toBe(0);
  });

  test("paces consecutive chats on the healthy path", async () => {
    const limiter = new TemporaryChatRateLimiter();
    let clock = 1_000;
    await limiter.acquire({ now: () => clock });
    expect(limiter.delayBeforeOpen(clock + 1_000)).toBe(MIN_TEMPORARY_CHAT_INTERVAL_MS - 1_000);
    expect(limiter.delayBeforeOpen(clock + MIN_TEMPORARY_CHAT_INTERVAL_MS)).toBe(0);
  });

  test("widens the gap after a challenge instead of hammering the block", async () => {
    const limiter = new TemporaryChatRateLimiter();
    const clock = 1_000;
    await limiter.acquire({ now: () => clock });
    limiter.noteChallenge(clock);
    expect(limiter.delayBeforeOpen(clock + 1_000)).toBe(GUARDED_TEMPORARY_CHAT_INTERVAL_MS - 1_000);
  });

  test("the guarded pace stays inside the 150s preparation stage budget", () => {
    expect(GUARDED_TEMPORARY_CHAT_INTERVAL_MS + 60_000).toBeLessThanOrEqual(150_000);
  });

  test("returns to the healthy pace once the sighting ages out", async () => {
    const limiter = new TemporaryChatRateLimiter(10_000, 60_000, 30 * 60_000);
    const clock = 1_000;
    await limiter.acquire({ now: () => clock });
    limiter.noteChallenge(clock);
    expect(limiter.delayBeforeOpen(clock + 30 * 60_000 + 1)).toBe(0);
  });

  test("a waiting caller claims its slot so the next one queues behind it", async () => {
    const limiter = new TemporaryChatRateLimiter(20, 20, 1_000);
    await limiter.acquire();
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test("an aborted wait rejects rather than opening the chat", async () => {
    const limiter = new TemporaryChatRateLimiter(50_000, 50_000, 1_000);
    await limiter.acquire();
    const controller = new AbortController();
    const pending = limiter.acquire({ signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});

describe("waitForComposerPastCloudflare", () => {
  const timeout = (): Error => new Error("composer did not appear");

  function scenario(options: { composerOnAttempt?: number; challenge: boolean[]; abortOnAttempt?: number }) {
    const controller = new AbortController();
    const waits: number[] = [];
    const events: string[] = [];
    let probes = 0;
    const run = () => waitForComposerPastCloudflare(
      async timeoutMs => {
        waits.push(timeoutMs);
        if (options.abortOnAttempt === waits.length) {
          controller.abort();
          throw new DOMException("Codex turn interrupted", "AbortError");
        }
        if (options.composerOnAttempt === waits.length) return "composer";
        throw timeout();
      },
      () => options.challenge[Math.min(probes++, options.challenge.length - 1)] ?? false,
      controller.signal,
      {
        challengeSeen: async () => { events.push("seen"); },
        challengeCleared: async () => { events.push("cleared"); },
        blocked: () => { events.push("blocked"); },
      },
    );
    return { run, waits, events };
  }

  test("a composer that appears is returned without touching the challenge path", async () => {
    const { run, waits, events } = scenario({ composerOnAttempt: 1, challenge: [false] });
    expect(await run()).toBe("composer");
    expect(waits).toEqual([30_000]);
    expect(events).toEqual([]);
  });

  test("no composer and no challenge is reported as an unavailable surface, not as Cloudflare", async () => {
    const { run, events } = scenario({ challenge: [false] });
    await expect(run()).rejects.toThrow("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    expect(events).toEqual([]);
  });

  test("a check that clears on its own lets the turn continue without backing off", async () => {
    // What the browser now does unaided: Cloudflare shows its check, then lets the page through.
    const { run, waits, events } = scenario({ composerOnAttempt: 2, challenge: [true] });
    expect(await run()).toBe("composer");
    expect(waits).toEqual([30_000, CLOUDFLARE_CHALLENGE_GRACE_MS]);
    expect(events).toEqual(["seen", "cleared"]);
  });

  test("a check still on screen after the grace blocks the turn and backs off", async () => {
    const { run, events } = scenario({ challenge: [true, true] });
    const error = await run().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect((error as ChatGptWebAdapterError).code).toBe("cloudflare_challenge");
    expect((error as ChatGptWebAdapterError).retryable).toBe(false);
    expect(events).toEqual(["seen", "blocked"]);
  });

  test("a check that cleared into a page without a composer is not blamed on Cloudflare", async () => {
    const { run, events } = scenario({ challenge: [true, false] });
    await expect(run()).rejects.toThrow("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    expect(events).toEqual(["seen"]);
  });

  test("a turn cancelled while waiting stays a cancellation", async () => {
    const { run, events } = scenario({ abortOnAttempt: 1, challenge: [true] });
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual([]);
  });

  test("a turn cancelled during the grace is neither a block nor a reason to back off", async () => {
    const { run, events } = scenario({ abortOnAttempt: 2, challenge: [true, true] });
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["seen"]);
  });
});
