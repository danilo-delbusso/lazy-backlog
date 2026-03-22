import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeVelocity } from "../lib/analytics.js";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { formatTeamInsights } from "../lib/team-insights.js";
import { handlePlanAction } from "./insights-plan.js";
import { loadTeamInsights } from "./issues-helpers.js";
import { handleRetroAction } from "./sprints-retro.js";
import { fetchSprintData } from "./sprints-utils.js";
import { buildSuggestions } from "./suggestions.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleTeamProfile(kb: KnowledgeBase): ToolResponse {
  const insights = loadTeamInsights(kb);
  const teamRules = kb.getTeamRules();

  const hasInsights =
    insights.estimation.length > 0 ||
    insights.ownership.length > 0 ||
    insights.templates.length > 0 ||
    Object.keys(insights.patterns.priorityDistribution).length > 0;

  if (!hasInsights && teamRules.length === 0) {
    return errorResponse(
      "No team profile data. Run configure action='setup' first to analyze your team's completed tickets.",
    );
  }

  const lines: string[] = ["# Team Profile\n"];

  if (hasInsights) {
    lines.push(formatTeamInsights(insights));
  }

  if (teamRules.length > 0) {
    lines.push("\n## Team Conventions\n");
    const byCategory = new Map<string, typeof teamRules>();
    for (const rule of teamRules) {
      const existing = byCategory.get(rule.category) ?? [];
      existing.push(rule);
      byCategory.set(rule.category, existing);
    }
    for (const [category, rules] of byCategory) {
      const label = category.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`### ${label}`);
      for (const r of rules) {
        const conf = Math.round(r.confidence * 100);
        const typeTag = r.issue_type ? ` [${r.issue_type}]` : "";
        lines.push(`- **${r.rule_key}:** ${r.rule_value}${typeTag} (${conf}% confidence, n=${r.sample_size})`);
      }
      lines.push("");
    }
  }

  return textResponse(lines.join("\n"));
}

async function handleEpicProgress(params: { epicKey?: string }, kb: KnowledgeBase): Promise<ToolResponse> {
  if (!params.epicKey) return errorResponse("epicKey is required for 'epic-progress' action.");

  const { jira, config } = buildJiraClient(kb);
  const issues = await jira.getEpicIssues(params.epicKey);
  const spField = jira.storyPointsFieldId;

  let doneCount = 0;
  let inProgressCount = 0;
  let todoCount = 0;
  let totalPoints = 0;
  let completedPoints = 0;
  const remaining: Array<{ key: string; summary: string; status: string }> = [];

  for (const issue of issues) {
    const f = issue.fields as Record<string, unknown>;
    const statusName = issue.fields.status?.name ?? "Unknown";
    const cat = (issue.fields.status?.statusCategory?.name ?? "new").toLowerCase();
    const sp =
      (spField ? (f[spField] as number | undefined) : undefined) ??
      (f.story_points as number | undefined) ??
      (f.customfield_10016 as number | undefined) ??
      0;

    if (cat === "done") {
      doneCount++;
      completedPoints += sp;
    } else if (cat === "indeterminate" || cat === "in progress") {
      inProgressCount++;
      remaining.push({ key: issue.key, summary: issue.fields.summary, status: statusName });
    } else {
      todoCount++;
      remaining.push({ key: issue.key, summary: issue.fields.summary, status: statusName });
    }
    totalPoints += sp;
  }

  const total = issues.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const remainingPoints = totalPoints - completedPoints;

  let out = `# Epic Progress: ${params.epicKey}\n\n`;
  out += `**Total Issues:** ${total} | **Done:** ${doneCount} | **In Progress:** ${inProgressCount} | **To Do:** ${todoCount}\n`;
  out += `**Story Points:** ${totalPoints} total, ${completedPoints} completed, ${remainingPoints} remaining\n`;
  out += `**Completion:** ${pct}%\n`;

  if (remaining.length > 0) {
    out += `\n## Remaining Issues (${remaining.length})\n`;
    for (const r of remaining) {
      out += `- ${r.key} (${r.status}): ${r.summary}\n`;
    }
  }

  // Forecast based on velocity
  if (remainingPoints > 0) {
    const boardId = config.jiraBoardId ?? "";
    if (boardId) {
      try {
        const sprintData = await fetchSprintData(jira, boardId, 5);
        if (sprintData.length > 0) {
          const velocity = computeVelocity(sprintData);
          if (velocity.average > 0) {
            const sprintsRemaining = Math.ceil(remainingPoints / velocity.average);
            const weeksRemaining = sprintsRemaining * 2;
            const estDate = new Date();
            estDate.setDate(estDate.getDate() + weeksRemaining * 7);
            const dateStr = estDate.toISOString().slice(0, 10);

            out += `\n## Forecast\n`;
            out += `**At current velocity (~${Math.round(velocity.average)} SP/sprint), estimated completion in ${sprintsRemaining} sprint${sprintsRemaining === 1 ? "" : "s"} (~${dateStr})**\n`;

            const stddev = Math.sqrt(
              velocity.sprints.reduce((sum, s) => sum + (s.completed - velocity.average) ** 2, 0) /
                velocity.sprints.length,
            );
            if (velocity.trendSlope < -1 || stddev > velocity.average * 0.3) {
              out += "\n> Warning: High uncertainty -- velocity is unstable\n";
            }
          }
        }
      } catch {
        // Velocity data unavailable — skip forecast
      }
    }
  }

  const behindSchedule = remainingPoints > completedPoints;
  const suggestions = buildSuggestions("insights", "epic-progress", { behindSchedule });
  return textResponse(out + suggestions);
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerInsightsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "insights",
    {
      description:
        "Team intelligence and analytics. Use this tool for understanding team performance, patterns, and progress. " +
        "Actions: 'team-profile' — view stored team intelligence from setup: who owns what components, estimation patterns, " +
        "description templates, rework rates, and conventions (zero API calls — reads local analysis). " +
        "'epic-progress' — show epic completion stats with velocity-based forecast. " +
        "'retro' — sprint retrospective data (scope creep, cycle time, workload distribution, carry-over). " +
        "'plan' — sprint planning assistant: velocity, carryover, capacity budget, recommended items from backlog.",
      inputSchema: z.object({
        action: z.enum(["team-profile", "epic-progress", "retro", "plan"]),
        epicKey: z.string().optional().describe("[epic-progress] Epic issue key, e.g. 'BP-100'"),
        sprintId: z.string().optional().describe("[retro] Sprint ID. Omit to use most recent closed sprint"),
        sprintCount: z
          .number()
          .default(5)
          .optional()
          .describe("[retro, plan] Number of past closed sprints to analyze"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "team-profile":
          return handleTeamProfile(kb);

        case "epic-progress":
          return handleEpicProgress(params, kb);

        case "plan":
          return handlePlanAction(params, kb);

        case "retro": {
          const { jira, config } = buildJiraClient(kb);
          const boardId = config.jiraBoardId ?? "";
          return handleRetroAction(params, jira, boardId, jira.storyPointsFieldId);
        }
      }
    },
  );
}
