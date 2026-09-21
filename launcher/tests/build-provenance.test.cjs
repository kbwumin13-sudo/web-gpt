const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installedBuildProvenance } = require("../electron/runtime-install.cjs");

function runtimeRoot(manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-build-provenance-"));
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(root, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("an installed runtime reports the build and bundle it was produced from", () => {
  const root = runtimeRoot({
    bundleId: "a".repeat(64),
    build: { commit: "b".repeat(40), dirty: false, builtAt: "2026-09-17T04:05:06.000Z" },
  });
  assert.deepEqual(installedBuildProvenance(root), {
    commit: "b".repeat(40),
    dirty: false,
    builtAt: "2026-09-17T04:05:06.000Z",
    bundleId: "a".repeat(64),
  });
});

test("a manifest predating the build block still names its bundle", () => {
  const root = runtimeRoot({ bundleId: "c".repeat(64) });
  assert.deepEqual(installedBuildProvenance(root), { bundleId: "c".repeat(64) });
});

test("provenance is diagnostic, so a missing or unreadable manifest yields null instead of throwing", () => {
  assert.equal(installedBuildProvenance(runtimeRoot()), null);
  assert.equal(installedBuildProvenance(runtimeRoot("{ not json")), null);
  assert.equal(installedBuildProvenance(runtimeRoot({})), null);
});

test("an unpackaged launcher has no installed runtime to describe", () => {
  // `ensurePackagedRuntime` returns null outside a packaged app; that must not become a crash.
  assert.equal(installedBuildProvenance(null), null);
  assert.equal(installedBuildProvenance(""), null);
  assert.equal(installedBuildProvenance(undefined), null);
});

test("malformed build fields are dropped rather than reported as the build", () => {
  const root = runtimeRoot({ bundleId: "d".repeat(64), build: { commit: 42, dirty: "yes", builtAt: null } });
  assert.deepEqual(installedBuildProvenance(root), { bundleId: "d".repeat(64) });
});
