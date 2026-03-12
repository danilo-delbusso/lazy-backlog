import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { JiraClient } from "../lib/jira.js";
import { DEFAULT_RULES, formatTeamStyleGuide, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions, formatConventionsSection } from "../lib/team-rules-format.js";
import { handleBulkCreateAction, handleCreateAction } from "./issues-create.js";
import { handleGetAction, handleSearchAction } from "./issues-get.js";
import {
  boolPreprocess,
  buildKbContextSection,
  buildSchemaGuidance,
  FIELD_RULES,
  jsonPreprocess,
  retrieveKbContext,
} from "./issues-helpers.js";

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export * from "./issues-create.js";
export * from "./issues-get.js";
export * from "./issues-helpers.js";

// ── Params type alias (inferred from the Zod schema) ─────────────────────────

/** Minimal type for the tool callback params — keeps handler signatures readable. */
interface IssueParams {
  action: string;
  issueKey?: string;
  issueKeys?: string[];
  summary?: string;
  description?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  parentKey?: string;
  components?: string[];
  namedFields?: Record<string, string | null>;
  comment?: string;
  tickets?: Array<{
    summary: string;
    description?: string;
    issueType: string;
    labels: string[];
    storyPoints?: number;
    priority: string;
    parentKey?: string;
    components: string[];
    namedFields?: Record<string, string>;
  }>;
  confirmed?: boolean;
  jql?: string;
  maxResults?: number;
  parent?: string;
  rankBefore?: string;
  rankAfter?: string;
  epicKey?: string;
  status?: string;
  assignee?: string;
  links?: Array<{ targetKey: string; linkType: string; direction: "inward" | "outward" }>;
  spaceKey?: string;
}

// ── Update helpers ───────────────────────────────────────────────────────────

function collectFieldChanges(params: IssueParams, parentKey: string | undefined): string[] {
  return [
    params.summary ? `Summary: ${params.summary}` : "",
    params.description ? "Description: updated" : "",
    params.priority ? `Priority: ${params.priority}` : "",
    params.labels ? `Labels: ${params.labels.join(", ")}` : "",
    params.storyPoints == null ? "" : `Story Points: ${params.storyPoints}`,
    params.components ? `Components: ${params.components.join(", ")}` : "",
    params.namedFields ? `Custom fields: ${Object.keys(params.namedFields).join(", ")}` : "",
    parentKey ? `Parent: ${parentKey}` : "",
    params.comment ? "Comment: added" : "",
  ].filter(Boolean);
}

function hasFieldUpdates(params: IssueParams, parentKey: string | undefined): boolean {
  return (
    params.summary != null ||
    params.description != null ||
    params.priority != null ||
    params.labels != null ||
    params.storyPoints != null ||
    params.components != null ||
    params.namedFields != null ||
    params.comment != null ||
    parentKey != null
  );
}

async function applyStatusTransition(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  status: string,
  changes: string[],
) {
  const transitions = await jira.getTransitions(issueKey);
  const match = transitions.find((t) => t.name.toLowerCase() === status.toLowerCase());
  if (!match) {
    const available = transitions.map((t) => t.name).join(", ");
    return errorResponse(`No transition matching "${status}" for ${issueKey}. Available: ${available}`);
  }
  await jira.transitionIssue(issueKey, match.id);
  changes.push(`Status: transitioned via "${match.name}"`);
  return null;
}

async function applyAssignee(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  assignee: string,
  changes: string[],
) {
  const accountId = assignee === "unassigned" ? null : assignee;
  await jira.assignIssue(issueKey, accountId);
  changes.push(`Assignee: ${assignee === "unassigned" ? "cleared" : assignee}`);
}

async function applyLinks(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  links: NonNullable<IssueParams["links"]>,
  changes: string[],
) {
  for (const link of links) {
    const inward = link.direction === "inward" ? issueKey : link.targetKey;
    const outward = link.direction === "inward" ? link.targetKey : issueKey;
    await jira.linkIssues(inward, outward, link.linkType);
  }
  changes.push(`Links: ${links.length} link(s) created`);
}

