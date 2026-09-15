import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outputs = [
  join(root, "dist"),
  join(root, "launcher", "dist"),
  join(root, "launcher", "build"),
  join(root, "launcher", "release"),
  join(root, "launcher", "artifacts"),
];

for (const output of outputs) {
  rmSync(output, { recursive: true, force: true });
  process.stdout.write(`Removed generated output: ${output}\n`);
}
