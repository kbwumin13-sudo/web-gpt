import type { Locator, Page, Response } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  'textarea[role="textbox"]',
  // ChatGPT degrades to a plain textarea when its rich editor does not load, and that element
  // carries none of the attributes above — no id, no data-testid, no role, no lexical marker.
  // Measured live on 2026-09-18: all four selectors above matched zero elements while the page
  // showed a working composer, so every turn failed at preparation with "login is expired".
  // The class is a CSS-module name whose hash prefix changes; the readable suffix comes from the
  // source and is the stable half.
  'textarea[class*="fallbackTextarea"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[aria-haspopup="menu"][data-composer-navigation-target="reasoning"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [role="slider"])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider], [role="menu"]:has([role="slider"])';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"], [role="menu"] [role="slider"]';
export const CHATGPT_SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[type="submit"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  '[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  '[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]',
].join(", ");

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

export interface ChatGptEffortActivation {
  method: "already-open" | "click" | "pointerdown";
  menu: Locator;
  sliderContainer: Locator;
  slider: Locator;
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last();
  // ChatGPT has used both a marked container with a hidden semantic input and a visible slider
  // directly inside the menu. The visible owner proves the active surface in either layout.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') };
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  // The exit animation keeps a closed menu's slider visible after Escape. Read the
  // owner state first: selecting that outgoing range races its removal from the DOM.
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "false" || state === "closed") return undefined;
  const menu = await chatGptEffortMenuForControl(page, control);
  const surface = chatGptEffortSlider(page);
  if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) {
    return { menu, ...surface };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control);
  if (openSurface) return { method: "already-open", ...openSurface };

  const settleMs = options.settleMs ?? 3_000;
  await clearGhostEffortState(page, control);
  await control.click({ force: true, timeout: Math.max(1, settleMs) });
  const clickedSurface = await waitForEffortSurface(page, control, settleMs);
  if (clickedSurface) return { method: "click", ...clickedSurface };

  await clearGhostEffortState(page, control);
  await control.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
  );
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Cloudflare serves its interactive challenge from this host, inside a frame that is not reachable
 * as an `<iframe>` element: measured live on 2026-09-23, `document.querySelectorAll("iframe")`
 * returned nothing while `page.frames()` listed the challenge. So frame URLs are the only reliable
 * probe. The page title ("请稍候…") and the widget label ("请验证您是真人") are localized and must
 * never be used as the signal.
 */
const CLOUDFLARE_CHALLENGE_FRAME_HOST = "challenges.cloudflare.com";

/**
 * True when Cloudflare has replaced ChatGPT with its "verify you are human" interstitial.
 *
 * This is a whole-document takeover, not an overlay: `document.body.innerText` is empty and no
 * composer exists, which is indistinguishable from an expired login if you only look at the DOM.
 * Telling the two apart matters because the remedies are opposite — a challenge is not fixed by
 * logging in again (measured 2026-09-18: a freshly captured session is still challenged, because
 * the clearance is bound to the browser fingerprint that solved it, not to the cookie).
 */
export function isCloudflareChallengePage(page: Page): boolean {
  return page.frames().some(frame => {
    const url = frame.url();
    if (!url) return false;
    try {
      return new URL(url).hostname.endsWith(CLOUDFLARE_CHALLENGE_FRAME_HOST);
    } catch {
      return false;
    }
  });
}

/** Cloudflare marks a response it replaced with a challenge; the value is `challenge`. */
const CLOUDFLARE_MITIGATED_HEADER = "cf-mitigated";

/**
 * The ChatGPT API path Cloudflare answered with a challenge, or undefined for any other response.
 * A challenged background request alone does not prove the turn is blocked; the watcher below
 * decides whether the path is required by the turn before escalating it.
 *
 * This is the quieter form of the block, and `isCloudflareChallengePage` cannot see it: no challenge
 * frame is drawn and the document keeps working. Measured live on 2026-09-25, the page and
 * `/backend-api/models` loaded normally while `POST /backend-api/f/conversation/prepare` and
 * `/backend-api/composer/items/interactions` came back 403 with `cf-mitigated: challenge` and a
 * Cloudflare HTML body. In the turn that met it, the effort picker opened without its slider and the
 * turn failed 70 seconds later reporting that the model controls were unavailable.
 */
