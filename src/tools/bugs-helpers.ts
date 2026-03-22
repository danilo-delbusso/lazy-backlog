import type { ProjectConfig } from "../config/schema.js";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";
import type { PatternInsight } from "../lib/team-insights-types.js";
import { DEFAULT_RULES, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions, formatConventionsSection } from "../lib/team-rules-format.js";
import { assessCompleteness, inferSeverity, type ToolResponse } from "./bugs.js";

// ── Rework risk helpers ─────────────────────────────────────────────────────

function loadReworkRates(kb: KnowledgeBase): PatternInsight["reworkRates"] {
  try {
    const patternsRaw = kb.getInsights("patterns");
    if (patternsRaw.length === 0) return [];
    const patterns = JSON.parse(patternsRaw[0]?.data ?? "{}") as PatternInsight;
    return patterns.reworkRates ?? [];
  } catch {
    return [];
  }
}

function formatReworkWarning(components: string[], reworkRates: PatternInsight["reworkRates"]): string {
  if (components.length === 0 || reworkRates.length === 0) return "";

  const warnings: string[] = [];
  for (const comp of components) {
    const rework = reworkRates.find((r) => r.component === comp);
    if (rework && rework.reopenRate > 0.15) {
      warnings.push(
        `- **${comp}:** ${Math.round(rework.reopenRate * 100)}% reopen rate (${rework.reopenedTickets}/${rework.totalTickets} tickets)`,
      );
    }
  }

  if (warnings.length === 0) return "";
  return `## Risk Warning\n\n${warnings.join("\n")}\n> Consider extra review/testing for these components.\n\n`;
}

// ── Convention helpers ──────────────────────────────────────────────────────

function formatConventions(
  issue: { summary: string; description?: string; labels: string[]; components: string[] },
  kb: KnowledgeBase,
): string {
  try {
    const teamRules = kb.getTeamRules();
    if (teamRules.length === 0) return "";
    const rules = teamRules.map((r) => ({
      category: r.category,
      rule_key: r.rule_key,
      issue_type: r.issue_type,
      rule_value: r.rule_value,
      confidence: r.confidence,
      sample_size: r.sample_size,
    }));
    const merged = mergeWithDefaults(rules, DEFAULT_RULES);
    const conventions = evaluateConventions(
      {
        summary: issue.summary,
        description: issue.description,
        issueType: "Bug",
        labels: issue.labels,
        components: issue.components,
      },
      merged,
    );
    const text = formatConventionsSection(conventions);
    return text ? `## Team Conventions\n\n${text}\n\n` : "";
  } catch {
    return "";
  }
}

// ── Completeness section ────────────────────────────────────────────────────

function formatCompleteness(score: number, missing: string[]): string {
  let out = "## Completeness\n\n";
  out += `**Score:** ${score}%\n`;
  if (missing.length > 0) {
    out += "**Missing:**\n";
    for (const m of missing) out += `- ${m}\n`;
  } else {
    out += "**Status:** Complete\n";
  }
  return out + "\n";
}

// ── Single-issue triage ─────────────────────────────────────────────────────

