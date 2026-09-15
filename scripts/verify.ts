import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[]): Promise<boolean> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await child.exited) === 0;
}

// Steps keep running after one fails so a single pass reports every problem. A dependency advisory
// no longer hides the typecheck, test, and release results behind it. Steps that consume an earlier
// step's output declare it in `needs` and are skipped instead of failing for the wrong reason.
const steps: Array<{ name: string; args: string[]; needs?: string }> = [
  { name: "check-version", args: ["run", "check-version"] },
  { name: "audit", args: ["run", "audit"] },
  { name: "launcher:audit", args: ["run", "launcher:audit"] },
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "test", args: ["run", "test"] },
  { name: "launcher:typecheck", args: ["run", "launcher:typecheck"] },
  { name: "launcher:test", args: ["run", "launcher:test"] },
  { name: "launcher:build", args: ["run", "launcher:build"] },
  { name: "runtime-bundle", args: ["run", "scripts/build-runtime-bundle.ts", runtimeBundle] },
  {
    name: "third-party-notices",
    args: [
      "run",
      "scripts/generate-third-party-notices.ts",
      join(scratch, "THIRD_PARTY_NOTICES.txt"),
      "--include-launcher",
    ],
  },
  { name: "smoke-release", args: ["run", "scripts/smoke-release.ts", runtimeBundle], needs: "runtime-bundle" },
];

const results = new Map<string, "passed" | "failed" | "skipped">();
try {
  for (const step of steps) {
    if (step.needs !== undefined && results.get(step.needs) !== "passed") {
      results.set(step.name, "skipped");
      continue;
    }
    results.set(step.name, (await run(step.args)) ? "passed" : "failed");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("\nVerification summary:");
for (const [name, result] of results) console.log(`  ${result.padEnd(7)} ${name}`);

const unresolved = [...results].filter(([, result]) => result !== "passed").map(([name]) => name);
if (unresolved.length > 0) {
  console.error(`\nVerification did not pass: ${unresolved.join(", ")}`);
  process.exit(1);
}
