import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { _internals as httpInternals } from "../lib/http-utils.js";
import { registerConfigureTool } from "../tools/configure.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Module mocks for learn-team ──────────────────────────────────────────────

const mockSearchIssues = vi.fn();
const mockGetIssueChangelog = vi.fn();

vi.mock("../lib/jira.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const RealJiraClient = actual.JiraClient as {
    discoverSchema: (...args: unknown[]) => unknown;
    saveSchemaToDb: (...args: unknown[]) => unknown;
  };
  return {
    ...actual,
    JiraClient: class MockJiraClient {
      searchIssues = mockSearchIssues;
      getIssueChangelog = mockGetIssueChangelog;
      project = "BP";
      static discoverSchema = RealJiraClient.discoverSchema;
      static saveSchemaToDb = RealJiraClient.saveSchemaToDb;
      static loadSchemaFromDb = vi.fn(() => null);
    },
  };
});

const mockAnalyzeBacklog: Mock = vi.fn();
const mockAdfToText: Mock = vi.fn((v: unknown) => (typeof v === "string" ? v : ""));

vi.mock("../lib/team-rules.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    analyzeBacklog: (...args: unknown[]) => mockAnalyzeBacklog(...(args as [unknown, unknown])),
  };
});

vi.mock("../lib/adf.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    adfToText: (...args: unknown[]) => mockAdfToText(...(args as [unknown])),
  };
});

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

// ── registerConfigureTool ────────────────────────────────────────────────────

describe("registerConfigureTool", () => {
  it("registers single configure tool", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-reg-"));
    const kb = new KnowledgeBase(join(tmpDir, "test.db"));
    try {
      const { server, toolNames } = createMockServer();
      registerConfigureTool(server, () => kb);
      expect(toolNames()).toEqual(["configure"]);
    } finally {
      kb.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── action=set ───────────────────────────────────────────────────────────────

describe("action=set", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-set-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("stores jiraProjectKey in SQLite config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "set", jiraProjectKey: "PROJ" });
    expect(result.content[0]?.text).toContain("Saved");
    expect(result.content[0]?.text).toContain("Project: PROJ");

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("PROJ");
  });

  it("merges with existing config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    await configure({ action: "set", jiraProjectKey: "BP" });
    await configure({ action: "set", jiraBoardId: "266" });

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("BP");
    expect(stored.jiraBoardId).toBe("266");
  });

  it("returns summary of saved settings", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({
      action: "set",
      jiraProjectKey: "BP",
      confluenceSpaces: ["ENG", "PM"],
    });
    expect(result.content[0]?.text).toContain("Project: BP");
    expect(result.content[0]?.text).toContain("Spaces: ENG, PM");
  });
});

// ── action=get ───────────────────────────────────────────────────────────────

describe("action=get", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-get-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("returns current config with env + SQLite values", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Store a value in SQLite
    kb.setConfig("atlassian", JSON.stringify({ jiraBoardId: "266" }));

    const configure = getTool("configure");
    const result = await configure({ action: "get" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Current Configuration");
    expect(text).toContain("atlassian.net");
    expect(text).toContain("test@example.com");
  });

  it("shows jiraProjectKey from env when set", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "get" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("BP");
    expect(text).toContain("JIRA_PROJECT_KEY");
  });
});

// ── action=setup ─────────────────────────────────────────────────────────────

describe("action=setup", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-setup-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    mockSearchIssues.mockReset();
    mockGetIssueChangelog.mockReset();
    mockAnalyzeBacklog.mockReset();
    mockAdfToText.mockReset();
    mockAdfToText.mockImplementation((v: unknown) => (typeof v === "string" ? v : ""));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("runs Jira schema discovery and team learning", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery: GET project, createmeta, fields, priorities, statuses, recent issues
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: searchIssues returns empty (no completed tickets)
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Setup Results");
    expect(text).toContain("Jira Schema");
    expect(text).toContain("Backlog (BP)");
    expect(text).toContain("Team Conventions");
  });

  it("returns Jira results and team conventions in output", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: has tickets
    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Add login",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Story" },
            priority: { name: "High" },
            labels: ["auth"],
            components: [{ name: "frontend" }],
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-10T00:00:00Z",
            resolutiondate: "2025-01-10T00:00:00Z",
          },
        },
      ],
      total: 1,
    });
    mockGetIssueChangelog.mockResolvedValue([]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [
        { category: "naming", rule_key: "k", issue_type: "Story", rule_value: "v", confidence: 0.85, sample_size: 1 },
      ],
      totalTickets: 1,
      qualityPassed: 1,
      qualityFailed: 0,
      avgQualityScore: 75.0,
      rulesByCategory: { naming: 1 },
    });

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Backlog (BP)");
    expect(text).toContain("issue types");
    expect(text).toContain("Team Conventions");
    expect(text).toContain("1 rules extracted");
    expect(mockAnalyzeBacklog).toHaveBeenCalledOnce();
  });

  it("skips Confluence when no spaces configured", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Jira Schema");
    expect(text).toContain("Not configured");
  });

  it("returns error when no project key configured", async () => {
    delete process.env.JIRA_PROJECT_KEY;

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("projectKey");
    expect(result.content[0]?.text).toContain("Setup needs more info");
  });

  it("returns error when Jira API call fails", { timeout: 15_000 }, async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Stub sleep to avoid real delays during retries
    const origSleep = httpInternals.sleep;
    httpInternals.sleep = () => Promise.resolve();

    // Must reject enough times to exhaust all retry attempts (initial + MAX_RETRIES)
    const err = new Error("ECONNREFUSED: connection refused");
    fetchMock.mockRejectedValueOnce(err);
    fetchMock.mockRejectedValueOnce(err);
    fetchMock.mockRejectedValueOnce(err);
    fetchMock.mockRejectedValueOnce(err);

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });

    httpInternals.sleep = origSleep;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Jira discovery failed");
    expect(result.content[0]?.text).toContain("ECONNREFUSED");
  });

  it("handles empty ticket history gracefully", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: no completed tickets
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("No completed tickets found");
    expect(text).toContain("Setup complete");
  });

  it("passes quality threshold to team analysis", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team
    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Task 1",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Task" },
            priority: { name: "Medium" },
            labels: [],
            components: [],
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-02T00:00:00Z",
            resolutiondate: null,
          },
        },
      ],
      total: 1,
    });
    mockGetIssueChangelog.mockResolvedValue([]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [],
      totalTickets: 1,
      qualityPassed: 0,
      qualityFailed: 1,
      avgQualityScore: 40.0,
      rulesByCategory: {},
    });

    const configure = getTool("configure");
    await configure({ action: "setup", qualityThreshold: 80 });

    expect(mockAnalyzeBacklog).toHaveBeenCalledWith(expect.any(Array), 80);
  });
});
