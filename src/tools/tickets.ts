import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase, PageSummary } from "../lib/db.js";
import { Spider } from "../lib/indexer.js";
import { JiraClient, type JiraSchema, type JiraTicketInput } from "../lib/jira.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Stop words filtered from description when extracting search keywords. */
export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "set",
  "up",
  "using",
  "via",
  "any",
  "new",
  "create",
  "add",
  "implement",
  "provision",
  "configure",
  "setup",
  "ensure",
  "including",
  "required",
  "necessary",
]);

const FIELD_RULES = `
## Field Rules

### Summary
- Action-oriented: start with a verb (Add, Fix, Implement, Investigate, Migrate)
- Concise: 5–15 words. No trailing period.
- Include scope: "Add retry logic to ingestion pipeline" not "Add retry logic"

### Description (Markdown → ADF)
Structure every description as:
1. **Context** — Why this work matters (1–2 sentences)
2. **Requirements** — Bullet list of what must be done
3. **Acceptance Criteria** — Checkboxes: \`- [ ] Criterion\`
4. **Technical Notes** — Implementation hints, links to ADRs/designs (optional)

### Issue Types
- **Epic** — Large body of work spanning multiple sprints. Summary = theme, not task.
- **Feature** — User-facing capability. Describe the user value.
- **Task** — Technical work. Be specific about the deliverable.
- **Bug** — Include: steps to reproduce, expected vs actual, environment.
- **Spike** — Time-boxed investigation. State the question and exit criteria.
- **Sub-task** — Must have parentKey. Atomic unit of work (< 1 day).

### Story Points (Fibonacci)
- **1** — Trivial change, < 1 hour
- **2** — Small, well-understood task, < half day
- **3** — Standard task, ~1 day
- **5** — Multi-day, some complexity
- **8** — Large, cross-cutting, ~1 week
- **13** — Very large, consider breaking down

### Priority
- **Showstopper/Critical** — Production down, data loss, security
- **High** — Blocks sprint goal or other work
- **Medium** — Standard sprint work (default)
- **Low/Lowest** — Nice-to-have, backlog grooming
- **Trivial** — Cosmetic, typos

### Labels
- Use kebab-case: \`tech-debt\`, \`customer-facing\`, \`auth0\`, \`infra\`
- Max 3 labels per ticket
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Zod preprocess: parse JSON strings into native types (handles buggy LLM clients). */
const jsonPreprocess = <T>(val: unknown): T => (typeof val === "string" ? JSON.parse(val) : val) as T;
const boolPreprocess = (val: unknown): boolean => (typeof val === "string" ? val === "true" : val) as boolean;

/** Extract search keywords from a description string. */
export function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,.:;()\-/]+/)
        .map((w) => w.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ];
}

/** Build a JiraClient from the KB config + schema. */
export function buildJiraClient(kb: KnowledgeBase): { jira: JiraClient; config: ReturnType<typeof resolveConfig> } {
  const config = resolveConfig(kb);
  const projectKey = config.jiraProjectKey;
  if (!projectKey) throw new Error("No project key configured. Run the configure tool first.");
  const schema = JiraClient.loadSchemaFromDb(kb);
  return { jira: new JiraClient({ ...config, jiraProjectKey: projectKey }, schema), config };
}

/** Format a schema discovery result into a summary string. */
export function formatSchemaResult(schema: JiraSchema): string {
  const types = schema.issueTypes.map((t) => t.name).join(", ");
  const fields = schema.issueTypes.reduce((n, t) => n + t.fields.length, 0);
  const lines = [
    `${schema.projectName} (${schema.projectKey}):`,
    `- ${schema.issueTypes.length} issue types: ${types}`,
    `- ${fields} fields mapped`,
    `- ${schema.priorities.length} priorities`,
  ];
  if (schema.board) {
    lines.push(`- Board: ${schema.board.name} (${schema.board.type})`);
    if (schema.board.teamName) lines.push(`- Team: ${schema.board.teamName}`);
  }
  return lines.join("\n");
}

/** Spider multiple Confluence spaces and return a summary. */
async function spiderSpaces(
  config: ReturnType<typeof resolveConfig>,
  kb: KnowledgeBase,
  spaceKeys: string[],
  maxDepth: number,
): Promise<string> {
  const client = new ConfluenceClient(config);
  const spider = new Spider(client, kb);
  let indexed = 0,
    unchanged = 0,
    skipped = 0;
  const errors: string[] = [];

  for (const spaceKey of spaceKeys) {
    const r = await spider.crawl({ spaceKey, maxDepth, maxConcurrency: 5, includeLabels: [], excludeLabels: [] });
    indexed += r.indexed;
    unchanged += r.unchanged;
    skipped += r.skipped;
    errors.push(...r.errors);
  }

  const stats = kb.getStats();
  const lines = [
    `Indexed: ${indexed} | Unchanged: ${unchanged} | Skipped: ${skipped}`,
    `KB total: ${stats.total} pages`,
    `Types: ${Object.entries(stats.byType)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`,
  ];
  if (errors.length > 0) lines.push(`Errors: ${errors.length} (first: ${errors[0]})`);
  return lines.join("\n");
}

/** Retrieve deep Confluence context for ticket planning. */
export function retrieveConfluenceContext(kb: KnowledgeBase, description: string, spaceKey?: string) {
  const opts = { spaceKey };

  // All ADRs, design docs, specs — always included
  const adrs = kb.getPageSummaries("adr", spaceKey);
  const designs = kb.getPageSummaries("design", spaceKey);
  const specs = kb.getPageSummaries("spec", spaceKey);

  // Targeted chunk search — keywords individually + pairs + full phrase
  const keywords = extractKeywords(description);
  const seen = new Set<string>();
  const chunks: Array<{ page_title: string; page_type: string; breadcrumb: string; snippet: string }> = [];

  const addChunks = (
    results: Array<{ page_title: string; page_type: string; breadcrumb?: string; heading?: string; snippet: string }>,
  ) => {
    for (const c of results) {
      const key = `${c.page_title}::${c.breadcrumb || c.heading || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        chunks.push({
          page_title: c.page_title,
          page_type: c.page_type,
          breadcrumb: c.breadcrumb || c.heading || "",
          snippet: c.snippet,
        });
      }
    }
  };

  for (const kw of keywords) addChunks(kb.searchChunks(kw, { ...opts, limit: 5 }));
  for (let i = 0; i < keywords.length - 1; i++) {
    addChunks(kb.searchChunks(`${keywords[i]} ${keywords[i + 1]}`, { ...opts, limit: 3 }));
  }
  addChunks(kb.searchChunks(description.split(/\s+/).slice(0, 12).join(" "), { ...opts, limit: 10 }));

  return { adrs, designs, specs, chunks };
}

