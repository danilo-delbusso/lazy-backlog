import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, formatLabels, textResponse } from "../lib/config.js";
import type { KnowledgeBase, PageSummary } from "../lib/db.js";
import { loadSchemaFromDb } from "../lib/jira-schema.js";
import { buildSuggestions } from "./suggestions.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_PAGE_CHARS = 15_000;
export const MAX_CONTEXT_CHARS = 20_000;

const STALE_CUTOFF_DAYS = 90;
const RECENT_DAYS = 7;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatSummaryLine(s: PageSummary): string {
  const preview = s.content_preview.replaceAll("\n", " ").trim();
  return `- **${s.title}** (${s.space_key}) [${formatLabels(s.labels)}]\n  ${preview}\u2026`;
}

export function appendSection(
  pages: PageSummary[],
  heading: string,
  maxItems: number,
  budget: number,
  emit: (s: string) => void,
): number {
  if (pages.length === 0 || budget <= 0) return budget;

  const header = `## ${heading} (${pages.length})\n\n`;
  emit(header);
  budget -= header.length;

  const items = pages.slice(0, maxItems);
  for (let i = 0; i < items.length; i++) {
    if (budget <= 100) {
      emit(`\u2026and ${pages.length - i} more\n\n`);
      break;
    }
    const p = items[i];
    if (!p) continue;
    const entry = `### ${p.title}\n${p.content_preview.trim()}\n\n`;
    emit(entry);
    budget -= entry.length;
  }

  return budget;
}

// ── Intelligence Helpers ─────────────────────────────────────────────────────

function formatResultSummary(items: Array<{ page_type: string; updated_at?: string | null; source?: string }>): string {
  if (items.length <= 1) return "";

  const byType: Record<string, number> = {};
  const bySrc: Record<string, number> = {};
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;

  for (const item of items) {
    byType[item.page_type] = (byType[item.page_type] || 0) + 1;
    if (item.source) bySrc[item.source] = (bySrc[item.source] || 0) + 1;
    if (item.updated_at) {
      const ts = new Date(item.updated_at).getTime();
      if (ts < oldest) oldest = ts;
      if (ts > newest) newest = ts;
    }
  }

  const typeParts = Object.entries(byType).map(([k, v]) => `${v} ${k}`);
  let summary = `\n\n**Result Summary:** ${items.length} results — ${typeParts.join(", ")}.`;

  if (newest > 0) {
    const newestDays = Math.floor((Date.now() - newest) / 86_400_000);
    const oldestDays = Math.floor((Date.now() - oldest) / 86_400_000);
    summary += ` Most recent: ${newestDays}d ago.`;
    if (oldestDays > 180) summary += ` Oldest: ${oldestDays}d ago (may need review).`;
  }
  if (Object.keys(bySrc).length > 1) {
    summary += ` Sources: ${Object.entries(bySrc)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ")}.`;
  }

  return summary;
}

// ── Action Handlers ──────────────────────────────────────────────────────────

function handleSearch(
  params: { query: string; pageType?: string; spaceKey?: string; source?: string; limit: number },
  kb: KnowledgeBase,
): ToolResponse {
  const limit = Math.min(params.limit, 10);

  const chunks = kb.searchChunks(params.query, {
    pageType: params.pageType,
    spaceKey: params.spaceKey,
    source: params.source,
    limit,
  });

  if (chunks.length > 0) {
    const lines = chunks.map((c, i) => {
      const location = c.breadcrumb || c.heading || c.page_title;
      const urlSuffix = c.url ? ` ${c.url}` : "";
      return `${i + 1}. **${c.page_title}** \u203A ${location} [${c.page_type}]${urlSuffix}\n   ${c.snippet}`;
    });

    const chunkSummary = formatResultSummary(chunks.map((c) => ({ page_type: c.page_type, source: c.source })));

    return textResponse(
      `${chunks.length} results (section-level):\n\n${lines.join("\n\n")}${chunkSummary}` +
        "\n\nUse **get-page** with a page ID for full content if needed.",
    );
  }

  const results = kb.search(params.query, {
    pageType: params.pageType,
    spaceKey: params.spaceKey,
    source: params.source,
    limit,
  });

  if (results.length === 0) return textResponse(`No results for "${params.query}".`);

  const lines = results.map((r, i) => {
    const urlSuffix = r.url ? ` ${r.url}` : "";
    return `${i + 1}. **${r.title}** [${r.page_type}]${urlSuffix}\n   ${r.snippet}`;
  });

  const pageSummary = formatResultSummary(results.map((r) => ({ page_type: r.page_type, source: r.source })));

  return textResponse(`${results.length} results:\n\n${lines.join("\n\n")}${pageSummary}`);
}

