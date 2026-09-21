import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProvenance,
  describeBuild,
  readWorkingTreeIdentity,
  resetBuildProvenanceCache,
  staleDaemonBuild,
  type BuildProvenance,
} from "../src/build-provenance";
import { VERSION } from "../src/version";

const temporaries: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "build-provenance-"));
  temporaries.push(directory);
  return directory;
}

/** A real repository, because the degraded paths are decided by what Git actually reports. */
function gitRepository(): string {
  const root = temporaryDirectory();
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Build Provenance Test");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git("add", "tracked.txt");
  git("commit", "--quiet", "--no-gpg-sign", "-m", "initial");
  return root;
}

/** The installed layout: `<version>/app/cli.js` beside `<version>/manifest.json`. */
function installedRuntime(manifest: Record<string, unknown>): string {
  const root = temporaryDirectory();
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return appDirectory;
}

afterEach(() => {
  resetBuildProvenanceCache();
  while (temporaries.length > 0) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

test("a clean working tree reports its commit and a dirty one says so", () => {
  const root = gitRepository();
  const clean = readWorkingTreeIdentity(root);
  expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(clean.dirty).toBeFalse();
  expect(Date.parse(clean.builtAt)).not.toBeNaN();

  writeFileSync(join(root, "tracked.txt"), "edited\n");
  const dirty = readWorkingTreeIdentity(root);
  expect(dirty.commit).toBe(clean.commit!);
  expect(dirty.dirty).toBeTrue();
});

test("an untracked file counts as dirty, because a build made from it is not its commit", () => {
  const root = gitRepository();
  writeFileSync(join(root, "untracked.txt"), "new\n");
  expect(readWorkingTreeIdentity(root).dirty).toBeTrue();
});

test("a tree without Git still yields a timestamp instead of nothing", () => {
  const identity = readWorkingTreeIdentity(temporaryDirectory());
  expect(identity.commit).toBeUndefined();
  expect(identity.dirty).toBeUndefined();
  expect(Date.parse(identity.builtAt)).not.toBeNaN();
});

test("a runtime beside its manifest reports the build that produced it", () => {
  const appDirectory = installedRuntime({
    bundleId: "a".repeat(64),
    build: { commit: "b".repeat(40), dirty: false, builtAt: "2026-09-17T04:05:06.000Z" },
  });
  expect(buildProvenance(appDirectory)).toEqual({
    version: VERSION,
    kind: "packaged",
    commit: "b".repeat(40),
    dirty: false,
    builtAt: "2026-09-17T04:05:06.000Z",
    bundleId: "a".repeat(64),
  });
});

test("a run with no manifest is reported as source rather than as an unknown build", () => {
  const provenance = buildProvenance(join(temporaryDirectory(), "app"));
  expect(provenance.kind).toBe("source");
  expect(provenance.builtAt).toBeUndefined();
  expect(provenance.bundleId).toBeUndefined();
});

test("a manifest without a build block still names the bundle it installed", () => {
  const appDirectory = installedRuntime({ bundleId: "c".repeat(64) });
  const provenance = buildProvenance(appDirectory);
  expect(provenance.kind).toBe("packaged");
  expect(provenance.bundleId).toBe("c".repeat(64));
  // No build block means the timestamp would describe this process, not the build, so it is omitted.
  expect(provenance.builtAt).toBeUndefined();
});

test("an unreadable manifest degrades to a packaged build with no identity, not to a crash", () => {
  const root = temporaryDirectory();
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory);
  writeFileSync(join(root, "manifest.json"), "{ not json");
  const provenance = buildProvenance(appDirectory);
  expect(provenance.kind).toBe("packaged");
  expect(provenance.bundleId).toBeUndefined();
});

test("the description carries the commit, dirty flag, build time, and bundle", () => {
  const provenance: BuildProvenance = {
    version: "5.0.7",
    kind: "packaged",
    commit: "0123456789abcdef0123456789abcdef01234567",
    dirty: true,
    builtAt: "2026-09-17T04:05:06.000Z",
    bundleId: "fedcba9876543210".padEnd(64, "0"),
  };
  expect(describeBuild(provenance)).toBe(
    "5.0.7 (packaged), commit 0123456789ab-dirty, built 2026-09-17T04:05:06.000Z, bundle fedcba987654",
  );
});

test("an unknown commit is stated rather than dropped from the description", () => {
  expect(describeBuild({ version: "5.0.7", kind: "source" })).toBe("5.0.7 (source), commit unknown");
});

test("a daemon serving a different bundle than the installed runtime is reported as stale", () => {
  const local: BuildProvenance = { version: VERSION, kind: "packaged", bundleId: "a".repeat(64) };
  const detail = staleDaemonBuild({ bundleId: "b".repeat(64) }, local);
  expect(detail).toContain("bbbbbbbbbbbb");
  expect(detail).toContain("aaaaaaaaaaaa");
  expect(detail).toContain("Restart the daemon");
  expect(staleDaemonBuild({ bundleId: "a".repeat(64) }, local)).toBeUndefined();
});

test("staleness is only decidable when both sides name a bundle", () => {
  const packaged: BuildProvenance = { version: VERSION, kind: "packaged", bundleId: "a".repeat(64) };
  // A source-run doctor has no installed bundle to compare against.
  expect(staleDaemonBuild({ bundleId: "b".repeat(64) }, { version: VERSION, kind: "source" })).toBeUndefined();
  // A daemon older than this field reports no bundle; that is not evidence of staleness.
  expect(staleDaemonBuild(undefined, packaged)).toBeUndefined();
  expect(staleDaemonBuild({}, packaged)).toBeUndefined();
  expect(staleDaemonBuild("not-an-object", packaged)).toBeUndefined();
});
