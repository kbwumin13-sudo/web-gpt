import type { LaunchOptions } from "playwright-core";
import type { AppConfig } from "./config";

/**
 * Chrome's `--proxy-server` for the proxy this process was given, or nothing.
 *
 * Credentials are never forwarded on a command line, where every local user can read them; a proxy
 * that needs them is left to the system configuration instead.
 */
export function chromeProxyArguments(environment: NodeJS.ProcessEnv = process.env): string[] {
  const raw = [environment.HTTPS_PROXY, environment.https_proxy, environment.HTTP_PROXY, environment.http_proxy]
    .find(value => typeof value === "string" && value.trim())?.trim();
  if (!raw) return [];
  try {
    const proxy = new URL(raw);
    if (!["http:", "https:", "socks4:", "socks5:"].includes(proxy.protocol)
      || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) return [];
    return [`--proxy-server=${proxy.protocol}//${proxy.host}`];
  } catch {
    return [];
  }
}

/** Stops Chrome from reporting itself as automated through `navigator.webdriver`. */
export const AUTOMATION_CONTROLLED_OFF = "--disable-blink-features=AutomationControlled";

/**
 * Launch options for every automated Chrome that opens ChatGPT.
 *
 * Cloudflare decides from what the page can observe whether a browser may pass its challenge, and
 * a browser that cannot pass it is locked out of ChatGPT whenever its clearance lapses. Measured
 * 2026-09-28 on this machine against a public Cloudflare managed challenge (Chrome 153, the same
 * exit IP, a fresh profile per run, nobody clicking):
 *
 * - Playwright's default launch failed every run. Its `--remote-debugging-pipe` makes Chrome
 *   report `navigator.webdriver === true`.
 * - The same launch with `AutomationControlled` disabled passed every run, with CDP attached
 *   throughout. Emulating a 1280x720 viewport made no difference either way.
 * - Chrome started with `--remote-debugging-port` looped even with no client attached, and a human
 *   clicking the checkbox in it looped too. Never start this profile that way.
 * - A page whose JavaScript world had been edited failed every run; see `wire/cdp-wire-tap.ts`.
 *
 * The sandbox stays on. Playwright otherwise adds `--no-sandbox`, which no ordinary Chrome runs
 * with and which removes the renderer sandbox from a browser that renders third-party content.
 */
export function automatedChromeLaunchOptions(
  config: Pick<AppConfig, "chromeExecutablePath">,
  options: { headless?: boolean; environment?: NodeJS.ProcessEnv } = {},
): LaunchOptions {
  return {
    executablePath: config.chromeExecutablePath,
    headless: options.headless ?? false,
    chromiumSandbox: true,
    // The dedicated profile is created by an ordinary Chrome that encrypts cookies with the real
    // macOS Keychain; Playwright's mock keychain would leave that login unreadable.
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      AUTOMATION_CONTROLLED_OFF,
      ...chromeProxyArguments(options.environment),
    ],
  };
}
