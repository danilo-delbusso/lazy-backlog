/**
 * Jira schema discovery — fetches issue types, fields, priorities, board config,
 * team assignment, statuses, and sample tickets from Jira REST API.
 */

import { fetchWithRetry } from "./http-utils.js";
import { authHeaders, validateSiteUrl } from "./jira-auth.js";
import type {
  BoardConfigResponse,
  BoardIssueResponse,
  CreateMetaResponse,
  FieldMetaResponse,
  JiraFieldSchema,
  JiraSchema,
  ProjectStatusEntry,
  RawFieldMeta,
  SampleSearchResponse,
} from "./jira-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

/** Authenticated GET helper for Jira REST API with retry. */
async function jiraGet<T>(baseUrl: string, headers: Record<string, string>, path: string): Promise<T> {
  const res = await fetchWithRetry(`${baseUrl}${path}`, {
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
    label: "Jira",
  });
  if (!res.ok) throw new Error(`Jira ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

// ── Schema Discovery ─────────────────────────────────────────────────────────

/**
 * Discover full Jira project schema via REST API.
 * Fetches issue types, fields, priorities, board config, team, statuses, and sample tickets.
 */
export async function discoverSchema(
  config: { siteUrl: string; email: string; apiToken: string },
  projectKey: string,
  boardId?: string,
): Promise<JiraSchema> {
  validateSiteUrl(config.siteUrl);
  const baseUrl = config.siteUrl.replace(/\/$/, "");
  const headers = authHeaders(config.email, config.apiToken);
  const encodedProject = encodeURIComponent(projectKey);
  const get = <T>(path: string) => jiraGet<T>(baseUrl, headers, path);

  const schema: JiraSchema = {
    projectKey,
    projectName: "",
    boardId: boardId || "",
    issueTypes: [],
    priorities: [],
  };

  // Project info
  const project = await get<{ name: string }>(`/rest/api/3/project/${encodedProject}`);
  schema.projectName = project.name;

  // Issue types + fields
  let rawTypes: { id: string; name: string; subtask?: boolean }[];
  try {
    const meta = await get<CreateMetaResponse>(`/rest/api/3/issue/createmeta/${encodedProject}/issuetypes`);
    rawTypes = meta.issueTypes || meta.values || [];
  } catch {
    const meta = await get<CreateMetaResponse>(
      `/rest/api/3/issue/createmeta?projectKeys=${encodedProject}&expand=projects.issuetypes`,
    );
    rawTypes = meta.projects?.[0]?.issuetypes || [];
  }

  for (const it of rawTypes) {
    let rawFields: RawFieldMeta[] = [];
    try {
      const fm = await get<FieldMetaResponse>(
        `/rest/api/3/issue/createmeta/${encodedProject}/issuetypes/${encodeURIComponent(it.id)}`,
      );
      rawFields = fm.fields || fm.values || [];
    } catch {
      /* skip */
    }

    const fields: JiraFieldSchema[] = rawFields.map((f) => {
      const fld = f.fieldId ? f : { fieldId: f.key, ...f };
      return {
        id: fld.fieldId || fld.key || "",
        name: fld.name,
        required: fld.required || false,
        type: fld.schema?.type || "unknown",
        system: fld.schema?.system,
        custom: fld.schema?.custom,
        allowedValues: fld.allowedValues?.slice(0, 20)?.map((v) => ({
          id: v.id,
          name: v.name || v.value || v.label || "",
        })),
      };
    });

    schema.issueTypes.push({
      id: it.id,
      name: it.name,
      subtask: it.subtask || false,
      fields,
      requiredFields: fields.filter((f) => f.required).map((f) => f.id),
    });
  }

  // Priorities
  const priorities = await get<{ id: string; name: string }[]>("/rest/api/3/priority");
  schema.priorities = priorities.map((p) => ({ id: p.id, name: p.name }));

  // Board config + team detection
  if (boardId) {
    await discoverBoard(get, schema, boardId);
  }

  // Statuses + sample tickets
  await discoverStatusesAndSamples(get, schema, projectKey);

  return schema;
}

/** Discover board configuration and team assignment for a board. */
async function discoverBoard(get: <T>(path: string) => Promise<T>, schema: JiraSchema, boardId: string): Promise<void> {
  const encodedBoard = encodeURIComponent(boardId);
  try {
    const bc = await get<BoardConfigResponse>(`/rest/agile/1.0/board/${encodedBoard}/configuration`);
    schema.board = {
      name: bc.name,
      type: bc.type,
      estimationField: bc.estimation?.field?.displayName,
      columns: bc.columnConfig?.columns?.map((c) => ({
        name: c.name,
        statuses: c.statuses?.map((s) => s.name || s.id || ""),
      })),
    };

    // Find team field dynamically from schema fields
    let teamFieldId: string | null = null;
    for (const it of schema.issueTypes) {
      const tf = it.fields.find((f) => f.custom?.toLowerCase().includes("team") || f.name === "Team");
      if (tf) {
        teamFieldId = tf.id;
        break;
      }
    }

    // Sample a board ticket to get the team value (no allowedValues in create meta)
    if (teamFieldId) {
      try {
        const board = await get<BoardIssueResponse>(
          `/rest/agile/1.0/board/${encodedBoard}/issue?maxResults=1&fields=${encodeURIComponent(teamFieldId)}`,
        );
        const teamValue = board.issues?.[0]?.fields?.[teamFieldId];
        if (teamValue?.id) {
          schema.board.teamFieldId = teamFieldId;
          schema.board.teamId = teamValue.id;
          schema.board.teamName = teamValue.name || teamValue.title;
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* optional */
  }
}

/** Discover statuses and sample tickets for convention detection. */
async function discoverStatusesAndSamples(
  get: <T>(path: string) => Promise<T>,
  schema: JiraSchema,
  projectKey: string,
): Promise<void> {
  const encodedPK = encodeURIComponent(projectKey);
  try {
    const statuses = await get<ProjectStatusEntry[]>(`/rest/api/3/project/${encodedPK}/statuses`);
    schema.statuses = statuses.map((st) => ({
      issueType: st.name,
      statuses: (st.statuses || []).map((s) => ({ id: s.id, name: s.name, category: s.statusCategory?.name || "" })),
    }));
  } catch {
    /* optional */
  }

  try {
    const jql = `project = ${projectKey} ORDER BY created DESC`;
    const search = await get<SampleSearchResponse>(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary,issuetype,priority,labels,status`,
    );
    schema.sampleTickets = search.issues?.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      type: issue.fields.issuetype?.name || "",
      priority: issue.fields.priority?.name || "",
      status: issue.fields.status?.name || "",
      labels: issue.fields.labels || [],
    }));
  } catch {
    /* optional */
  }
}

// ── Schema Persistence ───────────────────────────────────────────────────────

/** Load schema from a JSON file path. */
export function loadSchema(schemaPath?: string): JiraSchema | null {
  if (!schemaPath) return null;
  try {
    return JSON.parse(require("node:fs").readFileSync(schemaPath, "utf-8")) as JiraSchema;
  } catch {
    return null;
  }
}

/** Load schema from SQLite config. */
export function loadSchemaFromDb(kb: { getConfig(key: string): string | undefined }): JiraSchema | null {
  const raw = kb.getConfig("jira-schema");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JiraSchema;
  } catch {
    return null;
  }
}

/** Save schema to SQLite config. */
export function saveSchemaToDb(kb: { setConfig(key: string, value: string): void }, schema: JiraSchema): void {
  kb.setConfig("jira-schema", JSON.stringify(schema));
}
