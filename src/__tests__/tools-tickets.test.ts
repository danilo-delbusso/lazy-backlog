import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import {
	STOP_WORDS,
	buildJiraClient,
	extractKeywords,
	formatSchemaResult,
	formatSummaries,
	registerTicketTools,
	retrieveConfluenceContext,
} from "../tools/tickets.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function mockFetchResponse(body: unknown, status = 200) {
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
	);
}

beforeAll(() => {
	fetchMock = mock(() => Promise.resolve(new Response("{}")));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	fetchMock.mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
	return {
		id: overrides.id ?? "page-1",
		space_key: overrides.space_key ?? "ENG",
		title: overrides.title ?? "Test Page",
		url: overrides.url ?? null,
		content: overrides.content ?? "Some content about authentication.",
		page_type: overrides.page_type ?? "design",
		labels: overrides.labels ?? '["design"]',
		parent_id: overrides.parent_id ?? null,
		author_id: overrides.author_id ?? null,
		created_at: overrides.created_at ?? null,
		updated_at: overrides.updated_at ?? "2025-06-01T00:00:00Z",
		indexed_at: overrides.indexed_at ?? new Date().toISOString(),
	};
}

const testSchema: JiraSchema = {
	projectKey: "BP",
	projectName: "Backlog",
	boardId: "266",
	issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
	priorities: [{ id: "1", name: "Medium" }],
	statuses: [],
};

// ── Env helpers ──────────────────────────────────────────────────────────────

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY"];

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

// ── STOP_WORDS ───────────────────────────────────────────────────────────────

describe("STOP_WORDS", () => {
	it("contains common English stop words", () => {
		expect(STOP_WORDS.has("the")).toBe(true);
		expect(STOP_WORDS.has("and")).toBe(true);
	});

	it("contains action verbs used in ticket descriptions", () => {
		expect(STOP_WORDS.has("create")).toBe(true);
		expect(STOP_WORDS.has("implement")).toBe(true);
	});

	it("does not contain technical terms", () => {
		expect(STOP_WORDS.has("terraform")).toBe(false);
		expect(STOP_WORDS.has("kubernetes")).toBe(false);
	});
});

// ── extractKeywords ──────────────────────────────────────────────────────────

describe("extractKeywords", () => {
	it("extracts meaningful words", () => {
		const keywords = extractKeywords("Implement OAuth2 authentication for API gateway");
		expect(keywords).toContain("oauth2");
		expect(keywords).toContain("authentication");
		expect(keywords).toContain("gateway");
	});

	it("filters out stop words", () => {
		const keywords = extractKeywords("Create a new authentication service for the API");
		expect(keywords).not.toContain("create");
		expect(keywords).not.toContain("the");
	});

	it("filters short words (<=2 chars)", () => {
		const keywords = extractKeywords("Go to DB and do it");
		expect(keywords).not.toContain("go");
		expect(keywords).not.toContain("to");
	});

	it("deduplicates keywords", () => {
		const keywords = extractKeywords("auth auth auth service");
		expect(keywords.filter((k) => k === "auth")).toHaveLength(1);
	});

	it("handles punctuation", () => {
		const keywords = extractKeywords("user-facing, API-level; (internal)");
		expect(keywords).toContain("user");
		expect(keywords).toContain("facing");
		expect(keywords).toContain("api");
	});
});

// ── formatSchemaResult ───────────────────────────────────────────────────────

describe("formatSchemaResult", () => {
	it("includes project info and issue types", () => {
		const result = formatSchemaResult(testSchema);
		expect(result).toContain("Backlog (BP)");
		expect(result).toContain("1 issue types: Task");
		expect(result).toContain("1 priorities");
	});

	it("includes board info when present", () => {
		const schema = { ...testSchema, board: { name: "Sprint Board", type: "scrum", teamName: "Wall-E" } };
		const result = formatSchemaResult(schema);
		expect(result).toContain("Board: Sprint Board");
		expect(result).toContain("Team: Wall-E");
	});
});

// ── formatSummaries ──────────────────────────────────────────────────────────

describe("formatSummaries", () => {
	it("formats pages with heading", () => {
		const pages = [
			{ id: "1", title: "Auth", space_key: "ENG", page_type: "design", url: "", labels: "[]", content_preview: "OAuth2 flow", updated_at: "" },
		];
		const result = formatSummaries(pages, "Designs");
		expect(result).toContain("### Designs (1 total)");
		expect(result).toContain("**Auth**");
	});

	it("returns empty for no pages", () => {
		expect(formatSummaries([], "Nothing")).toBe("");
	});
});

// ── buildJiraClient ──────────────────────────────────────────────────────────

describe("buildJiraClient", () => {
	let kb: KnowledgeBase;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lb-bld-test-"));
		kb = new KnowledgeBase(join(tmpDir, "test.db"));
		setTestEnv();
	});

	afterEach(() => {
		kb.close();
		rmSync(tmpDir, { recursive: true, force: true });
		restoreEnv();
	});

	it("creates JiraClient with config", () => {
		JiraClient.saveSchemaToDb(kb, testSchema);
		const { jira, config } = buildJiraClient(kb);
		expect(config.jiraProjectKey).toBe("BP");
		expect(jira).toBeDefined();
	});

	it("throws when no project key", () => {
		delete process.env.JIRA_PROJECT_KEY;
		expect(() => buildJiraClient(kb)).toThrow("No project key");
	});
});

