import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

test("an implicit retry cannot leave a durable passed native task report", () => {
  const root = resolve(import.meta.dir, "..");
  const probe = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "acceptance-native-task-order.ts")], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.toString()).toContain('"persisted_status":"failed"');
  expect(probe.stdout.toString()).not.toContain("NATIVE_TASK_OK");
});
