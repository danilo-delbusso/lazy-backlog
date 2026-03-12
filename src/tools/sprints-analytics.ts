import { computeCapacity, computeVelocity, type SprintData } from "../lib/analytics.js";
import { errorResponse, textResponse } from "../lib/config.js";
import { groupBy } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";
import { fetchSprintData, getStoryPoints } from "./sprints-utils.js";

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

  // Build table header
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
  out += `${header}\n${separator}\n`;

  for (let idx = 0; idx < sprintData.length; idx++) {
    const s = sprintData[idx];
    const v = velocity.sprints[idx];
    if (!s || !v) continue;
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
    out += `${row}\n`;
  }
  out += `\n**Average velocity:** ${velocity.average} pts\n`;
  out += `**Trend:** ${velocity.trend} (slope: ${velocity.trendSlope})\n`;
  return textResponse(out);
}

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

  let sprintId = params.sprintId;

  if (!sprintId) {
    const active = await jira.listSprints(boardId, "active");
    if (active.length === 0) return errorResponse("No active sprints found.");
    const current = active[0];
    if (!current) return errorResponse("No active sprints found.");
    sprintId = String(current.id);
  }

  const [sprint, sprintIssuesRes] = await Promise.all([jira.getSprint(sprintId), jira.getSprintIssues(sprintId)]);
  const issues = sprintIssuesRes.issues;

  let totalSP = 0;
  let doneSP = 0;
  let inProgressSP = 0;
  let todoSP = 0;
  let blockerCount = 0;

  for (const issue of issues) {
    const sp = getStoryPoints(issue.fields, spFieldId);
    totalSP += sp;
    const status = (issue.fields.status?.name ?? "").toLowerCase();
    if (status === "done" || status === "closed" || status === "resolved") {
      doneSP += sp;
    } else if (status.includes("progress")) {
      inProgressSP += sp;
    } else {
      todoSP += sp;
    }
    if (status.includes("block")) blockerCount++;
  }

  const donePct = totalSP > 0 ? Math.round((doneSP / totalSP) * 100) : 0;
  const inProgressPct = totalSP > 0 ? Math.round((inProgressSP / totalSP) * 100) : 0;
  const todoPct = totalSP > 0 ? Math.round((todoSP / totalSP) * 100) : 0;

  let daysRemaining = 0;
  if (sprint.endDate) {
    const end = new Date(sprint.endDate);
    const now = new Date();
    daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  }

  // Health assessment
  let health: "healthy" | "at-risk" | "critical";
  if (blockerCount > 0 || (daysRemaining <= 2 && donePct < 50)) {
    health = "critical";
  } else if (todoPct > 50 || (daysRemaining <= 5 && donePct < 30)) {
    health = "at-risk";
  } else {
    health = "healthy";
  }

  const healthIndicator = health === "healthy" ? "[OK]" : health === "at-risk" ? "[WARNING]" : "[CRITICAL]";

  let out = `# Sprint Health: ${sprint.name} ${healthIndicator}\n\n`;
  out += `**State:** ${sprint.state}`;
  if (sprint.endDate) out += ` | **Days remaining:** ${daysRemaining}`;
  out += "\n";
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;

  out += `\n## Progress\n\n`;
  out += `- **Total SP:** ${totalSP}\n`;
  out += `- **Done:** ${doneSP} SP (${donePct}%)\n`;
  out += `- **In Progress:** ${inProgressSP} SP (${inProgressPct}%)\n`;
  out += `- **To Do:** ${todoSP} SP (${todoPct}%)\n`;
  out += `- **Blockers:** ${blockerCount}\n`;
  out += `- **Overall:** ${health}\n`;

  // Items by status breakdown
  const byStatus = groupBy(issues, (i) => i.fields.status?.name ?? "Unknown");
  out += `\n## Items by Status\n\n`;
  for (const [status, statusIssues] of byStatus) {
    out += `### ${status} (${statusIssues.length})\n`;
    for (const issue of statusIssues) {
      const sp = getStoryPoints(issue.fields, spFieldId);
      const spLabel = sp ? ` [${sp}pts]` : "";
      out += `- ${issue.key}: ${issue.fields.summary}${spLabel}\n`;
    }
    out += "\n";
  }

  // Recently completed (updated to Done in last 24 hours)
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentlyCompleted = issues.filter((i) => {
    const status = (i.fields.status?.name ?? "").toLowerCase();
    if (status !== "done" && status !== "closed" && status !== "resolved") return false;
    const updated = i.fields.updated;
    if (!updated) return false;
    return new Date(updated) >= oneDayAgo;
  });

  if (recentlyCompleted.length > 0) {
    out += `## Recently Completed (last 24h)\n\n`;
    for (const issue of recentlyCompleted) {
      out += `- ${issue.key}: ${issue.fields.summary}\n`;
    }
    out += "\n";
  }

  // Stale items (In Progress but not updated in staleDays)
  const staleDays = params.staleDays ?? 3;
  const staleThreshold = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);
  const staleItems = issues.filter((i) => {
    const status = (i.fields.status?.name ?? "").toLowerCase();
    if (!status.includes("progress")) return false;
    const updated = i.fields.updated;
    if (!updated) return true;
    return new Date(updated) < staleThreshold;
  });

  if (staleItems.length > 0) {
    out += `## Stale Items (no update in ${staleDays}+ days)\n\n`;
    for (const issue of staleItems) {
      const lastUpdate = issue.fields.updated ? issue.fields.updated.slice(0, 10) : "unknown";
      out += `- ${issue.key}: ${issue.fields.summary} (last updated: ${lastUpdate})\n`;
    }
    out += "\n";
  }

  // At risk: no story points, or in progress but sprint >75% elapsed
  let sprintElapsedPct = 0;
  if (sprint.startDate && sprint.endDate) {
    const start = new Date(sprint.startDate).getTime();
    const end = new Date(sprint.endDate).getTime();
    const totalDuration = end - start;
    if (totalDuration > 0) {
      sprintElapsedPct = Math.round(((now.getTime() - start) / totalDuration) * 100);
    }
  }

  const atRiskItems = issues.filter((i) => {
    const status = (i.fields.status?.name ?? "").toLowerCase();
    if (status === "done" || status === "closed" || status === "resolved") return false;
    const sp = getStoryPoints(i.fields, spFieldId);
    if (sp === 0) return true;
    if (status.includes("progress") && sprintElapsedPct > 75) return true;
    return false;
  });

  if (atRiskItems.length > 0) {
    out += `## At Risk (${atRiskItems.length})\n\n`;
    for (const issue of atRiskItems) {
      const sp = getStoryPoints(issue.fields, spFieldId);
      const reasons: string[] = [];
      if (sp === 0) reasons.push("no story points");
      const status = (issue.fields.status?.name ?? "").toLowerCase();
      if (status.includes("progress") && sprintElapsedPct > 75) {
        reasons.push(`sprint ${sprintElapsedPct}% elapsed`);
      }
      out += `- ${issue.key}: ${issue.fields.summary} (${reasons.join(", ")})\n`;
    }
    out += "\n";
  }

  // Capacity section — fetch historical velocity and compute capacity
  const sprintCount = params.sprintCount ?? 5;
  const historicalData = await fetchSprintData(jira, boardId, sprintCount);
  if (historicalData.length > 0) {
    const velocity = computeVelocity(historicalData);
    const currentIssues = issues.map((i) => ({
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
    const currentSprint: SprintData = {
      id: sprintId,
      name: sprint.name,
      issues: currentIssues,
    };
    const capacity = computeCapacity(velocity, currentSprint);
    const risk = capacity.capacityRatio > 1.2 ? "HIGH" : capacity.capacityRatio > 1.0 ? "MEDIUM" : "LOW";

    out += `\n## Capacity\n\n`;
    out += `**Committed:** ${capacity.committedSP} pts | **Avg Velocity:** ${capacity.velocityAverage} pts\n`;
    out += `**Capacity Ratio:** ${capacity.capacityRatio} | **Risk:** ${risk}\n\n`;
    out += "### Per-Assignee Breakdown\n\n";
    out += "| Assignee | Points | Issues |\n";
    out += "|----------|--------|--------|\n";
    for (const a of capacity.perAssignee) {
      out += `| ${a.name} | ${a.sp} | ${a.issueCount} |\n`;
    }
  }

  return textResponse(out);
}
