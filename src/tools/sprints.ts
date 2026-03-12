import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import { groupBy, type KnowledgeBase } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";
import type { SearchIssue } from "../lib/jira-types.js";
import { handleHealthAction } from "./sprints-analytics.js";
import { handleCreateSprintAction, handleGoalAction, handleMoveIssuesAction } from "./sprints-mutations.js";
import { getStoryPoints } from "./sprints-utils.js";

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export * from "./sprints-analytics.js";
export * from "./sprints-mutations.js";
export * from "./sprints-retro.js";
export * from "./sprints-utils.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSprintRow(s: {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
}): string {
  const start = s.startDate ? s.startDate.slice(0, 10) : "-";
  const end = s.endDate ? s.endDate.slice(0, 10) : "-";
  return `| ${s.id} | ${s.name} | ${s.state} | ${start} | ${end} | ${s.goal || "-"} |\n`;
}

function formatSprintsTable(
  sprints: Array<{ id: number; name: string; state: string; startDate?: string; endDate?: string; goal?: string }>,
): string {
  let out = "# Sprints\n\n";
  out += "| ID | Name | State | Start | End | Goal |\n";
  out += "|----|------|-------|-------|-----|------|\n";
  for (const s of sprints) {
    out += formatSprintRow(s);
  }
  return out;
}

async function handleListAction(
  params: { state?: "active" | "future" | "closed" },
  jira: JiraClient,
  boardId: string | undefined,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  const sprints = params.state
    ? await jira.listSprints(boardId, params.state)
    : [...(await jira.listSprints(boardId, "active")), ...(await jira.listSprints(boardId, "future"))];

  if (sprints.length === 0) return textResponse("No sprints found.");
  return textResponse(formatSprintsTable(sprints));
}

function computeStoryPointTotals(issues: SearchIssue[], spFieldId: string | undefined) {
  let totalSP = 0;
  let doneSP = 0;
  let inProgressSP = 0;

  for (const issue of issues) {
    const sp = getStoryPoints(issue.fields, spFieldId);
    totalSP += sp;
    const status = (issue.fields.status?.name ?? "").toLowerCase();
    if (status === "done" || status === "closed" || status === "resolved") doneSP += sp;
    else if (status.includes("progress")) inProgressSP += sp;
  }

  return { totalSP, doneSP, inProgressSP };
}

function formatSprintHeader(
  sprint: { name: string; state: string; startDate?: string; endDate?: string },
  sprintGoal: string | undefined,
  totals: { totalSP: number; doneSP: number; inProgressSP: number },
): string {
  let out = `# ${sprint.name}\n\n`;
  out += `**State:** ${sprint.state}`;
  if (sprint.startDate) out += ` | **Start:** ${sprint.startDate.slice(0, 10)}`;
  if (sprint.endDate) out += ` | **End:** ${sprint.endDate.slice(0, 10)}`;
  out += "\n";
  if (sprintGoal) out += `**Goal:** ${sprintGoal}\n`;
  out += `\n**Story Points:** ${totals.totalSP} total | ${totals.doneSP} done | ${totals.inProgressSP} in progress\n`;
  return out;
}

function formatIssuesByStatus(byStatus: Map<string, SearchIssue[]>, spFieldId: string | undefined): string {
  let out = "\n## Issues by Status\n\n";
  for (const [status, statusIssues] of byStatus) {
    out += `### ${status} (${statusIssues.length})\n`;
    for (const issue of statusIssues) {
      const sp = getStoryPoints(issue.fields, spFieldId);
      const spLabel = sp ? ` [${sp}pts]` : "";
      out += `- ${issue.key}: ${issue.fields.summary}${spLabel}\n`;
    }
    out += "\n";
  }
  return out;
}

function formatIssuesByAssignee(byAssignee: Map<string, SearchIssue[]>, spFieldId: string | undefined): string {
  let out = "## Per-Assignee Breakdown\n\n";
  for (const [assignee, assigneeIssues] of byAssignee) {
    const assigneeSP = assigneeIssues.reduce((sum, i) => sum + getStoryPoints(i.fields, spFieldId), 0);
    out += `### ${assignee} (${assigneeIssues.length} issues, ${assigneeSP} SP)\n`;
    for (const issue of assigneeIssues) {
      out += `- ${issue.key}: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
    }
    out += "\n";
  }
  return out;
}

async function handleGetAction(params: { sprintId?: string }, jira: JiraClient, spFieldId: string | undefined) {
  if (!params.sprintId) return errorResponse("sprintId is required for 'get' action.");

  const [sprint, sprintDetails, sprintIssuesRes] = await Promise.all([
    jira.getSprint(params.sprintId),
    jira.getSprintDetails(params.sprintId),
    jira.getSprintIssues(params.sprintId),
  ]);
  const issues = sprintIssuesRes.issues;

  const byStatus = groupBy(issues, (i) => i.fields.status?.name ?? "Unknown");
  const byAssignee = groupBy(issues, (i) => i.fields.assignee?.displayName ?? "Unassigned");
  const totals = computeStoryPointTotals(issues, spFieldId);
  const sprintGoal = sprintDetails.goal ?? sprint.goal;

  let out = formatSprintHeader(sprint, sprintGoal, totals);
  out += formatIssuesByStatus(byStatus, spFieldId);
  out += formatIssuesByAssignee(byAssignee, spFieldId);

  return textResponse(out);
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerSprintsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "sprints",
    {
      description:
        "Jira sprint management. Use this tool for sprint CRUD and health checks. Actions: 'list' show sprints (use state='active' for current sprint). 'get' sprint details with full issue breakdown. 'create' a new sprint. 'move-issues' assign issues to a sprint. 'health' active sprint progress, stale items, capacity. 'goal' read or set sprint goal. For velocity, retros, epic progress, and team intelligence use the 'insights' tool. For individual issues use 'issues'. For bug workflows use 'bugs'. For backlog use 'backlog'.",
      inputSchema: z.object({
        action: z.enum(["list", "get", "create", "move-issues", "health", "goal"]),
        state: z.enum(["active", "future", "closed"]).optional().describe("[list] Filter sprints by state"),
        sprintId: z.string().optional().describe("[get, move-issues, health, goal] Sprint ID to operate on"),
        name: z.string().optional().describe("[create] Name for the new sprint"),
        goal: z
          .string()
          .optional()
          .describe("[create, goal] Sprint goal text. For 'goal' action: set this to update, omit to read"),
        startDate: z.string().optional().describe("[create] Sprint start date in ISO format, e.g. '2025-03-15'"),
        endDate: z.string().optional().describe("[create] Sprint end date in ISO format, e.g. '2025-03-29'"),
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[move-issues] Issue keys to move into the sprint, e.g. ['BP-1','BP-2']"),
        staleDays: z
          .number()
          .default(3)
          .optional()
          .describe("[health] Days without update before an in-progress item is flagged as stale"),
      }),
    },
    async (params) => {
      const kb = getKb();
      try {
        const { jira, config } = buildJiraClient(kb);
        const boardId = config.jiraBoardId;
        const spFieldId = jira.storyPointsFieldId;

        switch (params.action) {
          case "list":
            return handleListAction(params, jira, boardId);
          case "get":
            return handleGetAction(params, jira, spFieldId);
          case "create":
            return handleCreateSprintAction(params, jira, boardId ?? "");
          case "move-issues":
            return handleMoveIssuesAction(params, jira);
          case "health":
            return handleHealthAction(params, jira, boardId ?? "", spFieldId);
          case "goal":
            return handleGoalAction(params, jira);
          default:
            return errorResponse(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResponse(`Sprint operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
