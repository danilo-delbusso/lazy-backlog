import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BUG_JQL = 'type = Bug AND status = "To Do" AND sprint is EMPTY ORDER BY created DESC';

const SEVERITY_KEYWORDS: Record<string, string[]> = {
  critical: ["data loss", "security", "crash", "production down", "outage"],
  high: ["blocks", "blocking", "broken", "regression", "all users"],
  low: ["cosmetic", "typo", "minor", "edge case", "workaround"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Infer severity from issue text content. */
function inferSeverity(text: string): { severity: string; matches: string[] } {
  const lower = text.toLowerCase();
  const matches: string[] = [];

  for (const keyword of SEVERITY_KEYWORDS.critical ?? []) {
    if (lower.includes(keyword)) matches.push(`critical: "${keyword}"`);
  }
  if (matches.length > 0) return { severity: "critical", matches };

  for (const keyword of SEVERITY_KEYWORDS.high ?? []) {
    if (lower.includes(keyword)) matches.push(`high: "${keyword}"`);
  }
  if (matches.length > 0) return { severity: "high", matches };

  for (const keyword of SEVERITY_KEYWORDS.low ?? []) {
    if (lower.includes(keyword)) matches.push(`low: "${keyword}"`);
  }
  if (matches.length > 0) return { severity: "low", matches };

  return { severity: "medium", matches: ["no specific keywords found"] };
}

/** Score a bug's completeness (0-100). */
function assessCompleteness(
  description: string | undefined,
  labels: string[],
  components: string[],
): {
  score: number;
  missing: string[];
} {
  let score = 0;
  const missing: string[] = [];
  const desc = description || "";

  if (desc.length > 50) {
    score += 25;
  } else {
    missing.push("Detailed description (>50 chars)");
  }

  const lowerDesc = desc.toLowerCase();
  if (lowerDesc.includes("steps to reproduce") || lowerDesc.includes("steps to repro")) {
    score += 25;
  } else {
    missing.push("Steps to reproduce");
  }

  if (lowerDesc.includes("expected") && lowerDesc.includes("actual")) {
    score += 20;
  } else {
    missing.push("Expected vs actual behavior");
  }

  if (lowerDesc.includes("environment") || lowerDesc.includes("version") || lowerDesc.includes("browser")) {
    score += 15;
  } else {
    missing.push("Environment/version info");
  }

  if (labels.length > 0 || components.length > 0) {
    score += 15;
  } else {
    missing.push("Labels or components");
  }

  return { score, missing };
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerBugsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "bugs",
    {
      description:
        "Bug discovery, assessment, and triage. Actions: 'find-bugs' list untriaged bugs by date range. 'search' query bugs via JQL (auto-enforces type=Bug and project filter). 'assess' score a bug report's completeness (0-100). 'triage' prioritize a bug — recommends severity, sprint placement, and trade-offs. To get full details or update a bug, use the 'issues' tool with get/update actions.",
      inputSchema: z.object({
        action: z.enum(["find-bugs", "search", "assess", "triage"]),
        // find-bugs / search params
        jql: z.string().optional().describe("[find-bugs, search] JQL query string"),
        maxResults: z.number().max(100).default(50).optional().describe("[find-bugs, search] Max issues to return"),
        dateRange: z
          .enum(["7d", "30d", "90d"])
          .default("30d")
          .optional()
          .describe("[find-bugs] Only bugs created within this window"),
        component: z.string().optional().describe("[find-bugs] Filter by component name"),
        // assess / triage params
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[assess, triage] Issue keys to assess or triage, e.g. ['BP-1','BP-2']"),
        autoComment: z
          .boolean()
          .default(true)
          .optional()
          .describe("[assess] Auto-add a comment to incomplete bugs requesting missing info"),
        // triage params
        autoUpdate: z
          .boolean()
          .default(false)
          .optional()
          .describe("[triage] Auto-update priority based on severity analysis"),
        severity: z
          .enum(["critical", "high", "medium", "low"])
          .optional()
          .describe("[triage] Override inferred severity for sprint assignment"),
        autoAssign: z.boolean().default(false).optional().describe("[triage] Auto-move issue to recommended sprint"),
      }),
    },
    async (params) => {
      const kb = getKb();

      // ── FIND-BUGS ──
      if (params.action === "find-bugs") {
        try {
          const { jira, config } = buildJiraClient(kb);
          let jql = params.jql || DEFAULT_BUG_JQL;
          if (!params.jql) {
            if (params.dateRange) {
              jql = jql.replace("ORDER BY", `AND created >= -${params.dateRange} ORDER BY`);
            }
            if (params.component) {
              const escaped = params.component.replace(/'/g, "\\'");
              jql = jql.replace("ORDER BY", `AND component = '${escaped}' ORDER BY`);
            }
          }
          const maxResults = params.maxResults ?? 20;
          const boardId = config.jiraBoardId;
          const { issues, total } = boardId
            ? await jira.searchBoardIssues(boardId, jql, maxResults)
            : await jira.searchIssues(jql, undefined, maxResults);

          if (issues.length === 0) {
            return textResponse("# Bug Triage\n\nNo untriaged bugs found matching criteria.");
          }

          let out = `# Untriaged Bugs (${issues.length} of ${total})\n\n`;
          out += "| Key | Summary | Reporter | Created | Priority |\n";
          out += "|-----|---------|----------|---------|----------|\n";
          for (const i of issues) {
            const f = i.fields;
            const reporter = (f as Record<string, unknown>).reporter as { displayName?: string } | undefined;
            const reporterName = reporter?.displayName || "Unknown";
            out += `| ${i.key} | ${(f.summary || "").slice(0, 50)} | ${reporterName} | ${(f.created || "").slice(0, 10)} | ${f.priority?.name || "None"} |\n`;
          }
          out += `\nUse \`assess\` with issueKeys to check completeness.`;
          return textResponse(out);
        } catch (err: unknown) {
          return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── SEARCH (bug-scoped JQL) ──
      if (params.action === "search") {
        if (!params.jql) return errorResponse("jql is required for 'search' action.");
        try {
          const { jira, config } = buildJiraClient(kb);
          let jql = params.jql;
          // Strip ORDER BY before wrapping
          const orderMatch = jql.match(/\s+(ORDER\s+BY\s+.+)$/i);
          const orderClause = orderMatch ? ` ${orderMatch[1]}` : "";
          const filterPart = orderMatch ? jql.slice(0, orderMatch.index) : jql;

          // Enforce type = Bug
          const bugFilter = /\btype\s*[=!]/i.test(filterPart) ? filterPart : `type = Bug AND (${filterPart})`;

          // Auto-scope to configured project
          const projectScoped =
            config.jiraProjectKey && !/\bproject\s*[=!]/i.test(bugFilter)
              ? `project = ${config.jiraProjectKey} AND (${bugFilter})`
              : bugFilter;

          jql = `${projectScoped}${orderClause}`;
          const maxResults = params.maxResults ?? 50;
          const boardId = config.jiraBoardId;
          const result = boardId
            ? await jira.searchBoardIssues(boardId, jql, maxResults)
            : await jira.searchIssues(jql, undefined, maxResults);

          if (result.issues.length === 0) {
            return textResponse(`No bugs found for: \`${params.jql}\``);
          }

          let out = `# Bug Search (${result.issues.length}/${result.total})\n\n`;
          out += "| Key | Summary | Status | Priority | Assignee |\n";
          out += "|-----|---------|--------|----------|----------|\n";
          for (const issue of result.issues) {
            out += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
          }
          return textResponse(out);
        } catch (err: unknown) {
          return errorResponse(`Bug search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── ASSESS ──
      if (params.action === "assess") {
        if (!params.issueKeys?.length) {
          return errorResponse("issueKeys required for assess action.");
        }
        try {
          const { jira } = buildJiraClient(kb);

          let out = "# Bug Assessment\n\n";
          for (const key of params.issueKeys) {
            const issue = await jira.getIssue(key);
            const { score, missing } = assessCompleteness(issue.description, issue.labels, issue.components);

            out += `## ${key}: ${issue.summary}\n`;
            out += `**Completeness:** ${score}%\n`;

            if (missing.length > 0) {
              out += "**Missing:**\n";
              for (const m of missing) out += `- ${m}\n`;
            } else {
              out += "**Status:** Complete\n";
            }

            if (score < 60 && (params.autoComment ?? true)) {
              const comment =
                `This bug report is incomplete (score: ${score}%). Please add:\n` +
                missing.map((m) => `- ${m}`).join("\n");
              await jira.addComment(key, comment);
              await jira.addLabels(key, ["needs-info"]);
              out += "*Comment added + labeled `needs-info`*\n";
            }
            out += "\n";
          }
          return textResponse(out);
        } catch (err: unknown) {
          return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── TRIAGE (prioritize + assign-sprint + report) ──
      if (params.action === "triage") {
        if (!params.issueKeys?.length) {
          return errorResponse("issueKeys required for triage action.");
        }
        try {
          const { jira, config } = buildJiraClient(kb);

          // Single issue: prioritize + assign-sprint
          if (params.issueKeys.length === 1) {
            const issueKey = params.issueKeys[0] as string;
            const issue = await jira.getIssue(issueKey);
            const text = `${issue.summary} ${issue.description || ""}`;
            const inferred = inferSeverity(text);
            const severity = params.severity || inferred.severity;

            let out = `# Triage: ${issueKey}\n\n`;

            // Severity analysis
            out += "## Severity Analysis\n\n";
            out += "| Key | Current | Recommended | Rationale |\n";
            out += "|-----|---------|-------------|----------|\n";
            out += `| ${issueKey} | ${issue.priority || "Unknown"} | ${inferred.severity} | ${inferred.matches.join(", ")} |\n\n`;

            if (params.autoUpdate && inferred.severity.toLowerCase() !== (issue.priority || "").toLowerCase()) {
              await jira.updateIssue({ issueKey, priority: inferred.severity });
            }

            // Sprint assignment
            const boardId = config.jiraBoardId;
            if (boardId) {
              out += "## Sprint Assignment\n\n";
              out += `**Severity:** ${severity}\n\n`;

              if (severity === "critical") {
                const activeSprints = await jira.listSprints(boardId, "active");
                const sprint = activeSprints[0];
                if (!sprint) {
                  out += "No active sprint found. Create one first.\n";
                } else {
                  const { issues: sprintIssues } = await jira.getSprintIssues(String(sprint.id));
                  const spField = jira.storyPointsFieldId;
                  const getSP = (f: Record<string, unknown>) =>
                    (spField ? (f[spField] as number | undefined) : undefined) ??
                    (f.story_points as number | undefined) ??
                    (f.customfield_10016 as number | undefined) ??
                    0;
                  const todoItems = sprintIssues
                    .filter((i) => i.fields.status?.name === "To Do")
                    .sort((a, b) => {
                      const pa = getSP(a.fields as Record<string, unknown>);
                      const pb = getSP(b.fields as Record<string, unknown>);
                      return pa - pb;
                    });

                  out += `**Recommendation:** Add to current sprint "${sprint.name}"\n`;
                  const tradeOff = todoItems[0];
                  if (tradeOff) {
                    out += `**Trade-off suggestion:** Consider deferring ${tradeOff.key} (${tradeOff.fields.summary})\n`;
                  }

                  if (params.autoAssign) {
                    await jira.moveIssuesToSprint(String(sprint.id), [issueKey]);
                    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${sprint.name}".`);
                    out += "\n*Issue moved to sprint + comment added.*\n";
                  }
                }
              } else if (severity === "high") {
                const futureSprints = await jira.listSprints(boardId, "future");
                const nextSprint = futureSprints[0];
                if (!nextSprint) {
                  out += "No future sprints found. Create one or use the active sprint.\n";
                } else {
                  out += `**Recommendation:** Add to next sprint "${nextSprint.name}"\n`;

                  if (params.autoAssign) {
                    await jira.moveIssuesToSprint(String(nextSprint.id), [issueKey]);
                    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${nextSprint.name}".`);
                    out += "\n*Issue moved to sprint + comment added.*\n";
                  }
                }
              } else {
                const futureSprints = await jira.listSprints(boardId, "future");
                const lastSprint = futureSprints[futureSprints.length - 1];
                if (!lastSprint) {
                  out += "No future sprints available. Leave in backlog.\n";
                } else {
                  out += `**Recommendation:** Add to backlog or future sprint "${lastSprint.name}"\n`;

                  if (params.autoAssign) {
                    await jira.moveIssuesToSprint(String(lastSprint.id), [issueKey]);
                    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${lastSprint.name}".`);
                    out += "\n*Issue moved to sprint + comment added.*\n";
                  }
                }
              }
            }

            return textResponse(out);
          }

          // Multiple issues: triage report
          const severityCounts: Record<string, number> = {};
          const statusCounts: Record<string, number> = {};
          const incomplete: string[] = [];

          for (const key of params.issueKeys) {
            const issue = await jira.getIssue(key);
            const { severity } = inferSeverity(`${issue.summary} ${issue.description || ""}`);
            severityCounts[severity] = (severityCounts[severity] || 0) + 1;
            statusCounts[issue.status] = (statusCounts[issue.status] || 0) + 1;

            const { score } = assessCompleteness(issue.description, issue.labels, issue.components);
            if (score < 60) incomplete.push(key);
          }

          let out = `# Triage Report (${params.issueKeys.length} bugs)\n\n`;
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
          return textResponse(out);
        } catch (err: unknown) {
          return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return errorResponse(`Unknown action: ${params.action}`);
    },
  );
}
