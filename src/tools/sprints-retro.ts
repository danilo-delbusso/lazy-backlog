import { computeSprintHealth, computeVelocity } from "../lib/analytics.js";
import { errorResponse, textResponse } from "../lib/config.js";
import { groupBy } from "../lib/db.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";
import { fetchSprintData, getStoryPoints } from "./sprints-utils.js";

// ── Types ──

interface CycleDataItem {
  key: string;
  summary: string;
  issueType: string;
  cycleTimeDays: number;
}

interface SprintReportData {
  completed: SearchIssue[];
  carryOver: SearchIssue[];
  totalSP: number;
  completedSP: number;
}

const DONE_STATUSES = new Set(["done", "closed", "resolved"]);

// ── Data helpers ──

function classifyIssues(issues: SearchIssue[], spFieldId: string | undefined): SprintReportData {
  const completed: SearchIssue[] = [];
  const carryOver: SearchIssue[] = [];
  let totalSP = 0;
  let completedSP = 0;

  for (const issue of issues) {
    const sp = getStoryPoints(issue.fields, spFieldId);
    totalSP += sp;
    const status = (issue.fields.status?.name ?? "").toLowerCase();
    if (DONE_STATUSES.has(status)) {
      completed.push(issue);
      completedSP += sp;
    } else {
      carryOver.push(issue);
    }
  }

  return { completed, carryOver, totalSP, completedSP };
}

