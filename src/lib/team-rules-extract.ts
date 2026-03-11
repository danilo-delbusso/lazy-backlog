/**
 * Pattern extraction functions for the Backlog Intelligence Engine.
 *
 * Label, component, workflow, and sprint composition extractors,
 * plus the main analyzeBacklog orchestrator.
 */

import { extractDescriptionRules, extractNamingRules, extractPointRules } from "./team-rules-quality.js";
import type { AnalysisResult, TeamRule, TicketData } from "./team-rules-types.js";
import { mean, pct, scoreTicketQuality, topN } from "./team-rules-utils.js";

// ─── Label extraction ───────────────────────────────────────────────────────────

/**
 * Extract label usage patterns across all tickets.
 */
export function extractLabelRules(tickets: TicketData[]): TeamRule[] {
  if (tickets.length === 0) return [];
  const n = tickets.length;
  const labelFreq = new Map<string, number>();
  let totalLabels = 0;
  let ticketsWithLabels = 0;

  for (const t of tickets) {
    if (t.labels.length > 0) ticketsWithLabels++;
    totalLabels += t.labels.length;
    for (const l of t.labels) {
      labelFreq.set(l, (labelFreq.get(l) ?? 0) + 1);
    }
  }

  const topLabels = topN(labelFreq, 10).map((e) => ({
    label: e.value,
    percentage: `${pct(e.count, n)}%`,
  }));

  const confidence = Math.min(1, n / 30);

  return [
    {
      category: "label_patterns",
      rule_key: "top_labels",
      issue_type: null,
      rule_value: JSON.stringify(topLabels),
      confidence,
      sample_size: n,
    },
    {
      category: "label_patterns",
      rule_key: "avg_per_ticket",
      issue_type: null,
      rule_value: (totalLabels / Math.max(n, 1)).toFixed(1),
      confidence,
      sample_size: n,
    },
    {
      category: "label_patterns",
      rule_key: "usage_rate",
      issue_type: null,
      rule_value: `${pct(ticketsWithLabels, n)}%`,
      confidence,
      sample_size: n,
    },
  ];
}

// ─── Component extraction ───────────────────────────────────────────────────────

/**
 * Extract component usage patterns across all tickets.
 */
export function extractComponentRules(tickets: TicketData[]): TeamRule[] {
  if (tickets.length === 0) return [];
  const n = tickets.length;
  const compFreq = new Map<string, number>();
  let ticketsWithComp = 0;

  for (const t of tickets) {
    if (t.components.length > 0) ticketsWithComp++;
    for (const c of t.components) {
      compFreq.set(c, (compFreq.get(c) ?? 0) + 1);
    }
  }

  const topComps = topN(compFreq, 10).map((e) => ({
    component: e.value,
    percentage: `${pct(e.count, n)}%`,
  }));

  const confidence = Math.min(1, n / 30);

  return [
    {
      category: "component_patterns",
      rule_key: "top_components",
      issue_type: null,
      rule_value: JSON.stringify(topComps),
      confidence,
      sample_size: n,
    },
    {
      category: "component_patterns",
      rule_key: "usage_rate",
      issue_type: null,
      rule_value: `${pct(ticketsWithComp, n)}%`,
      confidence,
      sample_size: n,
    },
  ];
}

// ─── Workflow helpers ────────────────────────────────────────────────────────────

/** Build status sequence and time-in-status data from a single ticket's changelog. */
function processTicketWorkflow(
  t: TicketData,
  statusTimeMap: Map<string, number[]>,
  sequenceFreq: Map<string, number>,
  totalLeadTimes: number[],
): void {
  const transitions = t.changelog
    .filter((c) => c.field === "status")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (transitions.length === 0) return;

  // Build sequence
  const statuses: string[] = [];
  if (transitions[0]?.from) statuses.push(transitions[0].from);
  for (const tr of transitions) {
    if (tr.to) statuses.push(tr.to);
  }
  if (statuses.length > 1) {
    const seq = statuses.join(" → ");
    sequenceFreq.set(seq, (sequenceFreq.get(seq) ?? 0) + 1);
  }

  // Calculate time in each status
  let prevTime = new Date(t.created).getTime();
  let prevStatus = transitions[0]?.from ?? "Unknown";

  for (const tr of transitions) {
    const trTime = new Date(tr.timestamp).getTime();
    const duration = trTime - prevTime;
    if (duration >= 0) {
      const arr = statusTimeMap.get(prevStatus);
      if (arr) arr.push(duration);
      else statusTimeMap.set(prevStatus, [duration]);
    }
    prevTime = trTime;
    prevStatus = tr.to ?? "Unknown";
  }

  // Total lead time
  const firstTime = new Date(t.created).getTime();
  const lastTransition = transitions.at(-1) ?? transitions[0];
  const lastTime = t.resolutionDate
    ? new Date(t.resolutionDate).getTime()
    : new Date(lastTransition?.timestamp ?? t.created).getTime();
  if (lastTime > firstTime) {
    totalLeadTimes.push(lastTime - firstTime);
  }
}

/** Find the bottleneck status and build avg days per status. */
function computeStatusMetrics(statusTimeMap: Map<string, number[]>): {
  avgDaysPerStatus: Record<string, string>;
  bottleneck: string;
} {
  const msPerDay = 86400000;
  const avgDaysPerStatus: Record<string, string> = {};
  let bottleneck = "";
  let maxAvgDays = 0;

  for (const [status, durations] of statusTimeMap) {
    const avgDays = mean(durations) / msPerDay;
    avgDaysPerStatus[status] = avgDays.toFixed(1);
    if (avgDays > maxAvgDays) {
      maxAvgDays = avgDays;
      bottleneck = status;
    }
  }

  return { avgDaysPerStatus, bottleneck };
}

