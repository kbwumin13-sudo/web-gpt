import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
  // Whitespace inside <code> is content. ChatGPT's code blocks carry their line breaks there with no
  // <pre> around them, and collapsing it turned multi-line code into one line.
  preformattedCode: true,
});

turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
/** A local destination written in angle brackets, so spaces and parentheses survive. */
function localLinkTarget(href: string): string {
  return href.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\n", "%0A").replaceAll("\r", "%0D");
}

// Preserve local artifact destinations across DOM extraction, including spaces and parentheses.
turndown.addRule("localArtifactLinks", {
  filter: node => node.nodeName === "A"
    && /^\/(?!\/)/.test((node as HTMLElement).getAttribute("href") ?? ""),
  replacement: (content, node) => `[${content}](<${localLinkTarget((node as HTMLElement).getAttribute("href")!)}>)`,
});
// ChatGPT's current renderer draws a linked local file as a mention, not an anchor: the model's
// target and label are on `data-prompt-link-href` and `data-prompt-link-label`, and read as text the
// link was reduced to its bare label.
turndown.addRule("fileReferenceLinks", {
  filter: node => attribute(node, "data-file-reference") === "true" && Boolean(attribute(node, "data-prompt-link-href")),
  replacement: (_content, node) => {
    const label = attribute(node, "data-prompt-link-label") ?? node.textContent ?? "";
    return `[${turndown.escape(label)}](<${localLinkTarget(attribute(node, "data-prompt-link-href")!)}>)`;
  },
});
// The current renderer also draws inline code as a `data-markdown-copy="inline-code"` span, not
// `<code>`, which read as plain text lost its backticks. A path in it is still linked, below.
turndown.addRule("markdownCopyInlineCode", {
  filter: node => attribute(node, "data-markdown-copy") === "inline-code",
  replacement: (_content, node) => {
    const code = node.textContent ?? "";
    const longestTicks = Math.max(0, ...Array.from(code.matchAll(/`+/g), run => run[0].length));
    const fence = "`".repeat(longestTicks + 1);
    const padding = /^`|`$/.test(code) ? " " : "";
    return `${fence}${padding}${code}${padding}${fence}`;
  },
});
turndown.addRule("linkInlineFilePaths", {
  filter: node => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent!;
    const target = path.replaceAll("\\", "/");
    return `[${path}](<${target}>)`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

function attribute(node: Node, name: string): string | null {
  return node.nodeType === 1 ? (node as HTMLElement).getAttribute(name) : null;
}

function hasClass(node: Node | null, name: string): boolean {
  return Boolean(node) && (attribute(node!, "class") ?? "").split(/\s+/).includes(name);
}

/**
 * The TeX behind a rendered formula. KaTeX renders every formula three times — MathML, its TeX
 * annotation, and the visible HTML — so converting its text wrote each formula out three times
 * over. ChatGPT's renderer also keeps the source on the wrapper in `data-math-source`.
 */
function renderedMath(node: Node): { tex: string; display: boolean } | undefined {
  const source = attribute(node, "data-math-source");
  if (source !== null) return { tex: source, display: attribute(node, "data-math-display") === "true" };
  if (!hasClass(node, "katex")) return undefined;
  const tex = (node as HTMLElement).querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  return tex ? { tex, display: hasClass(node.parentNode, "katex-display") } : undefined;
}

turndown.addRule("renderedMath", {
  filter: node => renderedMath(node) !== undefined,
  replacement: (_content, node) => {
    const { tex, display } = renderedMath(node)!;
    return display ? `\n\n$$\n${tex.trim()}\n$$\n\n` : `$${tex.trim()}$`;
  },
});

// ChatGPT marks what its own copy button takes: the header of a code block (language label, copy
// and wrap buttons) is `data-markdown-copy="exclude"`.
turndown.addRule("markdownCopyExclude", {
  filter: node => attribute(node, "data-markdown-copy") === "exclude",
  replacement: () => "",
});

/**
 * A code block in ChatGPT's current renderer is a `data-markdown-copy="code-block"` container whose
 * `<code>` holds the lines without any `<pre>`. Read as ordinary HTML it collapsed into a single line
 * of inline code, with the language label left behind as a paragraph of its own.
 */
turndown.addRule("markdownCopyCodeBlock", {
  filter: node => attribute(node, "data-markdown-copy") === "code-block",
  replacement: (_content, node) => {
    const element = node as HTMLElement;
    const code = (element.querySelector("code")?.textContent ?? "").replace(/\n$/, "");
    const label = element.querySelector('[data-markdown-copy="exclude"]')?.textContent?.trim() ?? "";
    const language = /^[\w+#.-]{1,32}$/.test(label) ? label : "";
    const longestTicks = Math.max(0, ...Array.from(code.matchAll(/`+/g), run => run[0].length));
    const fence = "`".repeat(Math.max(3, longestTicks + 1));
    return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
  },
});

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== "CODE" && attribute(node, "data-markdown-copy") !== "inline-code") return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["A", "PRE"].includes(ancestor.nodeName)) return undefined;
  }

  const path = node.textContent ?? "";
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;

  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const separator = Math.max(withoutLocation.lastIndexOf("/"), withoutLocation.lastIndexOf("\\"));
  if (separator < 0) return undefined;

  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

function preserveObsidianWikiLinks(markdown: string): string {
  // Turndown escapes literal brackets, but Codex interprets the resulting `\[` as LaTeX.
  // Restore the source syntax before converting it into a regular Markdown file link.
  return markdown.replace(/\\\[\\\[([^\r\n]*?)\\\]\\\]/g, "[[$1]]");
}

function obsidianWikiLink(value: string): string | undefined {
  const separator = value.indexOf("|");
  const target = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const label = (separator >= 0 ? value.slice(separator + 1) : value).trim();
  if (!target || !label || /[<>]/.test(target)) return undefined;

  const fragmentAt = target.indexOf("#");
  const note = fragmentAt >= 0 ? target.slice(0, fragmentAt) : target;
  const fragment = fragmentAt >= 0 ? target.slice(fragmentAt) : "";
  const extension = note.slice(note.lastIndexOf("/") + 1).includes(".");
  const path = note && !extension ? `${note}.md` : note;
  return `[${label}](<${path}${fragment}>)`;
}

function linkObsidianWikiLinks(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return markdown.split("\n").map(line => {
    const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const closingRun = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = undefined;
      return line;
    }
    if (fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      return line;
    }

    let result = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineCodeTicks = inlineCodeTicks === 0 ? ticks : ticks === inlineCodeTicks ? 0 : inlineCodeTicks;
        result += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineCodeTicks === 0 && line.startsWith("[[", index) && line[index - 1] !== "!") {
        const end = line.indexOf("]]", index + 2);
        if (end >= 0) {
          const linked = obsidianWikiLink(line.slice(index + 2, end));
          if (linked) {
            result += linked;
            index = end + 2;
            continue;
          }
        }
      }
      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return linkObsidianWikiLinks(preserveObsidianWikiLinks(turndown.turndown(html))).trim();
}

export interface ChatGptMarkdownSegment {
  key: string;
  tag?: string;
  html: string;
  text: string;
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  tag?: string;
  text: string;
  sourceStart?: number;
  sourceEnd?: number;
  html: string;
  group?: string;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string, readonly diagnostic?: {
    reason: "text_changed" | "block_order_changed" | "source_range_overlap";
    observedStart?: number;
    observedEnd?: number;
    committedStart?: number;
    committedEnd?: number;
    observedTextChars: number;
    committedTextChars: number;
  }) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. It can also virtualize an already-rendered prefix, so later DOM
 * snapshots are partial observations rather than the response ledger. The browser supplies source
 * ranges for semantic blocks and marks a block streamable only after a following block exists.
 * Once committed, a missing prefix is harmless; changing text at a committed source range remains
 * an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private consistencyError: ChatGptMarkdownConsistencyError | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
    // A wire-backed turn holds DOM output until completion. Its cached blocks may still hydrate;
    // only externally published append-only text must reject those revisions.
    private readonly deferOutput = false,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      this.consistencyError = reconciled;
      return "";
    }
    this.consistencyError = undefined;
    this.latest = reconciled.map(segment => ({ ...segment }));

    const visibleCandidates = new Set<string>();
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment);
      visibleCandidates.add(candidateId);
      const previous = this.candidates.get(candidateId);
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd;
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId);
    }

    let delta = "";
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!;
      const candidateId = this.candidateId(segment);
      const candidate = this.candidates.get(candidateId);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push(this.committedSegment(candidate));
      this.candidates.delete(candidateId);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return this.deferOutput ? "" : delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError;
    let delta = "";
    for (const segment of this.latest) {
      delta += this.commit(segment);
      this.committed.push(this.committedSegment(segment));
    }
    this.candidates.clear();
    this.latest = [];
    return { markdown: this.markdown, delta: this.deferOutput ? this.markdown : delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined;
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    if (this.committed.length === 0 || segments.length === 0) return segments;

    const pending: ChatGptMarkdownSegment[] = [];
    const lastRangedCommitted = this.committed
      .filter(segment => segment.sourceEnd !== undefined)
      .at(-1);
    const lastCommittedEnd = lastRangedCommitted?.sourceEnd;
    let highestCommittedIndex = -1;
    let sawPending = false;
    let committedChanged = false;
    const revisedCommitted = new Map<number, CommittedChatGptMarkdownSegment>();
    let previousSourceStart: number | undefined;

    for (const segment of segments) {
      if (segment.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && segment.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError(
            "ChatGPT final DOM exposed non-monotonic source ranges",
          );
        }
        previousSourceStart = segment.sourceStart;
      }
      const committedIndex = this.committedIndex(segment, highestCommittedIndex, sawPending);
      if (committedIndex !== undefined) {
        const committed = this.committed[committedIndex]!;
        if (sawPending || committedIndex < highestCommittedIndex
          || (!this.deferOutput && committed.text !== segment.text)) {
          return this.changedCommittedBlockError(
            sawPending || committedIndex < highestCommittedIndex ? "block_order_changed" : "text_changed",
            segment,
            committed,
          );
        }
        if (this.deferOutput) {
          committedChanged ||= committed.html !== segment.html || committed.group !== segment.group;
          revisedCommitted.set(committedIndex, this.committedSegment(segment));
        }
        highestCommittedIndex = committedIndex;
        continue;
      }

      if (segment.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (segment.sourceStart <= lastCommittedEnd) {
          return this.changedCommittedBlockError("source_range_overlap", segment, lastRangedCommitted!);
        }
        sawPending = true;
        pending.push(segment);
        continue;
      }

      const followsVisibleCommittedTail = highestCommittedIndex === this.committed.length - 1;
      if (!followsVisibleCommittedTail && !this.matchesLatestPending(segment)) {
        return new ChatGptMarkdownConsistencyError(
          "ChatGPT final DOM could not be aligned with text already streamed to Codex",
        );
      }
      sawPending = true;
      pending.push(segment);
    }

    for (const [index, segment] of revisedCommitted) this.committed[index] = segment;
    if (committedChanged) {
      this.markdown = "";
      this.lastGroup = undefined;
      for (const segment of this.committed) this.commit(segment);
    }
    return pending;
  }

  private committedIndex(
    segment: ChatGptMarkdownSegment,
    afterCommittedIndex: number,
    afterPending: boolean,
  ): number | undefined {
    const exact = this.committed.findIndex(committed => (
      segment.sourceStart !== undefined && committed.sourceStart !== undefined
        ? segment.sourceStart === committed.sourceStart && segment.tag === committed.tag
        : segment.key === committed.key
    ));
    if (exact >= 0) return exact;

    if (segment.sourceStart !== undefined) return undefined;
    if (!segment.tag) return undefined;
    // Without a source range a block is recognised only by its tag and text, and different blocks
    // share both: every horizontal rule is an empty <hr>. So the match is believed only where the
    // committed block could still stand — after the last block already matched and before any
    // block not yet streamed. Anywhere else it is a new block with the same content. ChatGPT's
    // renderer stopped emitting source ranges (seen 2026-09-28), which made this the common path:
    // an answer with two horizontal rules failed every time the second one appeared.
    if (afterPending) return undefined;
    const semanticMatches = this.committed
      .map((committed, index) => ({ committed, index }))
      .filter(({ committed, index }) => index > afterCommittedIndex
        && committed.tag === segment.tag
        && committed.text === segment.text);
    return semanticMatches.length === 1 ? semanticMatches[0]!.index : undefined;
  }

  private matchesLatestPending(segment: ChatGptMarkdownSegment): boolean {
    const exact = this.latest.filter(candidate => (
      segment.sourceStart !== undefined && candidate.sourceStart !== undefined
        ? segment.sourceStart === candidate.sourceStart && segment.tag === candidate.tag
        : segment.key === candidate.key
    ));
    if (exact.length === 1) return true;
    if (segment.sourceStart !== undefined) return false;
    if (!segment.tag) return false;
    return this.latest.filter(candidate => (
      candidate.tag === segment.tag && candidate.text === segment.text
    )).length === 1;
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `source:${segment.sourceStart}:${segment.tag ?? ""}`
      : `key:${segment.key}`;
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag ? { tag: segment.tag } : {}),
      text: segment.text,
      html: segment.html,
      ...(segment.group ? { group: segment.group } : {}),
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    };
  }

  private changedCommittedBlockError(
    reason: NonNullable<ChatGptMarkdownConsistencyError["diagnostic"]>["reason"],
    observed: ChatGptMarkdownSegment,
    committed: CommittedChatGptMarkdownSegment,
  ): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT changed a completed text block that was already streamed to Codex",
      {
        reason,
        observedStart: observed.sourceStart,
        observedEnd: observed.sourceEnd,
        committedStart: committed.sourceStart,
        committedEnd: committed.sourceEnd,
        observedTextChars: observed.text.length,
        committedTextChars: committed.text.length,
      },
    );
  }

  private commit(segment: Pick<ChatGptMarkdownSegment, "html" | "group">): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
