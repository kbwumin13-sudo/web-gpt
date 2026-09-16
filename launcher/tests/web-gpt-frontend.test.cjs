const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(launcherRoot, ...parts), "utf8");

test("macOS renderer selects the independent Web GPT entry while the legacy renderer remains available", () => {
  const main = read("src", "main.tsx");
  const manifest = JSON.parse(read("package.json"));
  assert.match(main, /VITE_LAUNCHER_FRONTEND === "web-gpt"/);
  assert.match(main, /import\("\.\/web-gpt\/App"\)/);
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
