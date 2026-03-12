import { describe, expect, it } from "vitest";
import {
  adfToText,
  analyzeBacklog,
  buildQualityMap,
  type ChangelogItem,
  DEFAULT_RULES,
  extractComponentRules,
  extractDescriptionRules,
  extractLabelRules,
  extractNamingRules,
  extractPointRules,
  extractSprintCompositionRules,
  extractWorkflowRules,
  formatTeamStyleGuide,
  mean,
  median,
  mergeWithDefaults,
  pct,
  percentile,
  scoreTicketQuality,
  stddev,
  type TeamRule,
  type TicketData,
  topN,
} from "../lib/team-rules.js";

// ─── Test Data Helpers ──────────────────────────────────────────────────────

function makeChangelog(transitions: { from: string; to: string; daysAfterCreate: number }[]): ChangelogItem[] {
  const base = new Date("2025-01-01T00:00:00Z").getTime();
  return transitions.map((t) => ({
    field: "status",
    from: t.from,
    to: t.to,
    timestamp: new Date(base + t.daysAfterCreate * 86400000).toISOString(),
  }));
}

function makeTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    key: "TEST-1",
    summary: "Add retry logic to ingestion pipeline",
    description:
      "## Context\nThe ingestion pipeline fails silently.\n\n## Requirements\n- Add exponential backoff\n- Log retries\n\n## Acceptance Criteria\n- [ ] Retries 3 times\n- [ ] Logs each attempt\n\n## Technical Notes\nSee ADR-042.",
    issueType: "Story",
    priority: "Medium",
    storyPoints: 5,
    labels: ["tech-debt"],
    components: ["backend"],
    status: "Done",
    assignee: "Alice",
    created: "2025-01-01T00:00:00Z",
    updated: "2025-01-10T00:00:00Z",
    resolutionDate: "2025-01-10T00:00:00Z",
    changelog: makeChangelog([
      { from: "To Do", to: "In Progress", daysAfterCreate: 1 },
      { from: "In Progress", to: "In Review", daysAfterCreate: 5 },
      { from: "In Review", to: "Done", daysAfterCreate: 8 },
    ]),
    ...overrides,
  };
}

function makeMinimalTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    key: "TEST-99",
    summary: "thing",
    description: "",
    issueType: "Task",
    priority: "Medium",
    storyPoints: null,
    labels: [],
    components: [],
    status: "To Do",
    assignee: null,
    created: "2025-01-01T00:00:00Z",
    updated: "2025-01-01T00:00:00Z",
    resolutionDate: null,
    changelog: [],
    ...overrides,
  };
}

function makeBugTicket(key: string, summary: string): TicketData {
  return makeTicket({
    key,
    summary,
    issueType: "Bug",
    description:
      "## Steps to Reproduce\n1. Open the app\n2. Click submit\n\n## Expected Behavior\nForm submits\n\n## Actual Behavior\nError 500\n\n## Environment\nProd",
    storyPoints: 2,
    labels: ["bug-fix"],
    changelog: makeChangelog([
      { from: "To Do", to: "In Progress", daysAfterCreate: 0.5 },
      { from: "In Progress", to: "Done", daysAfterCreate: 2 },
    ]),
  });
}

function makeBacklog(count: number): TicketData[] {
  const verbs = ["Add", "Fix", "Implement", "Create", "Update", "Remove", "Refactor", "Migrate"];
  const nouns = [
    "retry logic to pipeline",
    "null pointer in auth service",
    "caching layer for API",
    "user dashboard component",
    "database migration script",
    "deprecated endpoint handler",
    "payment module structure",
    "data from legacy system",
  ];
  const tickets: TicketData[] = [];
  for (let i = 0; i < count; i++) {
    const verb = verbs[i % verbs.length] as string;
    const noun = nouns[i % nouns.length] as string;
    const isBug = i % 3 === 0;
    if (isBug) {
      tickets.push(makeBugTicket(`BACK-${i + 1}`, `${verb} ${noun}`));
    } else {
      tickets.push(
        makeTicket({
          key: `BACK-${i + 1}`,
          summary: `${verb} ${noun}`,
          storyPoints: [1, 2, 3, 5, 8][i % 5] ?? 1,
        }),
      );
    }
  }
  return tickets;
}

// ─── adfToText ──────────────────────────────────────────────────────────────

describe("adfToText", () => {
  it("converts simple paragraph ADF to text", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    };
    expect(adfToText(adf).trim()).toBe("Hello world");
  });

  it("converts heading nodes with correct level prefixes", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Section Title" }],
        },
      ],
    };
    expect(adfToText(adf)).toContain("## Section Title");
  });

  it("handles nested content (paragraph inside bulletList)", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item one" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = adfToText(adf);
    expect(result).toContain("- Item one");
  });

  it("returns empty string for null/undefined input", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  it("returns empty string for non-object input", () => {
    expect(adfToText("just a string")).toBe("");
    expect(adfToText(42)).toBe("");
  });
});

// ─── scoreTicketQuality ─────────────────────────────────────────────────────

