import { expect, test } from "bun:test";
import {
  MANAGED_CODEX_LIFECYCLE_HOOK_END,
  codexLifecycleHookCommand,
  codexLifecycleHookHash,
  installCodexLifecycleHooks,
  restoreCodexLifecycleHooks,
  verifyCodexLifecycleHooks,
  verifyCodexLifecycleHooksRestored,
} from "../src/codex-lifecycle-hook";

test("installs trusted SessionStart and UserPromptSubmit backend hooks", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    "",
    "[[hooks.SessionStart]]",
    "matcher = \"startup\"",
    "",
  ].join("\n");
  const installed = installCodexLifecycleHooks(
    original,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/Codex Web/runtime/bun", "/opt/Codex Web/app/cli.js"] },
  );

  expect(installed.installed.sessionStartGroupIndex).toBe(1);
  expect(installed.installed.userPromptSubmitGroupIndex).toBe(0);
  expect(installed.text).toContain("[[hooks.SessionStart]]");
  expect(installed.text).toContain("[[hooks.UserPromptSubmit]]");
  expect(installed.text).toContain("[[hooks.SessionEnd]]");
  expect(installed.text).toContain(
    `[hooks.state.${JSON.stringify(installed.installed.sessionStartStateKey)}]`,
  );
  expect(installed.installed.sessionStartTrustedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(installed.installed.userPromptSubmitTrustedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  verifyCodexLifecycleHooks(installed.text, installed.installed);
  expect(restoreCodexLifecycleHooks(installed.text, installed.installed)).toBe(original);
  verifyCodexLifecycleHooksRestored(original);
});

test("uses the exact backend command and deterministic trust identities", () => {
  const command = codexLifecycleHookCommand(
    { runtimeCommand: ["/Applications/Codex Web GPT.app/runtime/bun", "/Applications/Codex Web GPT.app/app/cli.js"] },
    "/Users/test/Application Support/Codex Web GPT",
    "darwin",
  );
  expect(command).toBe(
    "'/Applications/Codex Web GPT.app/runtime/bun' '/Applications/Codex Web GPT.app/app/cli.js'"
      + " '--home' '/Users/test/Application Support/Codex Web GPT' 'hook' 'backend'",
  );
  expect(codexLifecycleHookHash("SessionStart", command, "startup|resume|clear|compact|fork"))
    .toBe(codexLifecycleHookHash("SessionStart", command, "startup|resume|clear|compact|fork"));
  expect(codexLifecycleHookHash("SessionStart", command, "startup|resume|clear|compact|fork"))
    .not.toBe(codexLifecycleHookHash("UserPromptSubmit", command));
});

test("refuses modified lifecycle hooks and duplicate markers", () => {
  const installed = installCodexLifecycleHooks(
    'model = "gpt-5.6-sol"\n',
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  );
  expect(() => verifyCodexLifecycleHooks(
    installed.text.replace("timeout = 20", "timeout = 10"),
    installed.installed,
  )).toThrow("changed after setup");
  expect(() => restoreCodexLifecycleHooks(
    installed.text.replace(MANAGED_CODEX_LIFECYCLE_HOOK_END, `approved = false\n${MANAGED_CODEX_LIFECYCLE_HOOK_END}`),
    installed.installed,
  )).toThrow("changed after setup");
  expect(() => installCodexLifecycleHooks(
    installed.text,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  )).toThrow("already contains");
});
