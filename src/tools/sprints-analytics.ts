import { computeCapacity, computeVelocity, type SprintData, type VelocityReport } from "../lib/analytics.js";
import { errorResponse, textResponse } from "../lib/config.js";
import { groupBy } from "../lib/db.js";
import type { JiraClient, JiraSprint, SearchIssue } from "../lib/jira.js";
import { fetchSprintData, getStoryPoints } from "./sprints-utils.js";

/* ------------------------------------------------------------------ */
/*  Velocity helpers                                                   */
/* ------------------------------------------------------------------ */

function buildVelocityHeader(showBugRate: boolean, showScopeChange: boolean): string {
  let header = "| Sprint | Committed | Completed | Rate |";
  let separator = "|--------|-----------|-----------|------|";
  if (showBugRate) {
    header += " Bug Count | Bug Rate |";
    separator += "-----------|----------|";
  }
  if (showScopeChange) {
    header += " Carry-over |";
    separator += "------------|";
  }
  return `${header}\n${separator}\n`;
}

function buildVelocityRow(
  s: SprintData,
  v: VelocityReport["sprints"][number],
  showBugRate: boolean,
  showScopeChange: boolean,
): string {
  const rate = v.committed > 0 ? Math.round((v.completed / v.committed) * 100) : 0;
  let row = `| ${v.sprintName} | ${v.committed} | ${v.completed} | ${rate}% |`;
  if (showBugRate) {
    const bugs = s.issues.filter((i) => i.issueType === "Bug").length;
    const bugRate = s.issues.length > 0 ? Math.round((bugs / s.issues.length) * 100) : 0;
    row += ` ${bugs} | ${bugRate}% |`;
  }
  if (showScopeChange) {
    row += ` ${v.carryOver} |`;
  }
  return row;
}

/** Handle the 'velocity' action. */
export async function handleVelocityAction(
  params: {
    sprintCount?: number;
    trendMetrics?: Array<"velocity" | "bugRate" | "scopeChange">;
  },
  jira: JiraClient,
  boardId: string,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  const sprintCount = params.sprintCount ?? 5;
  const sprintData = await fetchSprintData(jira, boardId, sprintCount);
  if (sprintData.length === 0) {
    return textResponse("# Velocity\n\nNo closed sprints found.");
  }
  const velocity = computeVelocity(sprintData);

  const metrics = params.trendMetrics ?? ["velocity"];
  const showBugRate = metrics.includes("bugRate");
  const showScopeChange = metrics.includes("scopeChange");

  let out = `# Velocity Report (last ${sprintData.length} sprints)\n\n`;
  out += buildVelocityHeader(showBugRate, showScopeChange);

  for (let idx = 0; idx < sprintData.length; idx++) {
    const s = sprintData[idx];
    const v = velocity.sprints[idx];
    if (!s || !v) continue;
    out += `${buildVelocityRow(s, v, showBugRate, showScopeChange)}\n`;
  }
  out += `\n**Average velocity:** ${velocity.average} pts\n`;
  out += `**Trend:** ${velocity.trend} (slope: ${velocity.trendSlope})\n`;
  return textResponse(out);
}

/* ------------------------------------------------------------------ */
/*  Health helpers — types                                             */
/* ------------------------------------------------------------------ */

interface SPBreakdown {
  totalSP: number;
  doneSP: number;
  inProgressSP: number;
  todoSP: number;
  blockerCount: number;
}

type HealthStatus = "healthy" | "at-risk" | "critical";

const HEALTH_INDICATORS: Record<HealthStatus, string> = {
  healthy: "[OK]",
  "at-risk": "[WARNING]",
  critical: "[CRITICAL]",
};

/* ------------------------------------------------------------------ */
/*  Health helpers — pure functions                                     */
/* ------------------------------------------------------------------ */

function statusLower(issue: SearchIssue): string {
  return (issue.fields.status?.name ?? "").toLowerCase();
}

function isDone(status: string): boolean {
  return status === "done" || status === "closed" || status === "resolved";
}