function mapSprintIssueData(issues: SearchIssue[], spFieldId: string | undefined) {
  return issues.map((i) => ({
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
}

async function collectCycleData(completed: SearchIssue[], jira: JiraClient): Promise<CycleDataItem[]> {
  const cycleData: CycleDataItem[] = [];

  for (const issue of completed) {
    try {
      const changelog = await jira.getIssueChangelog(issue.key);
      const times = extractStatusTimes(changelog);
      if (times.startTime && times.endTime) {
        const days = (times.endTime.getTime() - times.startTime.getTime()) / (1000 * 60 * 60 * 24);
        cycleData.push({
          key: issue.key,
          summary: issue.fields.summary ?? issue.key,
          issueType: issue.fields.issuetype?.name ?? "Unknown",
          cycleTimeDays: Math.round(days * 10) / 10,
        });
      }
    } catch {
      // Skip issues where changelog isn't available
    }
  }

  return cycleData;
}

function extractStatusTimes(changelog: { created: string; items: { field: string; toString: string | null }[] }[]) {
  let startTime: Date | null = null;
  let endTime: Date | null = null;

  for (const entry of changelog) {
    for (const item of entry.items) {
      if (item.field !== "status") continue;
      if (item.toString === "In Progress" && !startTime) {
        startTime = new Date(entry.created);
      }
      if ((item.toString === "Done" || item.toString === "Closed") && !endTime) {
        endTime = new Date(entry.created);
      }
    }
  }

  return { startTime, endTime };
}

// ── Output section builders ──

function formatHeader(sprint: { name: string; startDate?: string; endDate?: string; goal?: string }): string {
  let out = `# Retrospective: ${sprint.name}\n\n`;
  if (sprint.startDate && sprint.endDate) {
    out += `**Period:** ${sprint.startDate.slice(0, 10)} to ${sprint.endDate.slice(0, 10)}\n`;
  }
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;
  return out;
}

function formatHealthSection(
  health: { overall: string },
  velocity: { average: number; trend: string; trendSlope: number; sprints: { completed: number }[] },
  completionRate: number,
  completedSP: number,
  carryOverCount: number,
  bugRatio: number,
): string {
  let out = `\n## Sprint Health: ${health.overall.toUpperCase()}\n\n`;
  out += `- **Completion Rate:** ${completionRate}%\n`;
  out += `- **Velocity:** ${velocity.sprints[0]?.completed ?? completedSP} pts completed\n`;
  out += `- **Average Velocity:** ${velocity.average} pts\n`;
  out += `- **Trend:** ${velocity.trend} (slope: ${velocity.trendSlope})\n`;
  out += `- **Carry-over:** ${carryOverCount} issues\n`;
  out += `- **Bug Ratio:** ${bugRatio}%\n`;
  return out;
}

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

function formatCycleTimeSection(cycleData: CycleDataItem[]): string {
  if (cycleData.length === 0) return "";
  const sorted = [...cycleData.map((d) => d.cycleTimeDays)].sort((a, b) => a - b);
  let out = `\n## Cycle Time\n\n`;
  out += `**Median:** ${percentile(sorted, 50)} days | **P75:** ${percentile(sorted, 75)} days | **P90:** ${percentile(sorted, 90)} days\n`;
  return out;
}

function formatSummarySection(
  issueCount: number,
  completedCount: number,
  carryOverCount: number,
  totalSP: number,
  completedSP: number,
  completionRate: number,
): string {
  let out = `\n## Summary\n\n`;
  out += `- **Total issues:** ${issueCount}\n`;
  out += `- **Completed:** ${completedCount}\n`;
  out += `- **Carry-over:** ${carryOverCount}\n`;
  out += `- **Total SP:** ${totalSP}\n`;
  out += `- **Completed SP:** ${completedSP}\n`;
  out += `- **Completion rate:** ${completionRate}%\n`;
  return out;
}

function formatCompletedByType(completedByType: Map<string, SearchIssue[]>): string {
  if (completedByType.size === 0) return "";
  let out = `\n## Completed by Type\n\n`;
  for (const [type, typeIssues] of completedByType) {
    out += `### ${type} (${typeIssues.length})\n`;
    for (const issue of typeIssues) {
      out += `- ${issue.key}: ${issue.fields.summary}\n`;
    }
    out += "\n";
  }
  return out;
}

function formatCarryOver(carryOver: SearchIssue[]): string {
  if (carryOver.length === 0) return "";
  let out = `## Carry-over Items (${carryOver.length})\n\n`;
  for (const issue of carryOver) {
    out += `- **${issue.key}**: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
  }
  out += "\n";
  return out;
}

function formatIssueBreakdown(issues: SearchIssue[]): string {
  let out = "## Issue Breakdown\n\n";
  const byType: Record<string, number> = {};
  for (const issue of issues) {
    const type = issue.fields.issuetype?.name ?? "Unknown";
    byType[type] = (byType[type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    out += `- **${type}**: ${count}\n`;
  }
  return out;
}

function formatScopeCreep(issues: SearchIssue[], sprintStartDate: string | undefined): string {
  if (!sprintStartDate) return "";
  const sprintStart = new Date(sprintStartDate);
  const scopeCreepIssues = issues.filter((i) => {
    const created = i.fields.created;
    return created ? new Date(created) > sprintStart : false;
  });
  const scopeCreepPct = issues.length > 0 ? Math.round((scopeCreepIssues.length / issues.length) * 100) : 0;

  let out = `\n## Scope Creep\n\n`;
  out += `**Added mid-sprint:** ${scopeCreepIssues.length} of ${issues.length} issues (${scopeCreepPct}%)\n`;
  if (scopeCreepIssues.length > 0) {
    out += "\n";
    for (const issue of scopeCreepIssues) {
      const createdDate = issue.fields.created ? issue.fields.created.slice(0, 10) : "unknown";
      out += `- ${issue.key}: ${issue.fields.summary} (added ${createdDate})\n`;
    }
  }
  out += "\n";
  return out;
}

function buildTypeTimings(completed: SearchIssue[]): Map<string, number[]> {
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
  return typeTimings;
}

function formatSlowItems(cycleData: CycleDataItem[]): string {
  if (cycleData.length === 0) return "";
  const avgCycle = cycleData.reduce((sum, d) => sum + d.cycleTimeDays, 0) / cycleData.length;
  const slowItems = cycleData.filter((d) => d.cycleTimeDays > avgCycle * 1.5);
  if (slowItems.length === 0) return "";

  let out = `\n**Notably slow items** (>1.5x average cycle time of ${Math.round(avgCycle * 10) / 10} days):\n`;
  for (const item of slowItems) {
    out += `- ${item.key}: ${item.summary} (${item.cycleTimeDays} days, ${item.issueType})\n`;
  }
  return out;
}

function formatTimeInStatus(completed: SearchIssue[], cycleData: CycleDataItem[]): string {
  if (completed.length === 0) return "";
  const typeTimings = buildTypeTimings(completed);
  if (typeTimings.size === 0) return "";

  let out = `\n## Time in Status\n\n`;
  out += "| Issue Type | Avg Cycle Time (days) | Issues |\n";
  out += "|------------|----------------------|--------|\n";
  for (const [issueType, timings] of typeTimings) {
    const avg = Math.round((timings.reduce((a, b) => a + b, 0) / timings.length) * 10) / 10;
    out += `| ${issueType} | ${avg} | ${timings.length} |\n`;
  }
  out += formatSlowItems(cycleData);
  out += "\n";
  return out;
}

// ── Main handler ──

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
    const latest = closed.at(-1);
    if (!latest) return errorResponse("No closed sprints found.");
    sprintId = String(latest.id);
  }

  const [sprint, sprintIssuesRes] = await Promise.all([jira.getSprint(sprintId), jira.getSprintIssues(sprintId)]);
  const issues = sprintIssuesRes.issues;

  const { completed, carryOver, totalSP, completedSP } = classifyIssues(issues, spFieldId);
  const completionRate = totalSP > 0 ? Math.round((completedSP / totalSP) * 100) : 0;
  const completedByType = groupBy(completed, (i) => i.fields.issuetype?.name ?? "Unknown");

  const sprintIssueData = mapSprintIssueData(issues, spFieldId);
  const sprintCount = params.sprintCount ?? 5;
  const historicalData = await fetchSprintData(jira, boardId, sprintCount);
  const velocity = computeVelocity(
    historicalData.length > 0 ? historicalData : [{ id: sprintId, name: sprint.name, issues: sprintIssueData }],
  );
  const health = computeSprintHealth({ id: sprintId, name: sprint.name, issues: sprintIssueData }, velocity.average);

  const cycleData = await collectCycleData(completed, jira);

  const bugCount = issues.filter((i) => (i.fields.issuetype?.name ?? "").toLowerCase() === "bug").length;
  const bugRatio = issues.length > 0 ? Math.round((bugCount / issues.length) * 100) : 0;

  const out =
    formatHeader(sprint) +
    formatHealthSection(health, velocity, completionRate, completedSP, carryOver.length, bugRatio) +
    formatCycleTimeSection(cycleData) +
    formatSummarySection(issues.length, completed.length, carryOver.length, totalSP, completedSP, completionRate) +
    formatCompletedByType(completedByType) +
    formatCarryOver(carryOver) +
    formatIssueBreakdown(issues) +
    formatScopeCreep(issues, sprint.startDate) +
    formatTimeInStatus(completed, cycleData);

  return textResponse(out);
}
