const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(launcherRoot, ...parts), "utf8");

test("macOS renderer selects the independent Web GPT entry while the legacy renderer remains available", () => {
  const main = read("src", "main.tsx");
  const config = read("vite.config.ts");
  const manifest = JSON.parse(read("package.json"));
  // The entry is resolved while bundling. Choosing it at runtime put both renderers in the module
  // graph, so a Web GPT build emitted the legacy one and every asset it referenced — 2.1 MB of
  // screen recordings among them, inside an app with no way to load them.
  assert.match(main, /from "#launcher-frontend"/);
  assert.doesNotMatch(main, /import\("\.\/App"\)/);
  assert.match(config, /VITE_LAUNCHER_FRONTEND === "web-gpt"/);
  assert.match(config, /"#launcher-frontend":/);
  assert.match(config, /\.\/src\/web-gpt\/App\.tsx/);
  assert.match(config, /\.\/src\/App\.tsx/);
  assert.equal(manifest.scripts["build:renderer:mac"], "VITE_LAUNCHER_FRONTEND=web-gpt vite build");
  assert.equal(manifest.scripts["build:renderer"], "vite build");
});

test("Web GPT renderer preserves every browser and runtime bridge boundary", () => {
  const source = read("src", "web-gpt", "App.tsx");
  for (const method of [
    "setBrowserBounds", "setBrowserSurfaceActive", "openPasskeyLogin", "continuePasskeyLogin",
    "setupCore", "setupMcp", "verifyMcp", "doctor", "exportLogs", "cancelTurns",
  ]) assert.match(source, new RegExp(`api![.]${method}`), `Web GPT must call ${method}`);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /className="wg-tab-drag draggable"/);
  assert.match(source, /className="wg-welcome"/);
  assert.match(source, /const managedBrowser = snapshot\.browserHost === "managed-chrome"/);
  assert.match(source, /!managedBrowser \? <SetupRow/);
});

test("Web GPT presents readiness before browser controls and keeps diagnostics fact-based", () => {
  const source = read("src", "web-gpt", "App.tsx");
  const types = read("src", "types.ts");
  assert.match(types, /"overview"/);
  assert.match(source, /function OverviewSurface/);
  assert.match(source, /codexCatalogVerified === true/);
  assert.match(source, /mcpSetupComplete === true/);
  assert.match(source, /mcpRuntimeInstalled === true/);
  assert.match(source, /api!\.doctor\(\)/);
  assert.match(source, /localToolsRequired/);
});

test("Web GPT uses its own mark and tokenized visual system", () => {
  const icons = read("src", "web-gpt", "icons.tsx");
  const styles = read("src", "web-gpt", "styles.css");
  const tokens = read("src", "web-gpt", "tokens.css");
  assert.match(icons, /function BrandMark/);
  assert.doesNotMatch(icons, /22\.2819|4\.9807/);
  assert.match(styles, /^\/\* Hallmark · macrostructure: Workbench/m);
  assert.match(styles, /@import "[.]\/tokens[.]css"/);
  assert.match(tokens, /--wg-sidebar: 252px/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.doesNotMatch(tokens, /OpenAI Sans/);
});

test("legacy demo recordings and inherited brand paths do not remain in the launcher source", () => {
  const legacy = read("src", "App.tsx");
  assert.doesNotMatch(legacy, /mcp-create-tunnel|mcp-connect-connector|22\.2819|4\.9807/);
  for (const name of [
    "mcp-connect-connector.gif",
    "mcp-connect-connector.mp4",
    "mcp-create-tunnel.gif",
    "mcp-create-tunnel.mp4",
  ]) assert.equal(fs.existsSync(path.join(launcherRoot, "src", "assets", name)), false, `${name} must not ship`);
});

test("first-run onboarding no longer requires upstream social visits", () => {
  const main = read("electron", "main.cjs");
  assert.match(main, /const GITHUB_URL = "https:\/\/github\.com\/kbwumin13-sudo\/web-gpt"/);
  assert.doesNotMatch(main, /Open the GitHub and X pages before continuing/);
  assert.match(main, /DEVELOPER_URL = "https:\/\/github\.com\/kbwumin13-sudo\?tab=repositories"/);
});

test("public release and updater target the Web GPT repository and macOS workflow", () => {
  const update = read("electron", "update.cjs");
  const workflow = fs.readFileSync(path.join(launcherRoot, "..", ".github", "workflows", "release.yml"), "utf8");
  const buildWorkflow = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  publish:"));
  const installer = fs.readFileSync(path.join(launcherRoot, "..", "scripts", "install-launcher.sh"), "utf8");
  assert.match(update, /const REPOSITORY = "kbwumin13-sudo\/web-gpt"/);
  assert.match(installer, /kbwumin13-sudo\/web-gpt/);
  assert.match(workflow, /macos-15/);
  assert.match(workflow, /macos-15-intel/);
  assert.doesNotMatch(buildWorkflow, /ubuntu-latest|windows-latest/);
  assert.match(workflow, /bun run --cwd launcher package:mac/);
});

test("a build records which renderer it contains, so the wrong packaging script is visible", () => {
  // `package:mac` selects the Web GPT renderer; `app:package` — the cross-platform CI check — does
  // not. Packaging through the wrong one produced an app that launched, worked, and quietly showed
  // the previous renderer, which nothing reported.
  const config = read("vite.config.ts");
  assert.match(config, /RENDERER_VARIANT_FILE = "renderer-variant\.json"/);
  assert.match(config, /VITE_LAUNCHER_FRONTEND === "web-gpt" \? "web-gpt" : "legacy"/);
  assert.match(config, /recordRendererVariant\(\)/);

  const main = read("electron", "main.cjs");
  assert.match(main, /function rendererVariant\(\)/);
  assert.match(main, /renderer-variant\.json/);
  assert.match(main, /renderer: rendererVariant\(\)/);
});