function computeSPBreakdown(issues: SearchIssue[], spFieldId: string | undefined): SPBreakdown {
  let totalSP = 0;
  let doneSP = 0;
  let inProgressSP = 0;
  let todoSP = 0;
  let blockerCount = 0;

  for (const issue of issues) {
    const sp = getStoryPoints(issue.fields, spFieldId);
    totalSP += sp;
    const status = statusLower(issue);
    if (isDone(status)) {
      doneSP += sp;
    } else if (status.includes("progress")) {
      inProgressSP += sp;
    } else {
      todoSP += sp;
    }
    if (status.includes("block")) blockerCount++;
  }
  return { totalSP, doneSP, inProgressSP, todoSP, blockerCount };
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function computeDaysRemaining(endDate: string | undefined): number {
  if (!endDate) return 0;
  const end = new Date(endDate);
  return Math.max(0, Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

function assessHealth(blockerCount: number, daysRemaining: number, donePct: number, todoPct: number): HealthStatus {
  if (blockerCount > 0 || (daysRemaining <= 2 && donePct < 50)) return "critical";
  if (todoPct > 50 || (daysRemaining <= 5 && donePct < 30)) return "at-risk";
  return "healthy";
}

function formatProgressSection(
  sprint: JiraSprint,
  health: HealthStatus,
  daysRemaining: number,
  bp: SPBreakdown,
): string {
  const donePctVal = pct(bp.doneSP, bp.totalSP);
  const inProgressPctVal = pct(bp.inProgressSP, bp.totalSP);
  const todoPctVal = pct(bp.todoSP, bp.totalSP);

  let out = `# Sprint Health: ${sprint.name} ${HEALTH_INDICATORS[health]}\n\n`;
  out += `**State:** ${sprint.state}`;
  if (sprint.endDate) out += ` | **Days remaining:** ${daysRemaining}`;
  out += "\n";
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;
  out += `\n## Progress\n\n`;
  out += `- **Total SP:** ${bp.totalSP}\n`;
  out += `- **Done:** ${bp.doneSP} SP (${donePctVal}%)\n`;
  out += `- **In Progress:** ${bp.inProgressSP} SP (${inProgressPctVal}%)\n`;
  out += `- **To Do:** ${bp.todoSP} SP (${todoPctVal}%)\n`;
  out += `- **Blockers:** ${bp.blockerCount}\n`;
  out += `- **Overall:** ${health}\n`;
  return out;
}

function formatStatusBreakdown(issues: SearchIssue[], spFieldId: string | undefined): string {
  const byStatus = groupBy(issues, (i) => i.fields.status?.name ?? "Unknown");
  let out = `\n## Items by Status\n\n`;
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

function formatRecentlyCompleted(issues: SearchIssue[]): string {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = issues.filter((i) => {
    if (!isDone(statusLower(i))) return false;
    return i.fields.updated ? new Date(i.fields.updated) >= oneDayAgo : false;
  });
  if (recent.length === 0) return "";
  let out = `## Recently Completed (last 24h)\n\n`;
  for (const issue of recent) {
    out += `- ${issue.key}: ${issue.fields.summary}\n`;
  }
  return `${out}\n`;
}

function formatStaleItems(issues: SearchIssue[], staleDays: number): string {
  const staleThreshold = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const stale = issues.filter((i) => {
    if (!statusLower(i).includes("progress")) return false;
    return i.fields.updated ? new Date(i.fields.updated) < staleThreshold : true;
  });
  if (stale.length === 0) return "";
  let out = `## Stale Items (no update in ${staleDays}+ days)\n\n`;
  for (const issue of stale) {
    const lastUpdate = issue.fields.updated ? issue.fields.updated.slice(0, 10) : "unknown";
    out += `- ${issue.key}: ${issue.fields.summary} (last updated: ${lastUpdate})\n`;
  }
  return `${out}\n`;
}

function computeElapsedPct(sprint: JiraSprint): number {
  if (!sprint.startDate || !sprint.endDate) return 0;
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate).getTime();
  const totalDuration = end - start;
  if (totalDuration <= 0) return 0;
  return Math.round(((Date.now() - start) / totalDuration) * 100);
}

function formatAtRiskItems(issues: SearchIssue[], spFieldId: string | undefined, elapsedPct: number): string {
  const atRisk = issues.filter((i) => {
    const status = statusLower(i);
    if (isDone(status)) return false;
    if (getStoryPoints(i.fields, spFieldId) === 0) return true;
    return status.includes("progress") && elapsedPct > 75;
  });
  if (atRisk.length === 0) return "";
  let out = `## At Risk (${atRisk.length})\n\n`;
  for (const issue of atRisk) {
    const reasons: string[] = [];
    if (getStoryPoints(issue.fields, spFieldId) === 0) reasons.push("no story points");
    if (statusLower(issue).includes("progress") && elapsedPct > 75) {
      reasons.push(`sprint ${elapsedPct}% elapsed`);
    }
    out += `- ${issue.key}: ${issue.fields.summary} (${reasons.join(", ")})\n`;
  }
  return `${out}\n`;
}

function capacityRisk(ratio: number): string {
  if (ratio > 1.2) return "HIGH";
  if (ratio > 1) return "MEDIUM";
  return "LOW";
}

function formatCapacitySection(
  issues: SearchIssue[],
  spFieldId: string | undefined,
  sprintId: string,
  sprintName: string,
  historicalData: SprintData[],
): string {
  if (historicalData.length === 0) return "";
  const velocity = computeVelocity(historicalData);
  const currentIssues = issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    issueType: i.fields.issuetype?.name || "Unknown",
    status: i.fields.status?.name || "Unknown",
    statusCategory: i.fields.status?.statusCategory?.name,
    storyPoints: getStoryPoints(i.fields, spFieldId) || undefined,
    assignee: i.fields.assignee?.displayName,
  }));
  const currentSprint: SprintData = { id: sprintId, name: sprintName, issues: currentIssues };
  const capacity = computeCapacity(velocity, currentSprint);
  const risk = capacityRisk(capacity.capacityRatio);

  let out = `\n## Capacity\n\n`;
  out += `**Committed:** ${capacity.committedSP} pts | **Avg Velocity:** ${capacity.velocityAverage} pts\n`;
  out += `**Capacity Ratio:** ${capacity.capacityRatio} | **Risk:** ${risk}\n\n`;
  out += "### Per-Assignee Breakdown\n\n";
  out += "| Assignee | Points | Issues |\n";
  out += "|----------|--------|--------|\n";
  for (const a of capacity.perAssignee) {
    out += `| ${a.name} | ${a.sp} | ${a.issueCount} |\n`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Health — resolve active sprint                                     */
/* ------------------------------------------------------------------ */

async function resolveSprintId(jira: JiraClient, boardId: string, sprintId?: string): Promise<string | null> {
  if (sprintId) return sprintId;
  const active = await jira.listSprints(boardId, "active");
  const current = active[0];
  return current ? String(current.id) : null;
}

/* ------------------------------------------------------------------ */
/*  Health — main handler                                              */
/* ------------------------------------------------------------------ */

/** Handle the 'health' action (with capacity). */
export async function handleHealthAction(
  params: {
    sprintId?: string;
    staleDays?: number;
    sprintCount?: number;
  },
  jira: JiraClient,
  boardId: string,
  spFieldId: string | undefined,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  const sprintId = await resolveSprintId(jira, boardId, params.sprintId);
  if (!sprintId) return errorResponse("No active sprints found.");

  const [sprint, sprintIssuesRes] = await Promise.all([jira.getSprint(sprintId), jira.getSprintIssues(sprintId)]);
  const issues = sprintIssuesRes.issues;

  const bp = computeSPBreakdown(issues, spFieldId);
  const daysRemaining = computeDaysRemaining(sprint.endDate);
  const donePctVal = pct(bp.doneSP, bp.totalSP);
  const todoPctVal = pct(bp.todoSP, bp.totalSP);
  const health = assessHealth(bp.blockerCount, daysRemaining, donePctVal, todoPctVal);
  const elapsedPct = computeElapsedPct(sprint);

  let out = formatProgressSection(sprint, health, daysRemaining, bp);
  out += formatStatusBreakdown(issues, spFieldId);
  out += formatRecentlyCompleted(issues);
  out += formatStaleItems(issues, params.staleDays ?? 3);
  out += formatAtRiskItems(issues, spFieldId, elapsedPct);

  const historicalData = await fetchSprintData(jira, boardId, params.sprintCount ?? 5);
  out += formatCapacitySection(issues, spFieldId, sprintId, sprint.name, historicalData);

  return textResponse(out);
}
