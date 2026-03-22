import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema, type SearchIssue } from "../lib/jira.js";
import { registerInsightsTool } from "../tools/insights.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

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
      assignee: undefined,
      story_points: points[idx],
    },
  })) as unknown as SearchIssue[];
}

function getText(result: { content: { type: string; text: string }[] }): string {
  return (result.content[0] as { type: string; text: string }).text;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerInsightsTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-insights-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    JiraClient.saveSchemaToDb(kb, testSchema);
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers single 'insights' tool", () => {
    const { server, toolNames } = createMockServer();
    registerInsightsTool(server, () => kb);
    expect(toolNames()).toContain("insights");
  });

  // ── action=team-profile ──────────────────────────────────────────────────

  describe("action=team-profile", () => {
    it("returns error when no data exists", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      const insights = getTool("insights");
      const result = await insights({ action: "team-profile" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("No team profile data");
    });

    it("shows estimation insights when stored in DB", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      kb.upsertInsight(
        "estimation",
        "Task",
        {
          issueType: "Task",
          medianCycleDays: 3,
          pointsToDaysRatio: 1.5,
          estimationAccuracy: 0.85,
          pointsDistribution: { 1: 2, 2: 5, 3: 8, 5: 3 },
          sampleSize: 18,
        },
        18,
        0.9,
      );

      const insights = getTool("insights");
      const result = await insights({ action: "team-profile" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Team Profile");
      expect(text).toContain("Task");
    });

    it("shows ownership insights when stored in DB", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      kb.upsertInsight(
        "ownership",
        "API",
        {
          component: "API",
          owners: [
            { assignee: "Alice", ticketCount: 10, percentage: 60, avgCycleDays: 2.5 },
            { assignee: "Bob", ticketCount: 7, percentage: 40, avgCycleDays: 3.1 },
          ],
          sampleSize: 17,
        },
        17,
        0.85,
      );

      const insights = getTool("insights");
      const result = await insights({ action: "team-profile" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Team Profile");
      expect(text).toContain("API");
    });

    it("shows team rules when stored in DB", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      kb.upsertTeamRule({
        category: "naming_convention",
        rule_key: "prefix",
        issue_type: "Bug",
        rule_value: "Use [BUG] prefix",
        confidence: 0.8,
        sample_size: 25,
      });

      const insights = getTool("insights");
      const result = await insights({ action: "team-profile" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Team Profile");
      expect(text).toContain("Team Conventions");
      expect(text).toContain("Naming Convention");
      expect(text).toContain("prefix");
      expect(text).toContain("Use [BUG] prefix");
      expect(text).toContain("[Bug]");
      expect(text).toContain("80% confidence");
      expect(text).toContain("n=25");
    });
  });

  // ── action=epic-progress ─────────────────────────────────────────────────

  describe("action=epic-progress", () => {
    it("computes progress with mixed statuses", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

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

      const insights = getTool("insights");
      const result = await insights({ action: "epic-progress", epicKey: "BP-100" });
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
      // BP-10 is done, should not appear in remaining list
      expect(text).not.toMatch(/- BP-10 \(/);

      vi.restoreAllMocks();
    });

    it("returns error when epicKey missing", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      const insights = getTool("insights");
      const result = await insights({ action: "epic-progress" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("epicKey is required");
    });

    it("propagates error when getEpicIssues throws", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      const epicSpy = (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getEpicIssues",
      ).mockImplementation(vi.fn().mockRejectedValue(new Error("Epic not found")));

      const insights = getTool("insights");
      await expect(insights({ action: "epic-progress", epicKey: "BP-999" })).rejects.toThrow("Epic not found");

      epicSpy.mockRestore();
    });
  });

  // ── action=retro ─────────────────────────────────────────────────────────

  describe("action=retro", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns comprehensive retrospective data", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation((_boardId: string, state?: string) => {
        if (state === "closed")
          return Promise.resolve([
            { id: 5, name: "Sprint 5", state: "closed" },
            { id: 6, name: "Sprint 6", state: "closed" },
          ]);
        return Promise.resolve([]);
      });

      vi.spyOn(JiraClient.prototype, "getSprint").mockImplementation((_sprintId: string) =>
        Promise.resolve({
          id: 6,
          name: "Sprint 6",
          state: "closed",
          startDate: "2026-02-15T00:00:00Z",
          endDate: "2026-02-28T00:00:00Z",
          goal: "Finish auth",
        }),
      );

      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((sprintId: string) => {
        if (sprintId === "6") {
          return Promise.resolve({
            issues: [
              {
                key: "BP-10",
                id: "10",
                fields: {
                  summary: "Done task",
                  status: { name: "Done" },
                  issuetype: { name: "Task" },
                  priority: { name: "High" },
                  story_points: 5,
                },
              },
              {
                key: "BP-11",
                id: "11",
                fields: {
                  summary: "Carried task",
                  status: { name: "In Progress" },
                  issuetype: { name: "Bug" },
                  priority: { name: "Medium" },
                  story_points: 3,
                },
              },
            ] as unknown as SearchIssue[],
            total: 2,
          });
        }
        // Sprint 5 issues for velocity
        return Promise.resolve({
          issues: makeSprintIssues(["Done", "Done"], [5, 3]),
          total: 2,
        });
      }) as typeof JiraClient.prototype.getSprintIssues);

      vi.spyOn(JiraClient.prototype, "getIssueChangelog").mockImplementation((_issueKey: string) =>
        Promise.resolve([
          {
            id: "1",
            created: "2026-02-16T10:00:00Z",
            author: { displayName: "dev", accountId: "dev-1" },
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
          },
          {
            id: "2",
            created: "2026-02-19T10:00:00Z",
            author: { displayName: "dev", accountId: "dev-1" },
            items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
          },
        ]),
      );

      const insights = getTool("insights");
      const result = await insights({ action: "retro" });
      const text = getText(result);
      expect(text).toContain("Retrospective");
      expect(text).toContain("Sprint 6");
      expect(text).toContain("Sprint Health");
      expect(text).toContain("Completion Rate");
      expect(text).toContain("Velocity");
      expect(text).toContain("Carry-over");
      expect(text).toContain("BP-10");
      expect(text).toContain("BP-11");
      expect(text).toContain("Completed:");
      expect(text).toContain("Total SP:");
      expect(text).toContain("Issue Breakdown");
      expect(text).toContain("Cycle Time");
    });

    it("returns retro with carry-over items highlighted", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation((_boardId: string, state?: string) => {
        if (state === "closed") return Promise.resolve([{ id: 10, name: "Sprint 10", state: "closed" }]);
        return Promise.resolve([]);
      });

      vi.spyOn(JiraClient.prototype, "getSprint").mockImplementation((_sprintId: string) =>
        Promise.resolve({
          id: 10,
          name: "Sprint 10",
          state: "closed",
          startDate: "2026-02-01T00:00:00Z",
          endDate: "2026-02-14T00:00:00Z",
        }),
      );

      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((sprintId: string) => {
        if (sprintId === "10") {
          return Promise.resolve({
            issues: [
              {
                key: "BP-1",
                id: "1",
                fields: {
                  summary: "Done item",
                  status: { name: "Done" },
                  issuetype: { name: "Task" },
                  priority: { name: "High" },
                  story_points: 3,
                },
              },
              {
                key: "BP-2",
                id: "2",
                fields: {
                  summary: "Still in progress",
                  status: { name: "In Progress" },
                  issuetype: { name: "Task" },
                  priority: { name: "Medium" },
                  story_points: 5,
                },
              },
              {
                key: "BP-3",
                id: "3",
                fields: {
                  summary: "Bug not started",
                  status: { name: "To Do" },
                  issuetype: { name: "Bug" },
                  priority: { name: "Low" },
                  story_points: 2,
                },
              },
            ] as unknown as SearchIssue[],
            total: 3,
          });
        }
        return Promise.resolve({ issues: makeSprintIssues(["Done", "Done"], [5, 3]), total: 2 });
      }) as typeof JiraClient.prototype.getSprintIssues);

      vi.spyOn(JiraClient.prototype, "getIssueChangelog").mockImplementation(() => Promise.resolve([]));

      const insights = getTool("insights");
      const result = await insights({ action: "retro" });
      const text = getText(result);
      expect(text).toContain("Carry-over Items (2)");
      expect(text).toContain("BP-2");
      expect(text).toContain("BP-3");
      expect(text).toContain("Bug Ratio");
      expect(text).toContain("Issue Breakdown");
      expect(text).toContain("Task");
      expect(text).toContain("Bug");
    });

    it("handles no closed sprints", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation(() => Promise.resolve([]));

      const insights = getTool("insights");
      const result = await insights({ action: "retro" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("No closed sprints found");
    });

    it("shows scope creep section for issues added mid-sprint", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      vi.spyOn(JiraClient.prototype, "getSprint").mockImplementation((_sprintId: string) =>
        Promise.resolve({
          id: 15,
          name: "Sprint 15",
          state: "closed",
          startDate: "2026-02-01T00:00:00Z",
          endDate: "2026-02-14T00:00:00Z",
        }),
      );

      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((_sprintId: string) =>
        Promise.resolve({
          issues: [
            {
              key: "BP-20",
              id: "20",
              fields: {
                summary: "Planned task",
                status: { name: "Done" },
                issuetype: { name: "Task" },
                priority: { name: "High" },
                story_points: 3,
                created: "2026-01-25T10:00:00Z",
                updated: "2026-02-10T10:00:00Z",
              },
            },
            {
              key: "BP-21",
              id: "21",
              fields: {
                summary: "Added mid-sprint",
                status: { name: "Done" },
                issuetype: { name: "Bug" },
                priority: { name: "Medium" },
                story_points: 2,
                created: "2026-02-05T10:00:00Z",
                updated: "2026-02-12T10:00:00Z",
              },
            },
            {
              key: "BP-22",
              id: "22",
              fields: {
                summary: "Also added mid-sprint",
                status: { name: "In Progress" },
                issuetype: { name: "Task" },
                priority: { name: "Low" },
                story_points: 1,
                created: "2026-02-08T10:00:00Z",
                updated: "2026-02-13T10:00:00Z",
              },
            },
          ] as unknown as SearchIssue[],
          total: 3,
        })) as typeof JiraClient.prototype.getSprintIssues);

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation(() => Promise.resolve([]));

      vi.spyOn(JiraClient.prototype, "getIssueChangelog").mockImplementation((issueKey: string) => {
        if (issueKey === "BP-20") {
          return Promise.resolve([
            {
              id: "1",
              created: "2026-02-02T10:00:00Z",
              author: { displayName: "dev", accountId: "dev-1" },
              items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
            },
            {
              id: "2",
              created: "2026-02-10T10:00:00Z",
              author: { displayName: "dev", accountId: "dev-1" },
              items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
            },
          ]);
        }
        if (issueKey === "BP-21") {
          return Promise.resolve([
            {
              id: "3",
              created: "2026-02-05T12:00:00Z",
              author: { displayName: "dev", accountId: "dev-1" },
              items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
            },
            {
              id: "4",
              created: "2026-02-12T10:00:00Z",
              author: { displayName: "dev", accountId: "dev-1" },
              items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const insights = getTool("insights");
      const result = await insights({ action: "retro", sprintId: "15" });
      const text = getText(result);
      expect(text).toContain("Scope Creep");
      expect(text).toContain("**Added mid-sprint:** 2 of 3 issues (67%)");
      expect(text).toContain("BP-21");
      expect(text).toContain("BP-22");
      // BP-20 was created before sprint start, should NOT be in scope creep
      expect(text).not.toMatch(/Scope Creep[\s\S]*BP-20/);
    });

    it("shows time-in-status section for completed issues", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      vi.spyOn(JiraClient.prototype, "getSprint").mockImplementation((_sprintId: string) =>
        Promise.resolve({
          id: 16,
          name: "Sprint 16",
          state: "closed",
          startDate: "2026-02-15T00:00:00Z",
          endDate: "2026-02-28T00:00:00Z",
        }),
      );

      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((_sprintId: string) =>
        Promise.resolve({
          issues: [
            {
              key: "BP-30",
              id: "30",
              fields: {
                summary: "Story A",
                status: { name: "Done" },
                issuetype: { name: "Story" },
                priority: { name: "High" },
                story_points: 5,
                created: "2026-02-15T10:00:00Z",
                updated: "2026-02-20T10:00:00Z",
              },
            },
            {
              key: "BP-31",
              id: "31",
              fields: {
                summary: "Bug B",
                status: { name: "Done" },
                issuetype: { name: "Bug" },
                priority: { name: "Medium" },
                story_points: 2,
                created: "2026-02-16T10:00:00Z",
                updated: "2026-02-18T10:00:00Z",
              },
            },
            {
              key: "BP-32",
              id: "32",
              fields: {
                summary: "Story C",
                status: { name: "Done" },
                issuetype: { name: "Story" },
                priority: { name: "Low" },
                story_points: 3,
                created: "2026-02-15T10:00:00Z",
                updated: "2026-02-25T10:00:00Z",
              },
            },
          ] as unknown as SearchIssue[],
          total: 3,
        })) as typeof JiraClient.prototype.getSprintIssues);

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation(() => Promise.resolve([]));

      vi.spyOn(JiraClient.prototype, "getIssueChangelog").mockImplementation(() => Promise.resolve([]));

      const insights = getTool("insights");
      const result = await insights({ action: "retro", sprintId: "16" });
      const text = getText(result);
      expect(text).toContain("Time in Status");
      expect(text).toContain("Story");
      expect(text).toContain("Bug");
      expect(text).toContain("Avg Cycle Time");
    });
  });

  // ── action=plan ───────────────────────────────────────────────────────

  describe("action=plan", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Helper: mock closed sprints for velocity calculation. */
    function mockClosedSprints(sprintCount: number) {
      const closedSprints = Array.from({ length: sprintCount }, (_, i) => ({
        id: 100 + i,
        name: `Sprint ${100 + i}`,
        state: "closed" as const,
      }));

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation((_boardId: string, state?: string) => {
        if (state === "closed") return Promise.resolve(closedSprints);
        if (state === "active") return Promise.resolve([]);
        return Promise.resolve([]);
      });

      // Each closed sprint had 10 SP done
      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((_sprintId: string) =>
        Promise.resolve({
          issues: makeSprintIssues(["Done", "Done"], [5, 5]),
          total: 2,
        })) as typeof JiraClient.prototype.getSprintIssues);
    }

    it("returns full plan with velocity, carryover, capacity, and recommended items", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      // 3 closed sprints for velocity (10 SP each → avg=10)
      const closedSprints = [
        { id: 100, name: "Sprint 100", state: "closed" as const },
        { id: 101, name: "Sprint 101", state: "closed" as const },
        { id: 102, name: "Sprint 102", state: "closed" as const },
      ];
      const activeSprint = { id: 200, name: "Sprint 200", state: "active" as const };

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation((_boardId: string, state?: string) => {
        if (state === "closed") return Promise.resolve(closedSprints);
        if (state === "active") return Promise.resolve([activeSprint]);
        return Promise.resolve([]);
      });

      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((sprintId: string) => {
        if (sprintId === "200") {
          // Active sprint: 1 done (3 SP), 1 in-progress (5 SP) → carryover = 5 SP
          return Promise.resolve({
            issues: [
              {
                key: "BP-50",
                id: "50",
                fields: {
                  summary: "Done in active",
                  status: { name: "Done", statusCategory: { name: "Done" } },
                  story_points: 3,
                },
              },
              {
                key: "BP-51",
                id: "51",
                fields: {
                  summary: "Still in progress",
                  status: { name: "In Progress", statusCategory: { name: "indeterminate" } },
                  story_points: 5,
                },
              },
            ] as unknown as SearchIssue[],
            total: 2,
          });
        }
        // Closed sprints: 10 SP each
        return Promise.resolve({
          issues: makeSprintIssues(["Done", "Done"], [5, 5]),
          total: 2,
        });
      }) as typeof JiraClient.prototype.getSprintIssues);

      vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-60",
            id: "60",
            fields: { summary: "Backlog item 1", status: { name: "To Do" }, story_points: 3 },
          },
          {
            key: "BP-61",
            id: "61",
            fields: { summary: "Backlog item 2", status: { name: "To Do" }, story_points: 2 },
          },
        ] as unknown as SearchIssue[],
        total: 2,
      });

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);

      expect(text).toContain("Sprint Planning Assistant");
      expect(text).toContain("Velocity");
      expect(text).toContain("Carryover");
      expect(text).toContain("BP-51"); // carryover item
      expect(text).toContain("Capacity");
      expect(text).toContain("Available for new work");
      expect(text).toContain("Recommended Items");
      expect(text).toContain("BP-60");
      expect(text).toContain("BP-61");
    });

    it("returns error when no board ID configured", async () => {
      const { server, getTool } = createMockServer();

      // Clear board ID from env — stored config has none either
      delete process.env.JIRA_BOARD_ID;
      // Use the main kb but it has no stored jiraBoardId config key,
      // and env is now cleared, so config.jiraBoardId should be undefined
      registerInsightsTool(server, () => kb);

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("No board ID configured");
    });

    it("returns error when no closed sprints exist (no velocity data)", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation(() => Promise.resolve([]));

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("No closed sprints found");
    });

    it("works with no active sprint (no carryover, full capacity)", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      mockClosedSprints(3);

      vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-70",
            id: "70",
            fields: { summary: "Backlog task", status: { name: "To Do" }, story_points: 4 },
          },
        ] as unknown as SearchIssue[],
        total: 1,
      });

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);

      expect(text).toContain("Sprint Planning Assistant");
      expect(text).toContain("No carryover items");
      expect(text).toContain("Available for new work");
      expect(text).toContain("BP-70");
    });

    it("shows stretch goals when items exceed capacity", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      // 2 closed sprints, 10 SP each → avg=10, no active sprint → capacity=10
      mockClosedSprints(2);

      vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-80",
            id: "80",
            fields: { summary: "Fits in capacity", status: { name: "To Do" }, story_points: 8 },
          },
          {
            key: "BP-81",
            id: "81",
            fields: { summary: "Stretch item 1", status: { name: "To Do" }, story_points: 5 },
          },
          {
            key: "BP-82",
            id: "82",
            fields: { summary: "Stretch item 2", status: { name: "To Do" }, story_points: 3 },
          },
        ] as unknown as SearchIssue[],
        total: 3,
      });

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);

      expect(text).toContain("Recommended Items");
      expect(text).toContain("BP-80"); // fits in 10 SP capacity
      expect(text).toContain("Stretch Goals");
      expect(text).toContain("BP-81"); // doesn't fit
    });

    it("handles empty backlog gracefully", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      mockClosedSprints(2);

      vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValue({
        issues: [],
        total: 0,
      });

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);

      expect(text).toContain("Sprint Planning Assistant");
      expect(text).toContain("Velocity");
      expect(text).toContain("No items fit the available capacity");
    });

    it("shows overcommitment warning when carryover exceeds velocity", async () => {
      const { server, getTool } = createMockServer();
      registerInsightsTool(server, () => kb);

      // 2 closed sprints, 10 SP each → avg=10
      const closedSprints = [
        { id: 100, name: "Sprint 100", state: "closed" as const },
        { id: 101, name: "Sprint 101", state: "closed" as const },
      ];
      const activeSprint = { id: 200, name: "Sprint 200", state: "active" as const };

      vi.spyOn(JiraClient.prototype, "listSprints").mockImplementation((_boardId: string, state?: string) => {
        if (state === "closed") return Promise.resolve(closedSprints);
        if (state === "active") return Promise.resolve([activeSprint]);
        return Promise.resolve([]);
      });

      vi.spyOn(JiraClient.prototype, "getSprintIssues").mockImplementation(((sprintId: string) => {
        if (sprintId === "200") {
          // Active sprint with 9 SP carryover (>80% of avg 10)
          return Promise.resolve({
            issues: [
              {
                key: "BP-90",
                id: "90",
                fields: {
                  summary: "Big carryover",
                  status: { name: "In Progress", statusCategory: { name: "indeterminate" } },
                  story_points: 9,
                },
              },
            ] as unknown as SearchIssue[],
            total: 1,
          });
        }
        return Promise.resolve({
          issues: makeSprintIssues(["Done", "Done"], [5, 5]),
          total: 2,
        });
      }) as typeof JiraClient.prototype.getSprintIssues);

      vi.spyOn(JiraClient.prototype, "getBacklogIssues").mockResolvedValue({
        issues: [],
        total: 0,
      });

      const insights = getTool("insights");
      const result = await insights({ action: "plan" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);

      // Available capacity = 10 - 9 = 1, which is < 20% of 10
      expect(text).toContain("Warning");
      expect(text).toContain("capacity");
    });
  });
});
