import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";

/** Create a minimal IndexedPage for testing. */
function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
	return {
		id: overrides.id ?? "page-1",
		space_key: overrides.space_key ?? "ENG",
		title: overrides.title ?? "Test Page",
		url: overrides.url ?? "https://wiki.example.com/page-1",
		content: overrides.content ?? "Some content about authentication and OAuth2.",
		page_type: overrides.page_type ?? "design",
		labels: overrides.labels ?? '["design","auth"]',
		parent_id: overrides.parent_id ?? null,
		author_id: overrides.author_id ?? "user-1",
		created_at: overrides.created_at ?? "2025-01-01T00:00:00Z",
		updated_at: overrides.updated_at ?? "2025-06-01T00:00:00Z",
		indexed_at: overrides.indexed_at ?? new Date().toISOString(),
	};
}

let kb: KnowledgeBase;
let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lb-test-"));
	kb = new KnowledgeBase(join(tmpDir, "test.db"));
});

afterEach(() => {
	kb.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("config", () => {
	it("returns undefined for missing key", () => {
		expect(kb.getConfig("nonexistent")).toBeUndefined();
	});

	it("stores and retrieves config values", () => {
		kb.setConfig("project", "BP");
		expect(kb.getConfig("project")).toBe("BP");
	});

	it("overwrites existing config", () => {
		kb.setConfig("key", "v1");
		kb.setConfig("key", "v2");
		expect(kb.getConfig("key")).toBe("v2");
	});
});

// ── Page CRUD ────────────────────────────────────────────────────────────────

describe("page CRUD", () => {
	it("upserts and retrieves a page by ID", () => {
		const page = makePage();
		kb.upsertPage(page);
		const result = kb.getPage("page-1");
		expect(result).toBeDefined();
		expect(result!.title).toBe("Test Page");
		expect(result!.page_type).toBe("design");
	});

	it("updates page on re-upsert", () => {
		kb.upsertPage(makePage({ title: "Original" }));
		kb.upsertPage(makePage({ title: "Updated" }));
		expect(kb.getPage("page-1")!.title).toBe("Updated");
	});

	it("returns falsy for nonexistent page", () => {
		expect(kb.getPage("nope")).toBeFalsy();
	});

	it("upserts many pages in a transaction", () => {
		const pages = Array.from({ length: 20 }, (_, i) =>
			makePage({ id: `page-${i}`, title: `Page ${i}` }),
		);
		kb.upsertMany(pages);
		expect(kb.getPage("page-0")).toBeDefined();
		expect(kb.getPage("page-19")).toBeDefined();
	});
});

// ── Stats ────────────────────────────────────────────────────────────────────

describe("getStats", () => {
	it("returns zero counts for empty DB", () => {
		const stats = kb.getStats();
		expect(stats.total).toBe(0);
	});

	it("counts pages by type and space", () => {
		kb.upsertPage(makePage({ id: "1", page_type: "adr", space_key: "ENG" }));
		kb.upsertPage(makePage({ id: "2", page_type: "adr", space_key: "ENG" }));
		kb.upsertPage(makePage({ id: "3", page_type: "design", space_key: "PM" }));

		const stats = kb.getStats();
		expect(stats.total).toBe(3);
		expect(stats.byType.adr).toBe(2);
		expect(stats.byType.design).toBe(1);
		expect(stats.bySpace.ENG).toBe(2);
		expect(stats.bySpace.PM).toBe(1);
	});
});

// ── FTS5 Search ──────────────────────────────────────────────────────────────

describe("search", () => {
	it("finds pages by keyword", () => {
		kb.upsertPage(makePage({ id: "1", content: "OAuth2 authentication flow" }));
		kb.upsertPage(makePage({ id: "2", content: "Database migration guide" }));

		const results = kb.search("OAuth2");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]!.id).toBe("1");
	});

	it("filters by page type", () => {
		kb.upsertPage(makePage({ id: "1", page_type: "adr", content: "auth decision" }));
		kb.upsertPage(makePage({ id: "2", page_type: "design", content: "auth design" }));

		const results = kb.search("auth", { pageType: "adr" });
		expect(results).toHaveLength(1);
		expect(results[0]!.page_type).toBe("adr");
	});

	it("filters by space key", () => {
		kb.upsertPage(makePage({ id: "1", space_key: "ENG", content: "terraform modules" }));
		kb.upsertPage(makePage({ id: "2", space_key: "PM", content: "terraform roadmap" }));

		const results = kb.search("terraform", { spaceKey: "ENG" });
		expect(results).toHaveLength(1);
		expect(results[0]!.space_key).toBe("ENG");
	});

	it("returns empty for no matches", () => {
		kb.upsertPage(makePage());
		expect(kb.search("zzzznonexistent")).toHaveLength(0);
	});

	it("respects limit option", () => {
		for (let i = 0; i < 20; i++) {
			kb.upsertPage(makePage({ id: `p-${i}`, content: `common keyword page ${i}` }));
		}
		const results = kb.search("common", { limit: 5 });
		expect(results).toHaveLength(5);
	});
});

// ── needsReindex ─────────────────────────────────────────────────────────────

describe("needsReindex", () => {
	it("returns true for new page", () => {
		expect(kb.needsReindex("page-new", "2025-06-01")).toBe(true);
	});

	it("returns true when page has been updated", () => {
		kb.upsertPage(makePage({ id: "page-1", updated_at: "2025-01-01T00:00:00Z" }));
		expect(kb.needsReindex("page-1", "2025-06-01T00:00:00Z")).toBe(true);
	});

	it("returns false when page is unchanged", () => {
		const ts = "2025-06-01T00:00:00Z";
		kb.upsertPage(makePage({ id: "page-1", updated_at: ts }));
		expect(kb.needsReindex("page-1", ts)).toBe(false);
	});
});

