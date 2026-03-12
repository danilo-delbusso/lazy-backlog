/**
 * Smart defaults and description scaffolding from team insights.
 *
 * Consumes analyzed team insights to suggest field values, assignees,
 * and description templates for new ticket creation.
 */

import type { EstimationInsight, OwnershipInsight, PatternInsight, TemplateInsight } from "./team-insights-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SmartDefaults {
  assignee?: { name: string; reason: string };
  storyPoints?: { value: number; reason: string };
  priority?: { value: string; reason: string };
  labels?: { additions: string[]; reason: string };
}

export interface DescriptionScaffold {
  template: string;
  acFormat: string;
  guidance: string;
}

export interface TicketContext {
  summary: string;
  issueType: string;
  description?: string;
  components?: string[];
  labels?: string[];
  storyPoints?: number;
  priority?: string;
}

// ─── Smart Default Helpers ──────────────────────────────────────────────────────

function suggestStoryPoints(ticket: TicketContext, estimation: EstimationInsight[]): SmartDefaults["storyPoints"] {
  if (ticket.storyPoints != null) return undefined;
  const est = estimation.find((e) => e.issueType === ticket.issueType);
  if (!est || est.sampleSize < 5) return undefined;
  const mostCommon = Object.entries(est.pointsDistribution).sort(([, a], [, b]) => b - a)[0];
  if (!mostCommon) return undefined;
  return {
    value: Number(mostCommon[0]),
    reason: `Most common for ${ticket.issueType} (${Math.round(mostCommon[1] * 100)}% of ${est.sampleSize} tickets)`,
  };
}

function suggestAssignee(ticket: TicketContext, ownership: OwnershipInsight[]): SmartDefaults["assignee"] {
  if (!ticket.components?.length) return undefined;
  const comp = ticket.components[0];
  const ownerData = comp ? ownership.find((o) => o.component === comp) : undefined;
  if (!ownerData?.owners.length || ownerData.sampleSize < 3) return undefined;
  const top = ownerData.owners[0];
  if (!top) return undefined;
  return {
    name: top.assignee,
    reason: `Owns ${top.percentage}% of ${comp} tickets (${top.ticketCount} tickets, avg ${top.avgCycleDays.toFixed(1)}d cycle)`,
  };
}

function suggestPriority(ticket: TicketContext, patterns: PatternInsight): SmartDefaults["priority"] {
  if (ticket.priority) return undefined;
  const dist = patterns.priorityDistribution[ticket.issueType];
  if (!dist) return undefined;
  const top = Object.entries(dist).sort(([, a], [, b]) => b - a)[0];
  if (!top || top[0] === "Medium") return undefined;
  return {
    value: top[0],
    reason: `${Math.round(top[1] * 100)}% of ${ticket.issueType} tickets use this priority`,
  };
}

function suggestLabels(ticket: TicketContext, patterns: PatternInsight): SmartDefaults["labels"] {
  if (!ticket.labels?.length) return undefined;
  const suggestions = new Set<string>();
  for (const label of ticket.labels) {
    for (const co of patterns.labelCooccurrence) {
      if (co.cooccurrenceRate >= 0.5 && co.count >= 5) {
        if (co.labelA === label && !ticket.labels.includes(co.labelB)) suggestions.add(co.labelB);
        if (co.labelB === label && !ticket.labels.includes(co.labelA)) suggestions.add(co.labelA);
      }
    }
  }
  if (suggestions.size === 0) return undefined;
  return {
    additions: [...suggestions].slice(0, 3),
    reason: "Frequently co-occurs with specified labels",
  };
}

// ─── Smart Defaults ─────────────────────────────────────────────────────────────

/** Generate smart default suggestions based on team insights. */
export function generateSmartDefaults(
  ticket: TicketContext,
  estimation: EstimationInsight[],
  ownership: OwnershipInsight[],
  patterns: PatternInsight,
): SmartDefaults {
  const defaults: SmartDefaults = {};
  defaults.storyPoints = suggestStoryPoints(ticket, estimation);
  defaults.assignee = suggestAssignee(ticket, ownership);
  defaults.priority = suggestPriority(ticket, patterns);
  defaults.labels = suggestLabels(ticket, patterns);
  return defaults;
}

// ─── Description Scaffold ───────────────────────────────────────────────────────

