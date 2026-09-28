import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium, type Browser } from "playwright-core";
import { atomicWriteFile, type AppConfig } from "./config";
import { managedProfileIsVerified } from "./browser-login";
import { automatedChromeLaunchOptions, chromeProxyArguments } from "./chrome-launch";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  ChatGptCloudflareApiChallengeWatch,
  detectChatGptAccountCapabilities,
  isCloudflareChallengePage,
} from "./chatgpt-session";

/**
 * How long a human is given to pass the checkbox before the window is closed again. Generous on
 * purpose: the operator may not be sitting at the machine when the challenge appears.
 */
const CHALLENGE_SOLVE_TIMEOUT_MS = 5 * 60_000;
const CHALLENGE_POLL_INTERVAL_MS = 1_000;
const MANUAL_VERIFICATION_TIMEOUT_MS = 60_000;

/** Cookie domains whose values this command is allowed to refresh, matching the login whitelist. */
const CLEARANCE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;

interface StorageCookie {
  name: string;
  domain: string;
  path: string;
  [key: string]: unknown;
}

interface StorageState {
  cookies: StorageCookie[];
  origins: unknown[];
}

export interface ClearCloudflareChallengeResult {
  /** False when ChatGPT was reachable and no challenge had to be solved. */
  challengeWasPresent: boolean;
  /** True when the composer and configured model controls became usable. */
  cleared: boolean;
  /** Cookie domains that now carry a `cf_clearance`, after the run. */
  clearanceDomains: string[];
  backupPath?: string;
  apiChallengedPath?: string;
}

function refreshableDomain(rawDomain: string): boolean {
  const hostname = rawDomain.replace(/^\.+/, "").toLowerCase();
  return CLEARANCE_ROOT_DOMAINS.some(root => hostname === root || hostname.endsWith(`.${root}`));
}

function cookieKey(cookie: StorageCookie): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}

/**
 * Replace only the ChatGPT/OpenAI cookies with the freshly cleared ones, keeping every other
 * cookie (identity-provider SSO state lives on domains the login whitelist does not cover, so a
 * wholesale overwrite would silently sign the profile out).
 */
export function mergeClearedCookies(stored: StorageState, live: StorageState): StorageState {
  const merged = new Map<string, StorageCookie>();
  for (const cookie of stored.cookies) merged.set(cookieKey(cookie), cookie);
  for (const cookie of live.cookies) {
    if (!refreshableDomain(cookie.domain)) continue;
    merged.set(cookieKey(cookie), cookie);
  }
  return { cookies: [...merged.values()], origins: stored.origins };
}

export function clearanceDomainsOf(state: StorageState): string[] {
  return [...new Set(
    state.cookies.filter(cookie => cookie.name === "cf_clearance").map(cookie => cookie.domain),
  )].sort();
}