async function triageSingleIssue(
  issueKey: string,
  params: { severity?: string; autoUpdate?: boolean; autoAssign?: boolean },
  jira: JiraClient,
  config: ProjectConfig,
  kb: KnowledgeBase,
): Promise<string> {
  const issue = await jira.getIssue(issueKey);
  const text = `${issue.summary} ${issue.description || ""}`;

  let out = `# Triage: ${issueKey}\n\n`;

  // ── Completeness ──────────────────────────────────────────────────────────
  const { score, missing } = assessCompleteness(issue.description, issue.labels, issue.components);
  out += formatCompleteness(score, missing);

  // Auto-comment on incomplete bugs
  if (score < 60 && (params.autoUpdate ?? false)) {
    const missingList = missing.map((m) => `- ${m}`).join("\n");
    const comment = `This bug report is incomplete (score: ${score}%). Please add:\n${missingList}`;
    await jira.addComment(issueKey, comment);
    await jira.addLabels(issueKey, ["needs-info"]);
    out += "*Comment added + labeled `needs-info`*\n\n";
  }

  // ── Severity ──────────────────────────────────────────────────────────────
  const inferred = inferSeverity(text);
  const severity = params.severity || inferred.severity;

  out += "## Severity\n\n";
  out += "| Key | Current | Recommended | Rationale |\n";
  out += "|-----|---------|-------------|----------|\n";
  out += `| ${issueKey} | ${issue.priority || "Unknown"} | ${inferred.severity} | ${inferred.matches.join(", ")} |\n\n`;

  if (params.autoUpdate && inferred.severity.toLowerCase() !== (issue.priority || "").toLowerCase()) {
    await jira.updateIssue({ issueKey, priority: inferred.severity });
    out += "*Priority updated.*\n\n";
  }

  // ── Recommendation (sprint assignment) ────────────────────────────────────
  const boardId = config.jiraBoardId;
  if (boardId) {
    out += await assignSprint(issueKey, severity, jira, boardId, params.autoAssign ?? false);
  }

  // ── Team Conventions ──────────────────────────────────────────────────────
  out += formatConventions(
    { summary: issue.summary, description: issue.description, labels: issue.labels, components: issue.components },
    kb,
  );

  // ── Rework Risk Warning ───────────────────────────────────────────────────
  const reworkRates = loadReworkRates(kb);
  out += formatReworkWarning(issue.components, reworkRates);

  return out;
}

// ── Sprint assignment helpers ───────────────────────────────────────────────

async function assignSprint(
  issueKey: string,
  severity: string,
  jira: JiraClient,
  boardId: string,
  autoAssign: boolean,
): Promise<string> {
  let out = "## Recommendation\n\n";
  out += `**Severity:** ${severity}\n\n`;

  if (severity === "critical") {
    return out + (await assignCriticalSprint(issueKey, jira, boardId, severity, autoAssign));
  }

  if (severity === "high") {
    return out + (await assignHighSprint(issueKey, jira, boardId, severity, autoAssign));
  }

  return out + (await assignLowSprint(issueKey, jira, boardId, severity, autoAssign));
}

async function assignCriticalSprint(
  issueKey: string,
  jira: JiraClient,
  boardId: string,
  severity: string,
  autoAssign: boolean,
): Promise<string> {
  const activeSprints = await jira.listSprints(boardId, "active");
  const sprint = activeSprints[0];
  if (!sprint) return "No active sprint found. Create one first.\n\n";

  const { issues: sprintIssues } = await jira.getSprintIssues(String(sprint.id));
  const spField = jira.storyPointsFieldId;
  const getSP = (f: Record<string, unknown>) =>
    (spField ? (f[spField] as number | undefined) : undefined) ??
    (f.story_points as number | undefined) ??
    (f.customfield_10016 as number | undefined) ??
    0;
  const todoItems = sprintIssues
    .filter((i) => i.fields.status?.name === "To Do")
    .sort((a, b) => getSP(a.fields as Record<string, unknown>) - getSP(b.fields as Record<string, unknown>));

  let out = `**Recommendation:** Add to current sprint "${sprint.name}"\n`;
  const tradeOff = todoItems[0];
  if (tradeOff) {
    out += `**Trade-off suggestion:** Consider deferring ${tradeOff.key} (${tradeOff.fields.summary})\n`;
  }

  if (autoAssign) {
    await jira.moveIssuesToSprint(String(sprint.id), [issueKey]);
    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${sprint.name}".`);
    out += "\n*Issue moved to sprint + comment added.*\n";
  }

  return out + "\n";
}

