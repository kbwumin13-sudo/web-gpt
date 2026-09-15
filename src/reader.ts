import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getConfigDir, atomicWriteFile } from "./config";

export interface ReaderProject {
  id: string;
  name: string;
  root: string;
}

interface ReaderState {
  version: 1;
  projects: ReaderProject[];
}

function statePath(home = getConfigDir()): string {
  return join(home, "reader", "projects.json");
}

function projectId(root: string): string {
  return `project_${createHash("sha256").update(root).digest("hex").slice(0, 20)}`;
}

function readState(home = getConfigDir()): ReaderState {
  const path = statePath(home);
  if (!existsSync(path)) return { version: 1, projects: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReaderState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.projects)) throw new Error(`Invalid Reader project state: ${path}`);
  const projects = parsed.projects.filter((project): project is ReaderProject => (
    Boolean(project)
    && typeof project === "object"
    && typeof project.id === "string"
    && /^[A-Za-z0-9_-]{8,64}$/.test(project.id)
    && typeof project.name === "string"
    && project.name.length <= 120
    && typeof project.root === "string"
    && resolve(project.root) === project.root
  ));
  if (projects.length !== parsed.projects.length) throw new Error(`Invalid Reader project entry: ${path}`);
  return { version: 1, projects };
}

function writeState(state: ReaderState, home = getConfigDir()): void {
  const path = statePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function canonicalDirectory(root: string): string {
  if (!root || !resolve(root)) throw new Error("Reader project path is required");
  const resolved = resolve(root);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Reader project path must be a regular directory");
  return realpathSync.native(resolved);
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function projectForId(id: string, home = getConfigDir()): ReaderProject {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("Reader project_id is invalid");
  const project = readState(home).projects.find(candidate => candidate.id === id);
  if (!project) throw new Error("Reader project is not authorized");
  const canonical = canonicalDirectory(project.root);
  if (canonical !== project.root) throw new Error("Reader project root changed; reauthorize the project");
  return project;
}

function projectPath(project: ReaderProject, path = ""): string {
  if (path.includes("\0") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error("Reader paths must be relative to the authorized project");
  }
  const candidate = resolve(project.root, path || ".");
  if (!inside(candidate, project.root)) throw new Error("Reader path escapes the authorized project");
  let canonical: string;
  try {
    canonical = realpathSync.native(candidate);
  } catch {
    throw new Error("Reader path does not exist");
  }
  if (!inside(canonical, project.root)) throw new Error("Reader path escapes the authorized project");
  return canonical;
}

function ignoredDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "dist" || name === "build" || name === ".next";
}

export function listReaderProjects(home = getConfigDir()): ReaderProject[] {
  return readState(home).projects.map(project => ({ ...project }));
}

export function authorizeReaderProject(root: string, name = basename(resolve(root)), home = getConfigDir()): ReaderProject {
  const canonical = canonicalDirectory(root);
  const state = readState(home);
  const existing = state.projects.find(project => project.root === canonical);
  if (existing) return { ...existing };
  if (!name.trim() || name.length > 120) throw new Error("Reader project name is invalid");
  const project = { id: projectId(canonical), name: name.trim(), root: canonical };
  writeState({ version: 1, projects: [...state.projects, project] }, home);
  return project;
}

export function revokeReaderProject(id: string, home = getConfigDir()): void {
  const state = readState(home);
  const next = state.projects.filter(project => project.id !== id);
  if (next.length === state.projects.length) throw new Error("Reader project is not authorized");
  writeState({ version: 1, projects: next }, home);
}

export function readerFileList(
  projectIdValue: string,
  path = "",
  maxEntries = 200,
  home = getConfigDir(),
): Array<{ path: string; type: "file" | "directory" }> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) throw new Error("max_entries must be 1..1000");
  const project = projectForId(projectIdValue, home);
  const directory = projectPath(project, path);
  if (!lstatSync(directory).isDirectory()) throw new Error("Reader list path must be a directory");
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.isSymbolicLink() && !ignoredDirectory(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, maxEntries)
    .map(entry => ({
      path: relative(project.root, join(directory, entry.name)) || entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
}

export function readerFileRead(
  projectIdValue: string,
  path: string,
  maxChars = 100_000,
  home = getConfigDir(),
): { path: string; content: string; truncated: boolean } {
  if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > 500_000) throw new Error("max_chars must be 1000..500000");
  const project = projectForId(projectIdValue, home);
  const file = projectPath(project, path);
  if (!lstatSync(file).isFile()) throw new Error("Reader path must be a file");
  const content = readFileSync(file, "utf8");
  return { path: relative(project.root, file), content: content.slice(0, maxChars), truncated: content.length > maxChars };
}

export function readerFileSearch(
  projectIdValue: string,
  query: string,
  path = "",
  maxResults = 50,
  home = getConfigDir(),
): Array<{ path: string; line: number; text: string }> {
  if (!query.trim() || query.length > 500) throw new Error("query must be 1..500 characters");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new Error("max_results must be 1..200");
  const project = projectForId(projectIdValue, home);
  const start = projectPath(project, path);
  const results: Array<{ path: string; line: number; text: string }> = [];
  const visit = (directory: string): void => {
    if (results.length >= maxResults) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || ignoredDirectory(entry.name)) continue;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && lstatSync(candidate).size <= 2_000_000) {
        let content: string;
        try { content = readFileSync(candidate, "utf8"); } catch { continue; }
        if (content.includes("\0")) continue;
        content.split(/\r?\n/).forEach((line, index) => {
          if (results.length < maxResults && line.toLowerCase().includes(query.toLowerCase())) {
            results.push({ path: relative(project.root, candidate), line: index + 1, text: line.slice(0, 2_000) });
          }
        });
      }
      if (results.length >= maxResults) return;
    }
  };
  if (lstatSync(start).isDirectory()) visit(start);
  else throw new Error("Reader search path must be a directory");
  return results;
}

export function readerGitStatus(projectIdValue: string, home = getConfigDir()): { branch: string; status: string } {
  const project = projectForId(projectIdValue, home);
  try {
    const output = execFileSync("git", ["-C", project.root, "status", "--short", "--branch"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 100_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = output.trimEnd().split(/\r?\n/).filter(Boolean);
    return { branch: lines.find(line => line.startsWith("## "))?.slice(3) ?? "unknown", status: lines.filter(line => !line.startsWith("## ")).join("\n") };
  } catch {
    throw new Error("Authorized Reader project is not a Git worktree");
  }
}

export function readerStatePath(home = getConfigDir()): string {
  return statePath(home);
}

export function removeReaderState(home = getConfigDir()): void {
  rmSync(statePath(home), { force: true });
}
