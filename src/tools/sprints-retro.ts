import { computeSprintHealth, computeVelocity } from "../lib/analytics.js";
import { errorResponse, textResponse } from "../lib/config.js";
import { groupBy } from "../lib/db.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";
import { fetchSprintData, getStoryPoints } from "./sprints-utils.js";

/** Handle the 'retro' action (comprehensive retrospective data pack). */
export async function handleRetroAction(
  params: {
    sprintId?: string;
    sprintCount?: number;
  },
  jira: JiraClient,
  boardId: string,
  spFieldId: string | undefined,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  let sprintId = params.sprintId;

  if (!sprintId) {
    const closed = await jira.listSprints(boardId, "closed");
    if (closed.length === 0) return errorResponse("No closed sprints found.");
    const latest = closed[closed.length - 1];
    if (!latest) return errorResponse("No closed sprints found.");
    sprintId = String(latest.id);
  }

  const [sprint, sprintIssuesRes] = await Promise.all([jira.getSprint(sprintId), jira.getSprintIssues(sprintId)]);
  const issues = sprintIssuesRes.issues;

  // ── Sprint report data ──
  const completed: SearchIssue[] = [];
  const carryOver: SearchIssue[] = [];
  let totalSP = 0;
  let completedSP = 0;

  for (const issue of issues) {
    const sp = getStoryPoints(issue.fields, spFieldId);
    totalSP += sp;
    const status = (issue.fields.status?.name ?? "").toLowerCase();
    if (status === "done" || status === "closed" || status === "resolved") {
      completed.push(issue);
      completedSP += sp;
    } else {
      carryOver.push(issue);
    }
  }

  const completionRate = totalSP > 0 ? Math.round((completedSP / totalSP) * 100) : 0;
  const completedByType = groupBy(completed, (i) => i.fields.issuetype?.name ?? "Unknown");

  // ── Analytics data (velocity + health) ──
  const sprintIssueData = issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    issueType: i.fields.issuetype?.name || "Unknown",
    status: i.fields.status?.name || "Unknown",
    statusCategory: i.fields.status?.statusCategory?.name,
    storyPoints: getStoryPoints(i.fields, spFieldId) || undefined,
    assignee: (i.fields as Record<string, unknown>).assignee
      ? ((i.fields as Record<string, unknown>).assignee as { displayName?: string })?.displayName
      : undefined,
  }));

  const sprintCount = params.sprintCount ?? 5;
  const historicalData = await fetchSprintData(jira, boardId, sprintCount);
  const velocity = computeVelocity(
    historicalData.length > 0 ? historicalData : [{ id: sprintId, name: sprint.name, issues: sprintIssueData }],
  );
  const health = computeSprintHealth({ id: sprintId, name: sprint.name, issues: sprintIssueData }, velocity.average);

  // ── Cycle time data (inline, from changelog) ──
  const cycleData: { key: string; summary: string; issueType: string; cycleTimeDays: number }[] = [];
  const doneIssueKeys = completed.map((i) => i.key);
  for (const key of doneIssueKeys) {
    try {
      const changelog = await jira.getIssueChangelog(key);
      let startTime: Date | null = null;
      let endTime: Date | null = null;

      for (const entry of changelog) {
        for (const item of entry.items) {
          if (item.field === "status") {
            if (item.toString === "In Progress" && !startTime) {
              startTime = new Date(entry.created);
            }
            if ((item.toString === "Done" || item.toString === "Closed") && !endTime) {
              endTime = new Date(entry.created);
            }
          }
        }
      }

      if (startTime && endTime) {
        const days = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
        const issue = completed.find((i) => i.key === key);
        cycleData.push({
          key,
          summary: issue?.fields.summary ?? key,
          issueType: issue?.fields.issuetype?.name ?? "Unknown",
          cycleTimeDays: Math.round(days * 10) / 10,
        });
      }
    } catch {
      // Skip issues where changelog isn't available
    }
  }

  // ── Bug stats ──
  const bugCount = issues.filter((i) => (i.fields.issuetype?.name ?? "").toLowerCase() === "bug").length;
  const bugRatio = issues.length > 0 ? Math.round((bugCount / issues.length) * 100) : 0;

  // ── Build output ──
  let out = `# Retrospective: ${sprint.name}\n\n`;
  if (sprint.startDate && sprint.endDate) {
    out += `**Period:** ${sprint.startDate.slice(0, 10)} to ${sprint.endDate.slice(0, 10)}\n`;
  }
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;

  out += `\n## Sprint Health: ${health.overall.toUpperCase()}\n\n`;
  out += `- **Completion Rate:** ${completionRate}%\n`;
  out += `- **Velocity:** ${velocity.sprints[0]?.completed ?? completedSP} pts completed\n`;
  out += `- **Average Velocity:** ${velocity.average} pts\n`;
  out += `- **Trend:** ${velocity.trend} (slope: ${velocity.trendSlope})\n`;
  out += `- **Carry-over:** ${carryOver.length} issues\n`;
  out += `- **Bug Ratio:** ${bugRatio}%\n`;

  // Cycle time stats
  if (cycleData.length > 0) {
    const cycleTimes = cycleData.map((d) => d.cycleTimeDays);
    const sorted = [...cycleTimes].sort((a, b) => a - b);
    const pct = (p: number) => {
      const rank = Math.ceil((p / 100) * sorted.length);
      return sorted[Math.max(0, rank - 1)] ?? 0;
    };
    out += `\n## Cycle Time\n\n`;
    out += `**Median:** ${pct(50)} days | **P75:** ${pct(75)} days | **P90:** ${pct(90)} days\n`;
  }

  out += `\n## Summary\n\n`;
  out += `- **Total issues:** ${issues.length}\n`;
  out += `- **Completed:** ${completed.length}\n`;
  out += `- **Carry-over:** ${carryOver.length}\n`;
  out += `- **Total SP:** ${totalSP}\n`;
  out += `- **Completed SP:** ${completedSP}\n`;
  out += `- **Completion rate:** ${completionRate}%\n`;

  if (completedByType.size > 0) {
    out += `\n## Completed by Type\n\n`;
    for (const [type, typeIssues] of completedByType) {
      out += `### ${type} (${typeIssues.length})\n`;
      for (const issue of typeIssues) {
        out += `- ${issue.key}: ${issue.fields.summary}\n`;
      }
      out += "\n";
    }
  }

  if (carryOver.length > 0) {
    out += `## Carry-over Items (${carryOver.length})\n\n`;
    for (const issue of carryOver) {
      out += `- **${issue.key}**: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
    }
    out += "\n";
  }

  out += "## Issue Breakdown\n\n";
  const byType: Record<string, number> = {};
  for (const issue of issues) {
    const type = issue.fields.issuetype?.name ?? "Unknown";
    byType[type] = (byType[type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    out += `- **${type}**: ${count}\n`;
  }

  // ── Scope Creep ──
  if (sprint.startDate) {
    const sprintStart = new Date(sprint.startDate);
    const scopeCreepIssues = issues.filter((i) => {
      const created = i.fields.created;
      if (!created) return false;
      return new Date(created) > sprintStart;
    });
    const scopeCreepPct = issues.length > 0 ? Math.round((scopeCreepIssues.length / issues.length) * 100) : 0;

    out += `\n## Scope Creep\n\n`;
    out += `**Added mid-sprint:** ${scopeCreepIssues.length} of ${issues.length} issues (${scopeCreepPct}%)\n`;
    if (scopeCreepIssues.length > 0) {
      out += "\n";
      for (const issue of scopeCreepIssues) {
        const createdDate = issue.fields.created ? issue.fields.created.slice(0, 10) : "unknown";
        out += `- ${issue.key}: ${issue.fields.summary} (added ${createdDate})\n`;
      }
    }
    out += "\n";
  }

  // ── Time in Status (approximate from created → updated) ──
  if (completed.length > 0) {
    const typeTimings = new Map<string, number[]>();
    for (const issue of completed) {
      const issueType = issue.fields.issuetype?.name ?? "Unknown";
      const created = issue.fields.created;
      const updated = issue.fields.updated;
      if (created && updated) {
        const days = (new Date(updated).getTime() - new Date(created).getTime()) / (1000 * 60 * 60 * 24);
        const timings = typeTimings.get(issueType) ?? [];
        timings.push(Math.round(days * 10) / 10);
        typeTimings.set(issueType, timings);
      }
    }

    if (typeTimings.size > 0) {
      out += `\n## Time in Status\n\n`;
      out += "| Issue Type | Avg Cycle Time (days) | Issues |\n";
      out += "|------------|----------------------|--------|\n";
      for (const [issueType, timings] of typeTimings) {
        const avg = Math.round((timings.reduce((a, b) => a + b, 0) / timings.length) * 10) / 10;
        out += `| ${issueType} | ${avg} | ${timings.length} |\n`;
      }

      // Flag notably slow statuses from cycle time data
      if (cycleData.length > 0) {
        const avgCycle = cycleData.reduce((sum, d) => sum + d.cycleTimeDays, 0) / cycleData.length;
        const slowItems = cycleData.filter((d) => d.cycleTimeDays > avgCycle * 1.5);
        if (slowItems.length > 0) {
          out += `\n**Notably slow items** (>1.5x average cycle time of ${Math.round(avgCycle * 10) / 10} days):\n`;
          for (const item of slowItems) {
            out += `- ${item.key}: ${item.summary} (${item.cycleTimeDays} days, ${item.issueType})\n`;
          }
        }
      }
      out += "\n";
    }
  }

  return textResponse(out);
}
