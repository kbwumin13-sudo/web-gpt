import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

test("preserves local artifact links of every type with spaces and parentheses", () => {
  for (const name of ["报告.pdf", "文档.docx", "表格.xlsx", "幻灯片.pptx", "图片.png", "音频.mp3", "视频.mp4", "归档.zip", "脚本.py", "LICENSE"]) {
    const path = `/Users/example/My Outputs (final)/${name}`;
    expect(chatGptHtmlToMarkdown(`<p><a href="${path}">${name}</a></p>`))
      .toBe(`[${name}](<${path}>)`);
  }
  expect(chatGptHtmlToMarkdown('<a href="https://example.com/report.pdf">下载</a>'))
    .toBe('[下载](https://example.com/report.pdf)');
});

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    expect(chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`))
      .toBe(`Created [${path}](<${target}>).`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});

// Captured 2026-09-28 from ChatGPT's current renderer with a synthetic prompt. It emits no source
// ranges at all, renders code blocks without <pre>, and wraps formulas in KaTeX.
const ANSWER_FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "chatgpt-answer-hr-math-code.html"), "utf8");

function fixtureBlocks(): HTMLElement[] {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  // domino's HTMLCollection is array-like rather than iterable.
  return Array.from(createDocument(ANSWER_FIXTURE).body.firstElementChild!.children) as HTMLElement[];
}

/** The segments the page reports while `visible` blocks have rendered: no ranges, keyed by position. */
function snapshot(blocks: { tagName: string; outerHTML: string; textContent: string | null }[], visible: number): ChatGptMarkdownSegment[] {
  return blocks.slice(0, visible).map((block, index) => ({
    key: `${index}:${block.tagName.toLowerCase()}`,
    tag: block.tagName.toLowerCase(),
    html: block.outerHTML,
    text: (block.textContent ?? "").trim(),
    streamable: index < visible - 1,
  }));
}

function streamAll(blocks: Parameters<typeof snapshot>[0]): string {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  let streamed = "";
  for (let visible = 1; visible <= blocks.length; visible += 1) streamed += buffer.observe(snapshot(blocks, visible), visible * 1_000);
  return streamed + buffer.finish().delta;
}

test("an answer with two horizontal rules streams to its end", () => {
  // Every such answer failed when its second rule appeared: an empty <hr> matched the committed one
  // by tag and text and was read as an old block that had moved behind new ones.
  const streamed = streamAll(fixtureBlocks());
  expect(streamed.match(/^\* \* \*$/gm)).toHaveLength(2);
  expect(streamed).toContain("### Part B");
  expect(streamed.endsWith("END-OF-FIXTURE")).toBeTrue();
});

test("a repeated block right after the committed tail is a new block", () => {
  const block = (tagName: string, text: string) => ({ tagName, outerHTML: `<${tagName}>${text}</${tagName}>`, textContent: text });
  const streamed = streamAll([block("p", "one"), block("hr", ""), block("p", "two"), block("hr", ""), block("p", "three")]);
  expect(streamed).toBe("one\n\n* * *\n\ntwo\n\n* * *\n\nthree");
});

test("a committed block whose position shifted is still recognised by its content", () => {
  // A virtualized prefix renumbers the blocks that remain.
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const segment = (key: string, tag: string, text: string, streamable: boolean): ChatGptMarkdownSegment => (
    { key, tag, html: `<${tag}>${text}</${tag}>`, text, streamable }
  );
  let streamed = buffer.observe([segment("0:h2", "h2", "Title", true), segment("1:h3", "h3", "Part A", true), segment("2:p", "p", "tail", false)], 1_000);
  streamed += buffer.observe([segment("0:h3", "h3", "Part A", true), segment("1:p", "p", "tail", true), segment("2:p", "p", "more", false)], 2_000);
  streamed += buffer.finish().delta;
  expect(streamed).toBe("## Title\n\n### Part A\n\ntail\n\nmore");
});

test("a code block keeps its lines, its language, and none of its header", () => {
  const [, , , first, , , , second] = fixtureBlocks();
  expect(chatGptHtmlToMarkdown(first!.outerHTML)).toBe("```matlab\nx=0:0.1:1;\ny=1./(1+25*x.^2);\nplot(x,y);\n```");
  expect(chatGptHtmlToMarkdown(second!.outerHTML)).toBe("```matlab\np=polyfit(x,y,4);\ndisp(p);\n```");
});

test("a code block containing backticks gets a longer fence", () => {
  const html = '<div data-markdown-copy="code-block"><div data-markdown-copy="exclude">md</div><code>a ``` b</code></div>';
  expect(chatGptHtmlToMarkdown(html)).toBe("````md\na ``` b\n````");
});

test("a rendered formula is written once, as its TeX source", () => {
  const [, , paragraph] = fixtureBlocks();
  expect(chatGptHtmlToMarkdown(paragraph!.outerHTML)).toContain("$f(x)=\\frac{1}{1+25x^2}$");
  expect(chatGptHtmlToMarkdown(paragraph!.outerHTML)).not.toContain("1+25x21");
  const display = chatGptHtmlToMarkdown('<p>so <span data-math-display="true" data-math-source="\\sum_i x_i"><span class="katex">junk</span></span> ends</p>');
  expect(display).toContain("\n\n$$\n\\sum_i x_i\n$$\n\n");
  expect(display).not.toContain("junk");
});

test("KaTeX without the renderer's source attribute falls back to its TeX annotation", () => {
  const katex = (tex: string) => `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>p</mi></mrow>`
    + `<annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>`
    + '<span class="katex-html" aria-hidden="true">p4​(x)</span></span>';
  expect(chatGptHtmlToMarkdown(`<p>Newton ${katex("p_4(x)")} form</p>`)).toBe("Newton $p_4(x)$ form");
  expect(chatGptHtmlToMarkdown(`<p><span class="katex-display">${katex("S(x)")}</span></p>`)).toBe("$$\nS(x)\n$$");
});