// ── rebuildFts ───────────────────────────────────────────────────────────────

describe("rebuildFts", () => {
	it("rebuilds FTS index and search still works", () => {
		kb.upsertPage(makePage({ id: "1", content: "kubernetes deployment" }));
		kb.rebuildFts();
		const results = kb.search("kubernetes");
		expect(results).toHaveLength(1);
	});
});

// ── getPagesByType ───────────────────────────────────────────────────────────

describe("getPagesByType", () => {
	it("returns pages filtered by type", () => {
		kb.upsertPage(makePage({ id: "1", page_type: "adr" }));
		kb.upsertPage(makePage({ id: "2", page_type: "design" }));
		kb.upsertPage(makePage({ id: "3", page_type: "adr" }));

		const adrs = kb.getPagesByType("adr");
		expect(adrs).toHaveLength(2);
		expect(adrs.every((p) => p.page_type === "adr")).toBe(true);
	});

	it("filters by type and space", () => {
		kb.upsertPage(makePage({ id: "1", page_type: "adr", space_key: "ENG" }));
		kb.upsertPage(makePage({ id: "2", page_type: "adr", space_key: "PM" }));

		const results = kb.getPagesByType("adr", "ENG");
		expect(results).toHaveLength(1);
		expect(results[0]!.space_key).toBe("ENG");
	});

	it("returns empty array for no matches", () => {
		expect(kb.getPagesByType("runbook")).toHaveLength(0);
	});
});

// ── getPageSummaries ─────────────────────────────────────────────────────────

describe("getPageSummaries", () => {
	it("returns summaries filtered by type", () => {
		kb.upsertPage(makePage({ id: "1", page_type: "design", title: "Auth Design" }));
		kb.upsertPage(makePage({ id: "2", page_type: "adr", title: "ADR-001" }));

		const summaries = kb.getPageSummaries("design");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.title).toBe("Auth Design");
	});

	it("filters by type and space", () => {
		kb.upsertPage(makePage({ id: "1", page_type: "design", space_key: "ENG" }));
		kb.upsertPage(makePage({ id: "2", page_type: "design", space_key: "PM" }));

		const summaries = kb.getPageSummaries("design", "ENG");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.space_key).toBe("ENG");
	});
});

// ── Chunks ───────────────────────────────────────────────────────────────────

describe("upsertChunks + searchChunks", () => {
	it("stores and searches chunks", () => {
		kb.upsertPage(makePage({ id: "p1", content: "parent page" }));
		kb.upsertChunks("p1", [
			{ breadcrumb: "Auth", heading: "OAuth2", depth: 2, content: "OAuth2 token refresh flow details", index: 0 },
			{ breadcrumb: "Auth", heading: "SAML", depth: 2, content: "SAML federation setup guide", index: 1 },
		]);

		const results = kb.searchChunks("OAuth2");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]!.heading).toBe("OAuth2");
	});

	it("replaces chunks on re-upsert", () => {
		kb.upsertPage(makePage({ id: "p1", content: "page" }));
		kb.upsertChunks("p1", [
			{ breadcrumb: "", heading: "Old", depth: 1, content: "old chunk content", index: 0 },
		]);
		kb.upsertChunks("p1", [
			{ breadcrumb: "", heading: "New", depth: 1, content: "new chunk content", index: 0 },
		]);

		const oldResults = kb.searchChunks("old chunk");
		expect(oldResults).toHaveLength(0);

		const newResults = kb.searchChunks("new chunk");
		expect(newResults.length).toBeGreaterThanOrEqual(1);
	});

	it("filters chunk search by page type", () => {
		kb.upsertPage(makePage({ id: "p1", page_type: "adr", content: "adr page" }));
		kb.upsertPage(makePage({ id: "p2", page_type: "design", content: "design page" }));
		kb.upsertChunks("p1", [
			{ breadcrumb: "", heading: "A", depth: 1, content: "kubernetes cluster setup", index: 0 },
		]);
		kb.upsertChunks("p2", [
			{ breadcrumb: "", heading: "B", depth: 1, content: "kubernetes networking design", index: 0 },
		]);

		const results = kb.searchChunks("kubernetes", { pageType: "adr" });
		expect(results).toHaveLength(1);
		expect(results[0]!.page_type).toBe("adr");
	});

	it("filters chunk search by space key", () => {
		kb.upsertPage(makePage({ id: "p1", space_key: "ENG", content: "eng page" }));
		kb.upsertPage(makePage({ id: "p2", space_key: "PM", content: "pm page" }));
		kb.upsertChunks("p1", [
			{ breadcrumb: "", heading: "A", depth: 1, content: "terraform modules guide", index: 0 },
		]);
		kb.upsertChunks("p2", [
			{ breadcrumb: "", heading: "B", depth: 1, content: "terraform roadmap plan", index: 0 },
		]);

		const results = kb.searchChunks("terraform", { spaceKey: "ENG" });
		expect(results).toHaveLength(1);
		expect(results[0]!.space_key).toBe("ENG");
	});
});

// ── clearSpace ───────────────────────────────────────────────────────────────

describe("clearSpace", () => {
	it("removes all pages from a space", () => {
		kb.upsertPage(makePage({ id: "1", space_key: "ENG" }));
		kb.upsertPage(makePage({ id: "2", space_key: "PM" }));
		kb.clearSpace("ENG");
		expect(kb.getPage("1")).toBeFalsy();
		expect(kb.getPage("2")).toBeTruthy();
	});
});
