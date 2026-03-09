import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageSummary } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { appendSection, formatSummaryLine, registerContextTools } from "../tools/context.js";
import { createMockServer } from "./helpers/mock-server.js";

/** Create a minimal PageSummary for testing. */
function makeSummary(overrides: Partial<PageSummary> = {}): PageSummary {
	return {
		id: overrides.id ?? "page-1",
		title: overrides.title ?? "Test Page",
		space_key: overrides.space_key ?? "ENG",
		page_type: overrides.page_type ?? "design",
		url: overrides.url ?? "https://wiki.example.com/page-1",
		labels: overrides.labels ?? '["design"]',
		content_preview: overrides.content_preview ?? "This is a preview of the page content.",
		updated_at: overrides.updated_at ?? "2025-06-01",
	};
}

// ── formatSummaryLine ────────────────────────────────────────────────────────

describe("formatSummaryLine", () => {
	it("formats a summary with title, space, labels, and preview", () => {
		const result = formatSummaryLine(makeSummary());
		expect(result).toContain("**Test Page**");
		expect(result).toContain("(ENG)");
		expect(result).toContain("[design]");
		expect(result).toContain("This is a preview");
	});

	it("replaces newlines in preview with spaces", () => {
		const result = formatSummaryLine(makeSummary({ content_preview: "Line 1\nLine 2\nLine 3" }));
		expect(result).toContain("Line 1 Line 2 Line 3");
	});
});

// ── appendSection ────────────────────────────────────────────────────────────

describe("appendSection", () => {
	it("emits heading and items", () => {
		const pages = [makeSummary({ title: "ADR-001" }), makeSummary({ title: "ADR-002" })];
		const parts: string[] = [];
		const remaining = appendSection(pages, "ADRs", 10, 5000, (s) => parts.push(s));

		const output = parts.join("");
		expect(output).toContain("## ADRs (2)");
		expect(output).toContain("### ADR-001");
		expect(output).toContain("### ADR-002");
		expect(remaining).toBeLessThan(5000);
	});

	it("returns budget unchanged for empty pages", () => {
		const remaining = appendSection([], "Empty", 10, 5000, () => {});
		expect(remaining).toBe(5000);
	});

	it("returns budget unchanged when budget is 0", () => {
		const pages = [makeSummary()];
		const remaining = appendSection(pages, "Test", 10, 0, () => {});
		expect(remaining).toBe(0);
	});

	it("truncates with '…and N more' when budget runs low", () => {
		const pages = Array.from({ length: 10 }, (_, i) =>
			makeSummary({ title: `Page ${i}`, content_preview: "A".repeat(200) }),
		);
		const parts: string[] = [];
		appendSection(pages, "Docs", 10, 400, (s) => parts.push(s));

		const output = parts.join("");
		expect(output).toContain("…and");
		expect(output).toContain("more");
	});

	it("respects maxItems limit", () => {
		const pages = Array.from({ length: 5 }, (_, i) => makeSummary({ title: `P${i}` }));
		const parts: string[] = [];
		appendSection(pages, "Docs", 2, 10000, (s) => parts.push(s));

		const output = parts.join("");
		expect(output).toContain("### P0");
		expect(output).toContain("### P1");
		expect(output).not.toContain("### P2");
	});
});

// ── registerContextTools (tool callbacks) ────────────────────────────────────

