import { errorResponse, textResponse } from "../lib/config.js";
import type { JiraClient } from "../lib/jira.js";

/** Handle the 'create' action (create a new sprint). */
export async function handleCreateSprintAction(
  params: {
    name?: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  },
  jira: JiraClient,
  boardId: string,
) {
  if (!params.name) return errorResponse("name is required for 'create' action.");
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  const created = await jira.createSprint(boardId, params.name, {
    goal: params.goal,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  // If a goal was provided, also call updateSprint to ensure it's set
  if (params.goal) {
    await jira.updateSprint(String(created.id), { goal: params.goal });
  }

  let out = `# Sprint Created\n\n`;
  out += `**ID:** ${created.id}\n`;
  out += `**Name:** ${created.name}\n`;
  out += `**State:** ${created.state}\n`;
  if (params.goal || created.goal) out += `**Goal:** ${params.goal || created.goal}\n`;
  if (created.startDate) out += `**Start:** ${created.startDate}\n`;
  if (created.endDate) out += `**End:** ${created.endDate}\n`;
  return textResponse(out);
}

/** Handle the 'move-issues' action. */
export async function handleMoveIssuesAction(
  params: {
    sprintId?: string;
    issueKeys?: string[];
  },
  jira: JiraClient,
) {
  if (!params.sprintId) return errorResponse("sprintId is required for 'move-issues' action.");
  if (!params.issueKeys?.length) return errorResponse("issueKeys is required for 'move-issues' action.");

  await jira.moveIssuesToSprint(params.sprintId, params.issueKeys);
  const count = params.issueKeys.length;
  const plural = count === 1 ? "" : "s";
  return textResponse(`Moved ${count} issue${plural} to sprint ${params.sprintId}: ${params.issueKeys.join(", ")}`);
}

/** Handle the 'goal' action (read or set sprint goal). */
export async function handleGoalAction(
  params: {
    sprintId?: string;
    goal?: string;
  },
  jira: JiraClient,
) {
  if (!params.sprintId) return errorResponse("sprintId is required for 'goal' action.");

  if (params.goal) {
    await jira.updateSprint(params.sprintId, { goal: params.goal });
    return textResponse(`# Sprint Goal Updated\n\n**Sprint:** ${params.sprintId}\n**Goal:** ${params.goal}\n`);
  }

  const details = await jira.getSprintDetails(params.sprintId);
  let out = `# Sprint Goal\n\n`;
  out += `**Sprint:** ${details.name} (${details.id})\n`;
  out += `**Goal:** ${details.goal || "(no goal set)"}\n`;
  return textResponse(out);
}