export function normalChallengeChromeArgs(profilePath: string, proxyArgs: readonly string[]): string[] {
  return [
    `--user-data-dir=${profilePath}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    ...proxyArgs,
    CHATGPT_TEMPORARY_CHAT_URL,
  ];
}

async function waitForHumanChallengeInNormalChrome(
  config: AppConfig,
  profilePath: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  log("A normal Chrome window is open in the dedicated ChatGPT profile. Complete any Cloudflare check, confirm ChatGPT works, then quit this dedicated Chrome completely.");
  const browser = spawn(config.chromeExecutablePath, normalChallengeChromeArgs(profilePath, chromeProxyArguments()), {
    env: process.env,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      browser.off("error", onError);
      browser.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timedOut) finish(new Error("Timed out waiting for the dedicated Chrome to finish manual Cloudflare verification"));
      else if (signal || code !== 0) finish(new Error(`Dedicated Chrome exited before verification completed (${signal ?? code ?? "unknown"})`));
      else finish();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      browser.kill();
      forceTimer = setTimeout(() => {
        browser.kill("SIGKILL");
        finish(new Error("Dedicated Chrome did not exit after the manual verification timeout"));
      }, 5_000);
    }, timeoutMs);
    browser.once("error", onError);
    browser.once("exit", onExit);
  });
}

/**
 * Open ChatGPT in a visible browser so a human can pass Cloudflare's "verify you are human"
 * checkbox, then persist the clearance that automated turns will reuse.
 *
 * Why this exists rather than reusing `login`: the clearance cookie is issued per origin, and the
 * login flow authenticates against auth.openai.com, so it never visits chatgpt.com while
 * challenged and never obtains a chatgpt.com clearance. Measured 2026-09-23 on this machine, the
 * stored state carried `cf_clearance` for `.auth.openai.com` only — which is exactly why repeating
 * `login` never fixed a chatgpt.com challenge.
 *
 * The checkbox is deliberately left to the operator. Passing it programmatically is both what
 * Cloudflare is detecting and not something this tool should do on the user's behalf.
 */
export async function clearCloudflareChallenge(
  config: AppConfig,
  options: { timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<ClearCloudflareChallengeResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? CHALLENGE_SOLVE_TIMEOUT_MS;
  const persistent = config.managedProfilePath !== undefined;
  if (persistent && !managedProfileIsVerified(config.managedProfilePath!)) {
    throw new Error(`Dedicated ChatGPT profile is missing or unverified: ${config.managedProfilePath}`);
  }
  if (!persistent && !existsSync(config.storageStatePath)) {
    throw new Error(`ChatGPT web login state is missing: ${config.storageStatePath}`);
  }
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Configured Chrome executable does not exist: ${config.chromeExecutablePath}`);
  }

  const backupPath = persistent ? undefined : `${config.storageStatePath}.bak-challenge`;
  if (backupPath) copyFileSync(config.storageStatePath, backupPath);
  const stored = persistent ? undefined : JSON.parse(readFileSync(config.storageStatePath, "utf8")) as StorageState;

  if (persistent) {
    await waitForHumanChallengeInNormalChrome(config, config.managedProfilePath!, timeoutMs, log);
  }

  // The verification runs in exactly the browser the turn worker launches, so a clearance that
  // passes here is one the worker can keep using.
  let browser: Browser | undefined;
  if (!persistent) browser = await chromium.launch(automatedChromeLaunchOptions(config));
  const context = persistent
    ? await chromium.launchPersistentContext(config.managedProfilePath!, automatedChromeLaunchOptions(config))
    : await browser!.newContext({ storageState: config.storageStatePath });
  const watch = new ChatGptCloudflareApiChallengeWatch();
  try {
    const page = await context.newPage();
    watch.observe(page);
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + (persistent ? MANUAL_VERIFICATION_TIMEOUT_MS : timeoutMs);
    let challengeWasPresent = false;
    let cleared = false;
    let prompted = false;
    let lastModelControlError = "";
    while (Date.now() < deadline) {
      if (await composer.count().catch(() => 0) > 0) {
        try {
          const capabilities = await detectChatGptAccountCapabilities(page);
          if (config.solAvailable && !capabilities.solAvailable) {
            throw new Error("The composer loaded but the configured model controls are unavailable.");
          }
          cleared = true;
          break;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (detail !== lastModelControlError) log(`ChatGPT model controls are not ready: ${detail}`);
          lastModelControlError = detail;
        }
      }
      if (isCloudflareChallengePage(page)) {
        challengeWasPresent = true;
        if (persistent) break;
        if (!prompted) {
          prompted = true;
          log("Cloudflare is showing its 'verify you are human' checkbox.");
          log("Click the checkbox in the Chrome window that just opened. Waiting…");
        }
      }
      await new Promise(resolve => setTimeout(resolve, CHALLENGE_POLL_INTERVAL_MS));
    }

    const live = await context.storageState() as StorageState;
    if (!cleared) return {
      challengeWasPresent: challengeWasPresent || watch.challengedPath !== undefined,
      cleared: false,
      clearanceDomains: clearanceDomainsOf(live),
      ...(backupPath ? { backupPath } : {}),
      ...(watch.challengedPath ? { apiChallengedPath: watch.challengedPath } : {}),
    };
    const saved = stored ? mergeClearedCookies(stored, live) : live;
    if (!persistent) atomicWriteFile(config.storageStatePath, `${JSON.stringify(saved)}\n`);
    return {
      challengeWasPresent,
      cleared: true,
      clearanceDomains: clearanceDomainsOf(saved),
      ...(backupPath ? { backupPath } : {}),
    };
  } finally {
    watch.dispose();
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
