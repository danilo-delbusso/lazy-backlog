import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema, type JiraTicketInput, markdownToAdf } from "../lib/jira.js";

// ── Fetch mock helpers ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function mockFetchResponse(body: unknown, status = 200) {
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

function mockFetchError(status: number, body: string) {
	fetchMock.mockResolvedValueOnce(
		new Response(body, { status, headers: { "Content-Type": "text/plain" } }),
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

// ── Test schema for JiraClient ───────────────────────────────────────────────

const testSchema: JiraSchema = {
	projectKey: "BP",
	projectName: "Backlog Project",
	boardId: "266",
	issueTypes: [
		{
			id: "1",
			name: "Task",
			subtask: false,
			fields: [
				{ id: "summary", name: "Summary", type: "string", required: true, system: "summary" },
				{ id: "customfield_10016", name: "Story Points", type: "number", required: false },
				{
					id: "components",
					name: "Components",
					type: "array",
					required: false,
					system: "components",
					allowedValues: [{ id: "10001", name: "Backend" }, { id: "10002", name: "Frontend" }],
				},
				{
					id: "customfield_999",
					name: "Environment",
					type: "option",
					required: true,
					custom: "select",
					allowedValues: [{ id: "env-1", name: "Production" }, { id: "env-2", name: "Staging" }],
				},
			],
			requiredFields: ["summary", "customfield_999"],
		},
	],
	priorities: [{ id: "1", name: "High" }, { id: "2", name: "Medium" }],
	statuses: [],
	board: { name: "Sprint Board", type: "scrum", teamFieldId: "customfield_100", teamId: "team-uuid", teamName: "Wall-E" },
};

const testConfig = {
	siteUrl: "https://test.atlassian.net",
	email: "test@example.com",
	apiToken: "tok_123",
	jiraProjectKey: "BP",
	confluenceSpaces: [],
	rootPageIds: [],
};

// ── markdownToAdf ────────────────────────────────────────────────────────────

describe("markdownToAdf", () => {
	it("returns a doc node with version 1", () => {
		const adf = markdownToAdf("Hello");
		expect(adf.type).toBe("doc");
		expect((adf as Record<string, unknown>).version).toBe(1);
		expect(adf.content).toBeDefined();
	});

	it("converts plain text to a paragraph", () => {
		const adf = markdownToAdf("Hello world");
		expect(adf.content).toHaveLength(1);
		expect(adf.content![0]!.type).toBe("paragraph");
	});

	it("converts headings (h1-h6)", () => {
		const adf = markdownToAdf("# Title\n## Subtitle\n### Section");
		expect(adf.content).toHaveLength(3);
		expect(adf.content![0]!.type).toBe("heading");
		expect((adf.content![0] as Record<string, unknown>).attrs).toEqual({ level: 1 });
	});

	it("converts bullet lists", () => {
		const adf = markdownToAdf("- Item one\n- Item two\n- Item three");
		expect(adf.content).toHaveLength(1);
		expect(adf.content![0]!.type).toBe("bulletList");
		expect(adf.content![0]!.content).toHaveLength(3);
	});

	it("converts ordered lists", () => {
		const adf = markdownToAdf("1. First\n2. Second\n3. Third");
		expect(adf.content).toHaveLength(1);
		expect(adf.content![0]!.type).toBe("orderedList");
		expect(adf.content![0]!.content).toHaveLength(3);
	});

	it("converts code blocks with language", () => {
		const adf = markdownToAdf("```typescript\nconst x = 1;\n```");
		expect(adf.content![0]!.type).toBe("codeBlock");
		expect((adf.content![0] as Record<string, unknown>).attrs).toEqual({ language: "typescript" });
	});

	it("converts code blocks without language", () => {
		const adf = markdownToAdf("```\nsome code\n```");
		expect(adf.content![0]!.type).toBe("codeBlock");
	});

	it("converts horizontal rules", () => {
		const adf = markdownToAdf("Above\n\n---\n\nBelow");
		const rule = adf.content!.find((n) => n.type === "rule");
		expect(rule).toBeDefined();
	});

	it("handles bold inline formatting", () => {
		const adf = markdownToAdf("This is **bold** text");
		const para = adf.content![0]!;
		const boldNode = para.content!.find((n) => n.marks?.some((m) => m.type === "strong"));
		expect(boldNode).toBeDefined();
		expect(boldNode!.text).toBe("bold");
	});

	it("handles italic inline formatting", () => {
		const adf = markdownToAdf("This is *italic* text");
		const para = adf.content![0]!;
		const italicNode = para.content!.find((n) => n.marks?.some((m) => m.type === "em"));
		expect(italicNode).toBeDefined();
	});

	it("handles inline code formatting", () => {
		const adf = markdownToAdf("Use `bun test` to run");
		const para = adf.content![0]!;
		const codeNode = para.content!.find((n) => n.marks?.some((m) => m.type === "code"));
		expect(codeNode).toBeDefined();
		expect(codeNode!.text).toBe("bun test");
	});

	it("skips empty lines", () => {
		const adf = markdownToAdf("Line one\n\n\n\nLine two");
		const paragraphs = adf.content!.filter((n) => n.type === "paragraph");
		expect(paragraphs).toHaveLength(2);
	});

	it("handles empty input", () => {
		const adf = markdownToAdf("");
		expect(adf.type).toBe("doc");
		expect(adf.content).toHaveLength(0);
	});

	it("handles mixed content", () => {
		const md = "# Title\n\nSome text\n\n- List item\n\n```\ncode\n```\n\n---\n\nEnd";
		const adf = markdownToAdf(md);
		const types = adf.content!.map((n) => n.type);
		expect(types).toContain("heading");
		expect(types).toContain("paragraph");
		expect(types).toContain("bulletList");
		expect(types).toContain("codeBlock");
		expect(types).toContain("rule");
	});
});

// ── JiraClient ───────────────────────────────────────────────────────────────

describe("JiraClient", () => {
	describe("createIssue", () => {
		it("creates a basic issue", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-100", self: "https://test.atlassian.net/rest/api/3/issue/10001" });

			const result = await client.createIssue({
				summary: "Test ticket",
				issueType: "Task",
			});

			expect(result.key).toBe("BP-100");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("includes description as ADF", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-101", self: "" });

			await client.createIssue({
				summary: "With description",
				issueType: "Task",
				description: "# Context\nSome details",
			});

			const call = fetchMock.mock.calls[0];
			const body = JSON.parse(call[1].body as string);
			expect(body.fields.description.type).toBe("doc");
		});

		it("includes priority when specified", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-102", self: "" });

			await client.createIssue({
				summary: "High priority",
				issueType: "Task",
				priority: "High",
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.priority).toEqual({ name: "High" });
		});

		it("includes labels when specified", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-103", self: "" });

			await client.createIssue({
				summary: "Labeled ticket",
				issueType: "Task",
				labels: ["tech-debt", "auth"],
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.labels).toEqual(["tech-debt", "auth"]);
		});

		it("includes parent key for sub-tasks", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-104", self: "" });

			await client.createIssue({
				summary: "Sub-task",
				issueType: "Task",
				parentKey: "BP-50",
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.parent).toEqual({ key: "BP-50" });
		});

		it("resolves story points to custom field", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-105", self: "" });

			await client.createIssue({
				summary: "Pointed ticket",
				issueType: "Task",
				storyPoints: 5,
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.customfield_10016).toBe(5);
		});

		it("resolves components by name", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-106", self: "" });

			await client.createIssue({
				summary: "With components",
				issueType: "Task",
				components: ["Backend"],
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.components).toEqual([{ id: "10001" }]);
		});

		it("auto-fills required fields with first allowed value", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-107", self: "" });

			await client.createIssue({
				summary: "Auto-filled",
				issueType: "Task",
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			// customfield_999 (Environment) is required, should be auto-filled
			expect(body.fields.customfield_999).toEqual({ id: "env-1" });
		});

		it("auto-assigns team from board config", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-108", self: "" });

			await client.createIssue({
				summary: "With team",
				issueType: "Task",
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.customfield_100).toBe("team-uuid");
		});

		it("throws on HTTP error", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchError(400, '{"errorMessages":["Field required"],"errors":{}}');

			await expect(client.createIssue({ summary: "Bad", issueType: "Task" })).rejects.toThrow("Jira 400");
		});
	});

	describe("getIssue", () => {
		it("fetches and maps issue fields", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({
				key: "BP-1",
				id: "10001",
				fields: {
					summary: "Fix auth bug",
					description: {
						type: "doc",
						content: [
							{ type: "paragraph", content: [{ type: "text", text: "Fix the auth" }] },
							{ type: "heading", content: [{ type: "text", text: "Steps" }] },
							{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Step 1" }] }] }] },
							{ type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] },
							{ type: "hardBreak" },
						],
					},
					issuetype: { name: "Bug" },
					priority: { name: "High" },
					status: { name: "In Progress" },
					labels: ["auth"],
					components: [{ name: "Backend" }],
					parent: { key: "BP-0" },
					assignee: { displayName: "Ricky" },
					reporter: { displayName: "Alice" },
					created: "2025-01-01T00:00:00Z",
					updated: "2025-06-01T00:00:00Z",
					comment: {
						comments: [
							{ author: { displayName: "Bob" }, created: "2025-06-01T00:00:00Z", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] } },
						],
					},
				},
			});

			const issue = await client.getIssue("BP-1");
			expect(issue.key).toBe("BP-1");
			expect(issue.summary).toBe("Fix auth bug");
			expect(issue.description).toContain("Fix the auth");
			expect(issue.description).toContain("Steps");
			expect(issue.description).toContain("- Step 1");
			expect(issue.description).toContain("```");
			expect(issue.issueType).toBe("Bug");
			expect(issue.priority).toBe("High");
			expect(issue.status).toBe("In Progress");
			expect(issue.labels).toEqual(["auth"]);
			expect(issue.components).toEqual(["Backend"]);
			expect(issue.parentKey).toBe("BP-0");
			expect(issue.assignee).toBe("Ricky");
			expect(issue.comments).toHaveLength(1);
			expect(issue.comments[0]!.body).toContain("Looks good");
			expect(issue.url).toContain("BP-1");
		});

		it("handles issue without description", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({
				key: "BP-2",
				id: "10002",
				fields: {
					summary: "No description",
					issuetype: { name: "Task" },
					priority: { name: "Medium" },
					status: { name: "To Do" },
					labels: [],
					components: [],
					created: "2025-01-01T00:00:00Z",
					updated: "2025-06-01T00:00:00Z",
				},
			});

			const issue = await client.getIssue("BP-2");
			expect(issue.description).toBeUndefined();
		});
	});

	describe("updateIssue", () => {
		it("updates issue fields", async () => {
			const client = new JiraClient(testConfig, testSchema);
			// First call: GET to fetch issue type
			mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
			// Second call: PUT to update
			fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

			await client.updateIssue({
				issueKey: "BP-1",
				summary: "Updated summary",
				priority: "High",
			});

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const putCall = fetchMock.mock.calls[1];
			expect(putCall[1].method).toBe("PUT");
			const body = JSON.parse(putCall[1].body as string);
			expect(body.fields.summary).toBe("Updated summary");
		});

		it("throws when no fields to update", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ fields: { issuetype: { name: "Task" } } });

			await expect(client.updateIssue({ issueKey: "BP-1" })).rejects.toThrow("No fields to update");
		});

		it("includes comment in update", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
			fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

			await client.updateIssue({ issueKey: "BP-1", comment: "Done" });

			const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
			expect(body.update.comment[0].add.body.type).toBe("doc");
		});
	});

	describe("resolveCustomFields via namedFields", () => {
		it("resolves named fields with allowed values", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "10001", key: "BP-200", self: "" });

			await client.createIssue({
				summary: "Named field test",
				issueType: "Task",
				namedFields: { Environment: "Staging" },
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.fields.customfield_999).toEqual({ id: "env-2" });
		});
	});

	describe("schema DB operations", () => {
		let kb: KnowledgeBase;
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "lb-jira-test-"));
			kb = new KnowledgeBase(join(tmpDir, "test.db"));
		});

		afterEach(() => {
			kb.close();
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("saves and loads schema from DB", () => {
			JiraClient.saveSchemaToDb(kb, testSchema);
			const loaded = JiraClient.loadSchemaFromDb(kb);
			expect(loaded).toBeDefined();
			expect(loaded!.projectKey).toBe("BP");
			expect(loaded!.issueTypes).toHaveLength(1);
		});

		it("returns null for missing schema", () => {
			expect(JiraClient.loadSchemaFromDb(kb)).toBeNull();
		});

		it("returns null for corrupt schema", () => {
			kb.setConfig("jira-schema", "not-json{{{");
			expect(JiraClient.loadSchemaFromDb(kb)).toBeNull();
		});
	});

	describe("createIssuesBatch", () => {
		it("creates multiple issues and returns results", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "1", key: "BP-1", self: "" });
			mockFetchResponse({ id: "2", key: "BP-2", self: "" });

			const inputs: JiraTicketInput[] = [
				{ summary: "Ticket 1", issueType: "Task" },
				{ summary: "Ticket 2", issueType: "Task" },
			];

			const result = await client.createIssuesBatch(inputs);
			expect(result.issues).toHaveLength(2);
			expect(result.errors).toHaveLength(0);
		});

		it("captures errors without stopping batch", async () => {
			const client = new JiraClient(testConfig, testSchema);
			mockFetchResponse({ id: "1", key: "BP-1", self: "" });
			mockFetchError(400, '{"errorMessages":["Bad request"],"errors":{}}');

			const inputs: JiraTicketInput[] = [
				{ summary: "Good ticket", issueType: "Task" },
				{ summary: "Bad ticket", issueType: "Task" },
			];

			const result = await client.createIssuesBatch(inputs);
			expect(result.issues).toHaveLength(1);
			expect(result.errors).toHaveLength(1);
		});
	});

	describe("getFieldGuide", () => {
		it("returns formatted field guide for known issue type", () => {
			const client = new JiraClient(testConfig, testSchema);
			const guide = client.getFieldGuide("Task");
			expect(guide).toContain("## Fields for Task");
			expect(guide).toContain("**Summary**");
			expect(guide).toContain("**REQUIRED**");
			expect(guide).toContain("**Story Points**");
			expect(guide).toContain("optional");
			expect(guide).toContain("Values:");
		});

		it("returns null for unknown issue type", () => {
			const client = new JiraClient(testConfig, testSchema);
			expect(client.getFieldGuide("NonExistent")).toBeNull();
		});

		it("returns null without schema", () => {
			const client = new JiraClient(testConfig);
			expect(client.getFieldGuide("Task")).toBeNull();
		});
	});

	describe("loadSchema", () => {
		it("returns null for undefined path", () => {
			expect(JiraClient.loadSchema()).toBeNull();
		});

		it("returns null for nonexistent file", () => {
			expect(JiraClient.loadSchema("/tmp/nonexistent-schema.json")).toBeNull();
		});
	});

	describe("discoverSchema", () => {
		it("discovers project schema from API", async () => {
			const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

			// 1. Project info
			mockFetchResponse({ name: "Test Project" });
			// 2. Issue types (createmeta)
			mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
			// 3. Fields for Task
			mockFetchResponse({
				values: [
					{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
					{ fieldId: "customfield_10016", name: "Story Points", required: false, schema: { type: "number" } },
				],
			});
			// 4. Priorities
			mockFetchResponse([{ id: "1", name: "High" }, { id: "2", name: "Medium" }]);
			// 5. Statuses
			mockFetchResponse([{ name: "Task", statuses: [{ id: "1", name: "To Do", statusCategory: { name: "To Do" } }] }]);
			// 6. Sample tickets
			mockFetchResponse({
				issues: [{ key: "BP-1", fields: { summary: "Sample", issuetype: { name: "Task" }, priority: { name: "High" }, status: { name: "To Do" }, labels: [] } }],
			});

			const schema = await JiraClient.discoverSchema(config, "BP");
			expect(schema.projectKey).toBe("BP");
			expect(schema.projectName).toBe("Test Project");
			expect(schema.issueTypes).toHaveLength(1);
			expect(schema.issueTypes[0]!.name).toBe("Task");
			expect(schema.priorities).toHaveLength(2);
			expect(schema.sampleTickets).toHaveLength(1);
		});

		it("discovers schema with board config", async () => {
			const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

			// 1. Project info
			mockFetchResponse({ name: "Board Project" });
			// 2. Issue types
			mockFetchResponse({ values: [{ id: "1", name: "Story", subtask: false }] });
			// 3. Fields for Story (include team field)
			mockFetchResponse({
				values: [
					{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
					{ fieldId: "customfield_100", name: "Team", required: false, schema: { type: "team", custom: "com.atlassian.teams:team" } },
				],
			});
			// 4. Priorities
			mockFetchResponse([{ id: "1", name: "Medium" }]);
			// 5. Board config
			mockFetchResponse({
				name: "Scrum Board",
				type: "scrum",
				estimation: { field: { displayName: "Story Points" } },
				columnConfig: { columns: [{ name: "To Do", statuses: [{ name: "To Do" }] }] },
			});
			// 6. Board ticket with team
			mockFetchResponse({
				issues: [{ fields: { customfield_100: { id: "team-uuid", name: "Alpha" } } }],
			});
			// 7. Statuses
			mockFetchResponse([]);
			// 8. Sample tickets
			mockFetchResponse({ issues: [] });

			const schema = await JiraClient.discoverSchema(config, "BP", "266");
			expect(schema.board).toBeDefined();
			expect(schema.board!.name).toBe("Scrum Board");
			expect(schema.board!.teamId).toBe("team-uuid");
			expect(schema.board!.teamName).toBe("Alpha");
		});
	});
});
