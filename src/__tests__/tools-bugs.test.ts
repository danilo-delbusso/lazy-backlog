import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraIssueDetail, type JiraSchema } from "../lib/jira.js";
import { registerBugsTool } from "../tools/bugs.js";
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

describe("registerBugsTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-bugs-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

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

  // ── action=find-bugs ─────────────────────────────────────────────────────

  describe("action=find-bugs", () => {
    it("returns table of untriaged bugs", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Login page crashes",
              reporter: { displayName: "Alice" },
              created: "2025-06-01",
              priority: { name: "High" },
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Button misaligned",
              reporter: { displayName: "Bob" },
              created: "2025-06-02",
              priority: { name: "Low" },
            },
          },
        ],
        total: 2,
      });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "find-bugs" });
      const text = getText(result);
      expect(text).toContain("Untriaged Bugs (2 of 2)");
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");
      expect(text).toContain("Alice");
      expect(text).toContain("Bob");
    });

    it("returns message when no bugs found", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "find-bugs" });
      const text = getText(result);
      expect(text).toContain("No untriaged bugs found");
    });

    it("applies dateRange filter to default JQL", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      await bugs({ action: "find-bugs", dateRange: "7d" });
      expect(searchSpy).toHaveBeenCalledWith("266", expect.stringContaining("created >= -7d"), expect.any(Number));

      searchSpy.mockRestore();
    });

    it("applies component filter to default JQL", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      await bugs({ action: "find-bugs", component: "Backend" });
      expect(searchSpy).toHaveBeenCalledWith(
        "266",
        expect.stringContaining("component = 'Backend'"),
        expect.any(Number),
      );

      searchSpy.mockRestore();
    });

    it("sanitizes component with special chars to prevent JQL injection", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      await bugs({ action: "find-bugs", component: 'it\'s "bad"' });
      const jql = searchSpy.mock.calls[0]?.[1] as string;
      expect(jql).toContain("component = 'it\\'s \"bad\"'");

      searchSpy.mockRestore();
    });

    it("truncates long summaries in table", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const longSummary = "A".repeat(80);
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: longSummary,
              reporter: { displayName: "Alice" },
              created: "2025-06-01",
              priority: { name: "Medium" },
            },
          },
        ],
        total: 1,
      });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "find-bugs" });
      const text = getText(result);
      // Summary truncated to 50 chars
      expect(text).toContain("A".repeat(50));
      expect(text).not.toContain("A".repeat(51));
    });
  });

  // ── action=search ──────────────────────────────────────────────────────

  describe("action=search", () => {
    it("searches bugs with JQL, enforces type=Bug via board-scoped search", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-100",
            fields: { summary: "Test bug", status: { name: "Open" }, priority: { name: "High" }, assignee: null },
          },
        ] as never[],
        total: 1,
      });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "search", jql: "priority = High" });
      const text = getText(result);
      expect(text).toContain("Bug Search");

      const jql = searchSpy.mock.calls[0]?.[1] as string;
      expect(jql).toContain("type = Bug");

      searchSpy.mockRestore();
    });

    it("returns empty message when no bugs found", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({
        issues: [],
        total: 0,
      });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "search", jql: "priority = High" });
      const text = getText(result);
      expect(text).toContain("No bugs found");

      searchSpy.mockRestore();
    });

    it("preserves user type filter if already present", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-100",
            fields: { summary: "Test bug", status: { name: "Open" }, priority: { name: "High" }, assignee: null },
          },
        ] as never[],
        total: 1,
      });

      const bugs = getTool("bugs");
      await bugs({ action: "search", jql: 'type = Bug AND status = "In Progress"' });

      const jql = searchSpy.mock.calls[0]?.[1] as string;
      // Should not double-add type = Bug
      const typeMatches = jql.match(/type\s*=\s*Bug/gi);
      expect(typeMatches).toHaveLength(1);

      searchSpy.mockRestore();
    });
  });

  // ── action=assess ────────────────────────────────────────────────────────

  describe("action=assess", () => {
    it("returns error when issueKeys missing", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "assess" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKeys required");
    });

    it("returns error when issueKeys is empty array", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "assess", issueKeys: [] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKeys required");
    });

    it("scores fully complete bug as 100%", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const fullDescription =
        "This is a detailed description that is definitely longer than fifty characters. " +
        "Steps to reproduce: 1. Open app 2. Click button. " +
        "Expected: It works. Actual: It crashes. " +
        "Environment: Chrome 120, macOS 14.";

      const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockResolvedValue(
        makeIssueDetail("BP-1", {
          summary: "Complete bug",
          description: fullDescription,
          labels: ["bug"],
          components: ["frontend"],
        }),
      );

      const bugs = getTool("bugs");
      const result = await bugs({ action: "assess", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("100%");
      expect(text).toContain("Complete");

      getIssueSpy.mockRestore();
    });

    it("scores empty bug as 0% with all items missing", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { description: "short", labels: [], components: [] }));

      // Mock addComment and addLabels since score < 60 and autoComment defaults to true
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);
      const addLabelsSpy = vi.spyOn(JiraClient.prototype, "addLabels").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "assess", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("0%");
      expect(text).toContain("Detailed description");
      expect(text).toContain("Steps to reproduce");
      expect(text).toContain("Expected vs actual");
      expect(text).toContain("Environment");
      expect(text).toContain("Labels or components");

      getIssueSpy.mockRestore();
      addCommentSpy.mockRestore();
      addLabelsSpy.mockRestore();
    });

    it("adds comment and needs-info label when score < 60 and autoComment=true", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { description: "short", labels: [], components: [] }));
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);
      const addLabelsSpy = vi.spyOn(JiraClient.prototype, "addLabels").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      await bugs({ action: "assess", issueKeys: ["BP-1"], autoComment: true });

      expect(addCommentSpy).toHaveBeenCalledWith("BP-1", expect.stringContaining("incomplete"));
      expect(addLabelsSpy).toHaveBeenCalledWith("BP-1", ["needs-info"]);

      getIssueSpy.mockRestore();
      addCommentSpy.mockRestore();
      addLabelsSpy.mockRestore();
    });

    it("does not comment when autoComment=false even if score < 60", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { description: "short", labels: [], components: [] }));
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);
      const addLabelsSpy = vi.spyOn(JiraClient.prototype, "addLabels").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      await bugs({ action: "assess", issueKeys: ["BP-1"], autoComment: false });

      expect(addCommentSpy).not.toHaveBeenCalled();
      expect(addLabelsSpy).not.toHaveBeenCalled();

      getIssueSpy.mockRestore();
      addCommentSpy.mockRestore();
      addLabelsSpy.mockRestore();
    });

    it("assesses multiple bugs in sequence", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "Bug one" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "Bug two" }));
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);
      const addLabelsSpy = vi.spyOn(JiraClient.prototype, "addLabels").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "assess", issueKeys: ["BP-1", "BP-2"] });
      const text = getText(result);
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");

      getIssueSpy.mockRestore();
      addCommentSpy.mockRestore();
      addLabelsSpy.mockRestore();
    });
  });

  // ── action=triage ────────────────────────────────────────────────────────

  describe("action=triage", () => {
    it("returns error when issueKeys missing", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKeys required");
    });

    it("returns error when issueKeys is empty array", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: [] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKeys required");
    });

    it("single issue: infers critical severity and recommends active sprint", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Production outage crash" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("Severity Analysis");
      expect(text).toContain("critical");
      expect(text).toContain("Sprint Assignment");
      expect(text).toContain("Sprint 5");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
    });

    it("single issue: infers medium severity when no keywords match", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Button color is wrong" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 10, name: "Sprint 10", state: "future" }]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("medium");
      expect(text).toContain("no specific keywords");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: auto-updates priority when autoUpdate=true", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Security vulnerability in auth", priority: "Low" }));
      const updateIssueSpy = vi.spyOn(JiraClient.prototype, "updateIssue").mockResolvedValue(undefined);
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      await bugs({ action: "triage", issueKeys: ["BP-1"], autoUpdate: true });

      expect(updateIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "BP-1", priority: "critical" }));

      getIssueSpy.mockRestore();
      updateIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
    });

    it("single issue with autoAssign: moves to sprint and comments", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Production crash" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });
      const moveToSprintSpy = vi.spyOn(JiraClient.prototype, "moveIssuesToSprint").mockResolvedValue(undefined);
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      await bugs({ action: "triage", issueKeys: ["BP-1"], autoAssign: true });

      expect(moveToSprintSpy).toHaveBeenCalledWith("5", ["BP-1"]);
      expect(addCommentSpy).toHaveBeenCalledWith("BP-1", expect.stringContaining("Sprint 5"));

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
      moveToSprintSpy.mockRestore();
      addCommentSpy.mockRestore();
    });

    it("multiple issues: generates report with severity and status distributions", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "crash data loss", status: "To Do" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "outage problem", status: "To Do" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-3", { summary: "normal thing", status: "In Progress" }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2", "BP-3"] });
      const text = getText(result);
      expect(text).toContain("Triage Report");
      expect(text).toContain("Severity Distribution");
      expect(text).toContain("Status Distribution");

      getIssueSpy.mockRestore();
    });

    it("multiple issues: lists incomplete bugs (score < 60)", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { description: "short", labels: [], components: [] }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { description: "short", labels: [], components: [] }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2"] });
      const text = getText(result);
      expect(text).toContain("Incomplete Bugs (2)");

      getIssueSpy.mockRestore();
    });

    it("multiple issues: omits incomplete section when all bugs are complete", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const fullDescription =
        "This is a detailed description that is definitely longer than fifty characters. " +
        "Steps to reproduce: 1. Open app 2. Click button. " +
        "Expected: It works. Actual: It crashes. " +
        "Environment: Chrome 120, macOS 14.";

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(
          makeIssueDetail("BP-1", { description: fullDescription, labels: ["bug"], components: ["fe"] }),
        )
        .mockResolvedValueOnce(
          makeIssueDetail("BP-2", { description: fullDescription, labels: ["bug"], components: ["be"] }),
        );

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2"] });
      const text = getText(result);
      expect(text).not.toContain("Incomplete Bugs");

      getIssueSpy.mockRestore();
    });

    it("multiple issues: counts severity distribution correctly", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "crash data loss" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "outage" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-3", { summary: "normal thing" }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2", "BP-3"] });
      const text = getText(result);
      expect(text).toContain("**critical:** 2");
      expect(text).toContain("**medium:** 1");

      getIssueSpy.mockRestore();
    });
  });
});
