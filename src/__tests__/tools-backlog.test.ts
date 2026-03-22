import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { registerBacklogTool } from "../tools/backlog.js";
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

function getText(result: { content: { type: string; text: string }[] }): string {
  return (result.content[0] as { type: string; text: string }).text;
}

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

describe("registerBacklogTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-backlog-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers single backlog tool", () => {
    const { server, toolNames } = createMockServer();
    registerBacklogTool(server, () => kb);
    expect(toolNames()).toContain("backlog");
    expect(toolNames()).toHaveLength(1);
  });

  describe("action=list", () => {
    it("returns formatted backlog table", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "First task",
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              story_points: 3,
              assignee: { displayName: "Alice" },
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Second task",
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              story_points: 5,
              assignee: null,
            },
          },
        ],
        total: 2,
      });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "list" });
      const text = getText(result);
      expect(text).toContain("Board Backlog");
      expect(text).toContain("BP-1");
      expect(text).toContain("First task");
      expect(text).toContain("BP-2");
      expect(text).toContain("Second task");
      expect(text).toContain("Alice");
      expect(text).toContain("Unassigned");
    });

    it("returns empty message when backlog is empty", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ issues: [], total: 0 });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "list" });
      const text = getText(result);
      expect(text).toContain("Board backlog is empty");
    });

    it("returns error when board ID not configured", async () => {
      delete process.env.JIRA_BOARD_ID;
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, { ...testSchema, boardId: "" });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "list" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("No board ID configured");
    });
  });

  describe("action=rank", () => {
    it("ranks issue before another", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const rankSpy = vi.spyOn(JiraClient.prototype, "rankIssue").mockResolvedValueOnce();

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", rankBefore: "BP-3" });
      const text = getText(result);
      expect(text).toContain("BP-1");
      expect(text).toContain("before BP-3");
      expect(rankSpy).toHaveBeenCalledWith("BP-1", { rankBefore: "BP-3" });

      rankSpy.mockRestore();
    });

    it("returns error when neither rankBefore nor rankAfter nor position provided", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("rankBefore, rankAfter, or position");
    });

    it("ranks issue to top of backlog", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValueOnce({
        issues: [{ key: "BP-10", id: "10010", fields: { summary: "Top item" } }] as never[],
        total: 5,
      });
      const rankSpy = vi.spyOn(JiraClient.prototype, "rankIssue").mockResolvedValueOnce();

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "top" });
      const text = getText(result);
      expect(text).toContain("top of backlog");
      expect(rankSpy).toHaveBeenCalledWith("BP-1", { rankBefore: "BP-10" });

      backlogSpy.mockRestore();
      rankSpy.mockRestore();
    });

    it("ranks issue to bottom of backlog", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi
        .spyOn(JiraClient.prototype, "getBacklogIssues")
        // First call: get total count
        .mockResolvedValueOnce({
          issues: [] as never[],
          total: 10,
        })
        // Second call: get last item
        .mockResolvedValueOnce({
          issues: [{ key: "BP-99", id: "10099", fields: { summary: "Last item" } }] as never[],
          total: 10,
        });
      const rankSpy = vi.spyOn(JiraClient.prototype, "rankIssue").mockResolvedValueOnce();

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "bottom" });
      const text = getText(result);
      expect(text).toContain("bottom of backlog");
      expect(rankSpy).toHaveBeenCalledWith("BP-1", { rankAfter: "BP-99" });

      backlogSpy.mockRestore();
      rankSpy.mockRestore();
    });

    it("returns already-at-top when issue is first in backlog", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValueOnce({
        issues: [{ key: "BP-1", id: "10001", fields: { summary: "Already top" } }] as never[],
        total: 5,
      });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "top" });
      const text = getText(result);
      expect(text).toContain("already at the top");

      backlogSpy.mockRestore();
    });

    it("handles empty backlog for position ranking", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValueOnce({
        issues: [] as never[],
        total: 0,
      });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "top" });
      const text = getText(result);
      expect(text).toContain("already at the top");

      backlogSpy.mockRestore();
    });

    it("handles empty backlog for bottom position ranking", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValueOnce({
        issues: [] as never[],
        total: 0,
      });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "bottom" });
      const text = getText(result);
      expect(text).toContain("already at the bottom");

      backlogSpy.mockRestore();
    });

    it("returns already-at-bottom when issue is last in backlog", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi
        .spyOn(JiraClient.prototype, "getBacklogIssues")
        .mockResolvedValueOnce({
          issues: [] as never[],
          total: 5,
        })
        .mockResolvedValueOnce({
          issues: [{ key: "BP-1", id: "10001", fields: { summary: "Already bottom" } }] as never[],
          total: 5,
        });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "bottom" });
      const text = getText(result);
      expect(text).toContain("already at the bottom");

      backlogSpy.mockRestore();
    });

    it("ranks issue after another with rankAfter", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const rankSpy = vi.spyOn(JiraClient.prototype, "rankIssue").mockResolvedValueOnce();

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", rankAfter: "BP-3" });
      const text = getText(result);
      expect(text).toContain("BP-1");
      expect(text).toContain("after BP-3");
      expect(rankSpy).toHaveBeenCalledWith("BP-1", { rankAfter: "BP-3" });

      rankSpy.mockRestore();
    });

    it("returns error when issueKey is missing", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", rankBefore: "BP-3" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKey is required");
    });

    it("returns error when rank fails", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const rankSpy = vi.spyOn(JiraClient.prototype, "rankIssue").mockRejectedValueOnce(new Error("Rank API error"));

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", rankBefore: "BP-3" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Rank API error");

      rankSpy.mockRestore();
    });

    it("returns error when board ID not configured for position ranking", async () => {
      delete process.env.JIRA_BOARD_ID;
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, { ...testSchema, boardId: "" });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "rank", issueKey: "BP-1", position: "top" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Board ID is required");
    });
  });

  describe("action=list (duplicates always-on)", () => {
    it("detects duplicate issues automatically", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Implement user authentication login flow",
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: null,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Implement user authentication login process",
              issuetype: { name: "Story" },
              priority: { name: "Medium" },
              assignee: null,
            },
          },
          {
            key: "BP-3",
            fields: {
              summary: "Fix database migration script",
              issuetype: { name: "Bug" },
              priority: { name: "Low" },
              assignee: null,
            },
          },
        ],
        total: 3,
      });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "list" });
      const text = getText(result);
      expect(text).toContain("Board Backlog");
      expect(text).toContain("Potential Duplicates");
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");
    });

    it("does not show duplicates section when no similar issues", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Implement authentication",
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: null,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Fix database migration",
              issuetype: { name: "Bug" },
              priority: { name: "Low" },
              assignee: null,
            },
          },
        ],
        total: 2,
      });

      const backlog = getTool("backlog");
      const result = await backlog({ action: "list" });
      const text = getText(result);
      expect(text).toContain("Board Backlog");
      expect(text).not.toContain("Potential Duplicates");
    });

    it("handles list error gracefully", async () => {
      const { server, getTool } = createMockServer();
      registerBacklogTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const backlogSpy = vi
        .spyOn(JiraClient.prototype, "getBacklogIssues")
        .mockRejectedValueOnce(new Error("API timeout"));

      const backlog = getTool("backlog");
      const result = await backlog({ action: "list" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("API timeout");

      backlogSpy.mockRestore();
    });
  });
});