export function cloudflareChallengedChatGptPath(response: Response): string | undefined {
  if (response.status() !== 403 || response.headers()[CLOUDFLARE_MITIGATED_HEADER] !== "challenge") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return undefined;
  }
  return url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/") ? url.pathname : undefined;
}

const cloudflareApiChallengeWatches = new WeakMap<Page, ChatGptCloudflareApiChallengeWatch>();

// A challenge on a background recommendation or cache request does not prove the conversation
// cannot run. Only requests used by model selection or the conversation transport may fail a turn.
const TURN_REQUIRED_CHATGPT_API_PATHS = new Set([
  "/backend-api/models",
  "/backend-api/settings/user",
  "/backend-api/composer/items/interactions",
  "/backend-api/f/conversation/prepare",
  "/backend-api/f/conversation",
]);

/**
 * Tracks turn-required API requests currently challenged during one turn. A later successful
 * response for the same path removes the challenge, so a recovered page can still finish.
 */
export class ChatGptCloudflareApiChallengeWatch {
  private firstPath: string | undefined;
  private readonly activePaths = new Set<string>();
  private settle: (path: string) => void = () => {};
  /** Settles with the first challenged path; never rejects. */
  readonly challenged = new Promise<string>(resolve => { this.settle = resolve; });
  private readonly observed = new Set<Page>();
  private readonly onResponse = (response: Response): void => {
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (url.hostname !== "chatgpt.com" || !TURN_REQUIRED_CHATGPT_API_PATHS.has(url.pathname)) return;
    if (cloudflareChallengedChatGptPath(response) === url.pathname) {
      this.activePaths.add(url.pathname);
      if (this.firstPath === undefined) {
        this.firstPath = url.pathname;
        this.settle(url.pathname);
      }
    } else if (response.status() >= 200 && response.status() < 300) {
      this.activePaths.delete(url.pathname);
    }
  };

  get challengedPath(): string | undefined {
    return this.activePaths.values().next().value;
  }

  /** Never throws: observation must not be able to fail a turn. */
  observe(page: Page): void {
    if (this.observed.has(page)) return;
    try {
      page.on("response", this.onResponse);
    } catch {
      return;
    }
    this.observed.add(page);
    cloudflareApiChallengeWatches.set(page, this);
  }

  dispose(): void {
    for (const page of this.observed) {
      try {
        page.off("response", this.onResponse);
      } catch {
        // A closed or disconnected page has already stopped emitting.
      }
      if (cloudflareApiChallengeWatches.get(page) === this) cloudflareApiChallengeWatches.delete(page);
    }
    this.observed.clear();
  }
}

export function chatGptCloudflareApiChallengeWatch(page: Page): ChatGptCloudflareApiChallengeWatch | undefined {
  return cloudflareApiChallengeWatches.get(page);
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const { sliderContainer, slider } = chatGptEffortSlider(page);
    const timeout = options.selectorTimeoutMs ?? 70_000;
    // Model radio rows can hydrate before the effort control. They carry no evidence
    // of the account's reasoning range, so an absent slider must fail, not cache false.
    await sliderContainer.waitFor({ state: "visible", timeout });
    await slider.waitFor({ state: "attached", timeout });
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow"),
    );
    if (!state) {
      throw new Error(
        "ChatGPT model controls are unavailable. Reload ChatGPT and run Repair again.",
        { cause: new Error("ChatGPT effort slider exposed an invalid ARIA range") },
      );
    }
    const optionCount = state.max - state.min + 1;
    return {
      solAvailable: true,
      extraHighAvailable: optionCount >= 4,
      proAvailable: optionCount >= 5,
    };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
