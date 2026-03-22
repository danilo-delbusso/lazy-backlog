import { errorResponse, textResponse } from "../lib/config.js";
import { groupBy } from "../lib/db.js";
import type { ChangelogEntry, JiraClient, JiraSprint, SearchIssue } from "../lib/jira.js";
import {
  assessHealth,
  computeDaysRemaining,
  computeElapsedPct,
  computeSPBreakdown,
  formatAtRiskItems,
  formatCapacitySection,
  formatProgressSection,
  formatRecentlyCompleted,
  formatStaleItems,
  pct,
  resolveSprintId,
} from "./sprints-analytics.js";
import {
  computeStoryPointTotals,
  fetchSprintData,
  formatReleaseNotes,
  formatStandupDigest,
  getStoryPoints,
  parseSinceParam,
  type StandupChange,
} from "./sprints-utils.js";

/* ------------------------------------------------------------------ */
/*  Active sprint — Full Dashboard                                     */
/* ------------------------------------------------------------------ */

function formatSprintHeader(
  sprint: JiraSprint,
  totals: { totalSP: number; doneSP: number; inProgressSP: number },
): string {
  let out = `# ${sprint.name}\n\n`;
  out += `**State:** ${sprint.state}`;
  if (sprint.startDate) out += ` | **Start:** ${sprint.startDate.slice(0, 10)}`;
  if (sprint.endDate) out += ` | **End:** ${sprint.endDate.slice(0, 10)}`;
  out += "\n";
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;
  out += `\n**Story Points:** ${totals.totalSP} total | ${totals.doneSP} done | ${totals.inProgressSP} in progress\n`;
  const donePct = totals.totalSP > 0 ? Math.round((totals.doneSP / totals.totalSP) * 100) : 0;
  out += `**Progress:** ${totals.doneSP} of ${totals.totalSP} SP done (${donePct}%)\n`;
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
  let out = "## Per-Assignee Workload\n\n";
  for (const [assignee, assigneeIssues] of byAssignee) {
    const assigneeSP = assigneeIssues.reduce((sum, i) => sum + getStoryPoints(i.fields, spFieldId), 0);
    const inProgress = assigneeIssues.filter((i) =>
      (i.fields.status?.name ?? "").toLowerCase().includes("progress"),
    ).length;
    out += `### ${assignee} (${assigneeSP} SP, ${inProgress} in progress)\n`;
    for (const issue of assigneeIssues) {
      out += `- ${issue.key}: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
    }
    out += "\n";
  }
  return out;
}

function formatBlockers(issues: SearchIssue[]): string {
  const blockers = issues.filter((i) => {
    const status = (i.fields.status?.name ?? "").toLowerCase();
    return status.includes("block");
  });
  if (blockers.length === 0) return "";
  let out = "## Blockers\n\n";
  for (const issue of blockers) {
    out += `- ${issue.key}: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
  }
  return `${out}\n`;
}

async function buildActiveDashboard(
  sprint: JiraSprint,
  issues: SearchIssue[],
  spFieldId: string | undefined,
  staleDays: number,
  jira: JiraClient,
  boardId: string,
): Promise<string> {
  const totals = computeStoryPointTotals(issues, spFieldId);
  const byStatus = groupBy(issues, (i) => i.fields.status?.name ?? "Unknown");
  const byAssignee = groupBy(issues, (i) => i.fields.assignee?.displayName ?? "Unassigned");

  // Health computation
  const bp = computeSPBreakdown(issues, spFieldId);
  const daysRemaining = computeDaysRemaining(sprint.endDate);
  const donePctVal = pct(bp.doneSP, bp.totalSP);
  const todoPctVal = pct(bp.todoSP, bp.totalSP);
  const health = assessHealth(bp.blockerCount, daysRemaining, donePctVal, todoPctVal);
  const elapsedPct = computeElapsedPct(sprint);

  let out = formatSprintHeader(sprint, totals);
  out += formatProgressSection(sprint, health, daysRemaining, bp);
  out += formatBlockers(issues);
  out += formatIssuesByStatus(byStatus, spFieldId);
  out += formatIssuesByAssignee(byAssignee, spFieldId);
  out += formatStaleItems(issues, staleDays);
  out += formatRecentlyCompleted(issues);
  out += formatAtRiskItems(issues, spFieldId, elapsedPct);

  const historicalData = await fetchSprintData(jira, boardId, 5);
  out += formatCapacitySection(issues, spFieldId, String(sprint.id), sprint.name, historicalData);

  return out;
}

/* ------------------------------------------------------------------ */
/*  Active sprint + since — Standup Mode                               */
/* ------------------------------------------------------------------ */

const DONE_STATUSES = new Set(["done", "closed", "resolved"]);
const BLOCKED_STATUSES = ["block", "impediment"];

function isBlockedStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return BLOCKED_STATUSES.some((s) => lower.includes(s));
}

