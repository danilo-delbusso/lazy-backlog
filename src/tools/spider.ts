import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";
import { Spider } from "../lib/indexer.js";

export function registerSpiderTools(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "configure",
    {
      description:
        "Configure project settings for Lazy Backlog. Auth credentials must be set as env vars (ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN). This tool stores project-specific settings like Jira project key, board ID, and Confluence spaces — these persist across sessions.",
      inputSchema: z.object({
        jiraProjectKey: z.string().optional().describe("Jira project key, e.g. BP"),
        jiraBoardId: z.string().optional().describe("Jira board ID, e.g. 266"),
        confluenceSpaces: z
          .array(z.string())
          .optional()
          .describe("Confluence space keys to index, e.g. ['Engineering', 'PM']"),
        rootPageIds: z.array(z.string()).optional().describe("Specific Confluence page IDs to spider from"),
      }),
    },
    async (params) => {
      const kb = getKb();

      if (!process.env.ATLASSIAN_SITE_URL || !process.env.ATLASSIAN_EMAIL || !process.env.ATLASSIAN_API_TOKEN) {
        return errorResponse(
          "Atlassian auth not configured. Set ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN as env vars in your MCP server config.",
        );
      }

      // Merge with existing stored config (only overwrite fields that were provided)
      const existing = kb.getConfig("atlassian");
      let current: Record<string, unknown> = {};
      if (existing) {
        try {
          current = JSON.parse(existing);
        } catch {
          /* fresh start */
        }
      }

      if (params.jiraProjectKey !== undefined) current.jiraProjectKey = params.jiraProjectKey;
      if (params.jiraBoardId !== undefined) current.jiraBoardId = params.jiraBoardId;
      if (params.confluenceSpaces !== undefined) current.confluenceSpaces = params.confluenceSpaces;
      if (params.rootPageIds !== undefined) current.rootPageIds = params.rootPageIds;

      kb.setConfig("atlassian", JSON.stringify(current));

      const parts: string[] = [];
      if (current.jiraProjectKey) parts.push(`Project: ${String(current.jiraProjectKey ?? "")}`);
      if (current.jiraBoardId) parts.push(`Board: ${String(current.jiraBoardId ?? "")}`);
      const spaces = (current.confluenceSpaces as string[])?.join(", ");
      if (spaces) parts.push(`Spaces: ${spaces}`);

      return textResponse(`Saved. ${parts.join(" | ") || "No settings changed."}`);
    },
  );

  server.registerTool(
    "spider",
    {
      description:
        "Crawl and index Confluence pages. Supports incremental sync — only re-indexes changed pages. Use spaceKey for full space, rootPageId for a page tree.",
      inputSchema: z.object({
        spaceKey: z.string().optional().describe("Confluence space key to crawl"),
        rootPageId: z.string().optional().describe("Page ID to crawl from (includes descendants)"),
        maxDepth: z.number().default(10).describe("Max tree depth"),
        maxConcurrency: z.number().default(5).describe("Parallel page fetches (1-10)"),
        includeLabels: z.array(z.string()).default([]).describe("Only pages with these labels"),
        excludeLabels: z.array(z.string()).default([]).describe("Skip pages with these labels"),
      }),
    },
    async (params) => {
      const kb = getKb();
      let config: ReturnType<typeof resolveConfig>;
      try {
        config = resolveConfig(kb);
      } catch (err) {
        return errorResponse(String(err));
      }

      const client = new ConfluenceClient(config);
      const spider = new Spider(client, kb);
      const result = await spider.crawl(params);

      const lines = [`Indexed: ${result.indexed} | Unchanged: ${result.unchanged} | Skipped: ${result.skipped}`];

      if (result.errors.length > 0) {
        lines.push(`Errors (${result.errors.length}):`);
        for (const e of result.errors.slice(0, 5)) lines.push(`  ${e}`);
        if (result.errors.length > 5) lines.push(`  …and ${result.errors.length - 5} more`);
      }

      const stats = kb.getStats();
      const typeBreakdown = Object.entries(stats.byType)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      lines.push(`\nKB total: ${stats.total} pages`, `Types: ${typeBreakdown}`);

      return textResponse(lines.join("\n"));
    },
  );

  server.registerTool(
    "list-spaces",
    { description: "List Confluence spaces accessible to the configured account.", inputSchema: z.object({}) },
    async () => {
      const kb = getKb();
      let config: ReturnType<typeof resolveConfig>;
      try {
        config = resolveConfig(kb);
      } catch (err) {
        return errorResponse(String(err));
      }

      const client = new ConfluenceClient(config);
      const spaces = await client.getSpaces();

      if (spaces.length === 0) return textResponse("No spaces found.");
      const text = spaces.map((s) => `${s.key}: ${s.name} (${s.type})`).join("\n");
      return textResponse(text);
    },
  );

  server.registerTool(
    "rebuild-index",
    {
      description: "Rebuild the FTS5 search index from scratch. Use if search results seem stale or incorrect.",
      inputSchema: z.object({}),
    },
    async () => {
      const kb = getKb();
      kb.rebuildFts();
      const stats = kb.getStats();
      return textResponse(`FTS index rebuilt. ${stats.total} pages indexed.`);
    },
  );
}