function handleStats(
  params: { source?: string; spaceKey?: string; pageType?: string },
  kb: KnowledgeBase,
): ToolResponse {
  const stats = kb.getStats();
  if (stats.total === 0) return textResponse("Knowledge base is empty.");

  // ── Counts by type / space / source ──
  const types = Object.entries(stats.byType)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const spaces = Object.entries(stats.bySpace)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  let out = `# Knowledge Base Dashboard\n\n`;
  out += `**Total pages:** ${stats.total}\n\n`;
  out += `By type:\n${types}\n\nBy space:\n${spaces}`;

  if (stats.bySource) {
    const sources = Object.entries(stats.bySource)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    out += `\n\nBy source:\n${sources}`;
  }

  // ── Coverage gap detection ──
  try {
    const gaps: string[] = [];
    if (!stats.byType.adr) gaps.push("No ADRs indexed — consider documenting architectural decisions.");
    if (!stats.byType.runbook) gaps.push("No runbooks indexed — consider documenting operational procedures.");

    const schema = loadSchemaFromDb(kb);
    if (schema) {
      const components = new Set<string>();
      for (const issueType of schema.issueTypes) {
        const compField = issueType.fields.find((f) => f.id === "components");
        for (const v of compField?.allowedValues ?? []) components.add(v.name);
      }
      if (components.size > 0) {
        const undocumented: string[] = [];
        for (const comp of components) {
          const results = kb.search(comp, { limit: 1 });
          if (results.length === 0) undocumented.push(comp);
        }
        if (undocumented.length > 0) {
          gaps.push(`No documentation found for components: ${undocumented.join(", ")}.`);
        }
      }
    }
    if (gaps.length > 0) {
      out += `\n\n**Coverage Gaps:**\n${gaps.map((g) => `- ${g}`).join("\n")}`;
    }
  } catch {
    /* graceful: skip coverage gap detection */
  }

  // ── Context summary (ADRs, designs, specs) ──
  const adrs = kb.getPageSummaries("adr", params.spaceKey, params.source);
  const designs = kb.getPageSummaries("design", params.spaceKey, params.source);
  const specs = kb.getPageSummaries("spec", params.spaceKey, params.source);

  if (adrs.length > 0 || designs.length > 0 || specs.length > 0) {
    out += "\n\n---\n\n# Context Summary\n\n";
    let budget = MAX_CONTEXT_CHARS - out.length;

    budget = appendSection(adrs, "ADRs", 20, budget, (s) => {
      out += s;
    });
    budget = appendSection(designs, "Design Docs", 10, budget, (s) => {
      out += s;
    });
    appendSection(specs, "Specs", 10, budget, (s) => {
      out += s;
    });
  }

  // ── Recent changes (last 7 days) ──
  const recentCutoff = new Date();
  recentCutoff.setDate(recentCutoff.getDate() - RECENT_DAYS);
  const recentPages = kb.getRecentlyIndexed(recentCutoff.toISOString(), params.source);

  if (recentPages.length > 0) {
    out += `\n\n---\n\n## Recent Changes (last ${RECENT_DAYS} days): ${recentPages.length}\n\n`;
    const shown = recentPages.slice(0, 10);
    for (const p of shown) {
      out += `- **${p.title}** (${p.space_key}) [${p.page_type}] indexed ${p.indexed_at.slice(0, 10)}\n`;
    }
    if (recentPages.length > 10) {
      out += `\u2026and ${recentPages.length - 10} more\n`;
    }
  } else {
    out += `\n\n---\n\n## Recent Changes (last ${RECENT_DAYS} days): none\n`;
  }

  // ── Stale docs (90-day cutoff) ──
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - STALE_CUTOFF_DAYS);
  const stalePages = kb.getStalePages(staleCutoff.toISOString(), {
    spaceKey: params.spaceKey,
    pageType: params.pageType,
    source: params.source,
  });

  if (stalePages.length > 0) {
    out += `\n## Stale Docs (>${STALE_CUTOFF_DAYS} days): ${stalePages.length}\n\n`;
    const top5 = stalePages.slice(0, 5);
    for (const p of top5) {
      const daysAgo = Math.floor(
        (Date.now() - new Date(p.updated_at ?? p.indexed_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      out += `- **${p.title}** (${p.space_key}) [${p.page_type}] \u2014 ${daysAgo}d ago\n`;
    }
    if (stalePages.length > 5) {
      out += `\u2026and ${stalePages.length - 5} more\n`;
    }
  }

  // ── KB Health Indicator ──
  const freshCount = stats.total - stalePages.length;
  const freshPct = Math.round((freshCount / stats.total) * 100);
  let health: string;
  if (freshPct > 80) {
    health = "healthy";
  } else if (freshPct >= 50) {
    health = "needs-attention";
  } else {
    health = "stale";
  }
  out += `\n## KB Health: **${health}** (${freshPct}% of pages updated within ${STALE_CUTOFF_DAYS} days)\n`;

  const suggestions = buildSuggestions("knowledge", "stats", { staleCount: stalePages.length });
  return textResponse(out + suggestions);
}

async function handleGetPage(params: { pageId?: string }, kb: KnowledgeBase): Promise<ToolResponse> {
  if (!params.pageId) return errorResponse("'pageId' is required for get-page action.");
  const page = kb.getPage(params.pageId);
  if (!page) return errorResponse(`Page ${params.pageId} not found in knowledge base.`);

  const body =
    page.content.length > MAX_PAGE_CHARS
      ? `${page.content.slice(0, MAX_PAGE_CHARS)}\n\n\u2026[truncated \u2014 ${page.content.length} chars total]`
      : page.content;

  // Freshness indicator
  let freshness = "";
  if (page.updated_at) {
    const daysAgo = Math.floor((Date.now() - new Date(page.updated_at).getTime()) / 86_400_000);
    const label = daysAgo < 30 ? "Fresh" : daysAgo < 90 ? "Aging" : "Stale — may need review";
    freshness = ` | **${label}** (${daysAgo}d ago)`;
  }

  // Related pages: search KB for pages with similar title keywords
  let relatedSection = "";
  try {
    const titleKeywords = page.title
      .split(/[\s\-_/]+/)
      .filter((w) => w.length > 3)
      .slice(0, 3)
      .join(" ");
    if (titleKeywords) {
      const related = kb.search(titleKeywords, { limit: 5 });
      const others = related.filter((r) => r.id !== page.id);
      if (others.length > 0) {
        relatedSection += `\n\n**Related pages:** ${others.map((r) => `${r.title} [${r.page_type}]`).join(", ")}`;
      }
    }
  } catch {
    /* graceful */
  }

  // Ticket references: search Jira for issues mentioning this page
  let ticketRefs = "";
  try {
    const { jira } = buildJiraClient(kb);
    const searchTerms = page.title
      .split(/\s+/)
      .slice(0, 4)
      .join(" ")
      .replace(/[\\"[\]()]/g, "");
    if (searchTerms.length > 3) {
      const { issues } = await jira.searchIssues(`summary ~ "${searchTerms}"`, undefined, 5);
      if (issues.length > 0) {
        ticketRefs = `\n**Referenced by:** ${issues.map((i) => `${i.key}`).join(", ")}`;
      }
    }
  } catch {
    /* graceful: skip if Jira not configured */
  }

  return textResponse(
    `# ${page.title}\n` +
      `${page.page_type} | ${page.space_key} | ${formatLabels(page.labels)} | ${page.updated_at ?? "?"}${freshness}\n` +
      (page.url ? `${page.url}\n` : "") +
      `---\n${body}${relatedSection}${ticketRefs}`,
  );
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerKnowledgeTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "knowledge",
    {
      description:
        "Knowledge base operations. Search indexed content from all sources (Confluence, GitHub, etc.). Use 'search' for full-text queries, 'get-page' for full content, 'stats' for KB dashboard with context summary, recent changes, stale docs, and health indicator.",
      inputSchema: z.object({
        action: z.enum(["search", "stats", "get-page"]),
        query: z.string().optional().describe("[search] Full-text search query"),
        pageId: z.string().optional().describe("[get-page] Page ID to retrieve"),
        source: z.string().optional().describe("Filter by source (e.g. 'confluence', 'github')"),
        pageType: z
          .enum(["adr", "design", "runbook", "meeting", "spec", "other"])
          .optional()
          .describe("Filter results by page type"),
        spaceKey: z.string().optional().describe("Filter by namespace/space key"),
        limit: z.number().default(5).describe("[search] Max results to return"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "search": {
          if (!params.query) {
            return handleStats(params, kb);
          }
          return handleSearch({ query: params.query, ...params }, kb);
        }
        case "stats":
          return handleStats(params, kb);
        case "get-page":
          return handleGetPage(params, kb);
        default: {
          const _exhaustive: never = params.action;
          return errorResponse(`Unknown action: ${_exhaustive}`);
        }
      }
    },
  );
}
