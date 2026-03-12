import { buildJiraClient, errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { findDuplicates } from "../lib/duplicate-detect.js";
import { JiraClient, type JiraTicketInput } from "../lib/jira.js";
import type { TicketContext } from "../lib/team-insights-suggest.js";
import {
  formatInsightsSection,
  generateDescriptionScaffold,
  generateSmartDefaults,
} from "../lib/team-insights-suggest.js";
import { DEFAULT_RULES, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions } from "../lib/team-rules-format.js";
import {
  buildKbContextSection,
  buildSchemaGuidance,
  FIELD_RULES,
  loadTeamInsights,
  retrieveKbContext,
} from "./issues-helpers.js";
import { buildBulkPreviewCard, buildPreviewCard, type PreviewData } from "./preview-builder.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadTeamRules(kb: KnowledgeBase) {
  const teamRules = kb.getTeamRules();
  return teamRules.map((r) => ({
    category: r.category,
    rule_key: r.rule_key,
    issue_type: r.issue_type,
    rule_value: r.rule_value,
    confidence: r.confidence,
    sample_size: r.sample_size,
  }));
}

function buildFields(params: {
  summary: string;
  issueType: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  components?: string[];
  parent?: string;
  parentKey?: string;
  namedFields?: Record<string, string | null>;
}): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [
    { label: "Summary", value: params.summary },
    { label: "Type", value: params.issueType },
    { label: "Priority", value: params.priority || "Medium (default)" },
  ];
  if (params.labels?.length) fields.push({ label: "Labels", value: params.labels.join(", ") });
  if (params.storyPoints != null) fields.push({ label: "Story Points", value: String(params.storyPoints) });
  if (params.components?.length) fields.push({ label: "Components", value: params.components.join(", ") });
  if (params.parent || params.parentKey)
    fields.push({ label: "Parent", value: (params.parent || params.parentKey) as string });
  if (params.namedFields)
    fields.push({
      label: "Custom Fields",
      value: Object.entries(params.namedFields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    });
  return fields;
}

/** Best-effort duplicate detection and epic listing. */
async function fetchDuplicatesAndEpics(
  kb: KnowledgeBase,
  summary: string,
  description: string | undefined,
  hasParent: boolean,
): Promise<{ duplicates: Awaited<ReturnType<typeof findDuplicates>>; epicsSection: string }> {
  let duplicates: Awaited<ReturnType<typeof findDuplicates>> = [];
  let epicsSection = "";
  try {
    const { jira, config } = buildJiraClient(kb);
    const projectKey = config.jiraProjectKey;
    if (!projectKey) return { duplicates, epicsSection };

    duplicates = await findDuplicates(jira, summary, description, projectKey);

    if (!hasParent) {
      const epicJql = `project = ${projectKey} AND type = Epic AND status != Done ORDER BY updated DESC`;
      const epicResult = await jira.searchIssues(epicJql, undefined, 10);
      epicsSection = formatEpicsSection(epicResult.issues);
    }
  } catch {
    // best-effort
  }
  return { duplicates, epicsSection };
}

function formatEpicsSection(
  epics: Array<{ key: string; fields: { summary: string; status?: { name: string } | null } }>,
): string {
  if (epics.length === 0) return "";
  let out = `\n## Available Epics\n\n`;
  out += `No parent epic specified. Consider assigning to one of these:\n\n`;
  out += `| Key | Summary | Status |\n|-----|---------|--------|\n`;
  for (const epic of epics) {
    out += `| ${epic.key} | ${epic.fields.summary} | ${epic.fields.status?.name ?? "-"} |\n`;
  }
  out += `\nTo assign, add \`parentKey\` to the create call.\n`;
  return out;
}

function buildTeamInsightsSection(kb: KnowledgeBase, issueType: string, ticketCtx: TicketContext): string {
  const teamInsights = loadTeamInsights(kb);
  const smartDefaults = generateSmartDefaults(
    ticketCtx,
    teamInsights.estimation,
    teamInsights.ownership,
    teamInsights.patterns,
  );
  const scaffold = generateDescriptionScaffold(issueType, teamInsights.templates);
  return formatInsightsSection(
    smartDefaults,
    scaffold,
    teamInsights.estimation,
    ticketCtx,
    teamInsights.patterns.reworkRates,
  );
}

function buildConventions(
  kb: KnowledgeBase,
  ticket: {
    summary: string;
    description?: string;
    issueType: string;
    labels?: string[];
    storyPoints?: number;
    components?: string[];
  },
) {
  const rules = loadTeamRules(kb);
  const merged = mergeWithDefaults(rules, DEFAULT_RULES);
  return evaluateConventions(ticket, merged);
}

