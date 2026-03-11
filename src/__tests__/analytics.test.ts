import { describe, expect, it } from "vitest";
import type { SprintData } from "../lib/analytics.js";
import {
  computeCapacity,
  computeCycleTime,
  computeSprintHealth,
  computeVelocity,
  linearRegression,
  percentile,
} from "../lib/analytics.js";

// ── linearRegression ──────────────────────────────────────────────────────

describe("linearRegression", () => {
  it("calculates slope and intercept for increasing data", () => {
    const result = linearRegression([1, 2, 3, 4, 5]);
    expect(result.slope).toBeCloseTo(1, 5);
    expect(result.intercept).toBeCloseTo(1, 5);
  });

  it("returns slope ~0 for flat data", () => {
    const result = linearRegression([5, 5, 5, 5]);
    expect(result.slope).toBeCloseTo(0, 5);
    expect(result.intercept).toBeCloseTo(5, 5);
  });

  it("handles two points", () => {
    const result = linearRegression([1, 3]);
    expect(result.slope).toBeCloseTo(2, 5);
    expect(result.intercept).toBeCloseTo(1, 5);
  });

  it("handles single point", () => {
    const result = linearRegression([7]);
    expect(result.slope).toBe(0);
    expect(result.intercept).toBe(7);
  });
});

// ── percentile ────────────────────────────────────────────────────────────

describe("percentile", () => {
  it("returns correct p50 for [1,2,3,4,5]", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("returns correct p90 for [1..10]", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("handles single value", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 90)).toBe(42);
  });
});

// ── computeVelocity ──────────────────────────────────────────────────────

describe("computeVelocity", () => {
  function makeSprints(completedPerSprint: number[]): SprintData[] {
    return completedPerSprint.map((completed, i) => ({
      id: `s${i}`,
      name: `Sprint ${i + 1}`,
      issues: [
        { key: `PROJ-${i}a`, summary: "Done task", issueType: "Story", status: "Done", storyPoints: completed },
        {
          key: `PROJ-${i}b`,
          summary: "Todo task",
          issueType: "Story",
          status: "To Do",
          storyPoints: 3,
        },
      ],
    }));
  }

  it("calculates correct SP for sprints with mixed done/not-done", () => {
    const report = computeVelocity(makeSprints([5, 8, 3, 10, 7]));
    expect(report.sprints).toHaveLength(5);
    // Each sprint has completed + 3 committed (not done)
    expect((report.sprints[0] as (typeof report.sprints)[number]).committed).toBe(8); // 5 + 3
    expect((report.sprints[0] as (typeof report.sprints)[number]).completed).toBe(5);
    expect((report.sprints[0] as (typeof report.sprints)[number]).carryOver).toBe(3);
    expect(report.average).toBeCloseTo(6.6, 1);
  });

  it("returns improving when completed SP increases", () => {
    const report = computeVelocity(makeSprints([2, 4, 6, 8, 10]));
    expect(report.trend).toBe("improving");
    expect(report.trendSlope).toBeGreaterThan(0.5);
  });

  it("returns declining when completed SP decreases", () => {
    const report = computeVelocity(makeSprints([10, 8, 6, 4, 2]));
    expect(report.trend).toBe("declining");
    expect(report.trendSlope).toBeLessThan(-0.5);
  });

  it("returns stable for flat velocity", () => {
    const report = computeVelocity(makeSprints([5, 5, 5, 5]));
    expect(report.trend).toBe("stable");
  });

  it("handles sprints with zero SP", () => {
    const sprints: SprintData[] = [
      {
        id: "s1",
        name: "Sprint 1",
        issues: [{ key: "PROJ-1", summary: "No SP", issueType: "Task", status: "Done" }],
      },
    ];
    const report = computeVelocity(sprints);
    expect((report.sprints[0] as (typeof report.sprints)[number]).committed).toBe(0);
    expect((report.sprints[0] as (typeof report.sprints)[number]).completed).toBe(0);
    expect(report.average).toBe(0);
  });

  it("handles single sprint (trend = stable)", () => {
    const report = computeVelocity(makeSprints([10]));
    expect(report.trend).toBe("stable");
    expect(report.trendSlope).toBe(0);
  });
});

// ── computeCycleTime ─────────────────────────────────────────────────────

