import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";
import { Spider } from "../lib/indexer.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { adfToText, analyzeBacklog, type TicketData } from "../lib/team-rules.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a schema discovery result into a summary string. */
function formatSchemaResult(schema: JiraSchema): string {
  const types = schema.issueTypes.map((t) => t.name).join(", ");
  const fields = schema.issueTypes.reduce((n, t) => n + t.fields.length, 0);
  const lines = [
    `${schema.projectName} (${schema.projectKey}):`,
    `- ${schema.issueTypes.length} issue types: ${types}`,
    `- ${fields} fields mapped`,
    `- ${schema.priorities.length} priorities`,
  ];
  if (schema.board) {
    lines.push(`- Board: ${schema.board.name} (${schema.board.type})`);
    if (schema.board.teamName) lines.push(`- Team: ${schema.board.teamName}`);
  }
  return lines.join("\n");
}

/** Spider multiple Confluence spaces and return a summary. */
async function spiderSpaces(
  config: ReturnType<typeof resolveConfig>,
  kb: KnowledgeBase,
  spaceKeys: string[],
  maxDepth: number,
): Promise<string> {
  const client = new ConfluenceClient(config);
  const spider = new Spider(client, kb);
  let indexed = 0;
  let unchanged = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const spaceKey of spaceKeys) {
    const r = await spider.crawl({ spaceKey, maxDepth, maxConcurrency: 5, includeLabels: [], excludeLabels: [] });
    indexed += r.indexed;
    unchanged += r.unchanged;
    skipped += r.skipped;
    errors.push(...r.errors);
  }

  const stats = kb.getStats();
  const lines = [
    `Indexed: ${indexed} | Unchanged: ${unchanged} | Skipped: ${skipped}`,
    `KB total: ${stats.total} pages`,
    `Types: ${Object.entries(stats.byType)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`,
  ];
  if (errors.length > 0) lines.push(`Errors: ${errors.length} (first: ${errors[0]})`);
  return lines.join("\n");
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerConfigureTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "configure",
    {
      description:
        "Project configuration. Actions: 'setup' — REQUIRED before using any other tool. Needs projectKey, boardId, and spaceKeys (Confluence). If any are missing, ask the user for ALL THREE before calling. Discovers Jira schema, spiders Confluence pages for context, and learns team conventions from existing tickets. 'set' — save individual settings. 'get' — view current config and setup status. After setup, use 'issues' for issue CRUD, 'bugs' for bug workflows, 'backlog' for backlog management, 'sprints' for sprint ops, 'confluence' for wiki search.",
      inputSchema: z.object({
        action: z.enum(["setup", "set", "get"]),
        // set: save project settings
        jiraProjectKey: z.string().optional().describe("[set] Jira project key, e.g. 'BP'"),
        jiraBoardId: z.string().optional().describe("[set] Jira board ID, e.g. '266'"),
        confluenceSpaces: z
          .array(z.string())
          .optional()
          .describe("[set] Confluence space keys to index, e.g. ['ENG','PM']"),
        rootPageIds: z.array(z.string()).optional().describe("[set] Specific Confluence page IDs to spider from"),
        // setup: all params can be passed directly
        projectKey: z
          .string()
          .optional()
          .describe("[setup] Jira project key (REQUIRED — from env JIRA_PROJECT_KEY or pass here)"),
        boardId: z
          .string()
          .optional()
          .describe("[setup] Jira board ID (optional — from env JIRA_BOARD_ID or pass here)"),
        spaceKeys: z.preprocess(
          (val) => (typeof val === "string" ? JSON.parse(val) : val),
          z
            .array(z.string())
            .optional()
            .describe(
              "[setup] Confluence space keys to spider (from env CONFLUENCE_SPACES or pass here). Omit or pass empty array to skip Confluence",
            ),
        ),
        maxDepth: z.number().default(10).describe("[setup] Max Confluence page tree depth"),
        maxTickets: z.number().default(200).describe("[setup] Max recent tickets to analyze for team conventions"),
        qualityThreshold: z
          .number()
          .default(60)
          .describe("[setup] Min quality score (0-100) for a ticket to be used as a convention pattern"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        // ── set ──────────────────────────────────────────────────────────
        case "set": {
          if (!process.env.ATLASSIAN_SITE_URL || !process.env.ATLASSIAN_EMAIL || !process.env.ATLASSIAN_API_TOKEN) {
            return errorResponse(
              "Atlassian auth not configured. Set ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN as env vars in your MCP server config.",
            );
          }

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
        }

        // ── get ──────────────────────────────────────────────────────────
        case "get": {
          let config: ReturnType<typeof resolveConfig>;
          try {
            config = resolveConfig(kb);
          } catch (err: unknown) {
            return errorResponse(String(err));
          }

          const maskedUrl = config.siteUrl
            .replace(/\/\/(.+?)\./, "//***.")
            .replace(/\.atlassian\.net.*/, ".atlassian.net");
          const lines: string[] = ["# Current Configuration\n"];

          const envOrDb = (envKey: string, value: string | undefined): string => {
            if (process.env[envKey]) return `${value} (env: ${envKey})`;
            return value ? `${value} (SQLite)` : "(not set)";
          };

          lines.push(`**Site URL:** ${maskedUrl} (env: ATLASSIAN_SITE_URL)`);
          lines.push(`**Email:** ${config.email} (env: ATLASSIAN_EMAIL)`);
          lines.push(`**Jira Project Key:** ${envOrDb("JIRA_PROJECT_KEY", config.jiraProjectKey)}`);
          lines.push(`**Jira Board ID:** ${envOrDb("JIRA_BOARD_ID", config.jiraBoardId)}`);
          lines.push(
            `**Confluence Spaces:** ${config.confluenceSpaces.length > 0 ? config.confluenceSpaces.join(", ") : "(none)"}${process.env.CONFLUENCE_SPACES ? " (env: CONFLUENCE_SPACES)" : " (SQLite)"}`,
          );
          lines.push(`**Root Page IDs:** ${config.rootPageIds.length > 0 ? config.rootPageIds.join(", ") : "(none)"}`);

          // Setup status
          const schema = JiraClient.loadSchemaFromDb(kb);
          const stats = kb.getStats();
          const teamRules = kb.getTeamRules();
          lines.push("");
          lines.push("## Setup Status");
          lines.push(
            `**Jira Schema:** ${schema ? `Discovered (${schema.issueTypes.length} types)` : "Not run — use configure action='setup'"}`,
          );
          lines.push(`**Confluence KB:** ${stats.total > 0 ? `${stats.total} pages indexed` : "Empty"}`);
          lines.push(
            `**Team Conventions:** ${teamRules.length > 0 ? `${teamRules.length} rules learned` : "Not analyzed"}`,
          );

          return textResponse(lines.join("\n"));
        }

        // ── setup (all-in-one: Jira schema + Confluence spider + learn team) ──
        case "setup": {
          let config: ReturnType<typeof resolveConfig>;
          try {
            config = resolveConfig(kb);
          } catch (err: unknown) {
            return errorResponse(String(err));
          }

          const output: string[] = ["# Setup Results\n"];
          const projectKey = params.projectKey || config.jiraProjectKey;
          const boardId = params.boardId || config.jiraBoardId;

          // Phase 1: Jira Schema Discovery (required)
          // Check what's missing and ask for everything at once
          const spaces = params.spaceKeys || config.confluenceSpaces || [];
          const missing: string[] = [];
          if (!projectKey) {
            missing.push("1. **projectKey** (REQUIRED): Jira project key — the prefix on ticket IDs, e.g. 'BP', 'ENG'");
          }
          if (!boardId) {
            missing.push(
              "2. **boardId** (recommended): Jira board ID — found in the board URL /board/123. Needed for sprint management",
            );
          }
          if (spaces.length === 0) {
            missing.push(
              "3. **spaceKeys** (recommended): Confluence space keys to spider for project context, e.g. ['ENG','PM']. " +
                "Spidering Confluence is what makes ticket planning context-aware. Say 'none' only if you don't use Confluence",
            );
          }
          if (missing.length > 0 && !projectKey) {
            return errorResponse(
              "Setup needs more info. Ask the user for:\n" +
                missing.join("\n") +
                "\n\nThen call: configure action='setup' projectKey='...' boardId='...' spaceKeys=['...']",
            );
          }

          // After the guard above, projectKey is guaranteed to be defined
          const resolvedProjectKey = projectKey as string;

          let schema: JiraSchema | null = null;
          try {
            schema = await JiraClient.discoverSchema(config, resolvedProjectKey, boardId);
            JiraClient.saveSchemaToDb(kb, schema);
            output.push(`## Jira Schema\n${formatSchemaResult(schema)}\n`);
          } catch (err: unknown) {
            return errorResponse(`Jira discovery failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Phase 2: Confluence Spider
          if (spaces.length > 0) {
            try {
              output.push(`## Confluence\n${await spiderSpaces(config, kb, spaces, params.maxDepth)}\n`);
            } catch (err: unknown) {
              output.push(`## Confluence: FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
            }
          } else {
            output.push(
              "## Confluence\n**Not configured.** Confluence context makes ticket planning much richer. " +
                "To enable, re-run setup with spaceKeys or set the CONFLUENCE_SPACES env var.\n",
            );
          }

          // Phase 3: Learn Team Conventions (auto-runs)
          try {
            const jira = new JiraClient({ ...config, jiraProjectKey: resolvedProjectKey }, schema);
            const jql = `project = ${resolvedProjectKey} AND status in (Done, Closed, Resolved) ORDER BY updated DESC`;
            const extendedFields = [
              "summary",
              "description",
              "status",
              "issuetype",
              "priority",
              "assignee",
              "labels",
              "components",
              "created",
              "updated",
              "resolutiondate",
              "fixVersions",
            ];
            const allTickets: TicketData[] = [];
            let startAt = 0;
            const maxTickets = params.maxTickets || 200;
            const pageSize = Math.min(50, maxTickets);

            while (allTickets.length < maxTickets) {
              const batch = await jira.searchIssues(jql, extendedFields, pageSize, startAt);
              if (batch.issues.length === 0) break;

              for (const issue of batch.issues) {
                const f = issue.fields as Record<string, unknown>;
                const nested = (key: string) => f[key] as Record<string, unknown> | undefined;
                allTickets.push({
                  key: issue.key,
                  summary: String(f.summary || ""),
                  description: adfToText(f.description),
                  issueType: String(nested("issuetype")?.name || "Unknown"),
                  priority: String(nested("priority")?.name || "Medium"),
                  storyPoints: (f.story_points ?? f.storyPoints ?? f.customfield_10016 ?? null) as number | null,
                  labels: (f.labels || []) as string[],
                  components: ((f.components || []) as Array<{ name?: string }>).map((c) => c.name || String(c)),
                  status: String(nested("status")?.name || "Unknown"),
                  assignee: nested("assignee")?.displayName ? String(nested("assignee")?.displayName) : null,
                  created: String(f.created || ""),
                  updated: String(f.updated || ""),
                  resolutionDate: f.resolutiondate ? String(f.resolutiondate) : null,
                  changelog: [],
                });
              }

              startAt += batch.issues.length;
              if (batch.issues.length < pageSize || startAt >= batch.total) break;
            }

            if (allTickets.length > 0) {
              // Enrich with changelogs (bounded concurrency)
              const CONCURRENCY = 5;
              for (let i = 0; i < allTickets.length; i += CONCURRENCY) {
                const clBatch = allTickets.slice(i, i + CONCURRENCY);
                const changelogs = await Promise.all(
                  clBatch.map(async (t) => {
                    try {
                      const entries = await jira.getIssueChangelog(t.key);
                      return entries.flatMap((e) =>
                        e.items.map((item) => ({
                          field: item.field,
                          from: item.fromString,
                          to: item.toString,
                          timestamp: e.created,
                        })),
                      );
                    } catch {
                      return [];
                    }
                  }),
                );
                for (let j = 0; j < clBatch.length; j++) {
                  const ticket = clBatch[j];
                  if (ticket) ticket.changelog = changelogs[j] ?? [];
                }
              }

              const threshold = params.qualityThreshold || 60;
              const result = analyzeBacklog(allTickets, threshold);

              kb.upsertTeamRules(
                result.rules.map((r) => ({
                  category: r.category,
                  rule_key: r.rule_key,
                  issue_type: r.issue_type,
                  rule_value: r.rule_value,
                  confidence: r.confidence,
                  sample_size: r.sample_size,
                })),
              );

              kb.recordAnalysis({
                project_key: resolvedProjectKey,
                tickets_fetched: result.totalTickets,
                tickets_quality_passed: result.qualityPassed,
                quality_threshold: threshold,
                rules_extracted: result.rules.length,
                jql_used: jql,
                analyzed_at: new Date().toISOString(),
              });

              output.push(
                `## Team Conventions\n` +
                  `Analyzed ${result.totalTickets} tickets → ${result.rules.length} rules extracted\n` +
                  `Quality: ${result.qualityPassed}/${result.totalTickets} passed (avg score: ${result.avgQualityScore.toFixed(1)}/100)\n`,
              );
            } else {
              output.push("## Team Conventions\nNo completed tickets found — skipped.\n");
            }
          } catch (err: unknown) {
            output.push(`## Team Conventions: FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
          }

          output.push(
            "---\nSetup complete. You can now use **issues**, **sprints**, **plan**, and **confluence** tools.",
          );
          return textResponse(output.join("\n"));
        }
      }
    },
  );
}
