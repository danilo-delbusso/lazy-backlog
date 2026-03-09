import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, formatLabels, textResponse } from "../lib/config.js";
import type { KnowledgeBase, PageSummary } from "../lib/db.js";

const MAX_PAGE_CHARS = 15_000;
const MAX_CONTEXT_CHARS = 20_000;

export function registerContextTools(server: McpServer, getKb: () => KnowledgeBase) {
  server.tool(
    "search",
    "Search indexed Confluence content. Returns focused section-level chunks with heading breadcrumbs (e.g. 'Architecture > Auth > OAuth2'), not full pages. Token-efficient — use this as the primary way to answer questions about project knowledge. Supports FTS5: AND, OR, NOT, \"exact phrase\".",
    {
      query: z.string().describe("Search query"),
      pageType: z.enum(["adr", "design", "runbook", "meeting", "spec", "other"]).optional(),
      spaceKey: z.string().optional(),
      limit: z.number().default(5).describe("Max results (default 5, max 10)"),
    },
    async (params) => {
      const kb = getKb();
      const limit = Math.min(params.limit, 10);

      // Try chunk search first (section-level, token-efficient)
      const chunks = kb.searchChunks(params.query, {
        pageType: params.pageType,
        spaceKey: params.spaceKey,
        limit,
      });

      if (chunks.length > 0) {
        const lines = chunks.map((c, i) => {
          const location = c.breadcrumb || c.heading || c.page_title;
          return `${i + 1}. **${c.page_title}** › ${location} [${c.page_type}]${c.url ? ` ${c.url}` : ""}\n   ${c.snippet}`;
        });

        return textResponse(
          `${chunks.length} results (section-level):\n\n${lines.join("\n\n")}` +
            `\n\nUse **get-page** with a page ID for full content if needed.`,
        );
      }

      // Fallback to page-level search (for pages not yet chunked)
      const results = kb.search(params.query, {
        pageType: params.pageType,
        spaceKey: params.spaceKey,
        limit,
      });

      if (results.length === 0) return textResponse(`No results for "${params.query}".`);

      const lines = results.map(
        (r, i) => `${i + 1}. **${r.title}** [${r.page_type}]${r.url ? ` ${r.url}` : ""}\n   ${r.snippet}`,
      );

      return textResponse(`${results.length} results:\n\n${lines.join("\n\n")}`);
    },
  );

  server.tool(
    "get-page",
    "Retrieve full content of an indexed page by its Confluence page ID. Use sparingly — prefer search for focused answers. Content is capped at 15K chars.",
    {
      pageId: z.string().describe("Confluence page ID"),
    },
    async (params) => {
      const kb = getKb();
      const page = kb.getPage(params.pageId);
      if (!page) return errorResponse(`Page ${params.pageId} not found in knowledge base.`);

      const body =
        page.content.length > MAX_PAGE_CHARS
          ? page.content.slice(0, MAX_PAGE_CHARS) + `\n\n…[truncated — ${page.content.length} chars total]`
          : page.content;

      return textResponse(
        `# ${page.title}\n` +
          `${page.page_type} | ${page.space_key} | ${formatLabels(page.labels)} | ${page.updated_at ?? "?"}\n` +
          (page.url ? `${page.url}\n` : "") +
          `---\n${body}`,
      );
    },
  );

  server.tool(
    "get-adrs",
    "List all indexed ADRs with title and content preview. Use get-page for full content.",
    {
      spaceKey: z.string().optional(),
    },
    async (params) => {
      const kb = getKb();
      const adrs = kb.getPageSummaries("adr", params.spaceKey);
      if (adrs.length === 0) return textResponse("No ADRs found. Spider a space first.");

      const text = adrs.map(formatSummaryLine).join("\n");
      return textResponse(`${adrs.length} ADRs:\n\n${text}`);
    },
  );

  server.tool(
    "get-context-summary",
    "Synthesized project context from indexed ADRs, design docs, and specs. Compact summary for use as prompt context in ticket generation.",
    {
      spaceKey: z.string().optional(),
    },
    async (params) => {
      const kb = getKb();
      const stats = kb.getStats();
      if (stats.total === 0) return errorResponse("Knowledge base empty. Run spider first.");

      const adrs = kb.getPageSummaries("adr", params.spaceKey);
      const designs = kb.getPageSummaries("design", params.spaceKey);
      const specs = kb.getPageSummaries("spec", params.spaceKey);

      let out = `# Project Context\n`;
      out += `${stats.total} pages | ${Object.entries(stats.byType)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ")}\n\n`;

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

      return textResponse(out);
    },
  );

  server.tool("kb-stats", "Knowledge base statistics: total pages, breakdown by type and space.", {}, async () => {
    const kb = getKb();
    const stats = kb.getStats();
    if (stats.total === 0) return textResponse("Knowledge base is empty.");

    const types = Object.entries(stats.byType)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    const spaces = Object.entries(stats.bySpace)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    return textResponse(`Total: ${stats.total}\n\nBy type:\n${types}\n\nBy space:\n${spaces}`);
  });
}

function formatSummaryLine(s: PageSummary): string {
  const preview = s.content_preview.replace(/\n/g, " ").trim();
  return `- **${s.title}** (${s.space_key}) [${formatLabels(s.labels)}]\n  ${preview}…`;
}

function appendSection(
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
      emit(`…and ${pages.length - i} more\n\n`);
      break;
    }
    const p = items[i]!;
    const entry = `### ${p.title}\n${p.content_preview.trim()}\n\n`;
    emit(entry);
    budget -= entry.length;
  }

  return budget;
}
