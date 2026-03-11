import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { appendSection, formatSummaryLine, registerConfluenceTool } from "../tools/confluence.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

function mockFetchResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

beforeAll(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}")));
});

// ── Env helpers ──────────────────────────────────────────────────────────────

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY", "JIRA_BOARD_ID"];

function setTestEnv() {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.ATLASSIAN_SITE_URL = "https://test.atlassian.net";
  process.env.ATLASSIAN_EMAIL = "test@example.com";
  process.env.ATLASSIAN_API_TOKEN = "tok_123";
  process.env.JIRA_PROJECT_KEY = "BP";
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
}

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
    author_id: overrides.author_id ?? null,
    created_at: overrides.created_at ?? "2025-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2025-06-01T00:00:00Z",
    indexed_at: overrides.indexed_at ?? new Date().toISOString(),
  };
}

// ── Default params helper ────────────────────────────────────────────────────

const defaults = {
  maxDepth: 10,
  maxConcurrency: 5,
  includeLabels: [] as string[],
  excludeLabels: [] as string[],
  force: false,
  limit: 5,
  summarize: false,
  stale: false,
  staleDays: 90,
};

// ── formatSummaryLine ──────────────────────────────────────────────────────

describe("formatSummaryLine", () => {
  it("formats a summary with title, space, labels, and preview", () => {
    const result = formatSummaryLine({
      id: "p1",
      title: "Test Page",
      space_key: "ENG",
      page_type: "design",
      url: null,
      labels: '["design"]',
      content_preview: "Preview text here.",
      updated_at: "2025-06-01",
    });
    expect(result).toContain("**Test Page**");
    expect(result).toContain("(ENG)");
    expect(result).toContain("Preview text here.");
  });
});

// ── appendSection ──────────────────────────────────────────────────────────

describe("appendSection", () => {
  it("emits heading and items", () => {
    const pages = [
      {
        id: "a1",
        title: "ADR-001",
        space_key: "ENG",
        page_type: "adr" as const,
        url: null,
        labels: "[]",
        content_preview: "Decision",
        updated_at: null,
      },
    ];
    const parts: string[] = [];
    const remaining = appendSection(pages, "ADRs", 10, 5000, (s) => parts.push(s));
    const output = parts.join("");
    expect(output).toContain("## ADRs (1)");
    expect(output).toContain("### ADR-001");
    expect(remaining).toBeLessThan(5000);
  });

  it("returns budget unchanged for empty pages", () => {
    const remaining = appendSection([], "Empty", 10, 5000, () => {});
    expect(remaining).toBe(5000);
  });
});

// ── registerConfluenceTool ─────────────────────────────────────────────────

