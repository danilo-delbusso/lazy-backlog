import type { SprintData } from "../lib/analytics.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";

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