async function assignHighSprint(
  issueKey: string,
  jira: JiraClient,
  boardId: string,
  severity: string,
  autoAssign: boolean,
): Promise<string> {
  const futureSprints = await jira.listSprints(boardId, "future");
  const nextSprint = futureSprints[0];
  if (!nextSprint) return "No future sprints found. Create one or use the active sprint.\n\n";

  let out = `**Recommendation:** Add to next sprint "${nextSprint.name}"\n`;

  if (autoAssign) {
    await jira.moveIssuesToSprint(String(nextSprint.id), [issueKey]);
    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${nextSprint.name}".`);
    out += "\n*Issue moved to sprint + comment added.*\n";
  }

  return out + "\n";
}

async function assignLowSprint(
  issueKey: string,
  jira: JiraClient,
  boardId: string,
  severity: string,
  autoAssign: boolean,
): Promise<string> {
  const futureSprints = await jira.listSprints(boardId, "future");
  const lastSprint = futureSprints.at(-1);
  if (!lastSprint) return "No future sprints available. Leave in backlog.\n\n";

  let out = `**Recommendation:** Add to backlog or future sprint "${lastSprint.name}"\n`;

  if (autoAssign) {
    await jira.moveIssuesToSprint(String(lastSprint.id), [issueKey]);
    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${lastSprint.name}".`);
    out += "\n*Issue moved to sprint + comment added.*\n";
  }

  return out + "\n";
}

// ── Multi-issue triage report ───────────────────────────────────────────────

async function triageReport(issueKeys: string[], jira: JiraClient, kb: KnowledgeBase): Promise<string> {
  const severityCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const incomplete: string[] = [];
  const reworkRates = loadReworkRates(kb);
  const riskyComponents: string[] = [];

  for (const key of issueKeys) {
    const issue = await jira.getIssue(key);
    const { severity } = inferSeverity(`${issue.summary} ${issue.description || ""}`);
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    statusCounts[issue.status] = (statusCounts[issue.status] || 0) + 1;

    const { score } = assessCompleteness(issue.description, issue.labels, issue.components);
    if (score < 60) incomplete.push(key);

    // Track risky components
    for (const comp of issue.components) {
      const rework = reworkRates.find((r) => r.component === comp);
      if (rework && rework.reopenRate > 0.15 && !riskyComponents.includes(comp)) {
        riskyComponents.push(comp);
      }
    }
  }

  let out = `# Triage Report (${issueKeys.length} bugs)\n\n`;
  out += "## Severity Distribution\n\n";
  for (const [sev, count] of Object.entries(severityCounts)) {
    out += `- **${sev}:** ${count}\n`;
  }
  out += "\n## Status Distribution\n\n";
  for (const [status, count] of Object.entries(statusCounts)) {
    out += `- **${status}:** ${count}\n`;
  }
  if (incomplete.length > 0) {
    out += `\n## Incomplete Bugs (${incomplete.length})\n\n`;
    out += incomplete.map((k) => `- ${k}`).join("\n");
    out += "\n";
  }
  if (riskyComponents.length > 0) {
    out += "\n## Risk Warning\n\n";
    for (const comp of riskyComponents) {
      const rework = reworkRates.find((r) => r.component === comp);
      if (rework) {
        out += `- **${comp}:** ${Math.round(rework.reopenRate * 100)}% reopen rate\n`;
      }
    }
    out += "\n";
  }
  return out;
}

// ── Public handler ──────────────────────────────────────────────────────────

export async function handleTriage(
  params: {
    issueKeys: string[];
    severity?: string;
    autoUpdate?: boolean;
    autoAssign?: boolean;
  },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.issueKeys?.length) {
    return errorResponse("issueKeys required for triage action.");
  }
  try {
    const { jira, config } = buildJiraClient(kb);

    if (params.issueKeys.length === 1) {
      const issueKey = params.issueKeys[0] as string;
      const out = await triageSingleIssue(issueKey, params, jira, config, kb);
      return textResponse(out);
    }

    const out = await triageReport(params.issueKeys, jira, kb);
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