/** Format page summaries as markdown list items. */
export function formatSummaries(pages: PageSummary[], heading: string): string {
  if (pages.length === 0) return "";
  const items = pages.map((p) => `- **${p.title}**: ${p.content_preview.replaceAll("\n", " ").trim()}`).join("\n");
  return `### ${heading} (${pages.length} total)\n${items}\n\n`;
}

/** Build the schema guidance section for the ticket plan. */
function buildSchemaGuidance(schema: JiraSchema | null, issueType: string): string {
  if (!schema) return `> No Jira schema found. Run \`setup\` or \`discover-jira\` first.\n\n`;

  let plan = "";
  if (schema.board) {
    const estimationSuffix = schema.board.estimationField ? ` — estimates in ${schema.board.estimationField}` : "";
    plan += `**Board:** ${schema.board.name} (${schema.board.type})${estimationSuffix}\n`;
    if (schema.board.columns) plan += `**Workflow:** ${schema.board.columns.map((c) => c.name).join(" → ")}\n`;
  }
  plan += `**Priorities:** ${schema.priorities.map((p) => p.name).join(", ")}\n`;
  const typeLabels = schema.issueTypes.map((t) => t.name + (t.subtask ? " [subtask]" : "")).join(", ");
  plan += `**Issue Types:** ${typeLabels}\n\n`;

  const ts = schema.issueTypes.find((t) => t.name === issueType);
  if (ts) {
    plan += `## Fields for ${issueType}\n\n`;
    for (const f of ts.fields) {
      const valuesSuffix = f.allowedValues?.length
        ? ` — values: ${f.allowedValues.map((v) => `\`${v.name}\``).join(", ")}`
        : "";
      plan += `- **${f.name}** [${f.required ? "REQUIRED" : "optional"}]${valuesSuffix}\n`;
    }
    plan += `\nPass custom fields via \`namedFields\`: \`{"Field Name": "Value Name"}\`\n`;
    plan += `Required fields with allowed values are auto-filled if not provided.\n\n`;
  }

  if (schema.sampleTickets?.length) {
    plan += `## Conventions (from recent tickets)\n`;
    for (const t of schema.sampleTickets.slice(0, 3)) {
      plan += `- ${t.key}: "${t.summary}" [${t.type}, ${t.priority}]\n`;
    }
    plan += `\n`;
  }

  return plan;
}

