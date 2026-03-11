import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraIssueDetail, type JiraSchema } from "../lib/jira.js";
import { registerIssuesTool } from "../tools/issues.js";
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
  fetchMock.mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY", "JIRA_BOARD_ID"];

function setTestEnv() {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.ATLASSIAN_SITE_URL = "https://test.atlassian.net";
  process.env.ATLASSIAN_EMAIL = "test@example.com";
  process.env.ATLASSIAN_API_TOKEN = "tok_123";
  process.env.JIRA_PROJECT_KEY = "BP";
  process.env.JIRA_BOARD_ID = "266";
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerIssuesTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers single issues tool", () => {
    const { server, toolNames } = createMockServer();
    registerIssuesTool(server, () => kb);
    expect(toolNames()).toContain("issues");
    expect(toolNames()).toHaveLength(1);
  });

  describe("action=get", () => {
    it("fetches and formats ticket", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
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

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-1" });
      expect(result.content[0]?.text).toContain("BP-1");
      expect(result.content[0]?.text).toContain("Test ticket");
    });
  });

  describe("action=create", () => {
    it("returns preview when confirmed is not set", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "New feature ticket" });
      const text = result.content[0]?.text;
      expect(text).toContain("Ticket Preview");
      expect(text).toContain("New feature ticket");
      expect(text).toContain("confirmed=true");
    });

    it("creates ticket via Jira API when confirmed", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ id: "1", key: "BP-200", self: "" });

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "New feature ticket", confirmed: true });
      expect(result.content[0]?.text).toContain("BP-200");
    });

    it("creates ticket with parent epic when confirmed", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
        id: "1",
        key: "BP-201",
        self: "",
      });

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "Child task", parent: "BP-100", confirmed: true });
      expect(result.content[0]?.text).toContain("BP-201");
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ parentKey: "BP-100" }));

      createSpy.mockRestore();
    });
  });

  describe("action=bulk-create", () => {
    it("returns preview when confirmed is not set", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "Ticket one",
            issueType: "Task",
            description: "Test",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text;
      expect(text).toContain("Ticket Preview");
      expect(text).toContain("confirmed=true");
    });

    it("creates tickets when confirmed", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ id: "1", key: "BP-300", self: "" });

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [{ summary: "Bulk ticket", description: "## Context\nTest" }],
      });
      expect(result.content[0]?.text).toContain("BP-300");
    });
  });

  describe("action=update", () => {
    it("updates ticket", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // GET issue type
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
      // PUT update
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", summary: "Updated title" });
      expect(result.content[0]?.text).toContain("BP-1");
      expect(result.content[0]?.text).toContain("Updated title");
    });

    it("updates ticket with parent", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const updateSpy = vi.spyOn(JiraClient.prototype, "updateIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", parent: "BP-50" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Parent: BP-50");
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "BP-1", parentKey: "BP-50" }));

      updateSpy.mockRestore();
    });

    it("updates ticket with rankBefore", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const rankSpy = vi.fn().mockResolvedValue(undefined);
      (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "rankIssue",
      ).mockImplementation(rankSpy);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", rankBefore: "BP-2" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Ranked: before BP-2");
      expect(rankSpy).toHaveBeenCalledWith("BP-1", { rankBefore: "BP-2" });

      vi.restoreAllMocks();
    });

    it("updates ticket with status transition", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getTransitionsSpy = vi.spyOn(JiraClient.prototype, "getTransitions").mockResolvedValue([
        { id: "21", name: "In Progress", to: { name: "In Progress" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ]);
      const transitionSpy = vi.spyOn(JiraClient.prototype, "transitionIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", status: "In Progress" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain('transitioned via "In Progress"');
      expect(getTransitionsSpy).toHaveBeenCalledWith("BP-1");
      expect(transitionSpy).toHaveBeenCalledWith("BP-1", "21");

      getTransitionsSpy.mockRestore();
      transitionSpy.mockRestore();
    });

    it("returns error when status transition not found", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getTransitionsSpy = vi
        .spyOn(JiraClient.prototype, "getTransitions")
        .mockResolvedValue([{ id: "21", name: "In Progress", to: { name: "In Progress" } }]);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", status: "Nonexistent" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('No transition matching "Nonexistent"');
      expect(getText(result)).toContain("Available: In Progress");

      getTransitionsSpy.mockRestore();
    });

    it("updates ticket with assignee", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const assignSpy = vi.spyOn(JiraClient.prototype, "assignIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", assignee: "abc123" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Assignee: abc123");
      expect(assignSpy).toHaveBeenCalledWith("BP-1", "abc123");

      assignSpy.mockRestore();
    });

    it("clears assignee with 'unassigned'", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const assignSpy = vi.spyOn(JiraClient.prototype, "assignIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", assignee: "unassigned" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Assignee: cleared");
      expect(assignSpy).toHaveBeenCalledWith("BP-1", null);

      assignSpy.mockRestore();
    });

    it("updates ticket with links", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const linkSpy = vi.spyOn(JiraClient.prototype, "linkIssues").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({
        action: "update",
        issueKey: "BP-1",
        links: [
          { targetKey: "BP-2", linkType: "Blocks", direction: "outward" as const },
          { targetKey: "BP-3", linkType: "Relates", direction: "inward" as const },
        ],
      });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("2 link(s) created");
      expect(linkSpy).toHaveBeenCalledTimes(2);
      // outward: inward=target, outward=issueKey
      expect(linkSpy).toHaveBeenCalledWith("BP-2", "BP-1", "Blocks");
      // inward: inward=issueKey, outward=target
      expect(linkSpy).toHaveBeenCalledWith("BP-1", "BP-3", "Relates");

      linkSpy.mockRestore();
    });

    it("updates ticket with status, assignee, and links combined", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // GET issue type for field update
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
      // PUT update
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const getTransitionsSpy = vi
        .spyOn(JiraClient.prototype, "getTransitions")
        .mockResolvedValue([{ id: "21", name: "In Progress", to: { name: "In Progress" } }]);
      const transitionSpy = vi.spyOn(JiraClient.prototype, "transitionIssue").mockResolvedValue(undefined);
      const assignSpy = vi.spyOn(JiraClient.prototype, "assignIssue").mockResolvedValue(undefined);
      const linkSpy = vi.spyOn(JiraClient.prototype, "linkIssues").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({
        action: "update",
        issueKey: "BP-1",
        summary: "Updated",
        status: "In Progress",
        assignee: "user123",
        links: [{ targetKey: "BP-5", linkType: "Blocks", direction: "outward" as const }],
      });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Summary: Updated");
      expect(text).toContain('transitioned via "In Progress"');
      expect(text).toContain("Assignee: user123");
      expect(text).toContain("1 link(s) created");

      expect(transitionSpy).toHaveBeenCalledWith("BP-1", "21");
      expect(assignSpy).toHaveBeenCalledWith("BP-1", "user123");
      // outward: inward=target, outward=issueKey
      expect(linkSpy).toHaveBeenCalledWith("BP-5", "BP-1", "Blocks");

      getTransitionsSpy.mockRestore();
      transitionSpy.mockRestore();
      assignSpy.mockRestore();
      linkSpy.mockRestore();
    });
  });

  describe("action=search", () => {
    it("returns formatted JQL results", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        issues: [
          {
            key: "BP-10",
            fields: {
              summary: "Search result ticket",
              status: { name: "In Progress" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "project = BP" });
      expect(result.content[0]?.text).toContain("BP-10");
      expect(result.content[0]?.text).toContain("Search result ticket");
      expect(result.content[0]?.text).toContain("In Progress");
      expect(result.content[0]?.text).toContain("Alice");
    });

    it("handles empty results", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ issues: [], total: 0 });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "project = EMPTY" });
      expect(result.content[0]?.text).toContain("No issues found");
    });
  });

  // ── Triage actions (find-bugs, assess, triage) ─────────────────────────────

  function getText(result: { content: { type: string; text: string }[] }): string {
    return (result.content[0] as { type: string; text: string }).text;
  }

  function makeIssueDetail(key: string, overrides: Record<string, unknown> = {}): JiraIssueDetail {
    return {
      key,
      id: key.split("-")[1] ?? "1",
      summary: (overrides.summary as string) ?? `${key} summary`,
      description: (overrides.description as string) ?? "",
      issueType: "Bug",
      status: (overrides.status as string) ?? "To Do",
      priority: (overrides.priority as string) ?? "Medium",
      labels: (overrides.labels as string[]) ?? [],
      components: (overrides.components as string[]) ?? [],
      assignee: (overrides.assignee as string) ?? "",
      reporter: (overrides.reporter as string) ?? "",
      created: (overrides.created as string) ?? "2025-01-01",
      updated: (overrides.updated as string) ?? "2025-06-01",
      url: `https://test.atlassian.net/browse/${key}`,
      comments: [],
    };
  }

  describe("action=get with links", () => {
    it("shows issue links in output", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Test ticket" }));
      const getLinksSpy = vi.fn().mockResolvedValue([
        {
          direction: "outward",
          linkType: "blocks",
          issueKey: "BP-456",
          status: "In Progress",
          summary: "Some summary",
        },
        {
          direction: "inward",
          linkType: "is blocked by",
          issueKey: "BP-123",
          status: "Done",
          summary: "Other summary",
        },
      ]);
      (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getIssueLinks",
      ).mockImplementation(getLinksSpy);

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-1" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("**Links:**");
      expect(text).toContain("blocks \u2192 BP-456 (In Progress): Some summary");
      expect(text).toContain("is blocked by \u2190 BP-123 (Done): Other summary");

      getIssueSpy.mockRestore();
      vi.restoreAllMocks();
    });
  });

  describe("action=epic-progress", () => {
    it("computes progress with mixed statuses", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const epicIssuesSpy = vi.fn().mockResolvedValue([
        {
          key: "BP-10",
          id: "10",
          fields: {
            summary: "Done task",
            status: { name: "Done", statusCategory: { name: "Done" } },
            customfield_10016: 3,
          },
        },
        {
          key: "BP-11",
          id: "11",
          fields: {
            summary: "In progress task",
            status: { name: "In Progress", statusCategory: { name: "indeterminate" } },
            customfield_10016: 5,
          },
        },
        {
          key: "BP-12",
          id: "12",
          fields: {
            summary: "Todo task",
            status: { name: "To Do", statusCategory: { name: "new" } },
            customfield_10016: 2,
          },
        },
        {
          key: "BP-13",
          id: "13",
          fields: {
            summary: "Another done",
            status: { name: "Done", statusCategory: { name: "Done" } },
            customfield_10016: 1,
          },
        },
      ]);
      (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getEpicIssues",
      ).mockImplementation(epicIssuesSpy);

      const issues = getTool("issues");
      const result = await issues({ action: "epic-progress", epicKey: "BP-100" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Epic Progress: BP-100");
      expect(text).toContain("**Total Issues:** 4");
      expect(text).toContain("**Done:** 2");
      expect(text).toContain("**In Progress:** 1");
      expect(text).toContain("**To Do:** 1");
      expect(text).toContain("11 total, 4 completed, 7 remaining");
      expect(text).toContain("**Completion:** 50%");
      expect(text).toContain("Remaining Issues (2)");
      expect(text).toContain("BP-11");
      expect(text).toContain("BP-12");
      // BP-10 is done, should not appear in remaining list (but BP-100 is the epic key in header)
      expect(text).not.toMatch(/- BP-10 \(/);

      vi.restoreAllMocks();
    });

    it("returns error when epicKey missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "epic-progress" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("epicKey is required");
    });
  });

  // rank, find-bugs, assess, triage tests moved to tools-backlog.test.ts and tools-bugs.test.ts
});