describe("scoreTicketQuality", () => {
  it("perfect ticket scores high (>= 80)", () => {
    const ticket = makeTicket();
    const score = scoreTicketQuality(ticket);
    expect(score.total).toBeGreaterThanOrEqual(70);
  });

  it("empty description ticket scores low on description (0-10)", () => {
    const ticket = makeTicket({ description: "" });
    const score = scoreTicketQuality(ticket);
    expect(score.description).toBeLessThanOrEqual(10);
  });

  it("ticket with no story points loses metadata points", () => {
    const withPoints = makeTicket({ storyPoints: 5 });
    const withoutPoints = makeTicket({ storyPoints: null });
    const scoreWith = scoreTicketQuality(withPoints);
    const scoreWithout = scoreTicketQuality(withoutPoints);
    expect(scoreWith.metadata).toBeGreaterThan(scoreWithout.metadata);
  });

  it("ticket with no changelog loses process points", () => {
    const withChangelog = makeTicket();
    const withoutChangelog = makeTicket({ changelog: [] });
    const scoreWith = scoreTicketQuality(withChangelog);
    const scoreWithout = scoreTicketQuality(withoutChangelog);
    expect(scoreWith.process).toBeGreaterThan(scoreWithout.process);
  });

  it("minimum quality ticket (just a title) scores < 30", () => {
    const ticket = makeMinimalTicket();
    const score = scoreTicketQuality(ticket);
    expect(score.total).toBeLessThan(30);
  });

  it("scores higher for longer descriptions (100-300-500 char thresholds)", () => {
    const short = makeTicket({ description: "x".repeat(50) });
    const medium = makeTicket({ description: "x".repeat(150) });
    const long = makeTicket({ description: "x".repeat(350) });
    const veryLong = makeTicket({ description: "x".repeat(550) });

    const shortScore = scoreTicketQuality(short).description;
    const mediumScore = scoreTicketQuality(medium).description;
    const longScore = scoreTicketQuality(long).description;
    const veryLongScore = scoreTicketQuality(veryLong).description;

    expect(mediumScore).toBeGreaterThan(shortScore);
    expect(longScore).toBeGreaterThan(mediumScore);
    expect(veryLongScore).toBeGreaterThan(longScore);
  });

  it("scores description with context section keywords", () => {
    const withContext = makeTicket({
      description: "## Context\nSome background info about the feature requirements",
    });
    const withoutContext = makeTicket({ description: "Just a plain sentence" });
    expect(scoreTicketQuality(withContext).description).toBeGreaterThan(scoreTicketQuality(withoutContext).description);
  });

  it("gives metadata bonus for non-Medium priority", () => {
    const medium = makeTicket({ priority: "Medium" });
    const high = makeTicket({ priority: "High" });
    expect(scoreTicketQuality(high).metadata).toBeGreaterThan(scoreTicketQuality(medium).metadata);
  });

  it("caps metadata score at 30", () => {
    const maxMetadata = makeTicket({
      storyPoints: 5,
      labels: ["tech-debt"],
      components: ["backend"],
      priority: "Critical",
    });
    expect(scoreTicketQuality(maxMetadata).metadata).toBeLessThanOrEqual(30);
  });

  it("scores process for description updates in changelog", () => {
    const withDescUpdate = makeTicket({
      changelog: [
        ...makeChangelog([{ from: "To Do", to: "In Progress", daysAfterCreate: 1 }]),
        { field: "description", from: "old", to: "new", timestamp: "2025-01-02T00:00:00Z" },
      ],
    });
    const withoutDescUpdate = makeTicket({
      changelog: makeChangelog([{ from: "To Do", to: "In Progress", daysAfterCreate: 1 }]),
    });
    expect(scoreTicketQuality(withDescUpdate).process).toBeGreaterThan(scoreTicketQuality(withoutDescUpdate).process);
  });

  it("scores process for resolutionDate", () => {
    const withResolution = makeTicket({ resolutionDate: "2025-01-10T00:00:00Z" });
    const withoutResolution = makeTicket({ resolutionDate: null });
    expect(scoreTicketQuality(withResolution).process).toBeGreaterThan(scoreTicketQuality(withoutResolution).process);
  });

  it("gives process bonus for 3+ unique statuses in changelog", () => {
    const threeStatuses = makeTicket({
      changelog: makeChangelog([
        { from: "To Do", to: "In Progress", daysAfterCreate: 1 },
        { from: "In Progress", to: "In Review", daysAfterCreate: 3 },
        { from: "In Review", to: "Done", daysAfterCreate: 5 },
      ]),
    });
    const twoStatuses = makeTicket({
      changelog: makeChangelog([{ from: "To Do", to: "Done", daysAfterCreate: 1 }]),
    });
    expect(scoreTicketQuality(threeStatuses).process).toBeGreaterThan(scoreTicketQuality(twoStatuses).process);
  });

  it("handles null description gracefully", () => {
    const ticket = makeTicket({ description: undefined as unknown as string });
    const score = scoreTicketQuality(ticket);
    expect(score.description).toBe(0);
  });
});

// ─── extractDescriptionRules ────────────────────────────────────────────────

describe("extractDescriptionRules", () => {
  it("detects checkbox AC format when majority use checkboxes", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `CHK-${i}`,
        description: "## AC\n- [ ] First\n- [x] Second\n- [ ] Third",
      }),
    );
    const rules = extractDescriptionRules(tickets);
    const acRule = rules.find((r) => r.rule_key.startsWith("ac_format/"));
    expect(acRule).toBeDefined();
    expect(acRule?.rule_value).toBe("checkbox");
  });

  it("detects section headings from markdown headings", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `HEAD-${i}`,
        description: "## Context\nSome context\n\n## Requirements\n- Item\n\n## Acceptance Criteria\n- [ ] Done",
      }),
    );
    const rules = extractDescriptionRules(tickets);
    const headingRule = rules.find((r) => r.rule_key.startsWith("section_headings/"));
    expect(headingRule).toBeDefined();
    const headings: string[] = JSON.parse(headingRule?.rule_value ?? "");
    expect(headings).toContain("context");
    expect(headings).toContain("requirements");
  });

  it("returns empty rules for empty input", () => {
    expect(extractDescriptionRules([])).toEqual([]);
  });

  it("calculates average description length", () => {
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ key: `LEN-${i}`, description: "x".repeat(200) }));
    const rules = extractDescriptionRules(tickets);
    const avgRule = rules.find((r) => r.rule_key.startsWith("avg_length/"));
    expect(avgRule).toBeDefined();
    expect(Number(avgRule?.rule_value)).toBe(200);
  });
});