describe("registerConfluenceTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-confluence-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a single 'confluence' tool", () => {
    const { server, toolNames } = createMockServer();
    registerConfluenceTool(server, () => kb);
    expect(toolNames()).toEqual(["confluence"]);
  });

  // ── search ─────────────────────────────────────────────────────────────

  describe("action=search", () => {
    it("returns chunk matches with headings", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Auth Design", content: "OAuth2 authentication flow" }));
      kb.upsertChunks("p1", [
        {
          breadcrumb: "Auth > OAuth2",
          heading: "Token Flow",
          depth: 2,
          content: "OAuth2 token refresh mechanism details",
          index: 0,
        },
      ]);

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        query: "OAuth2",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("results");
      expect(result.content[0]?.text).toContain("Auth Design");
    });

    it("falls back to page search when no chunks", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(
        makePage({
          id: "p1",
          title: "DB Migration",
          content: "PostgreSQL migration guide",
          page_type: "runbook",
          labels: "[]",
        }),
      );

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        query: "PostgreSQL",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("DB Migration");
    });

    it("returns empty for no matches", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        query: "nonexistent",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("No results");
    });

    it("filters by pageType", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Design Doc", content: "OAuth2 flow", page_type: "design" }));
      kb.upsertPage(makePage({ id: "p2", title: "Runbook", content: "OAuth2 runbook", page_type: "runbook" }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        query: "OAuth2",
        pageType: "runbook",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Runbook");
      expect(result.content[0]?.text).not.toContain("Design Doc");
    });

    it("returns stats when no query and no special params", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", page_type: "adr" }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Total: 1");
      expect(result.content[0]?.text).toContain("adr");
    });

    it("returns empty message for stats on empty KB", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("empty");
    });

    it("returns context summary when summarize=true", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "a1", title: "ADR-001", page_type: "adr", content: "Use PostgreSQL" }));
      kb.upsertPage(makePage({ id: "d1", title: "Auth Design", page_type: "design", content: "OAuth2 design" }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
        summarize: true,
      });
      expect(result.content[0]?.text).toContain("Project Context");
      expect(result.content[0]?.text).toContain("ADRs");
    });

    it("returns error when summarize=true on empty KB", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
        summarize: true,
      });
      expect(result.isError).toBe(true);
    });

    it("returns stale pages when stale=true", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "old1", title: "Old Page", updated_at: "2020-01-01T00:00:00Z" }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
        stale: true,
        staleDays: 30,
      });
      expect(result.content[0]?.text).toContain("Old Page");
      expect(result.content[0]?.text).toContain("stale");
    });

    it("returns empty when stale=true but all pages are fresh", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "fresh1", title: "Fresh Page", updated_at: new Date().toISOString() }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
        stale: true,
        staleDays: 90,
      });
      expect(result.content[0]?.text).toContain("No pages older than");
    });

    it("returns recently changed pages when since is provided", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Recently Changed", indexed_at: new Date().toISOString() }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "search",
        ...defaults,
        since: "2020-01-01T00:00:00Z",
      });
      expect(result.content[0]?.text).toContain("Recently Changed");
    });

    it("returns empty when since finds nothing", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const result = await tool({
        action: "search",
        ...defaults,
        since: futureDate,
      });
      expect(result.content[0]?.text).toContain("No changes");
    });
  });

  // ── get-page ───────────────────────────────────────────────────────────

  describe("action=get-page", () => {
    it("returns full page content", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Auth Design", content: "Full page content here" }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Auth Design");
      expect(result.content[0]?.text).toContain("Full page content here");
    });

    it("returns error for missing page", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "get-page",
        pageId: "nonexistent",
        ...defaults,
      });
      expect(result.isError).toBe(true);
    });

    it("truncates at 15K chars", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Big Page", content: "A".repeat(20000) }));

      const tool = getTool("confluence");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("truncated");
    });

    it("returns error when pageId is missing", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "get-page",
        ...defaults,
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── spider ──────────────────────────────────────────────────────────────

  describe("action=spider", () => {
    beforeEach(() => {
      setTestEnv();
    });

    afterEach(() => {
      restoreEnv();
    });

    it("crawls and returns summary", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Mock: getSpace -> GET /wiki/api/v2/spaces?keys=ENG&limit=1
      mockFetchResponse({
        results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
        _links: {},
      });
      // Mock: listPagesInSpace -> GET /wiki/api/v2/spaces/100/pages?limit=50
      mockFetchResponse({
        results: [
          {
            id: "101",
            title: "Test Page",
            status: "current",
            _links: { webui: "/wiki/spaces/ENG/pages/101" },
          },
        ],
        _links: {},
      });
      // Mock: getPageFull -> parallel: GET page body + GET labels
      mockFetchResponse({
        id: "101",
        title: "Test Page",
        body: { storage: { value: "<p>Some content</p>" } },
        version: { number: 1, when: "2025-01-01T00:00:00Z" },
        _links: { webui: "/wiki/spaces/ENG/pages/101" },
      });
      mockFetchResponse({ results: [], _links: {} });

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
        maxDepth: 1,
        maxConcurrency: 1,
      });
      const text = result.content[0]?.text ?? "";

      expect(result.isError).toBeUndefined();
      expect(text).toContain("Indexed:");
      expect(text).toContain("KB total:");
    });

    it("rebuilds FTS when force=true", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Pre-populate a page so rebuildFts has something to work with
      kb.upsertPage(makePage({ id: "p1", title: "Existing Page", content: "existing content" }));

      // Mock: getSpace
      mockFetchResponse({
        results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
        _links: {},
      });
      // Mock: listPagesInSpace (empty — no new pages to crawl)
      mockFetchResponse({
        results: [],
        _links: {},
      });

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
        force: true,
        maxDepth: 1,
        maxConcurrency: 1,
      });
      const text = result.content[0]?.text ?? "";

      expect(result.isError).toBeUndefined();
      expect(text).toContain("FTS index rebuilt");
      expect(text).toContain("KB total:");
    });

    it("returns error when config is missing", async () => {
      restoreEnv();
      delete process.env.ATLASSIAN_SITE_URL;
      delete process.env.ATLASSIAN_EMAIL;
      delete process.env.ATLASSIAN_API_TOKEN;

      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── list-spaces ─────────────────────────────────────────────────────────

  describe("action=list-spaces", () => {
    beforeEach(() => {
      setTestEnv();
    });

    afterEach(() => {
      restoreEnv();
    });

    it("returns spaces list", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Mock: GET /wiki/api/v2/spaces
      mockFetchResponse({
        results: [
          { id: "1", key: "ENG", name: "Engineering", type: "global" },
          { id: "2", key: "PM", name: "Product", type: "global" },
        ],
        _links: {},
      });

      const tool = getTool("confluence");
      const result = await tool({
        action: "list-spaces",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";

      expect(result.isError).toBeUndefined();
      expect(text).toContain("ENG");
      expect(text).toContain("Engineering");
      expect(text).toContain("PM");
      expect(text).toContain("Product");
    });

    it("returns error when config is missing", async () => {
      restoreEnv();
      delete process.env.ATLASSIAN_SITE_URL;
      delete process.env.ATLASSIAN_EMAIL;
      delete process.env.ATLASSIAN_API_TOKEN;

      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "list-spaces",
        ...defaults,
      });

      expect(result.isError).toBe(true);
    });
  });
});
