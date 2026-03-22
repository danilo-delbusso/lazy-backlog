import type { SprintData } from "../lib/analytics.js";
import type { JiraClient, JiraSprint, SearchIssue } from "../lib/jira.js";

/** Get story points from an issue's fields (checks common field names + dynamic field ID from schema). */
export function getStoryPoints(fields: SearchIssue["fields"], spFieldId?: string): number {
  const f = fields as Record<string, unknown>;
  const sp =
    (spFieldId ? (f[spFieldId] as number | undefined) : undefined) ??
    (f.story_points as number | undefined) ??
    (f.storyPoints as number | undefined) ??
    (f.customfield_10016 as number | undefined);
  return typeof sp === "number" ? sp : 0;
}

/** Compute story point totals (done / in-progress / todo) for a set of issues. */
export function computeStoryPointTotals(issues: SearchIssue[], spFieldId: string | undefined) {
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

/** Fetch sprint data for the last N closed sprints (for analytics computations). */
export async function fetchSprintData(jira: JiraClient, boardId: string, count: number): Promise<SprintData[]> {
  const closedSprints = await jira.listSprints(boardId, "closed");
  const recent = closedSprints.slice(0, count);
  const sprintDataList: SprintData[] = [];
  for (const sprint of recent) {
    const { issues } = await jira.getSprintIssues(String(sprint.id));
    sprintDataList.push({
      id: String(sprint.id),
      name: sprint.name,
      issues: issues.map((i) => ({
        key: i.key,
        summary: i.fields.summary,
        issueType: i.fields.issuetype?.name || "Unknown",
        status: i.fields.status?.name || "Unknown",
        statusCategory: i.fields.status?.statusCategory?.name,
        storyPoints: getStoryPoints(i.fields, jira.storyPointsFieldId) || undefined,
        assignee: (i.fields as Record<string, unknown>).assignee
          ? ((i.fields as Record<string, unknown>).assignee as { displayName?: string })?.displayName
          : undefined,
      })),
    });
  }
  return sprintDataList;
}

// ── Standup & Release helpers ───────────────────────────────────────────────

/** Parse a `since` parameter: "24h", "48h" → Date, or ISO date string → Date. */
export function parseSinceParam(since: string): Date {
  const hoursMatch = since.match(/^(\d+)h$/i);
  if (hoursMatch) {
    const hours = Number.parseInt(hoursMatch[1] ?? "0", 10);
    return new Date(Date.now() - hours * 60 * 60 * 1000);
  }
  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid 'since' value: "${since}". Use ISO date or hours like "24h".`);
  }
  return parsed;
}

/** Changelog change grouped by assignee for standup. */
export interface StandupChange {
  completed: Array<{ key: string; summary: string }>;
  started: Array<{ key: string; summary: string }>;
  blocked: Array<{ key: string; summary: string }>;
  reassigned: Array<{ key: string; from: string; to: string }>;
}

/** Format per-person standup digest. */
export function formatStandupDigest(
  changesByAssignee: Map<string, StandupChange>,
  newItems: SearchIssue[],
  agingBlockers: SearchIssue[],
  since: Date,
): string {
  let out = `# Standup Digest (since ${since.toISOString().slice(0, 16)})\n\n`;

  if (changesByAssignee.size === 0) {
    out += "_No status changes found in this period._\n";
    return out;
  }

  for (const [assignee, changes] of changesByAssignee) {
    out += `## ${assignee}\n\n`;
    if (changes.completed.length > 0) {
      out += "**Completed:**\n";
      for (const item of changes.completed) out += `- ${item.key}: ${item.summary}\n`;
      out += "\n";
    }
    if (changes.started.length > 0) {
      out += "**Started:**\n";
      for (const item of changes.started) out += `- ${item.key}: ${item.summary}\n`;
      out += "\n";
    }
    if (changes.blocked.length > 0) {
      out += "**Blocked:**\n";
      for (const item of changes.blocked) out += `- ${item.key}: ${item.summary}\n`;
      out += "\n";
    }
    if (changes.reassigned.length > 0) {
      out += "**Reassigned:**\n";
      for (const item of changes.reassigned) out += `- ${item.key}: ${item.from} → ${item.to}\n`;
      out += "\n";
    }
  }

  if (agingBlockers.length > 0) {
    out += "## Aging Blockers (>2 days)\n\n";
    for (const issue of agingBlockers) {
      out += `- ${issue.key}: ${issue.fields.summary}\n`;
    }
    out += "\n";
  }

  if (newItems.length > 0) {
    out += "## New Items Added to Sprint\n\n";
    for (const issue of newItems) {
      out += `- ${issue.key}: ${issue.fields.summary} (created ${issue.fields.created?.slice(0, 10) ?? "unknown"})\n`;
    }
    out += "\n";
  }

  return out;
}

/** Format a closed sprint as release notes. */
export function formatReleaseNotes(sprint: JiraSprint, issues: SearchIssue[], spFieldId: string | undefined): string {
  const totals = computeStoryPointTotals(issues, spFieldId);
  const doneStatuses = new Set(["done", "closed", "resolved"]);

  const completed = issues.filter((i) => doneStatuses.has((i.fields.status?.name ?? "").toLowerCase()));
  const carryOver = issues.filter((i) => !doneStatuses.has((i.fields.status?.name ?? "").toLowerCase()));
  const completedSP = completed.reduce((sum, i) => sum + getStoryPoints(i.fields, spFieldId), 0);
  const completionPct = totals.totalSP > 0 ? Math.round((completedSP / totals.totalSP) * 100) : 0;

  let out = `# Release Notes: ${sprint.name}\n\n`;
  if (sprint.startDate && sprint.endDate) {
    const days = Math.ceil(
      (new Date(sprint.endDate).getTime() - new Date(sprint.startDate).getTime()) / (1000 * 60 * 60 * 24),
    );
    out += `**Period:** ${sprint.startDate.slice(0, 10)} to ${sprint.endDate.slice(0, 10)} (${days} days)\n`;
  }
  out += `**Velocity:** ${completedSP} of ${totals.totalSP} SP completed\n`;
  out += `**Completion:** ${completed.length}/${issues.length} issues done, ${completionPct}% SP completed\n`;
  if (sprint.goal) {
    const goalMet = completionPct >= 80 ? "Likely Met" : "Not Met";
    out += `**Goal:** ${sprint.goal} — ${goalMet}\n`;
  }

  // Group completed by type
  const features = completed.filter((i) => (i.fields.issuetype?.name ?? "").toLowerCase() === "story");
  const bugs = completed.filter((i) => (i.fields.issuetype?.name ?? "").toLowerCase() === "bug");
  const tasks = completed.filter((i) => !["story", "bug"].includes((i.fields.issuetype?.name ?? "").toLowerCase()));

  if (features.length > 0) {
    out += `\n## Features (${features.length})\n\n`;
    for (const i of features) out += `- ${i.key}: ${i.fields.summary}\n`;
  }
  if (bugs.length > 0) {
    out += `\n## Bug Fixes (${bugs.length})\n\n`;
    for (const i of bugs) out += `- ${i.key}: ${i.fields.summary}\n`;
  }
  if (tasks.length > 0) {
    out += `\n## Tasks & Tech Debt (${tasks.length})\n\n`;
    for (const i of tasks) out += `- ${i.key}: ${i.fields.summary}\n`;
  }

  if (carryOver.length > 0) {
    out += `\n## Carryover Items (${carryOver.length})\n\n`;
    for (const i of carryOver) {
      out += `- ${i.key}: ${i.fields.summary} [${i.fields.status?.name ?? "Unknown"}]\n`;
    }
  }

  return out;
}
