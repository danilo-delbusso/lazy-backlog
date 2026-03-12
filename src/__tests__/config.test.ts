import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adfToText } from "../lib/adf.js";
import { buildJiraClient, errorResponse, formatLabels, resolveConfig, textResponse } from "../lib/config.js";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient } from "../lib/jira.js";

let kb: KnowledgeBase;
let tmpDir: string;

/** Snapshot and restore env vars around each test. */
const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_BOARD_ID",
  "CONFLUENCE_SPACES",
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-test-"));
  kb = new KnowledgeBase(join(tmpDir, "test.db"));

  // Snapshot current env
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }

  // Set required Atlassian credentials
  process.env.ATLASSIAN_SITE_URL = "https://test.atlassian.net";
  process.env.ATLASSIAN_EMAIL = "test@example.com";
  process.env.ATLASSIAN_API_TOKEN = "tok_test123";

  // Clear optional env vars
  delete process.env.JIRA_PROJECT_KEY;
  delete process.env.JIRA_BOARD_ID;
  delete process.env.CONFLUENCE_SPACES;
});

afterEach(() => {
  kb.close();
  rmSync(tmpDir, { recursive: true, force: true });

  // Restore env
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe("resolveConfig", () => {
  it("resolves credentials from env vars", () => {
    const config = resolveConfig(kb);
    expect(config.siteUrl).toBe("https://test.atlassian.net");
    expect(config.email).toBe("test@example.com");
    expect(config.apiToken).toBe("tok_test123");
  });

  it("throws when credentials are missing", () => {
    delete process.env.ATLASSIAN_SITE_URL;
    expect(() => resolveConfig(kb)).toThrow("Missing Atlassian credentials");
  });

  it("reads project settings from SQLite", () => {
    kb.setConfig("atlassian", JSON.stringify({ jiraProjectKey: "BP", jiraBoardId: "266" }));
    const config = resolveConfig(kb);
    expect(config.jiraProjectKey).toBe("BP");
    expect(config.jiraBoardId).toBe("266");
  });

  it("env vars override SQLite settings", () => {
    kb.setConfig("atlassian", JSON.stringify({ jiraProjectKey: "OLD" }));
    process.env.JIRA_PROJECT_KEY = "NEW";
    const config = resolveConfig(kb);
    expect(config.jiraProjectKey).toBe("NEW");
  });

  it("parses CONFLUENCE_SPACES from env", () => {
    process.env.CONFLUENCE_SPACES = "ENG, PM, OPS";
    const config = resolveConfig(kb);
    expect(config.confluenceSpaces).toEqual(["ENG", "PM", "OPS"]);
  });

  it("falls back to SQLite confluence spaces", () => {
    kb.setConfig("atlassian", JSON.stringify({ confluenceSpaces: ["ENG", "PM"] }));
    const config = resolveConfig(kb);
    expect(config.confluenceSpaces).toEqual(["ENG", "PM"]);
  });

  it("handles corrupt stored config gracefully", () => {
    kb.setConfig("atlassian", "not-json{{{");
    // Should not throw — parseStoredConfig returns {} on error
    const config = resolveConfig(kb);
    expect(config.jiraProjectKey).toBeUndefined();
  });

  it("defaults to empty arrays for spaces and rootPageIds", () => {
    const config = resolveConfig(kb);
    expect(config.confluenceSpaces).toEqual([]);
    expect(config.rootPageIds).toEqual([]);
  });
});

// ── textResponse / errorResponse ─────────────────────────────────────────────

describe("textResponse", () => {
  it("wraps text in MCP content format", () => {
    const resp = textResponse("hello");
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0]?.type).toBe("text");
    expect(resp.content[0]?.text).toBe("hello");
  });
});

describe("errorResponse", () => {
  it("wraps error message with isError flag", () => {
    const resp = errorResponse("something broke");
    expect(resp.content[0]?.text).toBe("something broke");
    expect(resp.isError).toBe(true);
  });
});

// ── formatLabels ─────────────────────────────────────────────────────────────

describe("formatLabels", () => {
  it("formats valid JSON label array", () => {
    expect(formatLabels('["auth","design"]')).toBe("auth, design");
  });

  it("returns 'none' for empty array", () => {
    expect(formatLabels("[]")).toBe("none");
  });

  it("returns 'none' for invalid JSON", () => {
    expect(formatLabels("not-json")).toBe("none");
  });

  it("returns 'none' for non-array JSON", () => {
    expect(formatLabels('"string"')).toBe("none");
  });
});

// ── buildJiraClient ─────────────────────────────────────────────────────────

describe("buildJiraClient", () => {
  it("throws when schema projectKey doesn't match resolved config projectKey", () => {
    process.env.JIRA_PROJECT_KEY = "FRONTEND";
    JiraClient.saveSchemaToDb(kb, {
      projectKey: "BACKEND",
      projectName: "Backend",
      boardId: "100",
      issueTypes: [],
      priorities: [],
      statuses: [],
    });

    expect(() => buildJiraClient(kb)).toThrow(/BACKEND.*FRONTEND/);
  });

  it("error message mentions both project keys on mismatch", () => {
    process.env.JIRA_PROJECT_KEY = "NEW";
    JiraClient.saveSchemaToDb(kb, {
      projectKey: "OLD",
      projectName: "Old Project",
      boardId: "50",
      issueTypes: [],
      priorities: [],
      statuses: [],
    });

    expect(() => buildJiraClient(kb)).toThrow("OLD");
    expect(() => buildJiraClient(kb)).toThrow("NEW");
  });
});

// ── adfToText ───────────────────────────────────────────────────────────────

describe("adfToText", () => {
  it("renders taskList with TODO taskItem as '- [ ] text'", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "taskList",
          attrs: { localId: "tl-1" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "ti-1", state: "TODO" },
              content: [{ type: "text", text: "Buy milk" }],
            },
          ],
        },
      ],
    };
    const text = adfToText(adf);
    expect(text).toContain("- [ ] Buy milk");
  });

  it("renders taskItem with state DONE as '- [x] text'", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "taskList",
          attrs: { localId: "tl-2" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "ti-2", state: "DONE" },
              content: [{ type: "text", text: "Write tests" }],
            },
          ],
        },
      ],
    };
    const text = adfToText(adf);
    expect(text).toContain("- [x] Write tests");
  });

  it("renders multiple task items with newline separation", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "taskList",
          attrs: { localId: "tl-3" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "ti-3", state: "TODO" },
              content: [{ type: "text", text: "First task" }],
            },
            {
              type: "taskItem",
              attrs: { localId: "ti-4", state: "DONE" },
              content: [{ type: "text", text: "Second task" }],
            },
            {
              type: "taskItem",
              attrs: { localId: "ti-5", state: "TODO" },
              content: [{ type: "text", text: "Third task" }],
            },
          ],
        },
      ],
    };
    const text = adfToText(adf);
    expect(text).toContain("- [ ] First task\n");
    expect(text).toContain("- [x] Second task\n");
    expect(text).toContain("- [ ] Third task\n");
  });
});
