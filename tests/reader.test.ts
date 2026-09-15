import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeReaderProject,
  readerFileList,
  readerFileRead,
  readerFileSearch,
  readerGitStatus,
} from "../src/reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Reader exposes only an explicitly authorized project", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-reader-test-"));
  const project = join(root, "project");
  const home = join(root, "app");
  roots.push(root);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, "outside.txt"), "private\n");
  const authorized = authorizeReaderProject(project, "Test project", home);
  expect(readerFileList(authorized.id, "", 20, home)).toEqual([
    { path: "src", type: "directory" },
  ]);
  expect(readerFileRead(authorized.id, "src/main.ts", 10_000, home).content).toContain("answer");
  expect(readerFileSearch(authorized.id, "answer", "", 20, home)[0]?.path).toBe("src/main.ts");
  expect(() => readerFileRead(authorized.id, "../outside.txt", 10_000, home)).toThrow("escapes");
  expect(() => readerFileRead("project_not_authorized", "src/main.ts", 10_000, home)).toThrow("not authorized");
});

test("Reader Git status is read-only and scoped to the authorized worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-reader-git-test-"));
  const project = join(root, "project");
  const home = join(root, "app");
  roots.push(root);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "reader\n");
  const authorized = authorizeReaderProject(project, undefined, home);
  expect(() => readerGitStatus(authorized.id, home)).toThrow("not a Git worktree");
});
