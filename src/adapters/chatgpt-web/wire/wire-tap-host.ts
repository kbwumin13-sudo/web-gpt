import type { Page } from "playwright-core";
import { CHATGPT_WIRE_TAP_BINDING, chatGptWireTapInitScript, type ChatGptWireRecord } from "./page-tap";
import type { ChatGptWireCollector } from "./wire-collector";

/**
 * Attaches the in-page observer to a Playwright page and feeds what it reports to a collector.
 *
 * The binding is an entry point from a remote origin into this process, so every record is
 * validated against the shape this host accepts before it reaches the collector. A page that sends
 * anything else has its record rejected and counted; nothing malformed is stored or acted upon.
 */

/** Records accepted from one page before the tap stops listening. Bounds the cost of a page that misbehaves. */
export const MAX_WIRE_RECORDS_PER_PAGE = 200_000;

const KINDS = new Set(["request", "response", "chunk", "end", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Strict: an unexpected shape is rejected rather than coerced into a partial record. */
export function parseWireRecord(value: unknown): ChatGptWireRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, id, at } = value;
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (kind === "request") {
    const { method, url } = value;
    if (typeof method !== "string" || method.length > 16) return undefined;
    if (typeof url !== "string" || url.length > 4_096) return undefined;
    return { kind, id, method, url, at };
  }
  if (kind === "response") {
    const { status } = value;
    if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
    return { kind, id, status, at };
  }
  if (kind === "chunk") {
    const { text } = value;
    if (typeof text !== "string") return undefined;
    return { kind, id, text, at };
  }
  if (kind === "error") {
    const { message } = value;
    if (typeof message !== "string") return undefined;
    return { kind, id, message: message.slice(0, 2_048), at };
  }
  return { kind: "end", id, at };
}

export interface ChatGptWireTapAttachment {
  /** Whether the observer was installed. A refusal is reported, never thrown into a turn. */
  attached: boolean;
  /** Why it could not be installed, when it could not. */
  reason?: string;
  /** Records rejected as malformed, and records refused past the per-page cap, since this attach. */
  rejected(): { malformed: number; overflowed: number };
}

interface PageTap {
  /** The collector the binding currently routes to; swapped when a new turn attaches. */
  current: ChatGptWireCollector;
  malformed: number;
  overflowed: number;
  accepted: number;
}

/**
 * A binding and an init script can each be installed on a page only once, while a retained ChatGPT
 * conversation serves many turns from one page. The installation therefore happens once per page
 * and the *collector* rotates, so every turn observes its own records instead of the second turn
 * silently reporting into the first turn's collector.
 */
const taps = new WeakMap<Page, PageTap>();

/**
 * Install the observer. This runs in shadow mode: the DOM remains the authority for every turn
 * decision, so a tap that cannot attach must degrade to no observation rather than to a failed turn.
 */
export async function attachChatGptWireTap(
  page: Page,
  collector: ChatGptWireCollector,
  onFault?: (message: string) => void,
): Promise<ChatGptWireTapAttachment> {
  const existing = taps.get(page);
  if (existing) {
    existing.current = collector;
    const baseline = { malformed: existing.malformed, overflowed: existing.overflowed };
    return {
      attached: true,
      rejected: () => ({
        malformed: existing.malformed - baseline.malformed,
        overflowed: existing.overflowed - baseline.overflowed,
      }),
    };
  }
  const tap: PageTap = { current: collector, malformed: 0, overflowed: 0, accepted: 0 };
  const rejected = () => ({ malformed: tap.malformed, overflowed: tap.overflowed });
  try {
    await page.exposeFunction(CHATGPT_WIRE_TAP_BINDING, (value: unknown) => {
      if (tap.accepted >= MAX_WIRE_RECORDS_PER_PAGE) {
        tap.overflowed += 1;
        return;
      }
      const record = parseWireRecord(value);
      if (!record) {
        tap.malformed += 1;
        return;
      }
      tap.accepted += 1;
      tap.current.record(record);
    });
    // Applies from the page's next navigation. A turn page is created blank and navigated
    // afterwards, so its conversation traffic is covered from the first request.
    await page.addInitScript({ content: chatGptWireTapInitScript() });
    taps.set(page, tap);
    return { attached: true, rejected };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onFault?.(reason);
    return { attached: false, reason, rejected };
  }
}