// ─── Workflow extraction ────────────────────────────────────────────────────────

/**
 * Extract workflow transition rules from ticket changelogs.
 * Identifies the happy path, avg time per status, and bottlenecks.
 */
export function extractWorkflowRules(tickets: TicketData[]): TeamRule[] {
  const withChangelog = tickets.filter((t) => t.changelog.length > 0);
  if (withChangelog.length === 0) return [];

  const rules: TeamRule[] = [];
  const statusTimeMap = new Map<string, number[]>();
  const sequenceFreq = new Map<string, number>();
  const totalLeadTimes: number[] = [];

  for (const t of withChangelog) {
    processTicketWorkflow(t, statusTimeMap, sequenceFreq, totalLeadTimes);
  }

  const n = withChangelog.length;
  const confidence = Math.min(1, n / 20);

  // Happy path (most common sequence)
  const happyPath = topN(sequenceFreq, 1)[0];
  if (happyPath) {
    rules.push({
      category: "workflow",
      rule_key: "happy_path",
      issue_type: null,
      rule_value: JSON.stringify(happyPath.value.split(" → ")),
      confidence: happyPath.count / n,
      sample_size: n,
    });
  }

  const { avgDaysPerStatus, bottleneck } = computeStatusMetrics(statusTimeMap);

  rules.push({
    category: "workflow",
    rule_key: "avg_days_per_status",
    issue_type: null,
    rule_value: JSON.stringify(avgDaysPerStatus),
    confidence,
    sample_size: n,
  });

  if (bottleneck) {
    rules.push({
      category: "workflow",
      rule_key: "bottleneck",
      issue_type: null,
      rule_value: bottleneck,
      confidence,
      sample_size: n,
    });
  }

  // Avg total lead time
  if (totalLeadTimes.length > 0) {
    const msPerDay = 86400000;
    rules.push({
      category: "workflow",
      rule_key: "avg_total_days",
      issue_type: null,
      rule_value: (mean(totalLeadTimes) / msPerDay).toFixed(1),
      confidence: Math.min(1, totalLeadTimes.length / 20),
      sample_size: totalLeadTimes.length,
    });
  }

  return rules;
}

// ─── Sprint composition extraction ──────────────────────────────────────────────

/**
 * Extract sprint/backlog composition rules based on issue type distribution.
 */
export function extractSprintCompositionRules(tickets: TicketData[]): TeamRule[] {
  if (tickets.length === 0) return [];
  const n = tickets.length;
  const typeCounts = new Map<string, number>();

  for (const t of tickets) {
    typeCounts.set(t.issueType, (typeCounts.get(t.issueType) ?? 0) + 1);
  }

  const typeMix: Record<string, string> = {};
  for (const [type, count] of typeCounts) {
    typeMix[type] = `${pct(count, n)}%`;
  }

  const pointed = tickets.filter((t) => t.storyPoints != null && t.storyPoints > 0);
  const avgPts = pointed.length > 0 ? mean(pointed.map((t) => t.storyPoints ?? 0)).toFixed(1) : "0";

  return [
    {
      category: "sprint_composition",
      rule_key: "type_mix",
      issue_type: null,
      rule_value: JSON.stringify(typeMix),
      confidence: Math.min(1, n / 30),
      sample_size: n,
    },
    {
      category: "sprint_composition",
      rule_key: "avg_points_per_ticket",
      issue_type: null,
      rule_value: avgPts,
      confidence: Math.min(1, pointed.length / 20),
      sample_size: pointed.length,
    },
  ];
}

// ─── Main orchestrator ──────────────────────────────────────────────────────────

/**
 * Main orchestrator: score all tickets, filter by quality threshold,
 * run all extractors, and return a consolidated AnalysisResult.
 */
export function analyzeBacklog(tickets: TicketData[], qualityThreshold = 60): AnalysisResult {
  if (tickets.length === 0) {
    return {
      rules: [],
      totalTickets: 0,
      qualityPassed: 0,
      qualityFailed: 0,
      avgQualityScore: 0,
      rulesByCategory: {},
    };
  }

  // Score all tickets
  const scores = tickets.map((t) => scoreTicketQuality(t));
  const avgScore = mean(scores.map((s) => s.total));

  // Filter by threshold
  const passing = tickets.filter((_, i) => (scores[i]?.total ?? 0) >= qualityThreshold);
  const qualityPassed = passing.length;
  const qualityFailed = tickets.length - qualityPassed;

  // Run all extractors on passing tickets
  const allRules = [
    ...extractDescriptionRules(passing),
    ...extractNamingRules(passing),
    ...extractPointRules(passing),
    ...extractLabelRules(passing),
    ...extractComponentRules(passing),
    ...extractWorkflowRules(passing),
    ...extractSprintCompositionRules(passing),
  ];

  // Count rules by category
  const rulesByCategory: Record<string, number> = {};
  for (const r of allRules) {
    rulesByCategory[r.category] = (rulesByCategory[r.category] ?? 0) + 1;
  }

  return {
    rules: allRules,
    totalTickets: tickets.length,
    qualityPassed,
    qualityFailed,
    avgQualityScore: Math.round(avgScore),
    rulesByCategory,
  };
}
