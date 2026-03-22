import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { registerSprintsTool } from "../tools/sprints.js";
import {
  computeStoryPointTotals,
  formatReleaseNotes,
  formatStandupDigest,
  getStoryPoints,
  parseSinceParam,
  type StandupChange,
} from "../tools/sprints-utils.js";
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

// ── Test data ────────────────────────────────────────────────────────────────

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

// ── Helper to make sprint issues ─────────────────────────────────────────────

function makeSprintIssues(statuses: string[], points: (number | undefined)[], options?: { issueTypes?: string[] }) {
  return statuses.map((status, idx) => ({
    key: `BP-${idx + 1}`,
    id: String(idx + 1),
    fields: {
      summary: `Issue ${idx + 1}`,
      issuetype: { name: options?.issueTypes?.[idx] ?? "Task" },
      status: { name: status },
      priority: { name: "Medium" },
      assignee: null,
      story_points: points[idx],
    },
  }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerSprintsTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-sprint-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    JiraClient.saveSchemaToDb(kb, testSchema);
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers single 'sprints' tool", () => {
    const { server, toolNames } = createMockServer();
    registerSprintsTool(server, () => kb);
    expect(toolNames()).toEqual(["sprints"]);
  });

  describe("action=list", () => {
    it("returns sprint list", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // active sprints
      mockFetchResponse({
        values: [
          {
            id: 1,
            name: "Sprint 1",
            state: "active",
            startDate: "2026-03-01T00:00:00Z",
            endDate: "2026-03-14T00:00:00Z",
            goal: "Ship v2",
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // future sprints
      mockFetchResponse({
        values: [{ id: 2, name: "Sprint 2", state: "future" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "list" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 1");
      expect(text).toContain("Sprint 2");
      expect(text).toContain("active");
      expect(text).toContain("future");
    });

    it("filters by state", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        values: [
          {
            id: 1,
            name: "Sprint 1",
            state: "active",
            startDate: "2026-03-01T00:00:00Z",
            endDate: "2026-03-14T00:00:00Z",
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "list", state: "active" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 1");
      expect(text).toContain("active");
      // Should have called fetch once (not twice for active+future)
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("action=get", () => {
    it("returns active sprint dashboard with issue breakdown", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
        goal: "Deliver MVP",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Task A",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Task B",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Bob" },
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-3",
            fields: {
              summary: "Task C",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints (for capacity)
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 10");
      expect(text).toContain("Deliver MVP");
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");
      expect(text).toContain("Done");
      expect(text).toContain("In Progress");
      expect(text).toContain("Alice");
      expect(text).toContain("Unassigned");
      // Dashboard includes health info
      expect(text).toContain("Sprint Health");
      expect(text).toContain("Progress");
    });

    it("resolves active sprint when no sprintId provided", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // list active sprints (resolveSprintId)
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: makeSprintIssues(["Done", "In Progress"], [5, 3]),
        total: 2,
        maxResults: 50,
      });
      // list closed sprints (for capacity)
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 20");
    });

    it("shows release notes for closed sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "closed",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-14T00:00:00Z",
        goal: "Ship auth",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Auth feature",
              status: { name: "Done" },
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Fix login bug",
              status: { name: "Done" },
              issuetype: { name: "Bug" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 2,
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Release Notes");
      expect(text).toContain("Sprint 10");
      expect(text).toContain("Features");
      expect(text).toContain("Bug Fixes");
      expect(text).toContain("Ship auth");
    });

    it("shows basic info for future sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 30,
        name: "Sprint 30",
        state: "future",
        startDate: "2026-04-01T00:00:00Z",
        endDate: "2026-04-14T00:00:00Z",
        goal: "Plan ahead",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: makeSprintIssues(["To Do"], [3]),
        total: 1,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "30" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 30");
      expect(text).toContain("Future");
      expect(text).toContain("Plan ahead");
      expect(text).toContain("Planned Issues");
    });
  });

  describe("action=create", () => {
    it("creates sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({ id: 99, name: "Sprint 99", state: "future", goal: "Test goal" });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint 99", goal: "Test goal" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      expect(text).toContain("Sprint 99");
      expect(text).toContain("Test goal");
    });

    it("creates sprint with goal and calls updateSprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // POST create sprint
      mockFetchResponse({ id: 100, name: "Sprint 100", state: "future" });
      // PUT updateSprint (goal)
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint 100", goal: "Deliver API v2" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      expect(text).toContain("Sprint 100");
      expect(text).toContain("Deliver API v2");
      // Should have called fetch twice: createSprint + updateSprint
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns error without name", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("name is required");
    });

    it("creates sprint without goal (no updateSprint call)", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 101,
        name: "Sprint 101",
        state: "future",
        startDate: "2026-04-01T00:00:00Z",
        endDate: "2026-04-14T00:00:00Z",
      });

      const sprints = getTool("sprints");
      const result = await sprints({
        action: "create",
        name: "Sprint 101",
        startDate: "2026-04-01T00:00:00Z",
        endDate: "2026-04-14T00:00:00Z",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      expect(text).toContain("Sprint 101");
      expect(text).toContain("future");
      expect(text).toContain("**Start:**");
      expect(text).toContain("**End:**");
      // No goal provided, so only 1 fetch (createSprint) — no updateSprint
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns error when boardId is missing", async () => {
      const { server, getTool } = createMockServer();
      // Clear JIRA_BOARD_ID and save schema without boardId
      delete process.env.JIRA_BOARD_ID;
      const noBoardSchema = { ...testSchema, boardId: "" };
      JiraClient.saveSchemaToDb(kb, noBoardSchema);

      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint X" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("board");
    });

    it("shows goal from created response when no params.goal", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 102,
        name: "Sprint 102",
        state: "future",
        goal: "Server-set goal",
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint 102" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      // The created.goal should show even though params.goal was not set
      expect(text).toContain("Server-set goal");
    });
  });

  describe("action=move-issues", () => {
    it("moves issues to sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // POST move returns 204
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10", issueKeys: ["BP-1", "BP-2"] });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Moved 2 issues");
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");
    });

    it("returns error without sprintId", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", issueKeys: ["BP-1"] });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sprintId is required");
    });

    it("returns error without issueKeys", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("issueKeys is required");
    });

    it("returns error with empty issueKeys array", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10", issueKeys: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("issueKeys is required");
    });

    it("uses singular 'issue' for single item", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10", issueKeys: ["BP-1"] });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Moved 1 issue ");
      expect(text).not.toContain("issues");
    });
  });

  describe("action=get (health dashboard)", () => {
    it("returns health check in active sprint dashboard", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // list active sprints (resolveSprintId)
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-30",
            fields: {
              summary: "Done A",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-31",
            fields: {
              summary: "WIP B",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-32",
            fields: {
              summary: "Todo C",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 2,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints (for capacity computation)
      mockFetchResponse({
        values: [{ id: 10, name: "Sprint 10", state: "closed" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // Closed sprint issues (for velocity computation)
      mockFetchResponse({
        issues: makeSprintIssues(["Done", "Done"], [5, 3]),
        total: 2,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Health");
      expect(text).toContain("Sprint 20");
      expect(text).toContain("Total SP:");
      expect(text).toContain("Done:");
      expect(text).toContain("In Progress:");
      expect(text).toContain("To Do:");
      expect(text).toContain("Blockers:");
      expect(text).toContain("Overall:");
      // Capacity section
      expect(text).toContain("Capacity");
      expect(text).toContain("Committed:");
      expect(text).toContain("Avg Velocity:");
      expect(text).toContain("Capacity Ratio:");
      expect(text).toContain("Per-Assignee Breakdown");
    });

    it("includes items-by-status breakdown", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-30",
            fields: {
              summary: "Done A",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-31",
            fields: {
              summary: "WIP B",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-32",
            fields: {
              summary: "Todo C",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 2,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints (for capacity)
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Issues by Status");
      expect(text).toContain("Done (1)");
      expect(text).toContain("In Progress (1)");
      expect(text).toContain("To Do (1)");
      expect(text).toContain("BP-30");
      expect(text).toContain("BP-31");
      expect(text).toContain("BP-32");
    });

    it("shows stale items when in-progress issues have old updated dates", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const staleDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-40",
            fields: {
              summary: "Stale WIP",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: staleDate,
            },
          },
          {
            key: "BP-41",
            fields: {
              summary: "Fresh WIP",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 2,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });
      // list closed sprints
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Stale Items");
      expect(text).toContain("BP-40");
      expect(text).not.toContain("BP-41: Fresh WIP (last updated:");
    });

    it("shows recently completed items from last 24 hours", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago

      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-50",
            fields: {
              summary: "Just finished",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: recentDate,
            },
          },
          {
            key: "BP-51",
            fields: {
              summary: "Finished long ago",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: oldDate,
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });
      // list closed sprints
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Recently Completed");
      expect(text).toContain("BP-50");
      expect(text).toContain("Just finished");
      // BP-51 should not appear in recently completed (older than 24h)
      expect(text).not.toMatch(/Recently Completed[\s\S]*BP-51/);
    });

    it("shows at-risk items with no story points", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint — already >75% elapsed
      const startDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const endDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate,
        endDate,
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-60",
            fields: {
              summary: "No points task",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              updated: new Date().toISOString(),
              // no story_points
            },
          },
          {
            key: "BP-61",
            fields: {
              summary: "WIP late in sprint",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-62",
            fields: {
              summary: "Already done",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("At Risk");
      expect(text).toContain("BP-60");
      expect(text).toContain("no story points");
      expect(text).toContain("BP-61");
      expect(text).toContain("sprint");
      expect(text).toContain("elapsed");
      // Done items should not be at risk
      expect(text).not.toMatch(/At Risk[\s\S]*BP-62/);
    });

    it("returns dashboard without capacity when no closed sprints", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: makeSprintIssues(["Done", "In Progress"], [5, 3]),
        total: 2,
        maxResults: 50,
      });
      // list closed sprints (none)
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Health");
      expect(text).toContain("Sprint 20");
      // No capacity section when no historical data
      expect(text).not.toContain("Capacity Ratio:");
    });
  });

  describe("action=update", () => {
    it("updates sprint goal", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // PUT updateSprint
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "update", sprintId: "50", goal: "New sprint goal" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Updated");
      expect(text).toContain("New sprint goal");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("updates sprint name", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "update", sprintId: "50", name: "Renamed Sprint" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Updated");
      expect(text).toContain("Renamed Sprint");
    });

    it("returns error without sprintId", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "update", goal: "Some goal" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sprintId is required");
    });

    it("returns error without any update fields", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "update", sprintId: "50" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("At least one of");
    });
  });

  // ── Standup Mode (active sprint + since) ────────────────────────────────
  describe("action=get (standup mode with since)", () => {
    it("returns standup digest with per-person completed/started/blocked", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

      // GET sprint
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-15T00:00:00Z",
        endDate: "2026-03-29T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Login feature",
              status: { name: "Done" },
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
              story_points: 5,
              updated: twoHoursAgo,
              created: "2026-03-16T00:00:00Z",
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Fix navigation",
              status: { name: "In Progress" },
              issuetype: { name: "Bug" },
              priority: { name: "Medium" },
              assignee: { displayName: "Bob" },
              story_points: 3,
              updated: twoHoursAgo,
              created: "2026-03-16T00:00:00Z",
            },
          },
          {
            key: "BP-3",
            fields: {
              summary: "Blocked task",
              status: { name: "Blocked" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
              story_points: 2,
              // Updated 3 days ago — aging blocker
              updated: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
              created: "2026-03-16T00:00:00Z",
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });

      // Mock getIssueChangelog for each issue
      // BP-1: transitioned to Done within the last 24h
      mockFetchResponse({
        values: [
          {
            id: "100",
            created: twoHoursAgo,
            items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // BP-2: transitioned to In Progress within the last 24h
      mockFetchResponse({
        values: [
          {
            id: "101",
            created: twoHoursAgo,
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // BP-3: transitioned to Blocked within the last 24h
      mockFetchResponse({
        values: [
          {
            id: "102",
            created: twoHoursAgo,
            items: [{ field: "status", fromString: "In Progress", toString: "Blocked" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10", since: "24h" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 10");
      expect(text).toContain("Standup Digest");
      expect(text).toContain("Alice");
      expect(text).toContain("Bob");
      expect(text).toContain("Completed");
      expect(text).toContain("BP-1");
      expect(text).toContain("Started");
      expect(text).toContain("BP-2");
      expect(text).toContain("Blocked");
      expect(text).toContain("BP-3");
      // Aging blocker section
      expect(text).toContain("Aging Blockers");
    });

    it("returns error for invalid since param", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-15T00:00:00Z",
        endDate: "2026-03-29T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({ issues: [], total: 0, maxResults: 50 });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10", since: "invalid" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Invalid 'since' value");
    });

    it("shows reassignment changes in standup digest", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-15T00:00:00Z",
        endDate: "2026-03-29T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-5",
            fields: {
              summary: "Reassigned task",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Bob" },
              story_points: 3,
              updated: twoHoursAgo,
              created: "2026-03-16T00:00:00Z",
            },
          },
        ],
        total: 1,
        maxResults: 50,
      });
      // Changelog: reassigned from Alice to Bob
      mockFetchResponse({
        values: [
          {
            id: "200",
            created: twoHoursAgo,
            items: [{ field: "assignee", fromString: "Alice", toString: "Bob" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10", since: "24h" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Reassigned");
      expect(text).toContain("Alice");
      expect(text).toContain("Bob");
    });

    it("shows empty standup when no changes in period", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-15T00:00:00Z",
        endDate: "2026-03-29T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Some task",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              updated: "2026-03-16T00:00:00Z",
              created: "2026-03-10T00:00:00Z",
            },
          },
        ],
        total: 1,
        maxResults: 50,
      });
      // Changelog with old entries only
      mockFetchResponse({
        values: [
          {
            id: "300",
            created: "2026-03-10T00:00:00Z",
            items: [{ field: "status", fromString: "Backlog", toString: "To Do" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10", since: "1h" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("No status changes found");
    });

    it("shows new items added to sprint since cutoff", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-15T00:00:00Z",
        endDate: "2026-03-29T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-70",
            fields: {
              summary: "Brand new issue",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Alice" },
              updated: oneHourAgo,
              created: oneHourAgo,
            },
          },
          {
            key: "BP-71",
            fields: {
              summary: "Started work",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Bob" },
              updated: oneHourAgo,
              created: "2026-03-10T00:00:00Z",
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });
      // Changelog for BP-70: no recognized status change
      mockFetchResponse({
        values: [
          {
            id: "400",
            created: oneHourAgo,
            items: [{ field: "status", fromString: "Backlog", toString: "To Do" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // Changelog for BP-71: started (In Progress) — a recognized change
      mockFetchResponse({
        values: [
          {
            id: "401",
            created: oneHourAgo,
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10", since: "24h" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("New Items Added to Sprint");
      expect(text).toContain("BP-70");
      expect(text).toContain("Brand new issue");
    });
  });

  // ── Closed sprint — Release Notes (additional tests) ────────────────────
  describe("action=get (closed sprint release notes)", () => {
    it("shows carryover items for incomplete issues", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "closed",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-14T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Done feature",
              status: { name: "Done" },
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Incomplete work",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Release Notes");
      expect(text).toContain("Carryover Items");
      expect(text).toContain("BP-2");
      expect(text).toContain("In Progress");
    });

    it("shows sprint metrics with velocity and completion percentage", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "closed",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-14T00:00:00Z",
        goal: "Complete auth module",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Auth login",
              status: { name: "Done" },
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Auth signup",
              status: { name: "Done" },
              issuetype: { name: "Story" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
            },
          },
          {
            key: "BP-3",
            fields: {
              summary: "Not done",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 2,
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Velocity:");
      expect(text).toContain("8 of 10 SP completed");
      expect(text).toContain("Completion:");
      expect(text).toContain("2/3 issues done");
      expect(text).toContain("80%");
      // Goal met (80% >= 80)
      expect(text).toContain("Likely Met");
    });

    it("shows goal not met when completion is under 80%", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "closed",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-14T00:00:00Z",
        goal: "Deliver everything",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Done thing",
              status: { name: "Done" },
              issuetype: { name: "Story" },
              priority: { name: "High" },
              assignee: null,
              story_points: 2,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Not done",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 8,
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Not Met");
    });

    it("groups completed issues by type (tasks/tech debt)", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "closed",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-14T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Refactor auth",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
            },
          },
        ],
        total: 1,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Tasks & Tech Debt");
      expect(text).toContain("BP-1");
    });
  });

  // ── Future sprint (additional tests) ────────────────────────────────────
  describe("action=get (future sprint additional)", () => {
    it("shows planned items with story points", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 30,
        name: "Sprint 30",
        state: "future",
        startDate: "2026-04-01T00:00:00Z",
        endDate: "2026-04-14T00:00:00Z",
        goal: "Setup CI",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Setup pipeline",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 5,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Add linting",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 3,
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "30" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Future");
      expect(text).toContain("Planned Issues");
      expect(text).toContain("2");
      expect(text).toContain("Total SP:");
      expect(text).toContain("8");
      expect(text).toContain("[5pts]");
      expect(text).toContain("[3pts]");
      expect(text).toContain("Setup CI");
    });

    it("shows future sprint with no issues", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 30,
        name: "Sprint 30",
        state: "future",
      });
      mockFetchResponse({
        issues: [],
        total: 0,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "30" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Future");
      expect(text).toContain("Planned Issues");
      expect(text).toContain("0");
      expect(text).toContain("Total SP:");
      expect(text).toContain("0");
      expect(text).not.toContain("Planned Items");
    });
  });

  // ── Active sprint — Blockers ────────────────────────────────────────────
  describe("action=get (blocker detection)", () => {
    it("shows blockers section when issues have blocked status", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-80",
            fields: {
              summary: "Blocked by API",
              status: { name: "Blocked" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: { displayName: "Charlie" },
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-81",
            fields: {
              summary: "Normal task",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Charlie" },
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });
      mockFetchResponse({ values: [], isLast: true, maxResults: 50, startAt: 0 });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Blockers");
      expect(text).toContain("BP-80");
      expect(text).toContain("Blocked by API");
      // Non-blocked issue should not appear in the Blockers section (before next ##)
      const blockersSection = text.match(/## Blockers\n\n([\s\S]*?)(?=\n##)/)?.[1] ?? "";
      expect(blockersSection).toContain("BP-80");
      expect(blockersSection).not.toContain("BP-81");
    });
  });

  // ── Per-assignee workload ───────────────────────────────────────────────
  describe("action=get (per-assignee workload)", () => {
    it("groups issues by assignee with SP and in-progress count", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      mockFetchResponse({
        issues: [
          {
            key: "BP-90",
            fields: {
              summary: "Alice task 1",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-91",
            fields: {
              summary: "Alice task 2",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Alice" },
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-92",
            fields: {
              summary: "Bob task 1",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Bob" },
              story_points: 2,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      mockFetchResponse({ values: [], isLast: true, maxResults: 50, startAt: 0 });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "20" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Per-Assignee Workload");
      expect(text).toContain("Alice (8 SP, 1 in progress)");
      expect(text).toContain("Bob (2 SP, 1 in progress)");
    });
  });
});

// ── Unit tests for sprints-utils ──────────────────────────────────────────

describe("parseSinceParam", () => {
  it("parses hours format (24h)", () => {
    const before = Date.now();
    const result = parseSinceParam("24h");
    const after = Date.now();
    // Should be approximately 24 hours ago
    const expected = before - 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 100);
    expect(result.getTime()).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 100);
  });

  it("parses hours format (48h)", () => {
    const before = Date.now();
    const result = parseSinceParam("48h");
    const expected = before - 48 * 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 100);
    expect(result.getTime()).toBeLessThanOrEqual(expected + 100);
  });

  it("parses hours format case-insensitively (24H)", () => {
    const result = parseSinceParam("24H");
    const expected = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  it("parses ISO date string", () => {
    const result = parseSinceParam("2026-03-01");
    expect(result.getTime()).toBe(new Date("2026-03-01").getTime());
  });

  it("parses ISO datetime string", () => {
    const result = parseSinceParam("2026-03-01T10:00:00Z");
    expect(result.getTime()).toBe(new Date("2026-03-01T10:00:00Z").getTime());
  });

  it("throws on invalid input", () => {
    expect(() => parseSinceParam("invalid")).toThrow("Invalid 'since' value");
  });

  it("throws on empty string", () => {
    expect(() => parseSinceParam("")).toThrow("Invalid 'since' value");
  });

  it("throws on random text", () => {
    expect(() => parseSinceParam("yesterday")).toThrow("Invalid 'since' value");
  });
});

describe("getStoryPoints", () => {
  it("returns story_points from fields", () => {
    expect(getStoryPoints({ story_points: 5 } as unknown as SearchIssue["fields"])).toBe(5);
  });

  it("returns 0 when no story points field exists", () => {
    expect(getStoryPoints({} as unknown as SearchIssue["fields"])).toBe(0);
  });

  it("uses custom spFieldId when provided", () => {
    const fields = { customfield_99: 8 } as unknown as SearchIssue["fields"];
    expect(getStoryPoints(fields, "customfield_99")).toBe(8);
  });

  it("falls back to story_points when spFieldId value is undefined", () => {
    const fields = { story_points: 3 } as unknown as SearchIssue["fields"];
    expect(getStoryPoints(fields, "customfield_99")).toBe(3);
  });

  it("returns 0 for non-numeric story points", () => {
    const fields = { story_points: "five" } as unknown as SearchIssue["fields"];
    expect(getStoryPoints(fields)).toBe(0);
  });
});

describe("computeStoryPointTotals", () => {
  function makeIssue(status: string, sp: number | undefined): SearchIssue {
    return {
      key: "X-1",
      id: "1",
      fields: {
        summary: "test",
        status: { name: status },
        story_points: sp,
      },
    } as unknown as SearchIssue;
  }

  it("computes totals for mixed statuses", () => {
    const issues = [makeIssue("Done", 5), makeIssue("In Progress", 3), makeIssue("To Do", 2)];
    const result = computeStoryPointTotals(issues, undefined);
    expect(result).toEqual({ totalSP: 10, doneSP: 5, inProgressSP: 3 });
  });

  it("counts Closed and Resolved as done", () => {
    const issues = [makeIssue("Closed", 4), makeIssue("Resolved", 2)];
    const result = computeStoryPointTotals(issues, undefined);
    expect(result).toEqual({ totalSP: 6, doneSP: 6, inProgressSP: 0 });
  });

  it("returns zeros for empty array", () => {
    expect(computeStoryPointTotals([], undefined)).toEqual({ totalSP: 0, doneSP: 0, inProgressSP: 0 });
  });

  it("handles undefined story points as 0", () => {
    const issues = [makeIssue("Done", undefined), makeIssue("In Progress", undefined)];
    const result = computeStoryPointTotals(issues, undefined);
    expect(result).toEqual({ totalSP: 0, doneSP: 0, inProgressSP: 0 });
  });
});

describe("formatStandupDigest", () => {
  const since = new Date("2026-03-21T10:00:00Z");

  it("formats per-person changes with all sections", () => {
    const changes = new Map<string, StandupChange>([
      [
        "Alice",
        {
          completed: [{ key: "BP-1", summary: "Login" }],
          started: [{ key: "BP-2", summary: "Signup" }],
          blocked: [{ key: "BP-3", summary: "API issue" }],
          reassigned: [{ key: "BP-4", from: "Bob", to: "Alice" }],
        },
      ],
    ]);
    const result = formatStandupDigest(changes, [], [], since);
    expect(result).toContain("Alice");
    expect(result).toContain("**Completed:**");
    expect(result).toContain("BP-1: Login");
    expect(result).toContain("**Started:**");
    expect(result).toContain("BP-2: Signup");
    expect(result).toContain("**Blocked:**");
    expect(result).toContain("BP-3: API issue");
    expect(result).toContain("**Reassigned:**");
    expect(result).toContain("BP-4");
  });

  it("shows no-changes message for empty map", () => {
    const result = formatStandupDigest(new Map(), [], [], since);
    expect(result).toContain("No status changes found");
  });

  it("includes aging blockers section", () => {
    const agingBlockers = [
      {
        key: "BP-10",
        id: "10",
        fields: { summary: "Old blocker", status: { name: "Blocked" } },
      },
    ] as unknown as SearchIssue[];
    const changes = new Map<string, StandupChange>([
      ["X", { completed: [{ key: "Y-1", summary: "t" }], started: [], blocked: [], reassigned: [] }],
    ]);
    const result = formatStandupDigest(changes, [], agingBlockers, since);
    expect(result).toContain("Aging Blockers");
    expect(result).toContain("BP-10");
  });

  it("includes new items section", () => {
    const newItems = [
      {
        key: "BP-20",
        id: "20",
        fields: { summary: "Brand new", created: "2026-03-21T12:00:00Z" },
      },
    ] as unknown as SearchIssue[];
    const changes = new Map<string, StandupChange>([
      ["X", { completed: [{ key: "Y-1", summary: "t" }], started: [], blocked: [], reassigned: [] }],
    ]);
    const result = formatStandupDigest(changes, newItems, [], since);
    expect(result).toContain("New Items Added to Sprint");
    expect(result).toContain("BP-20");
    expect(result).toContain("Brand new");
  });
});

describe("formatReleaseNotes", () => {
  const sprint: JiraSprint = {
    id: 10,
    name: "Sprint 10",
    state: "closed",
    startDate: "2026-02-01T00:00:00Z",
    endDate: "2026-02-14T00:00:00Z",
    goal: "Ship auth",
    originBoardId: 1,
    self: "",
  };

  function makeIssue(key: string, summary: string, status: string, type: string, sp?: number): SearchIssue {
    return {
      key,
      id: key,
      fields: {
        summary,
        status: { name: status },
        issuetype: { name: type },
        story_points: sp,
      },
    } as unknown as SearchIssue;
  }

  it("formats complete release notes with all sections", () => {
    const issues = [
      makeIssue("BP-1", "Auth feature", "Done", "Story", 5),
      makeIssue("BP-2", "Fix login bug", "Done", "Bug", 2),
      makeIssue("BP-3", "Setup CI", "Done", "Task", 3),
      makeIssue("BP-4", "Incomplete work", "In Progress", "Story", 2),
    ];
    const result = formatReleaseNotes(sprint, issues, undefined);
    expect(result).toContain("Release Notes: Sprint 10");
    expect(result).toContain("Features (1)");
    expect(result).toContain("Bug Fixes (1)");
    expect(result).toContain("Tasks & Tech Debt (1)");
    expect(result).toContain("Carryover Items (1)");
    expect(result).toContain("10 of 12 SP completed");
    expect(result).toContain("3/4 issues done");
    expect(result).toContain("Ship auth");
    expect(result).toContain("Likely Met");
  });

  it("calculates sprint period in days", () => {
    const result = formatReleaseNotes(sprint, [], undefined);
    expect(result).toContain("13 days");
    expect(result).toContain("2026-02-01");
    expect(result).toContain("2026-02-14");
  });

  it("handles sprint with no issues", () => {
    const result = formatReleaseNotes(sprint, [], undefined);
    expect(result).toContain("Release Notes: Sprint 10");
    expect(result).toContain("0 of 0 SP completed");
    expect(result).toContain("0/0 issues done");
  });

  it("shows Not Met when completion under 80%", () => {
    const issues = [
      makeIssue("BP-1", "Done thing", "Done", "Story", 2),
      makeIssue("BP-2", "Not done", "To Do", "Task", 8),
    ];
    const result = formatReleaseNotes(sprint, issues, undefined);
    expect(result).toContain("Not Met");
  });

  it("omits goal line when sprint has no goal", () => {
    const noGoalSprint = { ...sprint, goal: undefined };
    const result = formatReleaseNotes(noGoalSprint, [], undefined);
    expect(result).not.toContain("Goal:");
  });
});