async function applyRanking(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  rankBefore: string | undefined,
  rankAfter: string | undefined,
  changes: string[],
) {
  await (
    jira as unknown as {
      rankIssue(key: string, opts: { rankBefore?: string; rankAfter?: string }): Promise<void>;
    }
  ).rankIssue(issueKey, {
    ...(rankBefore ? { rankBefore } : {}),
    ...(rankAfter ? { rankAfter } : {}),
  });
  const rankDesc = rankBefore ? `before ${rankBefore}` : `after ${rankAfter}`;
  changes.push(`Ranked: ${rankDesc}`);
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleUpdateAction(params: IssueParams, kb: KnowledgeBase) {
  if (!params.issueKey) return errorResponse("issueKey is required for 'update' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    const parentKey = params.parent || params.parentKey;

    if (hasFieldUpdates(params, parentKey)) {
      await jira.updateIssue({
        issueKey: params.issueKey,
        summary: params.summary,
        description: params.description,
        priority: params.priority,
        labels: params.labels,
        storyPoints: params.storyPoints,
        components: params.components,
        namedFields: params.namedFields,
        comment: params.comment,
        parentKey,
      });
    }

    const url = `${config.siteUrl}/browse/${params.issueKey}`;
    const changes = collectFieldChanges(params, parentKey);

    if (params.status) {
      const err = await applyStatusTransition(jira, params.issueKey, params.status, changes);
      if (err) return err;
    }

    if (params.assignee) {
      await applyAssignee(jira, params.issueKey, params.assignee, changes);
    }

    if (params.links?.length) {
      await applyLinks(jira, params.issueKey, params.links, changes);
    }

    if (params.rankBefore || params.rankAfter) {
      await applyRanking(jira, params.issueKey, params.rankBefore, params.rankAfter, changes);
    }

    const changesList = changes.map((c) => `- ${c}`).join("\n");
    return textResponse(`Updated **${params.issueKey}** — ${url}\n\nChanges:\n${changesList}`);
  } catch (err: unknown) {
    return errorResponse(`Failed to update ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatEpicDetails(epic: {
  key: string;
  summary: string;
  status: string;
  priority: string;
  labels: string[];
  description?: string;
}) {
  let plan = `# Epic Decomposition: ${epic.key}\n\n`;
  plan += `## Epic Details\n`;
  plan += `**Summary:** ${epic.summary}\n`;
  plan += `**Status:** ${epic.status} | **Priority:** ${epic.priority}\n`;
  if (epic.labels.length) plan += `**Labels:** ${epic.labels.join(", ")}\n`;
  if (epic.description) plan += `\n### Description\n${epic.description}\n`;
  plan += `\n`;
  return plan;
}

function formatExistingChildren(children: {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      status?: { name: string };
      priority?: { name: string };
      assignee?: { displayName: string };
    };
  }>;
  total: number;
}) {
  if (children.issues.length === 0) return `## Existing Stories\nNone found.\n\n`;

  let plan = `## Existing Stories (${children.issues.length}/${children.total})\n\n`;
  plan += `| Key | Summary | Status | Priority | Assignee |\n`;
  plan += `|-----|---------|--------|----------|----------|\n`;
  for (const issue of children.issues) {
    plan += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
  }
  plan += `\n`;
  return plan;
}

function buildTeamStyleSection(kb: KnowledgeBase) {
  const teamRules = kb.getTeamRules();
  const rules = teamRules.map((r) => ({
    category: r.category,
    rule_key: r.rule_key,
    issue_type: r.issue_type,
    rule_value: r.rule_value,
    confidence: r.confidence,
    sample_size: r.sample_size,
  }));
  return mergeWithDefaults(rules, DEFAULT_RULES);
}

async function handleDecomposeAction(params: IssueParams, kb: KnowledgeBase) {
  if (!params.epicKey) return errorResponse("epicKey is required for 'decompose' action.");

  try {
    const { jira } = buildJiraClient(kb);
    const schema = JiraClient.loadSchemaFromDb(kb);

    const epic = await jira.getIssue(params.epicKey);
    const children = await jira.searchIssues(`parent = ${params.epicKey}`);

    const epicDescription = epic.description || epic.summary;
    const ctx = retrieveKbContext(kb, epicDescription, params.spaceKey);
    const issueType = params.issueType || "Task";

    let plan = formatEpicDetails(epic);
    plan += formatExistingChildren(children);
    plan += buildSchemaGuidance(schema, issueType);

    const merged = buildTeamStyleSection(kb);
    const styleGuide = formatTeamStyleGuide(merged);
    if (styleGuide.trim()) {
      plan += `\n${styleGuide}\n`;
    }

    const conventions = evaluateConventions(
      { summary: epic.summary, description: epic.description, issueType, labels: epic.labels },
      merged,
    );
    const conventionsText = formatConventionsSection(conventions);
    if (conventionsText) plan += `\n${conventionsText}\n\n`;

    plan += buildKbContextSection(ctx);
    plan += `---\nUse **issues** (action=create or bulk-create) with parentKey="${params.epicKey}" to create child stories.\n`;
    plan += FIELD_RULES;
    return textResponse(plan);
  } catch (err: unknown) {
    return errorResponse(`Failed to decompose ${params.epicKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerIssuesTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "issues",
    {
      description:
        "Jira issue CRUD and planning. IMPORTANT: 'create' and 'bulk-create' ALWAYS return a preview first. You MUST show the preview to the user and wait for their explicit approval before calling again with confirmed=true. NEVER set confirmed=true without user approval. Actions: 'get' fetch one or many issue details (pass issueKey for single, issueKeys for bulk). 'create' create one issue (returns preview — user must approve before confirmed=true). 'bulk-create' create multiple (returns preview — user must approve before confirmed=true). 'update' modify fields, transition status, assign, or link. 'search' query via JQL (auto-scoped to configured board). 'decompose' break an epic into child stories. For epic progress, velocity, retros, and team profile use the 'insights' tool. For bug-specific workflows (find, assess, triage) use the 'bugs' tool. For backlog listing and ranking use the 'backlog' tool. For sprint operations use the 'sprints' tool.",
      inputSchema: z.object({
        action: z.enum(["get", "create", "bulk-create", "update", "search", "decompose"]),
        // Shared identifiers
        issueKey: z.string().optional().describe("[get, update] Single issue key, e.g. 'BP-42'"),
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[get] Array of issue keys for bulk fetch, e.g. ['BP-1','BP-2','BP-3']"),
        // create / update fields
        summary: z.string().optional().describe("[create, update] Issue title"),
        description: z.string().optional().describe("[create, update] Issue description (markdown, converted to ADF)"),
        issueType: z
          .string()
          .default("Task")
          .optional()
          .describe("[create] Issue type name, e.g. 'Task', 'Bug', 'Story'"),
        priority: z.string().optional().describe("[create, update] Priority name, e.g. 'High', 'Medium'"),
        labels: z.array(z.string()).optional().describe("[create, update] Labels in kebab-case, e.g. ['tech-debt']"),
        storyPoints: z.number().optional().describe("[create, update] Story points (Fibonacci: 1,2,3,5,8,13)"),
        parentKey: z
          .string()
          .optional()
          .describe("[create, bulk-create] Parent epic key, e.g. 'BP-10'. Alias for 'parent'"),
        components: z.array(z.string()).optional().describe("[create, update] Component names"),
        namedFields: z
          .record(z.string(), z.union([z.string(), z.null()]))
          .optional()
          .describe("[create, update] Custom fields as {'Field Name': 'Value Name'}. Pass null to clear a field."),
        comment: z.string().optional().describe("[update] Add a comment to the issue"),
        // bulk-create
        tickets: z.preprocess(
          jsonPreprocess,
          z
            .array(
              z.object({
                summary: z.string(),
                description: z.string().optional(),
                issueType: z.string().default("Task"),
                labels: z.array(z.string()).default([]),
                storyPoints: z.number().optional(),
                priority: z.string().default("Medium"),
                parentKey: z.string().optional(),
                components: z.array(z.string()).default([]),
                namedFields: z.record(z.string(), z.string()).optional(),
              }),
            )
            .optional()
            .describe("[bulk-create] Array of ticket objects to create"),
        ),
        confirmed: z
          .preprocess(boolPreprocess, z.boolean().default(false))
          .optional()
          .describe(
            "[create, bulk-create] ONLY set true AFTER showing the preview to the user AND receiving their explicit approval. Default false (preview only). NEVER set true on the first call.",
          ),
        // search
        jql: z.string().optional().describe("[search] JQL query string"),
        maxResults: z.number().max(100).default(50).optional().describe("[search] Max issues to return"),
        // parent epic
        parent: z.string().optional().describe("[create, update] Parent epic key, e.g. 'BP-10'"),
        // ranking
        rankBefore: z.string().optional().describe("[update] Rank this issue before the specified issue key"),
        rankAfter: z.string().optional().describe("[update] Rank this issue after the specified issue key"),
        // decompose
        epicKey: z.string().optional().describe("[decompose] Epic issue key"),
        // update extras
        status: z.string().optional().describe("[update] Transition to this status name, e.g. 'In Progress', 'Done'"),
        assignee: z.string().optional().describe("[update] Assignee account ID, or 'unassigned' to clear"),
        links: z
          .array(
            z.object({
              targetKey: z.string().describe("Issue key to link to"),
              linkType: z.string().describe("Link type name, e.g. 'Blocks', 'Relates'"),
              direction: z.enum(["inward", "outward"]).describe("Link direction from this issue's perspective"),
            }),
          )
          .optional()
          .describe("[update] Create issue links"),
        spaceKey: z
          .string()
          .optional()
          .describe("[create, bulk-create, decompose] Confluence space key to search for relevant context"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "get":
          return handleGetAction(params, kb);
        case "create":
          return handleCreateAction(params, kb);
        case "bulk-create":
          return handleBulkCreateAction(params, kb);
        case "update":
          return handleUpdateAction(params, kb);
        case "search":
          return handleSearchAction(params, kb);
        case "decompose":
          return handleDecomposeAction(params, kb);
        default:
          return errorResponse(`Unknown action: ${params.action}`);
      }
    },
  );
}