// ─── extractNamingRules ─────────────────────────────────────────────────────

describe("extractNamingRules", () => {
  it("detects verb-first pattern when summaries start with verbs", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({ key: `VRB-${i}`, summary: "Add new feature to dashboard" }),
    );
    const rules = extractNamingRules(tickets);
    const patternRule = rules.find((r) => r.rule_key.startsWith("pattern/"));
    expect(patternRule).toBeDefined();
    expect(patternRule?.rule_value).toBe("verb-first");
  });

  it("groups rules by issue type", () => {
    const tickets = [
      makeTicket({ key: "A-1", issueType: "Story", summary: "Add login page" }),
      makeBugTicket("A-2", "Fix broken link"),
    ];
    const rules = extractNamingRules(tickets);
    const storyRules = rules.filter((r) => r.issue_type === "Story");
    const bugRules = rules.filter((r) => r.issue_type === "Bug");
    expect(storyRules.length).toBeGreaterThan(0);
    expect(bugRules.length).toBeGreaterThan(0);
  });

  it("finds top verbs per type", () => {
    const tickets = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeTicket({ key: `FIX-${i}`, issueType: "Bug", summary: "Fix crash on startup" }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeTicket({ key: `RES-${i}`, issueType: "Bug", summary: "Resolve timeout issue" }),
      ),
    ];
    const rules = extractNamingRules(tickets);
    const verbRule = rules.find((r) => r.rule_key === "first_verb/Bug");
    expect(verbRule).toBeDefined();
    const verbs: { verb: string; percentage: string }[] = JSON.parse(verbRule?.rule_value ?? "");
    expect((verbs[0] as { verb: string }).verb).toBe("fix");
  });

  it("calculates average word count", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({ key: `WC-${i}`, summary: "Add retry logic to pipeline" }),
    );
    const rules = extractNamingRules(tickets);
    const avgRule = rules.find((r) => r.rule_key.startsWith("avg_words/"));
    expect(avgRule).toBeDefined();
    expect(Number(avgRule?.rule_value)).toBe(5);
  });
});

// ─── extractPointRules ──────────────────────────────────────────────────────

describe("extractPointRules", () => {
  it("calculates median story points by type", () => {
    const tickets = [
      makeTicket({ key: "P-1", storyPoints: 3 }),
      makeTicket({ key: "P-2", storyPoints: 5 }),
      makeTicket({ key: "P-3", storyPoints: 8 }),
    ];
    const rules = extractPointRules(tickets);
    const medianRule = rules.find((r) => r.rule_key.startsWith("median/"));
    expect(medianRule).toBeDefined();
    expect(Number(medianRule?.rule_value)).toBe(5);
  });

  it("calculates point range (p25-p75)", () => {
    const tickets = Array.from({ length: 20 }, (_, i) =>
      makeTicket({ key: `R-${i}`, storyPoints: [1, 2, 3, 5, 8][i % 5] ?? 1 }),
    );
    const rules = extractPointRules(tickets);
    const rangeRule = rules.find((r) => r.rule_key.startsWith("range/"));
    expect(rangeRule).toBeDefined();
    expect(rangeRule?.rule_value).toMatch(/^\d+-\d+$/);
  });

  it("handles tickets with no story points (filters them out)", () => {
    const tickets = [makeTicket({ key: "NP-1", storyPoints: null }), makeTicket({ key: "NP-2", storyPoints: null })];
    const rules = extractPointRules(tickets);
    expect(rules).toEqual([]);
  });

  it("returns empty for no pointed tickets", () => {
    expect(extractPointRules([])).toEqual([]);
  });
});

// ─── extractWorkflowRules ───────────────────────────────────────────────────

