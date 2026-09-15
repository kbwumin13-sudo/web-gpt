import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Codex executes command hooks through cmd.exe /C on Windows. Quoting every argument preserves
  // spaces and shell metacharacters in the installed runtime path.
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
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

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
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
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

// TOML rejects a bare carriage return, so a CR-only config cannot be handed to the parser as-is.
// Valid TOML never contains one, including inside strings, so replacing it cannot change a
// document's values. Parsing only compares owned definitions and never produces output, which
// keeps CR configs restorable byte for byte.
function parseConfigToml(text: string): unknown {
  return Bun.TOML.parse(text.replace(/\r(?!\n)/g, "\n"));
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): Array<{
  start: number; end: number;
}> {
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  // Codex's TOML editor may move the hooks.state table away from the command hook while it
  // inserts unrelated tables. Match the command definition textually, then validate both owned
  // definitions semantically below instead of requiring the two tables to remain contiguous.
  const stateTable = installed.fragment.search(/(?:\r\n|\n|\r)\[hooks\.state\./);
  const ownedPrefix = stateTable < 0 ? installed.fragment.slice(0, marker) : installed.fragment.slice(0, stateTable);
  // Native config writes normalize CRLF to LF; the command and owned fields must still match exactly.
  const markerlessPrefix = ownedPrefix
    .replace(MANAGED_INTERRUPT_HOOK_START, "")
    .replace(/^(\r\n|\n|\r){2}/, "$1");
  const prefixes = text.includes(MANAGED_INTERRUPT_HOOK_START)
    ? [ownedPrefix]
    : [markerlessPrefix];
  const pattern = new RegExp(hookTextPattern(prefixes[0]!), "g");
  const match = pattern.exec(text);
  if (!match || pattern.exec(text)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const first = match.index;
  const ownedEnd = first + match[0].length;
  if (interruptGroupCount(text.slice(0, first)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }
  const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  const markerMissingAfterCodexNormalization = managedMarkerCount(text) === 0
    && !text.includes(MANAGED_INTERRUPT_HOOK_START);
  if ((!markerMissingAfterCodexNormalization && managedMarkerCount(text) !== 1) || endMarker < 0
    || (endMarker >= first && endMarker < ownedEnd)
    || text.split(MANAGED_INTERRUPT_HOOK_END).length !== 2) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (endMarker < first) {
    // A moved comment is independent of the owned definitions. Prove it is still a comment,
    // rather than matching text inside an unrelated TOML value, before removing it separately.
    const precedingConfig = text.slice(0, first);
    const withoutMarker = precedingConfig.slice(0, endMarker)
      + precedingConfig.slice(endMarker + MANAGED_INTERRUPT_HOOK_END.length);
    try {
      if (JSON.stringify(canonicalJson(parseConfigToml(precedingConfig)))
        !== JSON.stringify(canonicalJson(parseConfigToml(withoutMarker)))) {
        throw new Error("Marker removal changes TOML values");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
    }
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  // Compare the managed Interrupt entry and trust state by parsed TOML values. This tolerates
  // unrelated tables being inserted between them, but rejects added fields, changed commands,
  // changed hashes, duplicate entries, or malformed config.
  try {
    const expected = parseConfigToml(installed.fragment) as {
      hooks?: { Interrupt?: unknown[]; state?: Record<string, unknown> };
    };
    const actual = parseConfigToml(text) as {
      hooks?: { Interrupt?: unknown[]; state?: Record<string, unknown> };
    };
    const expectedInterrupt = expected.hooks?.Interrupt?.[0];
    const actualInterrupt = actual.hooks?.Interrupt?.[installed.groupIndex];
    const expectedState = expected.hooks?.state?.[installed.stateKey];
    const actualState = actual.hooks?.state?.[installed.stateKey];
    if (JSON.stringify(canonicalJson(actualInterrupt)) !== JSON.stringify(canonicalJson(expectedInterrupt))
      || JSON.stringify(canonicalJson(actualState)) !== JSON.stringify(canonicalJson(expectedState))) {
      throw new Error("Modified owned definitions");
    }
  } catch {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const stateHeader = `[hooks.state.${JSON.stringify(installed.stateKey)}]`;
  const escapedStateHeader = stateHeader.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const escapedHash = JSON.stringify(installed.trustedHash).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const statePattern = new RegExp(
    `(^|\\r\\n|\\n|\\r)${escapedStateHeader}(?:\\r\\n|\\n|\\r)trusted_hash\\s*=\\s*${escapedHash}(?:\\r\\n|\\n|\\r)?`,
    "g",
  );
  const stateMatches = [...text.matchAll(statePattern)];
  if (stateMatches.length !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const stateMatch = stateMatches[0];
  // Consume the separator immediately before the state table as well. It is part of the managed
  // fragment's spacing and prevents a blank line from being left behind after restoration.
  const stateStart = stateMatch.index!;
  const stateEnd = stateStart + stateMatch[0].length;
  const end = endMarker + MANAGED_INTERRUPT_HOOK_END.length;
  const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
  const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(end))?.[0].length ?? 0;
  return [
    { start: first, end: ownedEnd },
    { start: stateStart, end: stateEnd },
    { start: endMarker, end: end + trailingLength },
  ];
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = parseConfigToml(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
