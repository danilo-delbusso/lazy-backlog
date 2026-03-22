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

/** Handle the 'update' action (update sprint name, goal, dates). */
export async function handleUpdateSprintAction(
  params: {
    sprintId?: string;
    goal?: string;
    name?: string;
    startDate?: string;
    endDate?: string;
  },
  jira: JiraClient,
) {
  if (!params.sprintId) return errorResponse("sprintId is required for 'update' action.");

  const updates: { goal?: string; name?: string; startDate?: string; endDate?: string } = {};
  if (params.goal !== undefined) updates.goal = params.goal;
  if (params.name !== undefined) updates.name = params.name;
  if (params.startDate !== undefined) updates.startDate = params.startDate;
  if (params.endDate !== undefined) updates.endDate = params.endDate;

  if (Object.keys(updates).length === 0) {
    return errorResponse("At least one of name, goal, startDate, or endDate is required for 'update' action.");
  }

  await jira.updateSprint(params.sprintId, updates);

  const updatedFields = Object.keys(updates).join(", ");
  let out = `# Sprint Updated\n\n`;
  out += `**Sprint:** ${params.sprintId}\n`;
  out += `**Updated fields:** ${updatedFields}\n`;
  if (updates.name) out += `**Name:** ${updates.name}\n`;
  if (updates.goal) out += `**Goal:** ${updates.goal}\n`;
  if (updates.startDate) out += `**Start:** ${updates.startDate}\n`;
  if (updates.endDate) out += `**End:** ${updates.endDate}\n`;
  return textResponse(out);
}