describe("registerContextTools", () => {
	let kb: KnowledgeBase;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lb-ctx-test-"));
		kb = new KnowledgeBase(join(tmpDir, "test.db"));
	});

	afterEach(() => {
		kb.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("registers all expected tools", () => {
		const { server, toolNames } = createMockServer();
		registerContextTools(server, () => kb);
		expect(toolNames()).toContain("search");
		expect(toolNames()).toContain("get-page");
		expect(toolNames()).toContain("get-adrs");
		expect(toolNames()).toContain("get-context-summary");
		expect(toolNames()).toContain("kb-stats");
	});

	describe("search tool", () => {
		it("returns chunk results when available", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "p1", space_key: "ENG", title: "Auth Design", url: "https://wiki.example.com/p1",
				content: "OAuth2 authentication flow", page_type: "design", labels: '["auth"]',
				parent_id: null, author_id: null, created_at: null, updated_at: "2025-01-01", indexed_at: new Date().toISOString(),
			});
			kb.upsertChunks("p1", [
				{ breadcrumb: "Auth > OAuth2", heading: "Token Flow", depth: 2, content: "OAuth2 token refresh mechanism details", index: 0 },
			]);

			const search = getTool("search")!;
			const result = await search({ query: "OAuth2", limit: 5 });
			expect(result.content[0]!.text).toContain("results");
			expect(result.content[0]!.text).toContain("Auth Design");
		});

		it("falls back to page-level search when no chunks", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "p1", space_key: "ENG", title: "DB Migration", url: null,
				content: "PostgreSQL migration guide", page_type: "runbook", labels: "[]",
				parent_id: null, author_id: null, created_at: null, updated_at: null, indexed_at: new Date().toISOString(),
			});

			const search = getTool("search")!;
			const result = await search({ query: "PostgreSQL", limit: 5 });
			expect(result.content[0]!.text).toContain("DB Migration");
		});

		it("returns no results message", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			const search = getTool("search")!;
			const result = await search({ query: "nonexistent", limit: 5 });
			expect(result.content[0]!.text).toContain("No results");
		});
	});

	describe("get-page tool", () => {
		it("returns page content", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "p1", space_key: "ENG", title: "Auth Design", url: "https://wiki.example.com/p1",
				content: "Full page content here", page_type: "design", labels: '["auth"]',
				parent_id: null, author_id: null, created_at: null, updated_at: "2025-01-01", indexed_at: new Date().toISOString(),
			});

			const getPage = getTool("get-page")!;
			const result = await getPage({ pageId: "p1" });
			expect(result.content[0]!.text).toContain("Auth Design");
			expect(result.content[0]!.text).toContain("Full page content here");
		});

		it("returns error for missing page", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			const getPage = getTool("get-page")!;
			const result = await getPage({ pageId: "nonexistent" });
			expect(result.isError).toBe(true);
		});

		it("truncates long content", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "p1", space_key: "ENG", title: "Big Page", url: null,
				content: "A".repeat(20000), page_type: "other", labels: "[]",
				parent_id: null, author_id: null, created_at: null, updated_at: null, indexed_at: new Date().toISOString(),
			});

			const getPage = getTool("get-page")!;
			const result = await getPage({ pageId: "p1" });
			expect(result.content[0]!.text).toContain("truncated");
		});
	});

	describe("get-adrs tool", () => {
		it("returns ADR list", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "a1", space_key: "ENG", title: "ADR-001: Use Postgres", url: null,
				content: "Decision record", page_type: "adr", labels: '["adr"]',
				parent_id: null, author_id: null, created_at: null, updated_at: null, indexed_at: new Date().toISOString(),
			});

			const getAdrs = getTool("get-adrs")!;
			const result = await getAdrs({});
			expect(result.content[0]!.text).toContain("1 ADRs");
			expect(result.content[0]!.text).toContain("ADR-001");
		});

		it("returns message when no ADRs", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			const getAdrs = getTool("get-adrs")!;
			const result = await getAdrs({});
			expect(result.content[0]!.text).toContain("No ADRs found");
		});
	});

	describe("get-context-summary tool", () => {
		it("returns synthesized context", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "a1", space_key: "ENG", title: "ADR-001", url: null,
				content: "Use PostgreSQL for persistence", page_type: "adr", labels: '["adr"]',
				parent_id: null, author_id: null, created_at: null, updated_at: null, indexed_at: new Date().toISOString(),
			});
			kb.upsertPage({
				id: "d1", space_key: "ENG", title: "Auth Design", url: null,
				content: "OAuth2 service design", page_type: "design", labels: '["design"]',
				parent_id: null, author_id: null, created_at: null, updated_at: null, indexed_at: new Date().toISOString(),
			});

			const getSummary = getTool("get-context-summary")!;
			const result = await getSummary({});
			expect(result.content[0]!.text).toContain("Project Context");
			expect(result.content[0]!.text).toContain("ADRs");
		});

		it("returns error when KB is empty", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			const getSummary = getTool("get-context-summary")!;
			const result = await getSummary({});
			expect(result.isError).toBe(true);
		});
	});

	describe("kb-stats tool", () => {
		it("returns stats when pages exist", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			kb.upsertPage({
				id: "p1", space_key: "ENG", title: "Page", url: null,
				content: "Content", page_type: "adr", labels: "[]",
				parent_id: null, author_id: null, created_at: null, updated_at: null, indexed_at: new Date().toISOString(),
			});

			const kbStats = getTool("kb-stats")!;
			const result = await kbStats({});
			expect(result.content[0]!.text).toContain("Total: 1");
			expect(result.content[0]!.text).toContain("adr");
		});

		it("returns empty message when no pages", async () => {
			const { server, getTool } = createMockServer();
			registerContextTools(server, () => kb);

			const kbStats = getTool("kb-stats")!;
			const result = await kbStats({});
			expect(result.content[0]!.text).toContain("empty");
		});
	});
});