async function buildStandupDigest(
  sprint: JiraSprint,
  issues: SearchIssue[],
  since: Date,
  jira: JiraClient,
): Promise<string> {
  const changesByAssignee = new Map<string, StandupChange>();

  const getOrCreate = (assignee: string): StandupChange => {
    let entry = changesByAssignee.get(assignee);
    if (!entry) {
      entry = { completed: [], started: [], blocked: [], reassigned: [] };
      changesByAssignee.set(assignee, entry);
    }
    return entry;
  };

  // Process changelog for each issue
  for (const issue of issues) {
    let changelog: ChangelogEntry[];
    try {
      changelog = await jira.getIssueChangelog(issue.key);
    } catch {
      continue;
    }

    const assignee = issue.fields.assignee?.displayName ?? "Unassigned";

    for (const entry of changelog) {
      const entryDate = new Date(entry.created);
      if (entryDate < since) continue;

      for (const item of entry.items) {
        if (item.field === "status") {
          const toStatus = item.toString ?? "";
          if (DONE_STATUSES.has(toStatus.toLowerCase())) {
            getOrCreate(assignee).completed.push({ key: issue.key, summary: issue.fields.summary });
          } else if (toStatus.toLowerCase().includes("progress")) {
            getOrCreate(assignee).started.push({ key: issue.key, summary: issue.fields.summary });
          } else if (isBlockedStatus(toStatus)) {
            getOrCreate(assignee).blocked.push({ key: issue.key, summary: issue.fields.summary });
          }
        }
        if (item.field === "assignee") {
          const from = item.fromString ?? "Unassigned";
          const to = item.toString ?? "Unassigned";
          getOrCreate(to).reassigned.push({ key: issue.key, from, to });
        }
      }
    }
  }

  // Aging blockers: blocked for >2 days
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const agingBlockers = issues.filter((i) => {
    const status = (i.fields.status?.name ?? "").toLowerCase();
    if (!isBlockedStatus(status)) return false;
    return i.fields.updated ? new Date(i.fields.updated) < twoDaysAgo : true;
  });

  // New items added since
  const newItems = issues.filter((i) => {
    const created = i.fields.created;
    return created ? new Date(created) > since : false;
  });

  let out = `# ${sprint.name}\n\n`;
  out += formatStandupDigest(changesByAssignee, newItems, agingBlockers, since);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Closed sprint — Release Notes                                      */
/* ------------------------------------------------------------------ */

function buildClosedView(sprint: JiraSprint, issues: SearchIssue[], spFieldId: string | undefined): string {
  return formatReleaseNotes(sprint, issues, spFieldId);
}

/* ------------------------------------------------------------------ */
/*  Future sprint — Basic Info                                         */
/* ------------------------------------------------------------------ */

function buildFutureView(sprint: JiraSprint, issues: SearchIssue[], spFieldId: string | undefined): string {
  const totals = computeStoryPointTotals(issues, spFieldId);
  let out = `# ${sprint.name} (Future)\n\n`;
  if (sprint.startDate) out += `**Planned Start:** ${sprint.startDate.slice(0, 10)}\n`;
  if (sprint.endDate) out += `**Planned End:** ${sprint.endDate.slice(0, 10)}\n`;
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;
  out += `\n**Planned Issues:** ${issues.length}\n`;
  out += `**Total SP:** ${totals.totalSP}\n`;

  if (issues.length > 0) {
    out += "\n## Planned Items\n\n";
    for (const issue of issues) {
      const sp = getStoryPoints(issue.fields, spFieldId);
      const spLabel = sp ? ` [${sp}pts]` : "";
      out += `- ${issue.key}: ${issue.fields.summary}${spLabel}\n`;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

/** Context-adaptive sprint get: dashboard, standup, release notes, or future view. */
export async function handleSmartGetAction(
  params: {
    sprintId?: string;
    since?: string;
    staleDays?: number;
  },
  jira: JiraClient,
  boardId: string,
  spFieldId: string | undefined,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  const sprintId = await resolveSprintId(jira, boardId, params.sprintId);
  if (!sprintId) return errorResponse("No active sprints found. Provide a sprintId.");

  const [sprint, sprintIssuesRes] = await Promise.all([jira.getSprint(sprintId), jira.getSprintIssues(sprintId)]);
  const issues = sprintIssuesRes.issues;

  // Route based on sprint state
  if (sprint.state === "closed") {
    return textResponse(buildClosedView(sprint, issues, spFieldId));
  }

  if (sprint.state === "future") {
    return textResponse(buildFutureView(sprint, issues, spFieldId));
  }

  // Active sprint
  if (params.since) {
    let sinceDate: Date;
    try {
      sinceDate = parseSinceParam(params.since);
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : String(err));
    }
    const out = await buildStandupDigest(sprint, issues, sinceDate, jira);
    return textResponse(out);
  }

  // Full dashboard
  const staleDays = params.staleDays ?? 3;
  const out = await buildActiveDashboard(sprint, issues, spFieldId, staleDays, jira, boardId);
  return textResponse(out);
}
