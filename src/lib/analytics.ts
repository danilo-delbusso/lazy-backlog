// ── Interfaces ──────────────────────────────────────────────────────────────

export interface VelocityPoint {
  sprintId: string;
  sprintName: string;
  committed: number;
  completed: number;
  carryOver: number;
}

export interface VelocityReport {
  sprints: VelocityPoint[];
  average: number;
  trend: "improving" | "declining" | "stable";
  trendSlope: number;
}

export interface CycleTimeResult {
  issueKey: string;
  summary: string;
  issueType: string;
  cycleTimeHours: number;
  leadTimeHours: number;
}

export interface CycleTimeReport {
  issues: CycleTimeResult[];
  p50: number;
  p75: number;
  p90: number;
  average: number;
  byType: Record<string, { p50: number; average: number; count: number }>;
}

export interface CapacityReport {
  sprintName: string;
  committedSP: number;
  velocityAverage: number;
  capacityRatio: number;
  perAssignee: Array<{ name: string; sp: number; issueCount: number }>;
}

export interface SprintHealthScore {
  sprintName: string;
  scopeVsCapacity: number;
  blockerCount: number;
  percentInProgress: number;
  percentDone: number;
  percentTodo: number;
  overall: "healthy" | "at-risk" | "critical";
}

// Input types (loose, to avoid coupling to Jira-specific types)
export interface SprintIssueData {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  statusCategory?: string;
  storyPoints?: number;
  assignee?: string;
}

export interface ChangelogItem {
  field: string;
  fromString: string | null;
  toString: string | null;
  created: string;
}