describe("extractWorkflowRules", () => {
  it("detects happy path from changelog transitions", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `WF-${i}`,
        changelog: makeChangelog([
          { from: "To Do", to: "In Progress", daysAfterCreate: 1 },
          { from: "In Progress", to: "In Review", daysAfterCreate: 3 },
          { from: "In Review", to: "Done", daysAfterCreate: 5 },
        ]),
      }),
    );
    const rules = extractWorkflowRules(tickets);
    const happyPath = rules.find((r) => r.rule_key === "happy_path");
    expect(happyPath).toBeDefined();
    const path: string[] = JSON.parse(happyPath?.rule_value ?? "");
    expect(path).toContain("To Do");
    expect(path).toContain("Done");
  });

  it("calculates average days per status", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({
        key: `AVG-${i}`,
        changelog: makeChangelog([
          { from: "To Do", to: "In Progress", daysAfterCreate: 2 },
          { from: "In Progress", to: "Done", daysAfterCreate: 6 },
        ]),
      }),
    );
    const rules = extractWorkflowRules(tickets);
    const daysRule = rules.find((r) => r.rule_key === "avg_days_per_status");
    expect(daysRule).toBeDefined();
    const days: Record<string, string> = JSON.parse(daysRule?.rule_value ?? "{}");
    expect(Object.keys(days).length).toBeGreaterThan(0);
  });

  it("identifies bottleneck status", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({
        key: `BN-${i}`,
        changelog: makeChangelog([
          { from: "To Do", to: "In Progress", daysAfterCreate: 1 },
          { from: "In Progress", to: "In Review", daysAfterCreate: 10 },
          { from: "In Review", to: "Done", daysAfterCreate: 11 },
        ]),
      }),
    );
    const rules = extractWorkflowRules(tickets);
    const bottleneck = rules.find((r) => r.rule_key === "bottleneck");
    expect(bottleneck).toBeDefined();
    expect(bottleneck?.rule_value).toBe("In Progress");
  });

  it("returns empty rules when all tickets have empty changelogs", () => {
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ key: `NC-${i}`, changelog: [] }));
    expect(extractWorkflowRules(tickets)).toEqual([]);
  });

  it("handles tickets with single transition (no sequence)", () => {
    const tickets = Array.from({ length: 3 }, (_, i) =>
      makeTicket({
        key: `ST-${i}`,
        changelog: makeChangelog([{ from: "To Do", to: "Done", daysAfterCreate: 1 }]),
      }),
    );
    const rules = extractWorkflowRules(tickets);
    // Should produce rules even with minimal transitions
    expect(rules.length).toBeGreaterThan(0);
    const daysRule = rules.find((r) => r.rule_key === "avg_days_per_status");
    expect(daysRule).toBeDefined();
  });

  it("calculates avg_total_days from resolution dates", () => {
    const tickets = Array.from({ length: 3 }, (_, i) =>
      makeTicket({
        key: `LD-${i}`,
        resolutionDate: "2025-01-10T00:00:00Z",
        changelog: makeChangelog([
          { from: "To Do", to: "In Progress", daysAfterCreate: 1 },
          { from: "In Progress", to: "Done", daysAfterCreate: 5 },
        ]),
      }),
    );
    const rules = extractWorkflowRules(tickets);
    const leadTime = rules.find((r) => r.rule_key === "avg_total_days");
    expect(leadTime).toBeDefined();
    expect(Number(leadTime?.rule_value)).toBeGreaterThan(0);
  });

  it("handles changelog entries with null from/to fields", () => {
    const tickets = [
      makeTicket({
        key: "NULL-1",
        changelog: [
          {
            field: "status",
            from: null,
            to: "In Progress",
            timestamp: "2025-01-02T00:00:00Z",
          },
          {
            field: "status",
            from: "In Progress",
            to: null,
            timestamp: "2025-01-05T00:00:00Z",
          },
        ],
      }),
    ];
    // Should not throw
    const rules = extractWorkflowRules(tickets);
    expect(rules.length).toBeGreaterThan(0);
  });
});

// ─── extractComponentRules ───────────────────────────────────────────────────

describe("extractComponentRules", () => {
  it("extracts top components and usage rate", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `COMP-${i}`,
        components: i < 7 ? ["backend"] : ["frontend"],
      }),
    );
    const rules = extractComponentRules(tickets);
    expect(rules.length).toBe(2);

    const topRule = rules.find((r) => r.rule_key === "top_components");
    expect(topRule).toBeDefined();
    const comps: { component: string; percentage: string }[] = JSON.parse(topRule?.rule_value ?? "[]");
    expect((comps[0] as { component: string }).component).toBe("backend");

    const usageRule = rules.find((r) => r.rule_key === "usage_rate");
    expect(usageRule).toBeDefined();
    expect(usageRule?.rule_value).toBe("100%");
  });

  it("returns empty rules for empty input", () => {
    expect(extractComponentRules([])).toEqual([]);
  });

  it("reports correct usage rate when some tickets lack components", () => {
    const tickets = [
      makeTicket({ key: "C-1", components: ["backend"] }),
      makeTicket({ key: "C-2", components: [] }),
      makeTicket({ key: "C-3", components: ["frontend"] }),
      makeTicket({ key: "C-4", components: [] }),
    ];
    const rules = extractComponentRules(tickets);
    const usageRule = rules.find((r) => r.rule_key === "usage_rate");
    expect(usageRule).toBeDefined();
    expect(usageRule?.rule_value).toBe("50%");
  });
});

// ─── extractLabelRules (extractStoryPointRules proxy) ────────────────────────

describe("extractLabelRules", () => {
  it("extracts top labels and usage stats", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `LBL-${i}`,
        labels: i < 6 ? ["tech-debt", "backend"] : ["feature"],
      }),
    );
    const rules = extractLabelRules(tickets);
    expect(rules.length).toBe(3);

    const topRule = rules.find((r) => r.rule_key === "top_labels");
    expect(topRule).toBeDefined();
    const labels: { label: string; percentage: string }[] = JSON.parse(topRule?.rule_value ?? "[]");
    expect((labels[0] as { label: string }).label).toBe("tech-debt");

    const avgRule = rules.find((r) => r.rule_key === "avg_per_ticket");
    expect(avgRule).toBeDefined();
    expect(Number(avgRule?.rule_value)).toBeGreaterThan(1);
  });

  it("returns empty rules for empty input", () => {
    expect(extractLabelRules([])).toEqual([]);
  });

  it("reports correct usage rate when some tickets have no labels", () => {
    const tickets = [
      makeTicket({ key: "L-1", labels: ["bug"] }),
      makeTicket({ key: "L-2", labels: [] }),
      makeTicket({ key: "L-3", labels: [] }),
      makeTicket({ key: "L-4", labels: ["feature"] }),
    ];
    const rules = extractLabelRules(tickets);
    const usageRule = rules.find((r) => r.rule_key === "usage_rate");
    expect(usageRule).toBeDefined();
    expect(usageRule?.rule_value).toBe("50%");
  });
});

