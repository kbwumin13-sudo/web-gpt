import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { CODEX_READER_CONNECTOR_NAME } from "./config";
import {
  listReaderProjects,
  readerFileList,
  readerFileRead,
  readerFileSearch,
  readerGitStatus,
} from "./reader";
import { VERSION } from "./version";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function registerReaderMcpTools(server: McpServer): void {
  server.registerTool(
    "codex_reader_projects",
    {
      title: "List authorized Codex projects",
      description: "List projects explicitly authorized for read-only local inspection.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ projects: listReaderProjects() }),
  );
  server.registerTool(
    "codex_reader_list_files",
    {
      title: "List project files",
      description: "List files and directories inside an authorized project.",
      inputSchema: {
        project_id: z.string().min(8).max(64),
        path: z.string().max(16_384).optional(),
        max_entries: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, path, max_entries }) => result({ entries: readerFileList(project_id, path, max_entries, undefined) }),
  );
  server.registerTool(
    "codex_reader_read_file",
    {
      title: "Read a project file",
      description: "Read a UTF-8 file inside an authorized project.",
      inputSchema: {
        project_id: z.string().min(8).max(64),
        path: z.string().min(1).max(16_384),
        max_chars: z.number().int().min(1_000).max(500_000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, path, max_chars }) => result(readerFileRead(project_id, path, max_chars, undefined)),
  );
  server.registerTool(
    "codex_reader_search_files",
    {
      title: "Search project files",
      description: "Search text in files inside an authorized project.",
      inputSchema: {
        project_id: z.string().min(8).max(64),
        query: z.string().min(1).max(500),
        path: z.string().max(16_384).optional(),
        max_results: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, query, path, max_results }) => result({ matches: readerFileSearch(project_id, query, path, max_results, undefined) }),
  );
  server.registerTool(
    "codex_reader_git_status",
    {
      title: "Read project Git status",
      description: "Read the branch and working-tree status of an authorized Git project.",
      inputSchema: { project_id: z.string().min(8).max(64) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) => result(readerGitStatus(project_id, undefined)),
  );
}

export async function runReaderMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: CODEX_READER_CONNECTOR_NAME, version: VERSION },
    { instructions: "This connector is read-only. It can access only explicitly authorized projects. It cannot execute commands, write files, or expand its project scope." },
  );
  registerReaderMcpTools(server);
  await server.connect(new StdioServerTransport());
  await new Promise<void>(() => {});
}
