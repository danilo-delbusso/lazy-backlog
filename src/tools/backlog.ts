import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatIssueRow(issue: SearchIssue, spField: string | undefined): string {
  const f = issue.fields as Record<string, unknown>;
  const sp =
    (spField ? (f[spField] as number | undefined) : undefined) ??
    (f.story_points as number | undefined) ??
    (f.customfield_10016 as number | undefined);
  return `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.issuetype?.name ?? "-"} | ${issue.fields.priority?.name ?? "-"} | ${sp ?? "-"} | ${issue.fields.assignee?.displayName || "Unassigned"} |`;
}

// ── Action Handlers ──────────────────────────────────────────────────────────

async function handleList(params: { maxResults?: number }, kb: KnowledgeBase): Promise<ToolResponse> {
  try {
    const { jira, config } = buildJiraClient(kb);
    const boardId = config.jiraBoardId;
    if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

    const result = await jira.getBacklogIssues(boardId, params.maxResults || 50);

    if (result.issues.length === 0) {
      return textResponse("Board backlog is empty.");
    }

    let out = `# Board Backlog (${result.issues.length}/${result.total})\n\n`;
    out += "| Key | Summary | Type | Priority | SP | Assignee |\n";
    out += "|-----|---------|------|----------|----|----------|\n";
    const spField = jira.storyPointsFieldId;
    for (const issue of result.issues) {
      out += `${formatIssueRow(issue, spField)}\n`;
    }
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Backlog failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleSearch(params: { jql?: string; maxResults?: number }, kb: KnowledgeBase): Promise<ToolResponse> {
  if (!params.jql) return errorResponse("jql is required for 'search' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    const boardId = config.jiraBoardId;
    const maxResults = params.maxResults ?? 50;

    let result: { issues: SearchIssue[]; total: number };

    if (boardId) {
      result = await jira.searchBacklogIssues(boardId, params.jql, maxResults);
    } else {
      let jql = params.jql;
      const orderExec = /\s+(ORDER\s+BY\s+[^\n]+)$/i.exec(jql);
      const orderClause = orderExec ? ` ${orderExec[1]}` : " ORDER BY rank ASC";
      const filterPart = orderExec ? jql.slice(0, orderExec.index) : jql;

      const backlogFilter = /\bsprint\s/i.test(filterPart) ? filterPart : `sprint is EMPTY AND (${filterPart})`;

      const projectScoped =
        config.jiraProjectKey && !/\bproject\s*[=!]/i.test(backlogFilter)
          ? `project = ${config.jiraProjectKey} AND (${backlogFilter})`
          : backlogFilter;

      jql = `${projectScoped}${orderClause}`;
      result = await jira.searchIssues(jql, undefined, maxResults);
    }

    if (result.issues.length === 0) {
      return textResponse(`No backlog items found for: \`${params.jql}\``);
    }

    const spField = jira.storyPointsFieldId;
    let out = `# Backlog Search (${result.issues.length}/${result.total})\n\n`;
    out += "| Key | Summary | Type | Priority | SP | Assignee |\n";
    out += "|-----|---------|------|----------|----|----------|\n";
    for (const issue of result.issues) {
      out += `${formatIssueRow(issue, spField)}\n`;
    }
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Backlog search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolvePosition(
  params: { issueKey: string; position: "top" | "bottom" },
  jira: JiraClient,
  boardId: string,
): Promise<ToolResponse | { rankBefore?: string; rankAfter?: string }> {
  if (params.position === "top") {
    const backlog = await jira.getBacklogIssues(boardId, 1);
    if (backlog.issues.length === 0) {
      return textResponse(`Backlog is empty — **${params.issueKey}** is already at the top.`);
    }
    const topKey = backlog.issues[0]?.key;
    if (!topKey || topKey === params.issueKey) {
      return textResponse(`**${params.issueKey}** is already at the top of the backlog.`);
    }
    return { rankBefore: topKey };
  }

  const backlog = await jira.getBacklogIssues(boardId, 1, 0);
  const totalItems = backlog.total;
  if (totalItems === 0) {
    return textResponse(`Backlog is empty — **${params.issueKey}** is already at the bottom.`);
  }
  const lastPage = await jira.getBacklogIssues(boardId, 1, Math.max(0, totalItems - 1));
  const lastKey = lastPage.issues[0]?.key;
  if (!lastKey || lastKey === params.issueKey) {
    return textResponse(`**${params.issueKey}** is already at the bottom of the backlog.`);
  }
  return { rankAfter: lastKey };
}

async function handleRank(
  params: {
    issueKey?: string;
    rankBefore?: string;
    rankAfter?: string;
    position?: "top" | "bottom";
  },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.issueKey) return errorResponse("issueKey is required for 'rank' action.");
  if (!params.rankBefore && !params.rankAfter && !params.position) {
    return errorResponse("rankBefore, rankAfter, or position ('top'/'bottom') is required for 'rank' action.");
  }
  try {
    const { jira, config } = buildJiraClient(kb);

    let rankBefore = params.rankBefore;
    let rankAfter = params.rankAfter;

    if (params.position && !rankBefore && !rankAfter) {
      const boardId = config.jiraBoardId;
      if (!boardId) {
        return errorResponse("Board ID is required for position ranking. Run configure action=discover-jira first.");
      }

      const resolved = await resolvePosition({ issueKey: params.issueKey, position: params.position }, jira, boardId);

      // If it's a ToolResponse (has 'content'), return early
      if ("content" in resolved) return resolved;

      rankBefore = resolved.rankBefore;
      rankAfter = resolved.rankAfter;
    }

    await jira.rankIssue(params.issueKey, {
      ...(rankBefore ? { rankBefore } : {}),
      ...(rankAfter ? { rankAfter } : {}),
    });

    let direction: string;
    if (params.position) {
      direction = `to ${params.position} of backlog`;
    } else {
      direction = rankBefore ? `before ${rankBefore}` : `after ${rankAfter}`;
    }
    return textResponse(`Ranked **${params.issueKey}** ${direction}.`);
  } catch (err: unknown) {
    return errorResponse(`Failed to rank ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerBacklogTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "backlog",
    {
      description:
        "Board backlog management. Actions: 'list' show the board's backlog items via Agile API (board-scoped). 'search' query backlog items via JQL (auto-enforces sprint is EMPTY and project filter). 'rank' reorder backlog items — use position='top'/'bottom' for common operations, or rankBefore/rankAfter for precise placement. To get full details or update a backlog item, use the 'issues' tool with get/update actions.",
      inputSchema: z.object({
        action: z.enum(["list", "search", "rank"]),
        maxResults: z.number().max(100).default(50).optional().describe("[list, search] Max issues to return"),
        jql: z.string().optional().describe("[search] JQL query string (auto-filtered to backlog items)"),
        issueKey: z.string().optional().describe("[rank] Issue key to reorder, e.g. 'BP-42'"),
        rankBefore: z.string().optional().describe("[rank] Rank this issue before the specified issue key"),
        rankAfter: z.string().optional().describe("[rank] Rank this issue after the specified issue key"),
        position: z
          .enum(["top", "bottom"])
          .optional()
          .describe("[rank] Move issue to top or bottom of the backlog. Requires board ID to be configured"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "list":
          return handleList(params, kb);
        case "search":
          return handleSearch(params, kb);
        case "rank":
          return handleRank(params, kb);
        default:
          return errorResponse(`Unknown action: ${params.action}`);
      }
    },
  );
}