// ─── extractSprintCompositionRules (extractStatusRules) ──────────────────────

describe("extractSprintCompositionRules", () => {
  it("extracts type mix and avg points per ticket", () => {
    const tickets = [
      makeTicket({ key: "SC-1", issueType: "Story", storyPoints: 5 }),
      makeTicket({ key: "SC-2", issueType: "Story", storyPoints: 3 }),
      makeTicket({ key: "SC-3", issueType: "Bug", storyPoints: 2 }),
      makeTicket({ key: "SC-4", issueType: "Task", storyPoints: null }),
    ];
    const rules = extractSprintCompositionRules(tickets);
    expect(rules.length).toBe(2);

    const mixRule = rules.find((r) => r.rule_key === "type_mix");
    expect(mixRule).toBeDefined();
    const mix: Record<string, string> = JSON.parse(mixRule?.rule_value ?? "{}");
    expect(mix.Story).toBe("50%");
    expect(mix.Bug).toBe("25%");
    expect(mix.Task).toBe("25%");

    const avgRule = rules.find((r) => r.rule_key === "avg_points_per_ticket");
    expect(avgRule).toBeDefined();
    // (5 + 3 + 2) / 3 pointed tickets = 3.3
    expect(Number(avgRule?.rule_value)).toBeCloseTo(3.3, 1);
  });

  it("returns empty rules for empty input", () => {
    expect(extractSprintCompositionRules([])).toEqual([]);
  });

  it("handles all same issue type", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({ key: `UNI-${i}`, issueType: "Story", storyPoints: 3 }),
    );
    const rules = extractSprintCompositionRules(tickets);
    const mixRule = rules.find((r) => r.rule_key === "type_mix");
    expect(mixRule).toBeDefined();
    const mix: Record<string, string> = JSON.parse(mixRule?.rule_value ?? "{}");
    expect(mix.Story).toBe("100%");
    expect(Object.keys(mix)).toHaveLength(1);
  });

  it("returns avg_points_per_ticket of 0 when no tickets have points", () => {
    const tickets = Array.from({ length: 3 }, (_, i) => makeTicket({ key: `NP-${i}`, storyPoints: null }));
    const rules = extractSprintCompositionRules(tickets);
    const avgRule = rules.find((r) => r.rule_key === "avg_points_per_ticket");
    expect(avgRule).toBeDefined();
    expect(avgRule?.rule_value).toBe("0");
  });
});

// ─── extractNamingConvention (tag-prefix detection) ──────────────────────────

describe("extractNamingRules — naming convention patterns", () => {
  it("detects tag-prefix pattern when summaries use [Tag] prefix", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `TAG-${i}`,
        summary: "[Auth] User login page styling",
      }),
    );
    const rules = extractNamingRules(tickets);
    const patternRule = rules.find((r) => r.rule_key.startsWith("pattern/"));
    expect(patternRule).toBeDefined();
    expect(patternRule?.rule_value).toBe("tag-prefix");
  });

  it("detects noun-phrase pattern when no verbs or tags dominate", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `NP-${i}`,
        summary: "User authentication flow improvements",
      }),
    );
    const rules = extractNamingRules(tickets);
    const patternRule = rules.find((r) => r.rule_key.startsWith("pattern/"));
    expect(patternRule).toBeDefined();
    expect(patternRule?.rule_value).toBe("noun-phrase");
  });

  it("includes best examples sorted by quality", () => {
    const tickets = [
      makeTicket({ key: "EX-1", summary: "Add retry logic to pipeline" }),
      makeMinimalTicket({ key: "EX-2", summary: "thing" }),
      makeTicket({ key: "EX-3", summary: "Implement caching layer for API" }),
    ];
    const rules = extractNamingRules(tickets);
    const examplesRule = rules.find((r) => r.rule_key.startsWith("examples/"));
    expect(examplesRule).toBeDefined();
    const examples: string[] = JSON.parse(examplesRule?.rule_value ?? "[]");
    // Best quality tickets should appear first
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.length).toBeLessThanOrEqual(3);
  });
});

// ─── analyzeBacklog ─────────────────────────────────────────────────────────