export interface SprintData {
  id: string;
  name: string;
  issues: SprintIssueData[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Simple linear regression where x = index (0, 1, 2, ...). */
export function linearRegression(points: number[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n <= 1) {
    return { slope: 0, intercept: points[0] ?? 0 };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += points[i] ?? 0;
    sumXY += i * (points[i] ?? 0);
    sumXX += i * i;
  }

  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

/** Return the value at the p-th percentile using nearest-rank method. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

// ── Computations ────────────────────────────────────────────────────────────

const DONE_STATUSES = new Set(["done", "closed", "resolved", "finished", "fixed", "complete", "completed"]);
const IN_PROGRESS_STATUSES = new Set(["in progress", "in review", "review", "in development", "working", "started"]);

function isDoneStatus(status: string, statusCategory?: string): boolean {
  if (statusCategory?.toLowerCase() === "done") return true;
  const lower = status.toLowerCase();
  return DONE_STATUSES.has(lower) || lower.includes("done");
}

function isInProgressStatus(status: string, statusCategory?: string): boolean {
  if (statusCategory?.toLowerCase() === "indeterminate") return true;
  const lower = status.toLowerCase();
  return IN_PROGRESS_STATUSES.has(lower) || lower.includes("progress");
}

function isDone(issue: SprintIssueData): boolean {
  return isDoneStatus(issue.status, issue.statusCategory);
}

/** Compute velocity report across sprints. */
export function computeVelocity(sprints: SprintData[]): VelocityReport {
  const points: VelocityPoint[] = sprints.map((sprint) => {
    const committed = sprint.issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    const completed = sprint.issues.filter(isDone).reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      committed,
      completed,
      carryOver: committed - completed,
    };
  });

  const completedValues = points.map((p) => p.completed);
  const average = completedValues.length > 0 ? completedValues.reduce((a, b) => a + b, 0) / completedValues.length : 0;

  const { slope } = linearRegression(completedValues);
  let trend: "improving" | "declining" | "stable" = "stable";
  if (slope > 0.5) trend = "improving";
  else if (slope < -0.5) trend = "declining";

  return { sprints: points, average, trend, trendSlope: slope };
}

/** Compute cycle time and lead time for issues with changelog data. */
export function computeCycleTime(
  issues: Array<{
    key: string;
    summary: string;
    issueType: string;
    created: string;
    changelog: ChangelogItem[];
  }>,
): CycleTimeReport {
  const results: CycleTimeResult[] = [];

  for (const issue of issues) {
    const statusChanges = issue.changelog.filter((c) => c.field === "status");

    // Find first "In Progress" transition
    const firstInProgress = statusChanges.find((c) => (c.toString ? isInProgressStatus(c.toString) : false));

    // Find last "Done" transition
    let lastDone: ChangelogItem | undefined;
    for (const change of statusChanges) {
      if (change.toString && isDoneStatus(change.toString)) {
        lastDone = change;
      }
    }

    if (!lastDone) continue;

    const doneTime = new Date(lastDone.created).getTime();
    const createdTime = new Date(issue.created).getTime();
    const leadTimeHours = (doneTime - createdTime) / (1000 * 60 * 60);

    let cycleTimeHours: number;
    if (firstInProgress) {
      const inProgressTime = new Date(firstInProgress.created).getTime();
      cycleTimeHours = (doneTime - inProgressTime) / (1000 * 60 * 60);
    } else {
      cycleTimeHours = leadTimeHours;
    }

    results.push({
      issueKey: issue.key,
      summary: issue.summary,
      issueType: issue.issueType,
      cycleTimeHours,
      leadTimeHours,
    });
  }

  const cycleTimes = results.map((r) => r.cycleTimeHours);
  const avg = cycleTimes.length > 0 ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : 0;

  // Group by issue type
  const byType: Record<string, { p50: number; average: number; count: number }> = {};
  const grouped: Record<string, number[]> = {};
  for (const r of results) {
    const arr = grouped[r.issueType] ?? [];
    arr.push(r.cycleTimeHours);
    grouped[r.issueType] = arr;
  }
  for (const [type, times] of Object.entries(grouped)) {
    byType[type] = {
      p50: percentile(times, 50),
      average: times.reduce((a, b) => a + b, 0) / times.length,
      count: times.length,
    };
  }

  return {
    issues: results,
    p50: percentile(cycleTimes, 50),
    p75: percentile(cycleTimes, 75),
    p90: percentile(cycleTimes, 90),
    average: avg,
    byType,
  };
}

/** Compute capacity report for a sprint given historical velocity. */
export function computeCapacity(velocity: VelocityReport, sprint: SprintData): CapacityReport {
  const committedSP = sprint.issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  const capacityRatio = velocity.average === 0 ? Number.POSITIVE_INFINITY : committedSP / velocity.average;

  const assigneeMap = new Map<string, { sp: number; issueCount: number }>();
  for (const issue of sprint.issues) {
    const name = issue.assignee ?? "Unassigned";
    const existing = assigneeMap.get(name) ?? { sp: 0, issueCount: 0 };
    existing.sp += issue.storyPoints ?? 0;
    existing.issueCount += 1;
    assigneeMap.set(name, existing);
  }

  const perAssignee = Array.from(assigneeMap.entries()).map(([name, data]) => ({
    name,
    sp: data.sp,
    issueCount: data.issueCount,
  }));

  return {
    sprintName: sprint.name,
    committedSP,
    velocityAverage: velocity.average,
    capacityRatio,
    perAssignee,
  };
}

/** Compute sprint health score. */
export function computeSprintHealth(sprint: SprintData, velocityAverage: number): SprintHealthScore {
  const totalSP = sprint.issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  const scopeVsCapacity = velocityAverage === 0 ? 200 : Math.min((totalSP / velocityAverage) * 100, 200);

  let blockerCount = 0;
  let doneCount = 0;
  let inProgressCount = 0;
  let todoCount = 0;

  for (const issue of sprint.issues) {
    const statusLower = issue.status.toLowerCase();
    if (statusLower.includes("block")) blockerCount++;
    if (isDoneStatus(issue.status, issue.statusCategory)) doneCount++;
    else if (isInProgressStatus(issue.status, issue.statusCategory)) inProgressCount++;
    else todoCount++;
  }

  const total = sprint.issues.length;
  const percentDone = total === 0 ? 0 : (doneCount / total) * 100;
  const percentInProgress = total === 0 ? 0 : (inProgressCount / total) * 100;
  const percentTodo = total === 0 ? 0 : (todoCount / total) * 100;

  let overall: "healthy" | "at-risk" | "critical" = "healthy";
  if (blockerCount >= 3 || scopeVsCapacity > 120) {
    overall = "critical";
  } else if (blockerCount > 0 || scopeVsCapacity > 100) {
    overall = "at-risk";
  }

  return {
    sprintName: sprint.name,
    scopeVsCapacity,
    blockerCount,
    percentInProgress,
    percentDone,
    percentTodo,
    overall,
  };
}