// ── retrieveConfluenceContext ─────────────────────────────────────────────────

describe("retrieveConfluenceContext", () => {
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

	it("retrieves ADRs, designs, specs, and chunk matches", () => {
		kb.upsertPage(makePage({ id: "a1", page_type: "adr", title: "ADR-001", content: "Use PostgreSQL" }));
		kb.upsertPage(makePage({ id: "d1", page_type: "design", title: "Auth Design", content: "OAuth2 service" }));
		kb.upsertPage(makePage({ id: "s1", page_type: "spec", title: "API Spec", content: "REST API spec" }));
		kb.upsertChunks("d1", [
			{ breadcrumb: "Auth > OAuth2", heading: "Token Flow", depth: 2, content: "OAuth2 token refresh mechanism", index: 0 },
		]);

		const ctx = retrieveConfluenceContext(kb, "Implement OAuth2 authentication");
		expect(ctx.adrs).toHaveLength(1);
		expect(ctx.designs).toHaveLength(1);
		expect(ctx.specs).toHaveLength(1);
		expect(ctx.chunks.length).toBeGreaterThanOrEqual(1);
	});

	it("returns empty results for empty KB", () => {
		const ctx = retrieveConfluenceContext(kb, "anything");
		expect(ctx.adrs).toHaveLength(0);
		expect(ctx.designs).toHaveLength(0);
		expect(ctx.specs).toHaveLength(0);
		expect(ctx.chunks).toHaveLength(0);
	});
});

// ── registerTicketTools ──────────────────────────────────────────────────────

describe("registerTicketTools", () => {
	let kb: KnowledgeBase;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lb-tkt-test-"));
		kb = new KnowledgeBase(join(tmpDir, "test.db"));
		setTestEnv();
	});

	afterEach(() => {
		kb.close();
		rmSync(tmpDir, { recursive: true, force: true });
		restoreEnv();
	});

	it("registers all expected tools", () => {
		const { server, toolNames } = createMockServer();
		registerTicketTools(server, () => kb);
		expect(toolNames()).toContain("setup");
		expect(toolNames()).toContain("discover-jira");
		expect(toolNames()).toContain("plan-tickets");
		expect(toolNames()).toContain("create-tickets");
		expect(toolNames()).toContain("get-ticket");
		expect(toolNames()).toContain("update-ticket");
	});

	describe("get-ticket tool", () => {
		it("fetches and formats a ticket", async () => {
			const { server, getTool } = createMockServer();
			registerTicketTools(server, () => kb);

			JiraClient.saveSchemaToDb(kb, testSchema);
			mockFetchResponse({
				key: "BP-1",
				id: "10001",
				fields: {
					summary: "Test ticket",
					issuetype: { name: "Task" },
					priority: { name: "Medium" },
					status: { name: "To Do" },
					labels: [],
					components: [],
					created: "2025-01-01",
					updated: "2025-06-01",
					comment: { comments: [] },
				},
			});

			const getTick = getTool("get-ticket")!;
			const result = await getTick({ issueKey: "BP-1" });
			expect(result.content[0]!.text).toContain("BP-1");
			expect(result.content[0]!.text).toContain("Test ticket");
		});
	});

	describe("plan-tickets tool", () => {
		it("returns confluence context for ticket planning", async () => {
			const { server, getTool } = createMockServer();
			registerTicketTools(server, () => kb);

			JiraClient.saveSchemaToDb(kb, testSchema);
			kb.upsertPage(makePage({ id: "a1", page_type: "adr", title: "ADR-001", content: "Use Terraform for infra" }));

			const plan = getTool("plan-tickets")!;
			const result = await plan({ description: "Provision staging environment with Terraform" });
			expect(result.content[0]!.text).toContain("ADR");
		});
	});

	describe("create-tickets tool (dry run)", () => {
		it("validates tickets in dry run mode", async () => {
			const { server, getTool } = createMockServer();
			registerTicketTools(server, () => kb);

			JiraClient.saveSchemaToDb(kb, testSchema);

			const create = getTool("create-tickets")!;
			const result = await create({
				dryRun: true,
				tickets: [{ summary: "Test ticket", type: "Task", issueType: "Task", description: "Test", labels: [], priority: "Medium", components: [] }],
			});
			expect(result.content[0]!.text).toContain("Preview");
		});
	});

	describe("create-tickets tool (live)", () => {
		it("creates tickets via Jira API", async () => {
			const { server, getTool } = createMockServer();
			registerTicketTools(server, () => kb);

			JiraClient.saveSchemaToDb(kb, testSchema);
			mockFetchResponse({ id: "1", key: "BP-100", self: "" });

			const create = getTool("create-tickets")!;
			const result = await create({
				dryRun: false,
				tickets: [{ summary: "Real ticket", type: "Task", description: "## Context\nTest" }],
			});
			expect(result.content[0]!.text).toContain("BP-100");
		});
	});

	describe("update-ticket tool", () => {
		it("updates a ticket", async () => {
			const { server, getTool } = createMockServer();
			registerTicketTools(server, () => kb);

			JiraClient.saveSchemaToDb(kb, testSchema);
			// GET issue type
			mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
			// PUT update
			fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const update = getTool("update-ticket")!;
			const result = await update({ issueKey: "BP-1", summary: "Updated title" });
			expect(result.content[0]!.text).toContain("BP-1");
		});
	});
});