describe("computeCycleTime", () => {
  it("calculates In Progress -> Done correctly", () => {
    const report = computeCycleTime([
      {
        key: "PROJ-1",
        summary: "Task 1",
        issueType: "Story",
        created: "2025-06-01T00:00:00Z",
        changelog: [
          { field: "status", fromString: "To Do", toString: "In Progress", created: "2025-06-02T00:00:00Z" },
          { field: "status", fromString: "In Progress", toString: "Done", created: "2025-06-04T00:00:00Z" },
        ],
      },
    ]);
    expect(report.issues).toHaveLength(1);
    expect((report.issues[0] as (typeof report.issues)[number]).cycleTimeHours).toBeCloseTo(48, 0);
    expect((report.issues[0] as (typeof report.issues)[number]).leadTimeHours).toBeCloseTo(72, 0);
  });

  it("handles issues with no Done transition (excluded from results)", () => {
    const report = computeCycleTime([
      {
        key: "PROJ-1",
        summary: "Still in progress",
        issueType: "Story",
        created: "2025-06-01T00:00:00Z",
        changelog: [{ field: "status", fromString: "To Do", toString: "In Progress", created: "2025-06-02T00:00:00Z" }],
      },
    ]);
    expect(report.issues).toHaveLength(0);
  });

  it("calculates percentiles correctly", () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      key: `PROJ-${i}`,
      summary: `Task ${i}`,
      issueType: "Story",
      created: "2025-06-01T00:00:00Z",
      changelog: [
        { field: "status", fromString: "To Do", toString: "In Progress", created: "2025-06-01T00:00:00Z" },
        {
          field: "status",
          fromString: "In Progress",
          toString: "Done",
          created: `2025-06-${String(2 + i).padStart(2, "0")}T00:00:00Z`,
        },
      ],
    }));
    const report = computeCycleTime(issues);
    expect(report.issues).toHaveLength(10);
    expect(report.p50).toBeGreaterThan(0);
    expect(report.p75).toBeGreaterThanOrEqual(report.p50);
    expect(report.p90).toBeGreaterThanOrEqual(report.p75);
  });

  it("groups by issue type", () => {
    const report = computeCycleTime([
      {
        key: "PROJ-1",
        summary: "Story",
        issueType: "Story",
        created: "2025-06-01T00:00:00Z",
        changelog: [{ field: "status", fromString: "To Do", toString: "Done", created: "2025-06-03T00:00:00Z" }],
      },
      {
        key: "PROJ-2",
        summary: "Bug",
        issueType: "Bug",
        created: "2025-06-01T00:00:00Z",
        changelog: [{ field: "status", fromString: "To Do", toString: "Done", created: "2025-06-02T00:00:00Z" }],
      },
    ]);
    expect(report.byType.Story).toBeDefined();
    expect(report.byType.Bug).toBeDefined();
    expect((report.byType.Story as NonNullable<typeof report.byType.Story>).count).toBe(1);
    expect((report.byType.Bug as NonNullable<typeof report.byType.Bug>).count).toBe(1);
  });

  it("calculates lead time (created -> done)", () => {
    const report = computeCycleTime([
      {
        key: "PROJ-1",
        summary: "Task",
        issueType: "Story",
        created: "2025-06-01T00:00:00Z",
        changelog: [{ field: "status", fromString: "To Do", toString: "Done", created: "2025-06-05T00:00:00Z" }],
      },
    ]);
    expect((report.issues[0] as (typeof report.issues)[number]).leadTimeHours).toBeCloseTo(96, 0); // 4 days
  });
});

// ── computeCapacity ──────────────────────────────────────────────────────