/** Generate a description scaffold from team template patterns. */
export function generateDescriptionScaffold(
  issueType: string,
  templates: TemplateInsight[],
): DescriptionScaffold | null {
  const tmpl = templates.find((t) => t.issueType === issueType);
  if (!tmpl || tmpl.sampleSize < 3) return null;

  const acFormats: Record<string, string> = {
    checkbox: "- [ ] Criterion here",
    "given-when-then": "Given ... When ... Then ...",
    numbered: "1. First criterion\n2. Second criterion",
    prose: "Describe expected outcome in paragraph form",
    none: "(No AC pattern detected)",
  };

  return {
    template: tmpl.templateSkeleton,
    acFormat: acFormats[tmpl.acFormat] ?? (acFormats.none as string),
    guidance:
      tmpl.headings.length > 0
        ? `Common sections: ${tmpl.headings
            .slice(0, 5)
            .map((h) => h.text)
            .join(", ")}`
        : "No common section pattern detected",
  };
}

// ─── Formatting Helpers ─────────────────────────────────────────────────────────

function formatDefaultsSection(defaults: SmartDefaults): string[] {
  const lines: string[] = ["### Suggested Defaults", ""];
  if (defaults.storyPoints) {
    lines.push(`- **Story Points:** ${defaults.storyPoints.value} — ${defaults.storyPoints.reason}`);
  }
  if (defaults.assignee) {
    lines.push(`- **Assignee:** ${defaults.assignee.name} — ${defaults.assignee.reason}`);
  }
  if (defaults.priority) {
    lines.push(`- **Priority:** ${defaults.priority.value} — ${defaults.priority.reason}`);
  }
  if (defaults.labels) {
    lines.push(`- **Labels to add:** ${defaults.labels.additions.join(", ")} — ${defaults.labels.reason}`);
  }
  lines.push("");
  return lines;
}

function formatEstimationSection(est: EstimationInsight, issueType: string): string[] {
  const lines: string[] = [
    "### Estimation Context",
    "",
    `- Median cycle time for ${issueType}: **${est.medianCycleDays.toFixed(1)} days**`,
    `- Estimation accuracy: **${Math.round(est.estimationAccuracy * 100)}%**`,
  ];
  if (est.pointsToDaysRatio > 0) {
    lines.push(`- Points-to-days ratio: **${est.pointsToDaysRatio.toFixed(1)} days/point**`);
  }
  lines.push("");
  return lines;
}

function formatReworkWarning(rework: PatternInsight["reworkRates"][number]): string[] {
  return [
    `> **Rework alert:** ${rework.component} has a ${Math.round(rework.reopenRate * 100)}% reopen rate (${rework.reopenedTickets}/${rework.totalTickets} tickets). Consider extra review/testing.`,
    "",
  ];
}

function formatScaffoldSection(scaffold: DescriptionScaffold): string[] {
  return [
    "### Description Template",
    "",
    scaffold.guidance,
    "",
    "```markdown",
    scaffold.template,
    "```",
    "",
    `**AC format:** ${scaffold.acFormat}`,
    "",
  ];
}

// ─── Formatting ─────────────────────────────────────────────────────────────────

/** Format insights into a markdown section for the preview card. */
export function formatInsightsSection(
  defaults: SmartDefaults,
  scaffold: DescriptionScaffold | null,
  estimation: EstimationInsight[],
  ticket: TicketContext,
  reworkRates: PatternInsight["reworkRates"],
): string {
  const hasDefaults = defaults.storyPoints || defaults.assignee || defaults.priority || defaults.labels;
  const est = estimation.find((e) => e.issueType === ticket.issueType);
  const rework = ticket.components?.length
    ? reworkRates.find((r) => r.component === ticket.components?.[0])
    : undefined;

  if (!hasDefaults && !scaffold && !est && !rework) return "";

  const lines: string[] = ["## Team Insights", ""];

  if (hasDefaults) lines.push(...formatDefaultsSection(defaults));
  if (est && est.sampleSize >= 5) lines.push(...formatEstimationSection(est, ticket.issueType));
  if (rework && rework.reopenRate >= 0.15) lines.push(...formatReworkWarning(rework));
  if (scaffold) lines.push(...formatScaffoldSection(scaffold));

  return lines.join("\n");
}
