import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adfToText } from "../lib/adf.js";
import { computeVelocity } from "../lib/analytics.js";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { jaccardSimilarity, tokenize } from "../lib/duplicate-detect.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";
import { fetchSprintData } from "./sprints-utils.js";
import { buildSuggestions } from "./suggestions.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

interface HealthFlags {
  orphan: boolean;
  stale: boolean;
  unestimated: boolean;
  thin: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const STALE_DAYS = 14;
const THIN_THRESHOLD = 100;

function getStoryPoints(issue: SearchIssue, spField: string | undefined): number | undefined {
  const f = issue.fields as Record<string, unknown>;
  return (
    (spField ? (f[spField] as number | undefined) : undefined) ??
    (f.story_points as number | undefined) ??
    (f.customfield_10016 as number | undefined)
  );
}

function computeHealthFlags(issue: SearchIssue, spField: string | undefined): HealthFlags {
  const f = issue.fields as Record<string, unknown>;

  const orphan = f.parent == null;

  const updated = issue.fields.updated;
  let stale = false;
  if (updated) {
    const diffMs = Date.now() - new Date(updated).getTime();
    stale = diffMs > STALE_DAYS * 24 * 60 * 60 * 1000;
  }

  const unestimated = getStoryPoints(issue, spField) == null;

  let thin = false;
  const desc = f.description;
  if (desc == null) {
    thin = true;
  } else if (typeof desc === "string") {
    thin = desc.trim().length < THIN_THRESHOLD;
  } else {
    // ADF object — convert to plain text
    const text = adfToText(desc);
    thin = text.trim().length < THIN_THRESHOLD;
  }

  return { orphan, stale, unestimated, thin };
}

function formatFlagLabels(flags: HealthFlags): string {
  const labels: string[] = [];
  if (flags.orphan) labels.push("orphan");
  if (flags.stale) labels.push("stale");
  if (flags.unestimated) labels.push("unestimated");
  if (flags.thin) labels.push("thin");
  return labels.join(", ");
}

function formatIssueRow(issue: SearchIssue, spField: string | undefined, flags: HealthFlags): string {
  const sp = getStoryPoints(issue, spField);
  const flagStr = formatFlagLabels(flags);
  return `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.issuetype?.name ?? "-"} | ${issue.fields.priority?.name ?? "-"} | ${sp ?? "-"} | ${issue.fields.assignee?.displayName || "Unassigned"} | ${flagStr} |`;
}

function formatIssueTable(
  issues: SearchIssue[],
  spField: string | undefined,
  flagsMap: Map<string, HealthFlags>,
): string {
  let out = "| Key | Summary | Type | Priority | SP | Assignee | Flags |\n";
  out += "|-----|---------|------|----------|----|----------|-------|\n";
  for (const issue of issues) {
    const flags = flagsMap.get(issue.key) ?? { orphan: false, stale: false, unestimated: false, thin: false };
    out += `${formatIssueRow(issue, spField, flags)}\n`;
  }
  return out;
}

function buildHealthSummary(total: number, flagsMap: Map<string, HealthFlags>): string {
  let orphaned = 0;
  let stale = 0;
  let unestimated = 0;
  let thin = 0;
  let healthy = 0;

  for (const flags of flagsMap.values()) {
    const hasAny = flags.orphan || flags.stale || flags.unestimated || flags.thin;
    if (!hasAny) healthy++;
    if (flags.orphan) orphaned++;
    if (flags.stale) stale++;
    if (flags.unestimated) unestimated++;
    if (flags.thin) thin++;
  }

  return `\n## Backlog Health\n${healthy}/${total} items ready (no flags) | ${orphaned} orphaned | ${unestimated} unestimated | ${stale} stale | ${thin} thin descriptions\n`;
}

function detectDuplicates(issues: SearchIssue[]): string {
  const tokenized = issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    tokens: tokenize(issue.fields.summary),
  }));
  const pairs: Array<{ a: string; b: string; summaryA: string; summaryB: string; similarity: number }> = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const itemA = tokenized[i];
      const itemB = tokenized[j];
      if (!itemA || !itemB) continue;
      const sim = jaccardSimilarity(itemA.tokens, itemB.tokens);
      if (sim > 0.4) {
        pairs.push({
          a: itemA.key,
          b: itemB.key,
          summaryA: itemA.summary,
          summaryB: itemB.summary,
          similarity: sim,
        });
      }
    }
  }
  if (pairs.length === 0) return "";

  pairs.sort((a, b) => b.similarity - a.similarity);
  let out = `\n## Potential Duplicates (${pairs.length} pairs)\n\n`;
  out += "| Issue A | Issue B | Overlap |\n";
  out += "|---------|---------|--------|\n";
  for (const p of pairs) {
    out += `| ${p.a}: ${p.summaryA.slice(0, 40)} | ${p.b}: ${p.summaryB.slice(0, 40)} | **${Math.round(p.similarity * 100)}%** |\n`;
  }
  return out;
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

    // Compute health flags for each issue
    const flagsMap = new Map<string, HealthFlags>();
    for (const issue of result.issues) {
      flagsMap.set(issue.key, computeHealthFlags(issue, jira.storyPointsFieldId));
    }

    let out = `# Board Backlog (${result.issues.length}/${result.total})\n\n`;
    out += formatIssueTable(result.issues, jira.storyPointsFieldId, flagsMap);
    out += buildHealthSummary(result.issues.length, flagsMap);

    if (result.issues.length > 1) {
      out += detectDuplicates(result.issues);
    }

    // Aging analysis
    const now = Date.now();
    const buckets = { fresh: 0, recent: 0, aging: 0, stale: 0 };
    for (const issue of result.issues) {
      const created = issue.fields.created ? new Date(issue.fields.created).getTime() : now;
      const days = (now - created) / 86_400_000;
      if (days < 7) buckets.fresh++;
      else if (days < 30) buckets.recent++;
      else if (days < 90) buckets.aging++;
      else buckets.stale++;
    }
    out += `\n**Aging:** <7d: ${buckets.fresh} | 7-30d: ${buckets.recent} | 30-90d: ${buckets.aging} | >90d: ${buckets.stale}`;
    if (buckets.stale > 0) {
      out += `\n${buckets.stale} item${buckets.stale > 1 ? "s have" : " has"} been in backlog >90 days — consider closing or reprioritizing.`;
    }

    const orphanedCount = result.issues.filter((i) => !(i.fields as Record<string, unknown>).parent).length;
    const unestimatedCount = result.issues.filter((i) => {
      const f = i.fields as Record<string, unknown>;
      const sp =
        (jira.storyPointsFieldId ? (f[jira.storyPointsFieldId] as number | undefined) : undefined) ??
        (f.story_points as number | undefined) ??
        (f.customfield_10016 as number | undefined);
      return sp == null;
    }).length;
    const suggestions = buildSuggestions("backlog", "list", { orphanedCount, unestimatedCount });
    return textResponse(out + suggestions);
  } catch (err: unknown) {
    return errorResponse(`Backlog failed: ${err instanceof Error ? err.message : String(err)}`);
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

function describeRankDirection(params: { position?: string; rankBefore?: string; rankAfter?: string }): string {
  if (params.position) return `to ${params.position} of backlog`;
  return params.rankBefore ? `before ${params.rankBefore}` : `after ${params.rankAfter}`;
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
      if ("content" in resolved) return resolved;
      rankBefore = resolved.rankBefore;
      rankAfter = resolved.rankAfter;
    }

    await jira.rankIssue(params.issueKey, {
      ...(rankBefore ? { rankBefore } : {}),
      ...(rankAfter ? { rankAfter } : {}),
    });

    // Rank impact preview: show context about the moved item
    let context = "";
    try {
      const detail = await jira.getIssue(params.issueKey);
      const sp = detail.storyPoints;
      const assignee = detail.assignee ?? "Unassigned";
      context = ` (${detail.issueType}, ${sp != null ? `${sp} SP, ` : ""}${detail.priority} priority, assigned to ${assignee})`;

      // Try velocity % if board configured and story points available
      if (sp != null && config.jiraBoardId) {
        try {
          const sprintData = await fetchSprintData(jira, config.jiraBoardId, 5);
          if (sprintData.length > 0) {
            const velocity = computeVelocity(sprintData);
            if (velocity.average > 0) {
              context += `. If pulled into next sprint: ${Math.round((sp / velocity.average) * 100)}% of velocity (avg ${Math.round(velocity.average)} SP)`;
            }
          }
        } catch {
          /* velocity unavailable — skip */
        }
      }
    } catch {
      /* issue detail unavailable — skip */
    }

    return textResponse(
      `Ranked **${params.issueKey}** ${describeRankDirection({ ...params, rankBefore, rankAfter })}.${context}`,
    );
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
        "Board backlog management with health intelligence. Actions: 'list' shows backlog items with per-item health flags (orphan, stale, unestimated, thin), a health summary, and automatic duplicate detection. 'rank' reorders backlog items — use position='top'/'bottom' for common operations, or rankBefore/rankAfter for precise placement. For JQL-filtered backlog queries, use the 'issues' tool with the 'search' action. To get full details or update a backlog item, use the 'issues' tool with get/update actions.",
      inputSchema: z.object({
        action: z.enum(["list", "rank"]),
        maxResults: z.number().max(100).default(50).optional().describe("[list] Max issues to return"),
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
        case "rank":
          return handleRank(params, kb);
        default:
          return errorResponse(`Unknown action: ${params.action}`);
      }
    },
  );
}
