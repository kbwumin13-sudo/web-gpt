import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";

export interface InstalledCodexLifecycleHooks {
  command: string;
  sessionStartGroupIndex: number;
  userPromptSubmitGroupIndex: number;
  sessionEndGroupIndex: number;
  sessionStartStateKey: string;
  userPromptSubmitStateKey: string;
  sessionEndStateKey: string;
  sessionStartTrustedHash: string;
  userPromptSubmitTrustedHash: string;
  sessionEndTrustedHash: string;
  fragment: string;
}

export const MANAGED_CODEX_LIFECYCLE_HOOK_START =
  "# Managed by codex-chatgpt-web: start the headless backend from Codex lifecycle hooks.";
export const MANAGED_CODEX_LIFECYCLE_HOOK_END =
  "# End codex-chatgpt-web backend lifecycle hooks.";

type LifecycleEvent = "SessionStart" | "UserPromptSubmit" | "SessionEnd";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function eventKey(event: LifecycleEvent): "session_start" | "user_prompt_submit" | "session_end" {
  if (event === "SessionStart") return "session_start";
  if (event === "UserPromptSubmit") return "user_prompt_submit";
  return "session_end";
}

export function codexLifecycleHookHash(
  event: LifecycleEvent,
  command: string,
  matcher?: string,
  timeout = 20,
): string {
  const identity = canonicalJson({
    event_name: eventKey(event),
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{
      type: "command",
      command,
      timeout,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex backend lifecycle hook command contains an invalid Windows path character");
  }
  return `"${value}"`;
}

export function codexLifecycleHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "backend"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function hookGroupCount(text: string, event: LifecycleEvent): number {
  const escaped = event.replace(/[.*+?()[\]{}|\\]/g, "\\$&");
  return text.split(/\r\n|\n|\r/).filter(line => new RegExp(`^\\s*\\[\\[hooks\\.${escaped}\\]\\]\\s*(?:#.*)?$`).test(line)).length;
}

function markerCount(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

function parseConfigToml(text: string): unknown {
  return Bun.TOML.parse(text.replace(/\r(?!\n)/g, "\n"));
}

function normalizedValue(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export function installCodexLifecycleHooks(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexLifecycleHooks } {
  return installCodexLifecycleHooksCommand(text, configPath, codexLifecycleHookCommand(config));
}

export function installCodexLifecycleHooksCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexLifecycleHooks } {
  if (markerCount(text, MANAGED_CODEX_LIFECYCLE_HOOK_START) !== 0
    || text.includes(MANAGED_CODEX_LIFECYCLE_HOOK_END)) {
    throw new Error("Codex config already contains codex-chatgpt-web backend lifecycle hook markers");
  }
  const sessionStartGroupIndex = hookGroupCount(text, "SessionStart");
  const userPromptSubmitGroupIndex = hookGroupCount(text, "UserPromptSubmit");
  const sessionEndGroupIndex = hookGroupCount(text, "SessionEnd");
  const canonicalPath = canonicalConfigPath(configPath);
  const sessionStartStateKey = `${canonicalPath}:session_start:${sessionStartGroupIndex}:0`;
  const userPromptSubmitStateKey = `${canonicalPath}:user_prompt_submit:${userPromptSubmitGroupIndex}:0`;
  const sessionEndStateKey = `${canonicalPath}:session_end:${sessionEndGroupIndex}:0`;
  const sessionStartTrustedHash = codexLifecycleHookHash(
    "SessionStart",
    command,
    "startup|resume|clear|compact|fork",
  );
  const userPromptSubmitTrustedHash = codexLifecycleHookHash("UserPromptSubmit", command);
  const sessionEndTrustedHash = codexLifecycleHookHash("SessionEnd", command, undefined, 3);
  const ending = lineEnding(text);
  const core = [
    MANAGED_CODEX_LIFECYCLE_HOOK_START,
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume|clear|compact|fork"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 20",
    "",
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 20",
    "",
    "[[hooks.SessionEnd]]",
    "",
    "[[hooks.SessionEnd.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(sessionStartStateKey)}]`,
    `trusted_hash = ${JSON.stringify(sessionStartTrustedHash)}`,
    "",
    `[hooks.state.${JSON.stringify(userPromptSubmitStateKey)}]`,
    `trusted_hash = ${JSON.stringify(userPromptSubmitTrustedHash)}`,
    "",
    `[hooks.state.${JSON.stringify(sessionEndStateKey)}]`,
    `trusted_hash = ${JSON.stringify(sessionEndTrustedHash)}`,
    MANAGED_CODEX_LIFECYCLE_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: {
      command,
      sessionStartGroupIndex,
      userPromptSubmitGroupIndex,
      sessionEndGroupIndex,
      sessionStartStateKey,
      userPromptSubmitStateKey,
      sessionEndStateKey,
      sessionStartTrustedHash,
      userPromptSubmitTrustedHash,
      sessionEndTrustedHash,
      fragment,
    },
  };
}

function locateCodexLifecycleHooks(
  text: string,
  installed: InstalledCodexLifecycleHooks,
): { start: number; end: number } {
  if (markerCount(text, MANAGED_CODEX_LIFECYCLE_HOOK_START) !== 1
    || markerCount(text, MANAGED_CODEX_LIFECYCLE_HOOK_END) !== 1) {
    throw new Error("Codex backend lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  const pattern = new RegExp(hookTextPattern(installed.fragment), "g");
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("Codex backend lifecycle hooks changed after setup; refusing to overwrite them");
  }
  const match = matches[0]!;
  const markerIndex = text.indexOf(MANAGED_CODEX_LIFECYCLE_HOOK_START);
  if (markerIndex < match.index! || markerIndex >= match.index! + match[0].length) {
    throw new Error("Codex backend lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (hookGroupCount(text.slice(0, markerIndex), "SessionStart") !== installed.sessionStartGroupIndex
    || hookGroupCount(text.slice(0, markerIndex), "UserPromptSubmit") !== installed.userPromptSubmitGroupIndex
    || hookGroupCount(text.slice(0, markerIndex), "SessionEnd") !== installed.sessionEndGroupIndex) {
    throw new Error("Codex backend lifecycle hook order changed after setup; refusing to overwrite it");
  }
  if (codexLifecycleHookHash(
    "SessionStart",
    installed.command,
    "startup|resume|clear|compact|fork",
  ) !== installed.sessionStartTrustedHash
    || codexLifecycleHookHash("UserPromptSubmit", installed.command) !== installed.userPromptSubmitTrustedHash
    || codexLifecycleHookHash("SessionEnd", installed.command, undefined, 3) !== installed.sessionEndTrustedHash) {
    throw new Error("Codex backend lifecycle hook journal hash is invalid");
  }
  try {
    const expected = parseConfigToml(installed.fragment) as {
      hooks?: {
        SessionStart?: unknown[];
        UserPromptSubmit?: unknown[];
        SessionEnd?: unknown[];
        state?: Record<string, unknown>;
      };
    };
    const actual = parseConfigToml(text) as {
      hooks?: {
        SessionStart?: unknown[];
        UserPromptSubmit?: unknown[];
        SessionEnd?: unknown[];
        state?: Record<string, unknown>;
      };
    };
    if (normalizedValue(actual.hooks?.SessionStart?.[installed.sessionStartGroupIndex])
      !== normalizedValue(expected.hooks?.SessionStart?.[0])
      || normalizedValue(actual.hooks?.UserPromptSubmit?.[installed.userPromptSubmitGroupIndex])
      !== normalizedValue(expected.hooks?.UserPromptSubmit?.[0])
      || normalizedValue(actual.hooks?.SessionEnd?.[installed.sessionEndGroupIndex])
      !== normalizedValue(expected.hooks?.SessionEnd?.[0])
      || normalizedValue(actual.hooks?.state?.[installed.sessionStartStateKey])
      !== normalizedValue(expected.hooks?.state?.[installed.sessionStartStateKey])
      || normalizedValue(actual.hooks?.state?.[installed.userPromptSubmitStateKey])
      !== normalizedValue(expected.hooks?.state?.[installed.userPromptSubmitStateKey])
      || normalizedValue(actual.hooks?.state?.[installed.sessionEndStateKey])
      !== normalizedValue(expected.hooks?.state?.[installed.sessionEndStateKey])) {
      throw new Error("Modified owned definitions");
    }
  } catch {
    throw new Error("Codex backend lifecycle hooks changed after setup; refusing to overwrite them");
  }
  return { start: match.index!, end: match.index! + match[0].length };
}

export function verifyCodexLifecycleHooks(text: string, installed: InstalledCodexLifecycleHooks): void {
  locateCodexLifecycleHooks(text, installed);
}

export function restoreCodexLifecycleHooks(
  text: string,
  installed: InstalledCodexLifecycleHooks,
  options: { allowAbsent?: boolean } = {},
): string {
  if (options.allowAbsent
    && markerCount(text, MANAGED_CODEX_LIFECYCLE_HOOK_START) === 0
    && !text.includes(MANAGED_CODEX_LIFECYCLE_HOOK_END)) {
    try {
      const parsed = parseConfigToml(text) as { hooks?: { state?: Record<string, unknown> } };
      if (!parsed.hooks?.state?.[installed.sessionStartStateKey]
        && !parsed.hooks?.state?.[installed.userPromptSubmitStateKey]
        && !parsed.hooks?.state?.[installed.sessionEndStateKey]) return text;
    } catch {
      throw new Error("Codex backend lifecycle hooks changed after setup; refusing to overwrite them");
    }
  }
  const owned = locateCodexLifecycleHooks(text, installed);
  return `${text.slice(0, owned.start)}${text.slice(owned.end)}`;
}

export function verifyCodexLifecycleHooksRestored(text: string): void {
  if (markerCount(text, MANAGED_CODEX_LIFECYCLE_HOOK_START) !== 0
    || text.includes(MANAGED_CODEX_LIFECYCLE_HOOK_END)) {
    throw new Error("Codex backend lifecycle hooks are present while the bridge is disconnected");
  }
}
