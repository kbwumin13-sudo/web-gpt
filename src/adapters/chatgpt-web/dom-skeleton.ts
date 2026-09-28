/**
 * Structure-only map of the ChatGPT page for browser-turn diagnostics.
 *
 * ChatGPT reshapes its conversation DOM without notice, and each reshape has surfaced as a turn
 * the reader could not find. Fixing one needs the page's shape: element nesting, tags, structural
 * attributes, class names and where text lives. The skeleton records exactly that and never the
 * text itself, so it can be persisted beside the other browser diagnostics.
 *
 * Line grammar, one element per line, indented two spaces per depth:
 *   tag [@attribute[=value]]... [.class]... [t=own-text-chars] [!hidden]
 *   tag ... n=children d=descendants t=text-chars   (opaque: Markdown, code, math, media)
 *   ~count                                          (children elided from a long list)
 */

export interface ChatGptDomSkeleton {
  elements: number;
  truncated: boolean;
  lines: string[];
}

export interface ChatGptDomSkeletonLimits {
  maxLines: number;
  /** Lists longer than this keep their first four and last children; must exceed four. */
  maxChildren: number;
}

export const CHATGPT_DOM_SKELETON_LIMITS: ChatGptDomSkeletonLimits = { maxLines: 3_000, maxChildren: 12 };

/**
 * Runs inside the page through `page.evaluate`, so it must stay self-contained: nothing from this
 * module's scope is available there.
 */
export function chatGptDomSkeleton(limits: ChatGptDomSkeletonLimits): ChatGptDomSkeleton {
  const safeName = /^[a-z][a-z0-9_:.-]{0,60}$/;
  const safeValue = /^[A-Za-z0-9_:./-]{1,64}$/;
  const safeClass = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
  // Attributes that carry rendered or user-supplied text are named but never valued.
  const withheld = new Set([
    "alt", "aria-description", "aria-label", "aria-placeholder", "aria-roledescription", "aria-valuetext",
    "content", "d", "data-math-source", "href", "placeholder", "src", "srcset", "style", "title", "value",
  ]);
  const skipped = new Set(["script", "style", "template", "noscript", "link", "meta"]);
  // Inner structure the conversation reader treats as one unit is summarized, not walked.
  const opaque = "[data-markdown-text-style], .markdown, svg, math, .katex, pre, iframe, img, video, canvas, textarea";
  const lines: string[] = [];
  let elements = 0;
  let truncated = false;

  const attributeToken = (name: string, raw: string): string => {
    if (!safeName.test(name) || name.startsWith("on")) return "";
    if (withheld.has(name)) return ` @${name}`;
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    // Only identifier lists may hold several values; a spaced value elsewhere can be prose.
    const single = tokens.length === 1 || (name.endsWith("ids") && tokens.length > 1 && tokens.length <= 8);
    return single && tokens.every(token => safeValue.test(token))
      ? ` @${name}=${tokens.join(",")}`
      : ` @${name}`;
  };

  const visit = (element: Element, depth: number, parentHidden: boolean): void => {
    if (lines.length >= limits.maxLines) {
      truncated = true;
      return;
    }
    const tag = element.tagName.toLowerCase();
    if (skipped.has(tag)) return;
    elements += 1;
    const indent = "  ".repeat(depth);
    let line = `${indent}${tag}`;
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes[index]!;
      if (attribute.name !== "class") line += attributeToken(attribute.name.toLowerCase(), attribute.value);
    }
    for (const token of (element.getAttribute("class") ?? "").split(/\s+/).filter(token => safeClass.test(token)).slice(0, 8)) {
      line += ` .${token}`;
    }
    const checkVisibility = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
    const hidden = parentHidden
      || (typeof checkVisibility === "function" && !checkVisibility.call(element, { visibilityProperty: true }));
    if (element.matches(opaque)) {
      lines.push(`${line} n=${element.children.length} d=${element.getElementsByTagName("*").length}`
        + ` t=${(element.textContent ?? "").length}${hidden && !parentHidden ? " !hidden" : ""}`);
      return;
    }
    let ownText = 0;
    for (let index = 0; index < element.childNodes.length; index += 1) {
      const node = element.childNodes[index]!;
      if (node.nodeType === 3) ownText += (node.textContent ?? "").trim().length;
    }
    if (ownText > 0) line += ` t=${ownText}`;
    lines.push(hidden && !parentHidden ? `${line} !hidden` : line);
    const children: Element[] = [];
    for (let index = 0; index < element.children.length; index += 1) children.push(element.children[index]!);
    if (children.length <= limits.maxChildren) {
      for (const child of children) visit(child, depth + 1, hidden);
      return;
    }
    const tail = limits.maxChildren - 4;
    for (const child of children.slice(0, 4)) visit(child, depth + 1, hidden);
    lines.push(`${indent}  ~${children.length - 4 - tail}`);
    for (const child of children.slice(-tail)) visit(child, depth + 1, hidden);
  };

  if (document.body) visit(document.body, 0, false);
  return { elements, truncated, lines };
}

const SKELETON_VALUE = "[A-Za-z0-9_:./-]{1,64}";
const SKELETON_TOKEN = [
  `@[a-z][a-z0-9_:.-]{0,60}(?:=${SKELETON_VALUE})?`,
  `@[a-z][a-z0-9_:.-]{0,57}ids=${SKELETON_VALUE}(?:,${SKELETON_VALUE}){1,7}`,
  "\\.[A-Za-z][A-Za-z0-9_-]{0,47}",
  "[tnd]=\\d{1,9}",
  "!hidden",
].join("|");
const SKELETON_LINE = new RegExp(`^ *(?:~\\d{1,7}|[a-z][a-z0-9-]{0,40}(?: (?:${SKELETON_TOKEN}))*)$`);

/** Defense in depth: keep only lines that match the skeleton grammar, which has no room for prose. */
export function sanitizeChatGptDomSkeleton(value: unknown): (ChatGptDomSkeleton & { rejectedLines: number }) | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { elements, truncated, lines } = value as Record<string, unknown>;
  if (typeof elements !== "number" || typeof truncated !== "boolean" || !Array.isArray(lines)) return undefined;
  const kept = lines.filter((line): line is string => (
    typeof line === "string" && line.length <= 4_000 && SKELETON_LINE.test(line)
  ));
  return { elements, truncated, lines: kept, rejectedLines: lines.length - kept.length };
}