/** Build the confirmed-creation response for a single ticket. */
async function executeCreate(
  kb: KnowledgeBase,
  params: {
    summary: string;
    description?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
    storyPoints?: number;
    parent?: string;
    parentKey?: string;
    components?: string[];
    namedFields?: Record<string, string | null>;
  },
) {
  const { jira, config } = buildJiraClient(kb);
  const input: JiraTicketInput = {
    summary: params.summary,
    description: params.description,
    issueType: params.issueType || "Task",
    priority: params.priority,
    labels: params.labels,
    storyPoints: params.storyPoints,
    parentKey: params.parent || params.parentKey,
    components: params.components,
    namedFields: params.namedFields,
  };
  const created = await jira.createIssue(input);
  return textResponse(
    `Created **${created.key}** — ${config.siteUrl}/browse/${created.key}\n\nSummary: ${params.summary}`,
  );
}

/** Build fields array for a bulk-create ticket preview. */
function buildBulkTicketFields(t: {
  summary: string;
  issueType: string;
  priority: string;
  labels: string[];
  storyPoints?: number;
  parentKey?: string;
  components: string[];
}): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [
    { label: "Summary", value: t.summary },
    { label: "Type", value: t.issueType },
    { label: "Priority", value: t.priority },
  ];
  if (t.labels.length) fields.push({ label: "Labels", value: t.labels.join(", ") });
  if (t.storyPoints != null) fields.push({ label: "Story Points", value: String(t.storyPoints) });
  if (t.parentKey) fields.push({ label: "Parent", value: t.parentKey });
  if (t.components.length) fields.push({ label: "Components", value: t.components.join(", ") });
  return fields;
}

/** Best-effort duplicate detection for bulk-create (first ticket only). */
async function fetchBulkDuplicates(
  kb: KnowledgeBase,
  projectKey: string | undefined,
  firstTicket: { summary: string; description?: string },
): Promise<Awaited<ReturnType<typeof findDuplicates>>> {
  if (!projectKey) return [];
  try {
    const { jira } = buildJiraClient(kb);
    return await findDuplicates(jira, firstTicket.summary, firstTicket.description, projectKey);
  } catch {
    return [];
  }
}

