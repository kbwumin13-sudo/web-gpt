import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "./version";

export interface BuildProvenance {
  version: string;
  /** `packaged` when a runtime bundle produced this code, `source` when it runs from a working tree. */
  kind: "packaged" | "source";
  /** Commit the build was produced from, when it could be determined. */
  commit?: string;
  /** Whether that commit had uncommitted changes when the build ran. A dirty build is not reproducible from its commit alone. */
  dirty?: boolean;
  /** ISO timestamp the build ran, which is what distinguishes two builds of the same dirty tree. */
  builtAt?: string;
  /** Content hash of the installed runtime bundle, taken from the same manifest. */
  bundleId?: string;
}

/** The working-tree identity a build records in its manifest. */
export interface BuildIdentity {
  commit?: string;
  dirty?: boolean;
  builtAt: string;
}

const SHORT_DIGEST_LENGTH = 12;

function gitOutput(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Read the working tree a build is running from. The build script records this in the runtime
 * manifest; a source run reports it live. A tree without Git still yields a usable timestamp, so
 * provenance degrades to fewer fields rather than to nothing.
 */
export function readWorkingTreeIdentity(root: string, now = new Date()): BuildIdentity {
  const commit = gitOutput(["rev-parse", "HEAD"], root);
  const status = commit === undefined ? undefined : gitOutput(["status", "--porcelain"], root);
  return {
    ...(commit ? { commit } : {}),
    ...(status === undefined ? {} : { dirty: status.length > 0 }),
    builtAt: now.toISOString(),
  };
}

interface RuntimeManifestProvenance {
  build?: unknown;
  bundleId?: unknown;
}

function readManifestProvenance(appDirectory: string): { identity?: BuildIdentity; bundleId?: string } | undefined {
  const path = join(appDirectory, "..", "manifest.json");
  if (!existsSync(path)) return undefined;
  let parsed: RuntimeManifestProvenance;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeManifestProvenance;
  } catch {
    return {};
  }
  const build = parsed.build && typeof parsed.build === "object" && !Array.isArray(parsed.build)
    ? parsed.build as Record<string, unknown>
    : undefined;
  return {
    ...(build && typeof build.builtAt === "string"
      ? {
        identity: {
          ...(typeof build.commit === "string" ? { commit: build.commit } : {}),
          ...(typeof build.dirty === "boolean" ? { dirty: build.dirty } : {}),
          builtAt: build.builtAt,
        },
      }
      : {}),
    ...(typeof parsed.bundleId === "string" ? { bundleId: parsed.bundleId } : {}),
  };
}

let cached: BuildProvenance | undefined;

/**
 * Identity of the build that is actually executing.
 *
 * A source edit only changes behaviour once the runtime bundle and the Launcher embedding it are
 * rebuilt and installed. A running daemon used to report nothing about its own origin, so "the fix
 * did not work" and "the fix was never installed" were indistinguishable without grepping the
 * installed bundle for string literals. Provenance is diagnostic, so every lookup here degrades to
 * a missing field instead of failing a startup that would otherwise succeed.
 *
 * The manifest carries the build identity rather than the bundle carrying it, because `bundleId`
 * hashes the bundle's own files and a timestamp inside them would change that hash on every build.
 * `manifest.json` is excluded from the hash, so a build stays reproducible while still naming itself.
 */
export function buildProvenance(moduleDirectory = import.meta.dir): BuildProvenance {
  if (cached) return cached;
  const manifest = readManifestProvenance(moduleDirectory);
  const identity = manifest?.identity ?? readWorkingTreeIdentity(join(moduleDirectory, ".."));
  cached = {
    version: VERSION,
    kind: manifest ? "packaged" : "source",
    ...(identity.commit ? { commit: identity.commit } : {}),
    ...(identity.dirty === undefined ? {} : { dirty: identity.dirty }),
    ...(manifest?.identity ? { builtAt: identity.builtAt } : {}),
    ...(manifest?.bundleId ? { bundleId: manifest.bundleId } : {}),
  };
  return cached;
}

/** Test seam; the provenance of a live process never changes while it runs. */
export function resetBuildProvenanceCache(): void {
  cached = undefined;
}

/**
 * A daemon keeps serving the build it started with. Reinstalling a runtime therefore changes
 * nothing until that process restarts, which is the shape of "the fix was never installed": the
 * files on disk hold the fix and the process answering Codex does not. Both sides report
 * `bundleId`, so the mismatch is decidable rather than inferred from timestamps.
 */
export function staleDaemonBuild(reported: unknown, local = buildProvenance()): string | undefined {
  if (!local.bundleId) return undefined;
  const build = reported && typeof reported === "object" && !Array.isArray(reported)
    ? reported as Record<string, unknown>
    : undefined;
  const daemonBundleId = typeof build?.bundleId === "string" ? build.bundleId : undefined;
  if (!daemonBundleId || daemonBundleId === local.bundleId) return undefined;
  return `Daemon is serving bundle ${daemonBundleId.slice(0, SHORT_DIGEST_LENGTH)} while the installed `
    + `runtime is bundle ${local.bundleId.slice(0, SHORT_DIGEST_LENGTH)}. `
    + "Restart the daemon so the installed build takes effect.";
}

/**
 * One line naming the build, for `--version`, `doctor`, and startup logs. Comparing the reported
 * commit against `git rev-parse HEAD` is the point, so an unknown commit is stated rather than omitted.
 */
export function describeBuild(provenance: BuildProvenance): string {
  const parts = [`${provenance.version} (${provenance.kind})`];
  parts.push(provenance.commit
    ? `commit ${provenance.commit.slice(0, SHORT_DIGEST_LENGTH)}${provenance.dirty ? "-dirty" : ""}`
    : "commit unknown");
  if (provenance.builtAt) parts.push(`built ${provenance.builtAt}`);
  if (provenance.bundleId) parts.push(`bundle ${provenance.bundleId.slice(0, SHORT_DIGEST_LENGTH)}`);
  return parts.join(", ");
}
