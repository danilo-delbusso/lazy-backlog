/**
 * Team Insights Analysis — barrel module and orchestrator.
 *
 * Coordinates all insight extractors and provides a single entry point
 * for analyzing completed Jira tickets to extract deep team insights.
 */

import { extractEstimationInsights } from "./team-insights-estimation.js";
import { extractOwnershipInsights } from "./team-insights-ownership.js";
import { extractPatternInsights } from "./team-insights-patterns.js";
import { extractTemplateInsights } from "./team-insights-templates.js";
import type { TeamInsights } from "./team-insights-types.js";
import type { TicketData } from "./team-rules-types.js";

// ─── Orchestrator ────────────────────────────────────────────────────────────────

/**
 * Analyze completed tickets and extract deep team insights across
 * estimation, ownership, templates, and cross-cutting patterns.
 *
 * Each extractor operates independently on the full ticket set.
 * All functions are pure — no side effects, no DB access.
 */
export function analyzeTeamInsights(tickets: TicketData[]): TeamInsights {
  return {
    estimation: extractEstimationInsights(tickets),
    ownership: extractOwnershipInsights(tickets),
    templates: extractTemplateInsights(tickets),
    patterns: extractPatternInsights(tickets),
  };
}

// ─── Section formatters ──────────────────────────────────────────────────────────

function formatEstimationSection(insights: TeamInsights["estimation"]): string | null {
  if (insights.length === 0) return null;
  const lines = ["## Estimation Insights", ""];
  for (const e of insights) {
    lines.push(`### ${e.issueType} (n=${e.sampleSize})`, `- Median cycle time: **${e.medianCycleDays} business days**`);
    if (e.pointsToDaysRatio > 0) {
      lines.push(
        `- Points-to-days ratio: **${e.pointsToDaysRatio}** days/point`,
        `- Estimation accuracy: **${Math.round(e.estimationAccuracy * 100)}%**`,
      );
    }
    const pointsStr = Object.entries(e.pointsDistribution)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([pts, count]) => `${pts}pts(${count})`)
      .join(", ");
    if (pointsStr) lines.push(`- Points distribution: ${pointsStr}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatOwnershipSection(insights: TeamInsights["ownership"]): string | null {
  if (insights.length === 0) return null;
  const lines = ["## Ownership Insights", ""];
  for (const o of insights) {
    lines.push(`### ${o.component} (n=${o.sampleSize})`);
    for (const owner of o.owners) {
      const pct = Math.round(owner.percentage * 100);
      const cycle = owner.avgCycleDays > 0 ? `, avg ${owner.avgCycleDays}d` : "";
      lines.push(`- ${owner.assignee}: ${owner.ticketCount} tickets (${pct}%${cycle})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatTemplateSection(insights: TeamInsights["templates"]): string | null {
  if (insights.length === 0) return null;
  const lines = ["## Template Insights", ""];
  for (const t of insights) {
    lines.push(`### ${t.issueType} (n=${t.sampleSize})`, `- AC format: **${t.acFormat}**`);
    if (t.avgAcItems > 0) lines.push(`- Avg AC items: ${t.avgAcItems}`);
    if (t.headings.length > 0) {
      const headingStr = t.headings.map((h) => `"${h.text}" (${Math.round(h.frequency * 100)}%)`).join(", ");
      lines.push(`- Common headings: ${headingStr}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatPatternSection(patterns: TeamInsights["patterns"]): string | null {
  const p = patterns;
  if (
    Object.keys(p.priorityDistribution).length === 0 &&
    p.labelCooccurrence.length === 0 &&
    p.reworkRates.length === 0
  ) {
    return null;
  }
  const lines = ["## Pattern Insights", ""];

  if (p.labelCooccurrence.length > 0) {
    lines.push("### Label Co-occurrence");
    for (const pair of p.labelCooccurrence.slice(0, 10)) {
      lines.push(`- ${pair.labelA} + ${pair.labelB}: ${Math.round(pair.cooccurrenceRate * 100)}% (n=${pair.count})`);
    }
    lines.push("");
  }

  if (p.reworkRates.length > 0) {
    lines.push("### Rework Rates");
    for (const r of p.reworkRates) {
      lines.push(
        `- ${r.component}: ${Math.round(r.reopenRate * 100)}% reopen rate (${r.reopenedTickets}/${r.totalTickets})`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Summary formatter ───────────────────────────────────────────────────────────

/**
 * Format team insights into a human-readable markdown summary.
 */
export function formatTeamInsights(insights: TeamInsights): string {
  const sections = [
    formatEstimationSection(insights.estimation),
    formatOwnershipSection(insights.ownership),
    formatTemplateSection(insights.templates),
    formatPatternSection(insights.patterns),
  ].filter((s): s is string => s !== null);

  return sections.join("\n") || "No insights available — insufficient data.";
}

// ─── Barrel re-exports ───────────────────────────────────────────────────────────

export { extractEstimationInsights } from "./team-insights-estimation.js";
export { extractOwnershipInsights } from "./team-insights-ownership.js";
export { extractPatternInsights } from "./team-insights-patterns.js";
export { extractTemplateInsights } from "./team-insights-templates.js";
export type {
  EstimationInsight,
  OwnershipInsight,
  PatternInsight,
  TeamInsights,
  TemplateInsight,
} from "./team-insights-types.js";
