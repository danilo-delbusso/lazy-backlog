import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";

/** Handle the 'get' action (single or bulk fetch with dev status enrichment). */
export async function handleGetAction(
  params: {
    issueKey?: string;
    issueKeys?: string[];
  },
  kb: KnowledgeBase,
) {
  const keys = params.issueKeys?.length ? params.issueKeys : params.issueKey ? [params.issueKey] : [];
  if (keys.length === 0) return errorResponse("issueKey or issueKeys is required for 'get' action.");

  try {
    const { jira } = buildJiraClient(kb);

    // Single issue — full details with links and comments
    if (keys.length === 1) {
      const key = keys[0] as string;
      const issue = await jira.getIssue(key);
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

      // Dev status (PRs, commits, builds)
      const dev = await jira.getDevStatus(issue.id);
      const devParts = [
        dev.pullRequests > 0 ? `${dev.pullRequests} PR(s)` : "No PRs",
        dev.commits > 0 ? `${dev.commits} commit(s)` : "No commits",
        dev.builds > 0 ? `${dev.builds} build(s)` : null,
      ].filter(Boolean);
      out += `**Dev Activity:** ${devParts.join(" | ")}\n`;

      if (issue.description) out += `\n## Description\n${issue.description}\n`;

      // Issue links
      try {
        const links = await (
          jira as unknown as {
            getIssueLinks(
              key: string,
            ): Promise<
              Array<{ direction: string; linkType: string; issueKey: string; status: string; summary: string }>
            >;
          }
        ).getIssueLinks(key);
        if (links.length > 0) {
          out += "\n**Links:**\n";
          for (const link of links) {
            const arrow = link.direction === "outward" ? "\u2192" : "\u2190";
            out += `- ${link.linkType} ${arrow} ${link.issueKey} (${link.status}): ${link.summary}\n`;
          }
        }
      } catch {
        /* links are best-effort */
      }

      if (issue.comments.length) {
        out += `\n## Recent Comments (${issue.comments.length})\n`;
        for (const c of issue.comments) out += `\n**${c.author}** (${c.created}):\n${c.body}\n`;
      }
      return textResponse(out);
    }

    // Bulk fetch — summary table + condensed details per issue
    let out = `# Bulk Fetch (${keys.length} issues)\n\n`;
    out += `| Key | Summary | Type | Status | Priority | PRs | Commits |\n`;
    out += `|-----|---------|------|--------|----------|-----|--------|\n`;
    const issueResults = await Promise.all(
      keys.map((k) =>
        jira.getIssue(k).catch((err) => ({ key: k, error: err instanceof Error ? err.message : String(err) })),
      ),
    );
    const devResults = await Promise.all(
      issueResults.map((issue) => ("error" in issue ? Promise.resolve(null) : jira.getDevStatus(issue.id))),
    );

    const fetched: Array<{
      key: string;
      summary: string;
      description?: string;
      comments: Array<{ author: string; created: string; body: string }>;
      dev: { pullRequests: number; commits: number };
    }> = [];
    for (let idx = 0; idx < issueResults.length; idx++) {
      const issue = issueResults[idx];
      const dev = devResults[idx];
      if (!issue || "error" in issue) {
        const key = issue ? issue.key : (keys[idx] ?? "?");
        out += `| ${key} | **ERROR:** ${"error" in (issue ?? {}) ? (issue as { error: string }).error : "unknown"} | - | - | - | - | - |\n`;
        continue;
      }
      const prs = dev?.pullRequests ?? 0;
      const commits = dev?.commits ?? 0;
      out += `| ${issue.key} | ${issue.summary} | ${issue.issueType} | ${issue.status} | ${issue.priority} | ${prs || "None"} | ${commits || "None"} |\n`;
      fetched.push({ ...issue, dev: { pullRequests: prs, commits } });
    }

    // Flag issues with no dev activity
    const noDevActivity = fetched.filter((i) => i.dev.pullRequests === 0 && i.dev.commits === 0);
    if (noDevActivity.length > 0) {
      out += `\n## No Dev Activity (${noDevActivity.length})\n`;
      for (const issue of noDevActivity) {
        out += `- **${issue.key}** (${issue.summary})\n`;
      }
    }

    // Condensed details for each successfully fetched issue
    for (const issue of fetched) {
      out += `\n---\n## ${issue.key}: ${issue.summary}\n`;
      if (issue.description) out += `${issue.description}\n`;
      if (issue.comments.length > 0) {
        const latest = issue.comments[issue.comments.length - 1];
        if (latest)
          out += `\n*Latest comment by ${latest.author} (${latest.created}):* ${latest.body.slice(0, 200)}${latest.body.length > 200 ? "..." : ""}\n`;
      }
    }

    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Handle the 'search' action. */
export async function handleSearchAction(
  params: {
    jql?: string;
    maxResults?: number;
  },
  kb: KnowledgeBase,
) {
  if (!params.jql) return errorResponse("jql is required for 'search' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    const boardId = config.jiraBoardId;
    // Auto-scope to configured project if JQL doesn't already specify one
    let jql = params.jql;
    if (config.jiraProjectKey && !/\bproject\s*[=!]/i.test(jql)) {
      const orderMatch = jql.match(/\s+(ORDER\s+BY\s+.+)$/i);
      const orderClause = orderMatch ? ` ${orderMatch[1]}` : "";
      const filterPart = orderMatch ? jql.slice(0, orderMatch.index) : jql;
      jql = `project = ${config.jiraProjectKey} AND (${filterPart})${orderClause}`;
    }
    // Some queries must use project-scoped JQL search instead of board-scoped Agile API:
    // - Epics are project-level and don't appear on boards
    // - History operators (was, changed, closedSprints) aren't supported by Agile endpoints
    const isEpicQuery = /\btype\s*=\s*Epic\b/i.test(jql) || /\bissuetype\s*=\s*Epic\b/i.test(jql);
    const hasHistoryOps = /\b(was|changed|closedSprints|openSprints|futureSprints)\b/i.test(jql);
    const useProjectSearch = isEpicQuery || hasHistoryOps;
    const result =
      boardId && !useProjectSearch
        ? await jira.searchBoardIssues(boardId, jql, params.maxResults)
        : await jira.searchIssues(jql, undefined, params.maxResults);

    if (result.issues.length === 0) {
      return textResponse(`No issues found for JQL: \`${params.jql}\``);
    }

    let out = `# Search Results (${result.issues.length}/${result.total})\n\n`;
    out += `| Key | Summary | Status | Priority | Assignee |\n`;
    out += `|-----|---------|--------|----------|----------|\n`;
    for (const issue of result.issues) {
      out += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
    }
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