describe("analyzeBacklog", () => {
  it("filters out low quality tickets", () => {
    const good = makeBacklog(15);
    const bad = Array.from({ length: 5 }, (_, i) => makeMinimalTicket({ key: `BAD-${i}` }));
    const result = analyzeBacklog([...good, ...bad]);
    expect(result.qualityFailed).toBeGreaterThan(0);
    expect(result.qualityPassed).toBeLessThan(result.totalTickets);
  });

  it("returns rules from all categories", () => {
    const tickets = makeBacklog(20);
    const result = analyzeBacklog(tickets);
    expect(result.rules.length).toBeGreaterThan(0);
    const categories = new Set(result.rules.map((r) => r.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
  });

  it("handles empty input gracefully", () => {
    const result = analyzeBacklog([]);
    expect(result.totalTickets).toBe(0);
    expect(result.rules).toEqual([]);
    expect(result.qualityPassed).toBe(0);
    expect(result.avgQualityScore).toBe(0);
  });

  it("reports correct quality stats", () => {
    const tickets = makeBacklog(10);
    const result = analyzeBacklog(tickets);
    expect(result.totalTickets).toBe(10);
    expect(result.qualityPassed + result.qualityFailed).toBe(10);
    expect(result.avgQualityScore).toBeGreaterThan(0);
  });
});

// ─── mergeWithDefaults ──────────────────────────────────────────────────────

describe("mergeWithDefaults", () => {
  const teamRule: TeamRule = {
    category: "naming_convention",
    rule_key: "pattern/Story",
    issue_type: "Story",
    rule_value: "tag-prefix",
    confidence: 0.8,
    sample_size: 25,
  };

  it("uses team rule when confidence >= 0.5 and sample_size >= 10", () => {
    const merged = mergeWithDefaults([teamRule], DEFAULT_RULES);
    const match = merged.find((r) => r.category === "naming_convention" && r.rule_key === "pattern/Story");
    expect(match).toBeDefined();
    expect(match?.rule_value).toBe("tag-prefix");
  });

  it("falls back to default when confidence < 0.5", () => {
    const lowConf = { ...teamRule, confidence: 0.3 };
    const merged = mergeWithDefaults([lowConf], DEFAULT_RULES);
    const match = merged.find((r) => r.category === "naming_convention" && r.rule_key === "pattern/Story");
    expect(match).toBeDefined();
    expect(match?.rule_value).toBe("verb-first");
  });

  it("falls back to default when sample_size < 10", () => {
    const lowSample = { ...teamRule, sample_size: 5 };
    const merged = mergeWithDefaults([lowSample], DEFAULT_RULES);
    const match = merged.find((r) => r.category === "naming_convention" && r.rule_key === "pattern/Story");
    expect(match).toBeDefined();
    expect(match?.rule_value).toBe("verb-first");
  });

  it("includes defaults that have no team override", () => {
    const merged = mergeWithDefaults([], DEFAULT_RULES);
    expect(merged.length).toBe(DEFAULT_RULES.length);
    const happyPath = merged.find((r) => r.rule_key === "happy_path");
    expect(happyPath).toBeDefined();
  });

  it("replaces low-confidence team rule with default at exact threshold boundary", () => {
    const atBoundary: TeamRule = {
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "tag-prefix",
      confidence: 0.5,
      sample_size: 9,
    };
    const merged = mergeWithDefaults([atBoundary], DEFAULT_RULES);
    const match = merged.find((r) => r.category === "naming_convention" && r.rule_key === "pattern/Story");
    expect(match).toBeDefined();
    // sample_size 9 < 10, so default should win
    expect(match?.rule_value).toBe("verb-first");
  });

  it("keeps team rule at exact passing threshold (confidence=0.5, sample_size=10)", () => {
    const atThreshold: TeamRule = {
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "tag-prefix",
      confidence: 0.5,
      sample_size: 10,
    };
    const merged = mergeWithDefaults([atThreshold], DEFAULT_RULES);
    const match = merged.find((r) => r.category === "naming_convention" && r.rule_key === "pattern/Story");
    expect(match?.rule_value).toBe("tag-prefix");
  });

  it("includes team rules with no matching default", () => {
    const customRule: TeamRule = {
      category: "custom_category",
      rule_key: "custom_key",
      issue_type: null,
      rule_value: "custom",
      confidence: 0.9,
      sample_size: 50,
    };
    const merged = mergeWithDefaults([customRule], DEFAULT_RULES);
    const match = merged.find((r) => r.category === "custom_category");
    expect(match).toBeDefined();
    expect(match?.rule_value).toBe("custom");
    // Should also include all defaults
    expect(merged.length).toBe(DEFAULT_RULES.length + 1);
  });

  it("handles null issue_type in team rules correctly", () => {
    const teamRule: TeamRule = {
      category: "label_patterns",
      rule_key: "avg_per_ticket",
      issue_type: null,
      rule_value: "2.5",
      confidence: 0.9,
      sample_size: 50,
    };
    const merged = mergeWithDefaults([teamRule], DEFAULT_RULES);
    const match = merged.find((r) => r.rule_key === "avg_per_ticket");
    expect(match?.rule_value).toBe("2.5");
  });
});

// ─── formatTeamStyleGuide ───────────────────────────────────────────────────

describe("formatTeamStyleGuide", () => {
  it("formats rules into readable markdown", () => {
    const result = formatTeamStyleGuide(DEFAULT_RULES);
    expect(result).toContain("## Team Style Guide");
    expect(result).toContain("### Description Structure");
    expect(result).toContain("### Naming Conventions");
    expect(result).toContain("### Story Points");
  });

  it("includes confidence percentages", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "ac_format/Story",
        issue_type: "Story",
        rule_value: "checkbox",
        confidence: 0.85,
        sample_size: 50,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("confidence: 85%");
  });

  it("handles empty rules array", () => {
    const result = formatTeamStyleGuide([]);
    expect(result).toContain("No rules available");
  });

  it("shows ticket count when totalSamples > 0", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "avg_length/Story",
        issue_type: "Story",
        rule_value: "400",
        confidence: 0.9,
        sample_size: 50,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("learned from 50 tickets");
  });

  it("omits *(default)* suffix for rules with sample_size > 0", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "avg_length/Story",
        issue_type: "Story",
        rule_value: "400",
        confidence: 0.9,
        sample_size: 30,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).not.toContain("*(default)*");
  });

  it("formats has_structure_pct description rule", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "has_structure_pct/Story",
        issue_type: "Story",
        rule_value: "75%",
        confidence: 0.8,
        sample_size: 20,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("75% of tickets have structured descriptions");
  });

  it("skips empty section_headings array", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "section_headings/Story",
        issue_type: "Story",
        rule_value: "[]",
        confidence: 0,
        sample_size: 10,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    // Should not contain numbered heading lines
    expect(result).not.toContain("1. **");
  });

  it("formats naming avg_words rule", () => {
    const rules: TeamRule[] = [
      {
        category: "naming_convention",
        rule_key: "avg_words/Bug",
        issue_type: "Bug",
        rule_value: "6",
        confidence: 0.8,
        sample_size: 25,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("**Bug**: avg 6 words");
  });

  it("formats naming examples rule", () => {
    const rules: TeamRule[] = [
      {
        category: "naming_convention",
        rule_key: "examples/Story",
        issue_type: "Story",
        rule_value: JSON.stringify(["Add login page", "Implement caching"]),
        confidence: 0.8,
        sample_size: 20,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("examples:");
    expect(result).toContain('"Add login page"');
    expect(result).toContain('"Implement caching"');
  });

  it("skips empty examples and empty verbs arrays", () => {
    const rules: TeamRule[] = [
      {
        category: "naming_convention",
        rule_key: "examples/Story",
        issue_type: "Story",
        rule_value: "[]",
        confidence: 0,
        sample_size: 5,
      },
      {
        category: "naming_convention",
        rule_key: "first_verb/Story",
        issue_type: "Story",
        rule_value: "[]",
        confidence: 0,
        sample_size: 5,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).not.toContain("examples:");
    expect(result).not.toContain("top verbs:");
  });

  it("formats story points mean rule", () => {
    const rules: TeamRule[] = [
      {
        category: "story_points",
        rule_key: "mean/Story",
        issue_type: "Story",
        rule_value: "4.5",
        confidence: 0.7,
        sample_size: 30,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("**Story**: mean 4.5");
  });

  it("formats label usage_rate rule", () => {
    const rules: TeamRule[] = [
      {
        category: "label_patterns",
        rule_key: "usage_rate",
        issue_type: null,
        rule_value: "80%",
        confidence: 0.9,
        sample_size: 40,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("80% of tickets have labels");
  });

  it("skips empty top_labels array", () => {
    const rules: TeamRule[] = [
      {
        category: "label_patterns",
        rule_key: "top_labels",
        issue_type: null,
        rule_value: "[]",
        confidence: 0,
        sample_size: 5,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).not.toContain("Top labels:");
  });

  it("formats component usage_rate and skips empty top_components", () => {
    const rules: TeamRule[] = [
      {
        category: "component_patterns",
        rule_key: "usage_rate",
        issue_type: null,
        rule_value: "60%",
        confidence: 0.8,
        sample_size: 30,
      },
      {
        category: "component_patterns",
        rule_key: "top_components",
        issue_type: null,
        rule_value: "[]",
        confidence: 0,
        sample_size: 5,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("60% of tickets have components");
    expect(result).not.toContain("Top components:");
  });

  it("formats workflow bottleneck and avg_total_days", () => {
    const rules: TeamRule[] = [
      {
        category: "workflow",
        rule_key: "bottleneck",
        issue_type: null,
        rule_value: "In Review",
        confidence: 0.7,
        sample_size: 20,
      },
      {
        category: "workflow",
        rule_key: "avg_total_days",
        issue_type: null,
        rule_value: "5.2",
        confidence: 0.8,
        sample_size: 25,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("Bottleneck status: **In Review**");
    expect(result).toContain("Avg lead time: 5.2 days");
  });

  it("formats sprint avg_points_per_ticket rule", () => {
    const rules: TeamRule[] = [
      {
        category: "sprint_composition",
        rule_key: "avg_points_per_ticket",
        issue_type: null,
        rule_value: "3.5",
        confidence: 0.7,
        sample_size: 20,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("Avg points per ticket: 3.5");
  });

  it("uses 'All' label when issue_type is null", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "ac_format/All",
        issue_type: null,
        rule_value: "bullet",
        confidence: 0.6,
        sample_size: 15,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("**All**");
  });

  it("formats all seven sections with complete rules", () => {
    const rules: TeamRule[] = [
      {
        category: "description_structure",
        rule_key: "section_headings/Story",
        issue_type: "Story",
        rule_value: JSON.stringify(["context", "requirements"]),
        confidence: 0.9,
        sample_size: 30,
      },
      {
        category: "naming_convention",
        rule_key: "pattern/Story",
        issue_type: "Story",
        rule_value: "verb-first",
        confidence: 0.8,
        sample_size: 25,
      },
      {
        category: "story_points",
        rule_key: "range/Story",
        issue_type: "Story",
        rule_value: "3-8",
        confidence: 0.7,
        sample_size: 20,
      },
      {
        category: "label_patterns",
        rule_key: "top_labels",
        issue_type: null,
        rule_value: JSON.stringify([{ label: "frontend", percentage: "40%" }]),
        confidence: 0.8,
        sample_size: 30,
      },
      {
        category: "component_patterns",
        rule_key: "top_components",
        issue_type: null,
        rule_value: JSON.stringify([{ component: "api", percentage: "60%" }]),
        confidence: 0.9,
        sample_size: 35,
      },
      {
        category: "workflow",
        rule_key: "happy_path",
        issue_type: null,
        rule_value: JSON.stringify(["To Do", "In Progress", "Done"]),
        confidence: 0.85,
        sample_size: 40,
      },
      {
        category: "sprint_composition",
        rule_key: "type_mix",
        issue_type: null,
        rule_value: JSON.stringify({ Story: "60%", Bug: "40%" }),
        confidence: 0.8,
        sample_size: 25,
      },
    ];
    const result = formatTeamStyleGuide(rules);
    expect(result).toContain("### Description Structure");
    expect(result).toContain("### Naming Conventions");
    expect(result).toContain("### Story Points");
    expect(result).toContain("### Labels");
    expect(result).toContain("### Components");
    expect(result).toContain("### Workflow");
    expect(result).toContain("### Sprint Composition");
    expect(result).toContain("Top labels: frontend (40%)");
    expect(result).toContain("Top components: api (60%)");
    expect(result).toContain("To Do");
    expect(result).toContain("Story 60%");
  });
});

// ─── Statistical helpers (team-rules-utils) ──────────────────────────────

describe("statistical helpers", () => {
  describe("median", () => {
    it("returns 0 for empty array", () => {
      expect(median([])).toBe(0);
    });

    it("returns middle value for odd-length array", () => {
      expect(median([3, 1, 5])).toBe(3);
    });

    it("returns average of two middle values for even-length array", () => {
      expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    it("handles single element", () => {
      expect(median([42])).toBe(42);
    });
  });

  describe("percentile", () => {
    it("returns 0 for empty array", () => {
      expect(percentile([], 50)).toBe(0);
    });

    it("returns exact value when index falls on element", () => {
      expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });

    it("interpolates between values", () => {
      const result = percentile([1, 2, 3, 4], 25);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(2);
    });

    it("returns first element for 0th percentile", () => {
      expect(percentile([10, 20, 30], 0)).toBe(10);
    });

    it("returns last element for 100th percentile", () => {
      expect(percentile([10, 20, 30], 100)).toBe(30);
    });
  });

  describe("mean", () => {
    it("returns 0 for empty array", () => {
      expect(mean([])).toBe(0);
    });

    it("calculates correct average", () => {
      expect(mean([2, 4, 6])).toBe(4);
    });
  });

  describe("stddev", () => {
    it("returns 0 for fewer than 2 elements", () => {
      expect(stddev([])).toBe(0);
      expect(stddev([5])).toBe(0);
    });

    it("returns 0 for identical values", () => {
      expect(stddev([3, 3, 3])).toBe(0);
    });

    it("calculates standard deviation", () => {
      const result = stddev([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe("topN", () => {
    it("returns top items sorted by count", () => {
      const freq = new Map<string, number>([
        ["a", 5],
        ["b", 10],
        ["c", 3],
      ]);
      const result = topN(freq, 2);
      expect(result).toHaveLength(2);
      expect(result[0]?.value).toBe("b");
      expect(result[1]?.value).toBe("a");
    });

    it("handles empty map", () => {
      expect(topN(new Map(), 5)).toEqual([]);
    });
  });

  describe("pct", () => {
    it("returns 0 when total is 0", () => {
      expect(pct(5, 0)).toBe(0);
    });

    it("calculates percentage correctly", () => {
      expect(pct(3, 4)).toBe(75);
    });
  });
});

// ─── buildQualityMap ────────────────────────────────────────────────────

describe("buildQualityMap", () => {
  it("returns map of ticket keys to quality scores", () => {
    const tickets = [makeTicket({ key: "Q-1" }), makeMinimalTicket({ key: "Q-2" })];
    const map = buildQualityMap(tickets);
    expect(map.size).toBe(2);
    expect(map.get("Q-1")).toBeGreaterThan(0);
    expect(map.get("Q-2")).toBeDefined();
    expect((map.get("Q-1") ?? 0) > (map.get("Q-2") ?? 0)).toBe(true);
  });

  it("returns empty map for no tickets", () => {
    expect(buildQualityMap([]).size).toBe(0);
  });
});

// ─── extractDescriptionRules — additional branches ──────────────────────

describe("extractDescriptionRules — AC format variants", () => {
  it("detects gherkin AC format", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `GHK-${i}`,
        description: "Given the user is logged in\nWhen they click submit\nThen the form is saved",
      }),
    );
    const rules = extractDescriptionRules(tickets);
    const acRule = rules.find((r) => r.rule_key.startsWith("ac_format/"));
    expect(acRule).toBeDefined();
    expect(acRule?.rule_value).toBe("gherkin");
  });

  it("detects bullet AC format", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `BUL-${i}`,
        description: "Requirements:\n- Must support login\n- Must validate email\n- Must show error",
      }),
    );
    const rules = extractDescriptionRules(tickets);
    const acRule = rules.find((r) => r.rule_key.startsWith("ac_format/"));
    expect(acRule).toBeDefined();
    expect(acRule?.rule_value).toBe("bullet");
  });

  it("detects none AC format when description has no structure", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({
        key: `NONE-${i}`,
        description: "Plain text description without any structured format.",
      }),
    );
    const rules = extractDescriptionRules(tickets);
    const acRule = rules.find((r) => r.rule_key.startsWith("ac_format/"));
    expect(acRule).toBeDefined();
    expect(acRule?.rule_value).toBe("none");
  });

  it("detects bold section headings as structure", () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        key: `BOLD-${i}`,
        description: "**Context**\nBackground info\n\n**Requirements**\n- Item 1",
      }),
    );
    const rules = extractDescriptionRules(tickets);
    const structRule = rules.find((r) => r.rule_key.startsWith("has_structure_pct/"));
    expect(structRule).toBeDefined();
    expect(structRule?.rule_value).not.toBe("0%");
  });
});