/** Format the result of a bulk-create operation. */
function formatBulkResult(
  result: { issues: Array<{ key: string }>; errors: string[] },
  totalTickets: number,
  siteUrl: string,
) {
  const plural = totalTickets === 1 ? "" : "s";
  let out = `# Created ${result.issues.length}/${totalTickets} ticket${plural}\n\n`;
  for (const issue of result.issues) out += `- **${issue.key}** — ${siteUrl}/browse/${issue.key}\n`;
  if (result.errors.length > 0) {
    out += `\n## Errors (${result.errors.length})\n`;
    for (const err of result.errors) out += `- ${err}\n`;
  }
  return result.errors.length > 0 ? errorResponse(out) : textResponse(out);
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Handle the 'create' action (preview + confirm flow). */
export async function handleCreateAction(
  params: {
    summary?: string;
    description?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
    storyPoints?: number;
    parent?: string;
    parentKey?: string;
    components?: string[];
    namedFields?: Record<string, string | null>;
    confirmed?: boolean;
    spaceKey?: string;
  },
  kb: KnowledgeBase,
) {
  if (!params.summary) return errorResponse("summary is required for 'create' action.");
  if (params.confirmed) return executeCreateConfirmed(kb, params as typeof params & { summary: string });
  return buildCreatePreview(kb, params as typeof params & { summary: string });
}

async function buildCreatePreview(
  kb: KnowledgeBase,
  params: {
    summary: string;
    description?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
    storyPoints?: number;
    parent?: string;
    parentKey?: string;
    components?: string[];
    namedFields?: Record<string, string | null>;
    spaceKey?: string;
  },
) {
  const schema = JiraClient.loadSchemaFromDb(kb);
  const issueType = params.issueType || "Task";
  const searchText = `${params.summary} ${params.description || ""}`;
  const ctx = retrieveKbContext(kb, searchText, params.spaceKey);

  const hasParent = !!(params.parent || params.parentKey);
  const { duplicates, epicsSection } = await fetchDuplicatesAndEpics(kb, params.summary, params.description, hasParent);

  const conventions = buildConventions(kb, {
    summary: params.summary,
    description: params.description,
    issueType,
    labels: params.labels,
    storyPoints: params.storyPoints,
    components: params.components,
  });

  const ticketCtx: TicketContext = {
    summary: params.summary,
    issueType,
    description: params.description,
    components: params.components,
    labels: params.labels,
    storyPoints: params.storyPoints,
    priority: params.priority,
  };
  const insightsSection = buildTeamInsightsSection(kb, issueType, ticketCtx);

  const previewData: PreviewData = {
    fields: buildFields({ ...params, summary: params.summary, issueType }),
    description: params.description,
    conventions,
    kbContext: buildKbContextSection(ctx),
    duplicates,
    schemaGuidance: buildSchemaGuidance(schema, issueType),
    fieldRules: FIELD_RULES,
    insights: insightsSection || undefined,
  };

  let out = buildPreviewCard(previewData);
  if (epicsSection) out += `\n\n${epicsSection}`;
  out += `\n---\n**STOP: Show this preview to the user and wait for their approval.** Do NOT proceed with \`confirmed=true\` until the user explicitly confirms. Ask the user to review the fields, description, and epic assignment above.\n`;
  return textResponse(out);
}

async function executeCreateConfirmed(
  kb: KnowledgeBase,
  params: {
    summary: string;
    description?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
    storyPoints?: number;
    parent?: string;
    parentKey?: string;
    components?: string[];
    namedFields?: Record<string, string | null>;
  },
) {
  try {
    return await executeCreate(kb, params);
  } catch (err: unknown) {
    return errorResponse(`Failed to create issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Bulk Create ──────────────────────────────────────────────────────────────

type BulkTicket = {
  summary: string;
  description?: string;
  issueType: string;
  labels: string[];
  storyPoints?: number;
  priority: string;
  parentKey?: string;
  components: string[];
  namedFields?: Record<string, string | null>;
};

/** Handle the 'bulk-create' action (preview + confirm flow). */
export async function handleBulkCreateAction(
  params: {
    tickets?: BulkTicket[];
    confirmed?: boolean;
    spaceKey?: string;
  },
  kb: KnowledgeBase,
) {
  if (!params.tickets?.length) return errorResponse("tickets array is required for 'bulk-create' action.");

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  if (!params.confirmed) return buildBulkPreview(kb, params.tickets, config.jiraProjectKey, params.spaceKey);
  return executeBulkCreate(kb, params.tickets, config);
}

async function buildBulkPreview(
  kb: KnowledgeBase,
  tickets: BulkTicket[],
  projectKey: string | undefined,
  spaceKey?: string,
) {
  const schema = JiraClient.loadSchemaFromDb(kb);
  const issueType = tickets[0]?.issueType || "Task";
  const searchText = tickets.map((t) => t.summary).join(" ");
  const ctx = retrieveKbContext(kb, searchText, spaceKey);
  const kbContextText = buildKbContextSection(ctx);

  const firstTicket = tickets[0] as BulkTicket;
  const firstDuplicates = await fetchBulkDuplicates(kb, projectKey, firstTicket);

  const rules = loadTeamRules(kb);
  const merged = mergeWithDefaults(rules, DEFAULT_RULES);
  const schemaGuidance = buildSchemaGuidance(schema, issueType);

  const bulkTicketCtx: TicketContext = {
    summary: firstTicket.summary,
    issueType: firstTicket.issueType,
    description: firstTicket.description,
    components: firstTicket.components,
    labels: firstTicket.labels,
    storyPoints: firstTicket.storyPoints,
    priority: firstTicket.priority,
  };
  const bulkInsights = buildTeamInsightsSection(kb, issueType, bulkTicketCtx);

  const previews: PreviewData[] = tickets.map((t, i) =>
    mapTicketToPreview(t, i, merged, kbContextText, firstDuplicates, schemaGuidance, bulkInsights),
  );

  let out = buildBulkPreviewCard(previews);
  out += `\n---\n**STOP: Show this preview to the user and wait for their approval.** Do NOT proceed with \`confirmed=true\` until the user explicitly confirms. Ask the user to review the tickets above.\n`;
  return textResponse(out);
}

function mapTicketToPreview(
  t: BulkTicket,
  index: number,
  merged: ReturnType<typeof mergeWithDefaults>,
  kbContextText: string,
  firstDuplicates: Awaited<ReturnType<typeof findDuplicates>>,
  schemaGuidance: string | undefined,
  bulkInsights: string,
): PreviewData {
  const conventions = evaluateConventions(
    {
      summary: t.summary,
      description: t.description,
      issueType: t.issueType,
      labels: t.labels,
      storyPoints: t.storyPoints,
      components: t.components,
    },
    merged,
  );
  const isFirst = index === 0;
  return {
    fields: buildBulkTicketFields(t),
    description: t.description,
    conventions,
    kbContext: isFirst ? kbContextText : undefined,
    duplicates: isFirst ? firstDuplicates : [],
    schemaGuidance: isFirst ? schemaGuidance : undefined,
    fieldRules: isFirst ? FIELD_RULES : undefined,
    insights: isFirst && bulkInsights ? bulkInsights : undefined,
  };
}

async function executeBulkCreate(kb: KnowledgeBase, tickets: BulkTicket[], config: ReturnType<typeof resolveConfig>) {
  const projectKey = config.jiraProjectKey;
  if (!projectKey) return errorResponse("No project key. Run configure or pass projectKey.");

  const schema = JiraClient.loadSchemaFromDb(kb);
  const jira = new JiraClient({ ...config, jiraProjectKey: projectKey }, schema);
  const inputs: JiraTicketInput[] = tickets.map((t) => ({
    summary: t.summary,
    description: t.description,
    issueType: t.issueType,
    priority: t.priority,
    labels: t.labels,
    storyPoints: t.storyPoints,
    parentKey: t.parentKey,
    components: t.components,
    namedFields: t.namedFields,
  }));

  const result = await jira.createIssuesBatch(inputs);
  return formatBulkResult(result, tickets.length, config.siteUrl);
}