/** Build the Confluence context section for the ticket plan. */
function buildConfluenceSection(ctx: ReturnType<typeof retrieveConfluenceContext>): string {
  let plan = `## Confluence Context\n\n`;
  plan += `> **IMPORTANT:** You MUST reference relevant ADRs, design docs, and specs in ticket descriptions. Cite specific ADR numbers and technical constraints.\n\n`;
  plan += formatSummaries(ctx.adrs, "ADRs");
  plan += formatSummaries(ctx.designs, "Design Docs");
  plan += formatSummaries(ctx.specs, "Specs");

  if (ctx.chunks.length > 0) {
    plan += `### Targeted Matches (${ctx.chunks.length} relevant sections)\n`;
    for (const c of ctx.chunks.slice(0, 25)) {
      plan += `- **${c.page_title}** › ${c.breadcrumb} [${c.page_type}]: ${c.snippet}\n`;
    }
    plan += `\n`;
  }

  if (!ctx.adrs.length && !ctx.designs.length && !ctx.chunks.length) {
    plan += `> ⚠ No Confluence context found. Spider a space first.\n\n`;
  }

  return plan;
}

/** Build the dry-run context string from Confluence search results. */
function buildDryRunContext(
  chunks: Array<{ page_title: string; page_type: string; breadcrumb?: string; heading?: string; snippet: string }>,
  fallback: Array<{ title: string; page_type: string; snippet: string }>,
): string {
  if (chunks.length > 0) {
    const items = chunks
      .map((c) => {
        const location = c.breadcrumb || c.heading || "";
        return `- **${c.page_title}** › ${location} [${c.page_type}]\n  ${c.snippet}`;
      })
      .join("\n");
    return (
      `\n\n## Relevant Confluence Context\n` +
      items +
      `\n\n> Review context above. Refine descriptions before setting dryRun=false.\n`
    );
  }

  if (fallback.length > 0) {
    const items = fallback.map((r) => `- **${r.title}** [${r.page_type}]: ${r.snippet}`).join("\n");
    return (
      `\n\n## Relevant Confluence Context\n` +
      items +
      `\n\n> Review context above. Refine descriptions before setting dryRun=false.\n`
    );
  }

  return `\n\n> ⚠ No Confluence context found. Run 'search' to ground these tickets.\n`;
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerTicketTools(server: McpServer, getKb: () => KnowledgeBase) {
  const getSchema = () => JiraClient.loadSchemaFromDb(getKb());

  // ── Setup (combined Jira discovery + Confluence spider) ──

  server.tool(
    "setup",
    "One-time project setup: discovers Jira board structure (issue types, fields, priorities, team) AND spiders Confluence spaces for project context. Run this once after configure. Subsequent runs are incremental.",
    {
      projectKey: z.string().optional().describe("Jira project key override"),
      boardId: z.string().optional().describe("Jira board ID override"),
      spaceKeys: z.preprocess(
        jsonPreprocess,
        z.array(z.string()).optional().describe("Confluence space keys to spider"),
      ),
      maxDepth: z.number().default(10).describe("Max Confluence tree depth"),
    },
    async (params) => {
      const kb = getKb();
      let config: ReturnType<typeof resolveConfig>;
      try {
        config = resolveConfig(kb);
      } catch (err) {
        return errorResponse(String(err));
      }

      const output: string[] = ["# Setup Results\n"];
      const projectKey = params.projectKey || config.jiraProjectKey;
      const boardId = params.boardId || config.jiraBoardId;

      // Phase 1: Jira Discovery
      if (projectKey) {
        try {
          const schema = await JiraClient.discoverSchema(config, projectKey, boardId);
          JiraClient.saveSchemaToDb(kb, schema);
          output.push(`## Jira\n${formatSchemaResult(schema)}\n`);
        } catch (err) {
          output.push(`## Jira: FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
        }
      } else {
        output.push("## Jira: skipped (no project key configured)\n");
      }

      // Phase 2: Confluence Spider
      const spaces = params.spaceKeys || config.confluenceSpaces || [];
      if (spaces.length > 0) {
        try {
          output.push(`## Confluence\n${await spiderSpaces(config, kb, spaces, params.maxDepth)}\n`);
        } catch (err) {
          output.push(`## Confluence: FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
        }
      } else {
        output.push("## Confluence: skipped (no spaces configured)\n");
      }

      output.push("---\nReady. Use **plan-tickets** → **create-tickets** → **get-ticket** / **update-ticket**.");
      return textResponse(output.join("\n"));
    },
  );

  // ── Discover Jira (standalone) ──

  server.tool(
    "discover-jira",
    "Discover and store the Jira project structure — issue types, fields, allowed values, priorities, board config, team. Use 'setup' instead for combined Jira + Confluence initialization.",
    {
      projectKey: z.string().optional().describe("Jira project key override"),
      boardId: z.string().optional().describe("Jira board ID override"),
    },
    async (params) => {
      const kb = getKb();
      let config: ReturnType<typeof resolveConfig>;
      try {
        config = resolveConfig(kb);
      } catch (err) {
        return errorResponse(String(err));
      }

      const projectKey = params.projectKey || config.jiraProjectKey;
      if (!projectKey) return errorResponse("No project key. Run configure with jiraProjectKey first.");

      const schema = await JiraClient.discoverSchema(config, projectKey, params.boardId || config.jiraBoardId);
      JiraClient.saveSchemaToDb(kb, schema);
      return textResponse(`Discovered ${formatSchemaResult(schema)}\n\nSchema saved.`);
    },
  );

  // ── Plan Tickets ──

  server.tool(
    "plan-tickets",
    "STEP 1 of ticket creation: Plan Jira tickets from a feature description + indexed Confluence context. Always start here — searches Confluence automatically for relevant ADRs, design docs and specs. Workflow: plan-tickets → create-tickets (dryRun=true) → review → create-tickets (dryRun=false).",
    {
      description: z.string().describe("Feature or task description to decompose into tickets"),
      spaceKey: z.string().optional().describe("Confluence space to draw context from"),
      issueType: z.string().default("Task").describe("Issue type to plan for — determines which fields are shown"),
    },
    async (params) => {
      const kb = getKb();
      const stats = kb.getStats();
      const schema = getSchema();

      // Deep Confluence context retrieval (local SQLite — thoroughness over speed)
      const ctx = retrieveConfluenceContext(kb, params.description, params.spaceKey);

      let plan = `# Ticket Plan\n\n`;
      plan += `**Feature:** ${params.description}\n`;
      plan += `**Default Type:** ${params.issueType} | **KB:** ${stats.total} pages indexed\n\n`;

      plan += buildSchemaGuidance(schema, params.issueType);
      plan += buildConfluenceSection(ctx);

      plan += `---\nUse **create-tickets** with a tickets array. Set dryRun=true to preview first.\n`;
      plan += FIELD_RULES;
      return textResponse(plan);
    },
  );

  // ── Create Tickets ──

  server.tool(
    "create-tickets",
    "Create Jira tickets from a structured plan. IMPORTANT: Use plan-tickets first to ground tickets in Confluence context. Supports dry-run preview and live creation. Descriptions are markdown → ADF.",
    {
      tickets: z.preprocess(
        jsonPreprocess,
        z.array(
          z.object({
            summary: z.string().describe("Ticket title — concise, action-oriented"),
            description: z.string().optional().describe("Markdown description with acceptance criteria"),
            issueType: z
              .string()
              .default("Task")
              .describe("Issue type (e.g. Task, Bug, Epic, Feature, Spike, Sub-task)"),
            labels: z.array(z.string()).default([]),
            storyPoints: z.number().optional().describe("Story points estimate"),
            priority: z.string().default("Medium").describe("Priority name"),
            parentKey: z.string().optional().describe("Parent issue key (e.g. BP-100)"),
            components: z.array(z.string()).default([]).describe("Component names"),
            namedFields: z
              .record(z.string(), z.string())
              .optional()
              .describe("Custom fields by display name → value name"),
          }),
        ),
      ),
      projectKey: z.string().optional().describe("Jira project key override"),
      dryRun: z.preprocess(
        boolPreprocess,
        z.boolean().default(true).describe("Preview without creating (default: true)"),
      ),
    },
    async (params) => {
      const kb = getKb();
      let config: ReturnType<typeof resolveConfig>;
      try {
        config = resolveConfig(kb);
      } catch (err) {
        return errorResponse(String(err));
      }

      const projectKey = params.projectKey || config.jiraProjectKey;

      // Dry-run preview with auto-fetched Confluence context
      if (params.dryRun) {
        const keywords = params.tickets
          .map((t) => t.summary)
          .join(" ")
          .split(/\s+/)
          .slice(0, 8)
          .join(" ");
        const chunks = kb.searchChunks(keywords, { limit: 5 });
        const fallback = chunks.length === 0 ? kb.search(keywords, { limit: 5 }) : [];

        const lines = params.tickets.map((t, i) => {
          const componentsList = t.components.join(",");
          const meta = [
            t.issueType,
            t.priority,
            t.storyPoints != null ? `${t.storyPoints}pts` : "",
            t.labels.length ? t.labels.join(",") : "",
            t.parentKey ? `parent: ${t.parentKey}` : "",
            t.components.length ? `components: ${componentsList}` : "",
          ].filter(Boolean);
          return `${i + 1}. **${t.summary}** [${meta.join(" | ")}]\n${t.description || "(no description)"}`;
        });

        const ctx = buildDryRunContext(chunks, fallback);
        const ticketCount = params.tickets.length;
        const plural = ticketCount === 1 ? "" : "s";

        return textResponse(
          `# Preview: ${ticketCount} ticket${plural}\n` +
            `Project: ${projectKey || "(not set)"}\n\n` +
            lines.join("\n\n---\n\n") +
            ctx +
            `\nSet **dryRun=false** to create in Jira.`,
        );
      }

      // Live creation
      if (!projectKey) return errorResponse("No project key. Run configure or pass projectKey.");

      const schema = getSchema();
      const jira = new JiraClient({ ...config, jiraProjectKey: projectKey }, schema);
      const inputs: JiraTicketInput[] = params.tickets.map((t) => ({
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
      const totalTickets = params.tickets.length;
      const plural = totalTickets === 1 ? "" : "s";
      let out = `# Created ${result.issues.length}/${totalTickets} ticket${plural}\n\n`;
      for (const issue of result.issues) out += `- **${issue.key}** — ${config.siteUrl}/browse/${issue.key}\n`;
      if (result.errors.length > 0) {
        out += `\n## Errors (${result.errors.length})\n`;
        for (const err of result.errors) out += `- ${err}\n`;
      }
      return result.errors.length > 0 ? errorResponse(out) : textResponse(out);
    },
  );

  // ── Get Ticket ──

  server.tool(
    "get-ticket",
    "Fetch a Jira ticket's full details — summary, description, status, priority, story points, labels, components, assignee, recent comments.",
    { issueKey: z.string().describe("Jira issue key (e.g. BP-123)") },
    async (params) => {
      const kb = getKb();
      try {
        const { jira } = buildJiraClient(kb);
        const issue = await jira.getIssue(params.issueKey);
        let out = `# ${issue.key}: ${issue.summary}\n\n`;
        out += `**Type:** ${issue.issueType} | **Status:** ${issue.status} | **Priority:** ${issue.priority}\n`;
        if (issue.storyPoints != null) out += `**Story Points:** ${issue.storyPoints}\n`;
        if (issue.assignee) out += `**Assignee:** ${issue.assignee}\n`;
        if (issue.reporter) out += `**Reporter:** ${issue.reporter}\n`;
        if (issue.parentKey) out += `**Parent:** ${issue.parentKey}\n`;
        if (issue.labels.length) out += `**Labels:** ${issue.labels.join(", ")}\n`;
        if (issue.components.length) out += `**Components:** ${issue.components.join(", ")}\n`;
        out += `**Created:** ${issue.created} | **Updated:** ${issue.updated}\n`;
        out += `**URL:** ${issue.url}\n`;
        if (issue.description) out += `\n## Description\n${issue.description}\n`;
        if (issue.comments.length) {
          out += `\n## Recent Comments (${issue.comments.length})\n`;
          for (const c of issue.comments) out += `\n**${c.author}** (${c.created}):\n${c.body}\n`;
        }
        return textResponse(out);
      } catch (err) {
        return errorResponse(`Failed to fetch ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── Update Ticket ──

  server.tool(
    "update-ticket",
    "Update an existing Jira ticket. Only provided fields are modified. Supports summary, description, priority, labels, story points, components, custom fields, and comments.",
    {
      issueKey: z.string().describe("Jira issue key (e.g. BP-123)"),
      summary: z.string().optional().describe("New ticket title"),
      description: z.string().optional().describe("New markdown description (replaces existing)"),
      priority: z.string().optional().describe("New priority name"),
      labels: z.array(z.string()).optional().describe("Replace all labels"),
      storyPoints: z.number().optional().describe("New story points estimate"),
      components: z.array(z.string()).optional().describe("Replace all components"),
      namedFields: z.record(z.string(), z.string()).optional().describe("Custom fields by display name → value name"),
      comment: z.string().optional().describe("Add a comment (markdown → ADF)"),
    },
    async (params) => {
      const kb = getKb();
      try {
        const { jira, config } = buildJiraClient(kb);
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
        });
        const url = `${config.siteUrl}/browse/${params.issueKey}`;
        const changes = [
          params.summary && `Summary: ${params.summary}`,
          params.description && "Description: updated",
          params.priority && `Priority: ${params.priority}`,
          params.labels && `Labels: ${params.labels.join(", ")}`,
          params.storyPoints != null && `Story Points: ${params.storyPoints}`,
          params.components && `Components: ${params.components.join(", ")}`,
          params.namedFields && `Custom fields: ${Object.keys(params.namedFields).join(", ")}`,
          params.comment && "Comment: added",
        ].filter(Boolean);
        const changesList = changes.map((c) => `- ${c}`).join("\n");
        return textResponse(
          `Updated **${params.issueKey}** — ${url}\n\nChanges:\n${changesList}`,
        );
      } catch (err) {
        return errorResponse(
          `Failed to update ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
