/**
 * Commentary of an agentic ChatGPT turn, read before that turn has an answer.
 *
 * ChatGPT's thread (measured 2026-09-29) renders a tool-using turn in two blocks. The first opens
 * with a hidden `[data-chatgpt-agent-turn-start]` marker and holds the work: the model's commentary
 * as assistant Markdown, and one row per tool call whose label is assistant Markdown in the
 * tertiary tone. The answer arrives later as its own `[data-chatgpt-search-unit-key]` message unit,
 * the only part the answer reader binds to. A plain reply has the marker and the unit and no work
 * between them. Everything read here is display trace for Codex, never answer text.
 */

export interface ChatGptAgentCommentaryBlock {
  html: string;
  /** The model has moved past this root: it lost ChatGPT's streaming mark, or something follows it. */
  complete: boolean;
}

export interface ChatGptAgentCommentaryProbe {
  /** Keys of the conversation turns on the page, in document order. */
  turnKeys: string[];
  /**
   * Commentary of the one agent turn outside the baseline, from root `fromBlock` on; empty unless
   * exactly one such turn exists. Roots already relayed are not sent back on every probe.
   */
  blocks: ChatGptAgentCommentaryBlock[];
}

/**
 * Runs inside the page through `page.evaluate`, so it must stay self-contained: nothing from this
 * module's scope is available there.
 */
export function chatGptAgentCommentaryProbe(
  options: { baselineTurnKeys: string[]; fromBlock: number },
): ChatGptAgentCommentaryProbe {
  const turns = Array.from(document.querySelectorAll("[data-turn-key]"));
  const turnKeys = turns.map(turn => turn.getAttribute("data-turn-key") ?? "");
  const baseline = new Set(options.baselineTurnKeys);
  const live = turns.filter((turn, index) => (
    turnKeys[index] !== "" && !baseline.has(turnKeys[index]!)
    && turn.querySelector("[data-chatgpt-agent-turn-start]") !== null
  ));
  // A turn cannot be attributed to this submission unless it is the only new one.
  if (live.length !== 1) return { turnKeys, blocks: [] };
  const marker = live[0]!.querySelector("[data-chatgpt-agent-turn-start]")!;
  const markdown = '[data-markdown-text-style="assistant-message"]';
  // Every root of the turn's work and answer, in document order.
  const roots = Array.from(live[0]!.querySelectorAll(markdown)).filter(root => (
    !root.parentElement?.closest(markdown)
    // 4 is Node.DOCUMENT_POSITION_FOLLOWING, inlined to keep this function standalone.
    && Boolean(marker.compareDocumentPosition(root) & 4)
  ));
  const blocks = roots.flatMap((root, index) => {
    // The answer unit belongs to the answer reader.
    if (root.closest("[data-chatgpt-search-unit-key]") !== null) return [];
    // Tool-call labels: Codex already shows each call as its own native item.
    if (root.getAttribute("data-markdown-text-tone") === "tertiary") return [];
    const checkVisibility = (root as Element & { checkVisibility?: () => boolean }).checkVisibility;
    if (typeof checkVisibility === "function" && !checkVisibility.call(root)) return [];
    // ChatGPT keeps the streaming mark on the turn's newest root until another item renders, so
    // a root that a tool row or a later root already follows is finished even while marked.
    const complete = !root.hasAttribute("data-markdown-animated")
      || root.nextElementSibling !== null
      || index < roots.length - 1;
    return [{ root, complete }];
  });
  return {
    turnKeys,
    blocks: blocks.slice(options.fromBlock).map(({ root, complete }) => ({ html: root.innerHTML, complete })),
  };
}