describe("computeCapacity", () => {
  it("calculates ratio correctly (committed / velocity average)", () => {
    const velocity = computeVelocity([
      {
        id: "s1",
        name: "Sprint 1",
        issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "Done", storyPoints: 10 }],
      },
      {
        id: "s2",
        name: "Sprint 2",
        issues: [{ key: "P-2", summary: "T", issueType: "Story", status: "Done", storyPoints: 20 }],
      },
    ]);
    // average = 15
    const sprint: SprintData = {
      id: "s3",
      name: "Sprint 3",
      issues: [{ key: "P-3", summary: "T", issueType: "Story", status: "To Do", storyPoints: 30 }],
    };
    const report = computeCapacity(velocity, sprint);
    expect(report.committedSP).toBe(30);
    expect(report.velocityAverage).toBe(15);
    expect(report.capacityRatio).toBeCloseTo(2, 5);
  });

  it("breaks down per assignee", () => {
    const velocity = computeVelocity([
      {
        id: "s1",
        name: "Sprint 1",
        issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "Done", storyPoints: 10 }],
      },
    ]);
    const sprint: SprintData = {
      id: "s2",
      name: "Sprint 2",
      issues: [
        { key: "P-1", summary: "T", issueType: "Story", status: "To Do", storyPoints: 5, assignee: "Alice" },
        { key: "P-2", summary: "T", issueType: "Story", status: "To Do", storyPoints: 3, assignee: "Alice" },
        { key: "P-3", summary: "T", issueType: "Story", status: "To Do", storyPoints: 8, assignee: "Bob" },
      ],
    };
    const report = computeCapacity(velocity, sprint);
    expect(report.perAssignee).toHaveLength(2);
    const alice = report.perAssignee.find((a) => a.name === "Alice");
    expect(alice?.sp).toBe(8);
    expect(alice?.issueCount).toBe(2);
  });

  it("handles unassigned issues", () => {
    const velocity = computeVelocity([
      {
        id: "s1",
        name: "Sprint 1",
        issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "Done", storyPoints: 10 }],
      },
    ]);
    const sprint: SprintData = {
      id: "s2",
      name: "Sprint 2",
      issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "To Do", storyPoints: 5 }],
    };
    const report = computeCapacity(velocity, sprint);
    expect(report.perAssignee[0]?.name).toBe("Unassigned");
  });

  it("handles zero velocity average", () => {
    const velocity = computeVelocity([
      {
        id: "s1",
        name: "Sprint 1",
        issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "To Do", storyPoints: 0 }],
      },
    ]);
    const sprint: SprintData = {
      id: "s2",
      name: "Sprint 2",
      issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "To Do", storyPoints: 5 }],
    };
    const report = computeCapacity(velocity, sprint);
    expect(report.capacityRatio).toBe(Number.POSITIVE_INFINITY);
  });
});

// ── computeSprintHealth ──────────────────────────────────────────────────

describe("computeSprintHealth", () => {
  it("returns healthy for normal sprint", () => {
    const sprint: SprintData = {
      id: "s1",
      name: "Sprint 1",
      issues: [
        { key: "P-1", summary: "T", issueType: "Story", status: "Done", storyPoints: 3 },
        { key: "P-2", summary: "T", issueType: "Story", status: "In Progress", storyPoints: 2 },
      ],
    };
    const health = computeSprintHealth(sprint, 10); // 5/10 = 50%
    expect(health.overall).toBe("healthy");
    expect(health.scopeVsCapacity).toBeCloseTo(50, 0);
  });

  it("returns at-risk for sprint over 100% capacity", () => {
    const sprint: SprintData = {
      id: "s1",
      name: "Sprint 1",
      issues: [{ key: "P-1", summary: "T", issueType: "Story", status: "To Do", storyPoints: 11 }],
    };
    const health = computeSprintHealth(sprint, 10); // 110%
    expect(health.overall).toBe("at-risk");
  });

  it("returns critical for 3+ blockers", () => {
    const sprint: SprintData = {
      id: "s1",
      name: "Sprint 1",
      issues: [
        { key: "P-1", summary: "T", issueType: "Story", status: "Blocked", storyPoints: 1 },
        { key: "P-2", summary: "T", issueType: "Story", status: "Blocked", storyPoints: 1 },
        { key: "P-3", summary: "T", issueType: "Story", status: "Blocked", storyPoints: 1 },
        { key: "P-4", summary: "T", issueType: "Story", status: "To Do", storyPoints: 1 },
      ],
    };
    const health = computeSprintHealth(sprint, 100); // low capacity
    expect(health.overall).toBe("critical");
    expect(health.blockerCount).toBe(3);
  });

  it("calculates percentage breakdown correctly", () => {
    const sprint: SprintData = {
      id: "s1",
      name: "Sprint 1",
      issues: [
        { key: "P-1", summary: "T", issueType: "Story", status: "Done", storyPoints: 1 },
        { key: "P-2", summary: "T", issueType: "Story", status: "In Progress", storyPoints: 1 },
        { key: "P-3", summary: "T", issueType: "Story", status: "To Do", storyPoints: 1 },
        { key: "P-4", summary: "T", issueType: "Story", status: "To Do", storyPoints: 1 },
      ],
    };
    const health = computeSprintHealth(sprint, 100);
    expect(health.percentDone).toBeCloseTo(25, 0);
    expect(health.percentInProgress).toBeCloseTo(25, 0);
    expect(health.percentTodo).toBeCloseTo(50, 0);
  });
});
