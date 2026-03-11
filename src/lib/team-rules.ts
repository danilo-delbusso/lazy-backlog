/**
 * Backlog Intelligence Engine — pure computation module.
 *
 * Analyzes historical Jira ticket data and extracts team patterns
 * as typed rules. No Jira API calls, no DB access.
 *
 * This file re-exports everything from the sub-modules and provides
 * default rules, merging logic, and formatting.
 */

import type { TeamRule } from "./team-rules-types.js";
import { groupBy, mean } from "./team-rules-utils.js";

// ─── Barrel re-exports ──────────────────────────────────────────────────────────

export * from "./team-rules-extract.js";
export * from "./team-rules-quality.js";
export * from "./team-rules-types.js";
export * from "./team-rules-utils.js";

// ─── Section formatting helpers ─────────────────────────────────────────────────

function ruleSuffix(r: TeamRule): string {
  return r.sample_size === 0 ? " *(default)*" : "";
}

function formatDescriptionSection(descRules: TeamRule[]): string[] {
  const avgConf = mean(descRules.map((r) => r.confidence));
  const lines: string[] = [`### Description Structure (confidence: ${Math.round(avgConf * 100)}%)`, ""];

  for (const r of descRules) {
    const typeLabel = r.issue_type ?? "All";
    const suffix = ruleSuffix(r);

    if (r.rule_key.startsWith("section_headings/")) {
      const headings: string[] = JSON.parse(r.rule_value);
      if (headings.length > 0) {
        lines.push(`**${typeLabel}** — expected sections:${suffix}`);
        for (let i = 0; i < headings.length; i++) {
          lines.push(`${i + 1}. **${headings[i]}**`);
        }
        lines.push("");
      }
    } else if (r.rule_key.startsWith("ac_format/")) {
      lines.push(`**${typeLabel}** — acceptance criteria format: \`${r.rule_value}\`${suffix}`);
    } else if (r.rule_key.startsWith("avg_length/")) {
      lines.push(`**${typeLabel}** — avg description length: ${r.rule_value} chars${suffix}`);
    } else if (r.rule_key.startsWith("has_structure_pct/")) {
      lines.push(`**${typeLabel}** — ${r.rule_value} of tickets have structured descriptions${suffix}`);
    }
  }
  lines.push("");
  return lines;
}

function formatNamingRule(r: TeamRule, lines: string[]): void {
  const typeLabel = r.issue_type ?? "All";
  const suffix = ruleSuffix(r);

  if (r.rule_key.startsWith("pattern/")) {
    lines.push(`- **${typeLabel}**: \`${r.rule_value}\` pattern${suffix}`);
  } else if (r.rule_key.startsWith("avg_words/")) {
    lines.push(`- **${typeLabel}**: avg ${r.rule_value} words${suffix}`);
  } else if (r.rule_key.startsWith("first_verb/")) {
    const verbs: { verb: string; percentage: string }[] = JSON.parse(r.rule_value);
    if (verbs.length > 0) {
      const verbStr = verbs.map((v) => `${v.verb} (${v.percentage})`).join(", ");
      lines.push(`- **${typeLabel}** top verbs: ${verbStr}${suffix}`);
    }
  } else if (r.rule_key.startsWith("examples/")) {
    const examples: string[] = JSON.parse(r.rule_value);
    if (examples.length > 0) {
      lines.push(`- **${typeLabel}** examples:`);
      for (const ex of examples) {
        lines.push(`  - "${ex}"`);
      }
    }
  }
}

function formatNamingSection(namingRules: TeamRule[]): string[] {
  const lines: string[] = ["### Naming Conventions", ""];
  for (const r of namingRules) {
    formatNamingRule(r, lines);
  }
  lines.push("");
  return lines;
}

function formatPointsSection(pointRules: TeamRule[]): string[] {
  const lines: string[] = ["### Story Points", ""];

  for (const r of pointRules) {
    const typeLabel = r.issue_type ?? "All";
    const suffix = ruleSuffix(r);

    if (r.rule_key.startsWith("range/")) {
      lines.push(`- **${typeLabel}**: typical range ${r.rule_value}${suffix}`);
    } else if (r.rule_key.startsWith("median/")) {
      lines.push(`- **${typeLabel}**: median ${r.rule_value}${suffix}`);
    } else if (r.rule_key.startsWith("mean/")) {
      lines.push(`- **${typeLabel}**: mean ${r.rule_value}${suffix}`);
    }
  }
  lines.push("");
  return lines;
}

function formatLabelsSection(labelRules: TeamRule[]): string[] {
  const lines: string[] = ["### Labels", ""];

  for (const r of labelRules) {
    const suffix = ruleSuffix(r);
    if (r.rule_key === "top_labels") {
      const labels: { label: string; percentage: string }[] = JSON.parse(r.rule_value);
      if (labels.length > 0) {
        const labelStr = labels.map((l) => `${l.label} (${l.percentage})`).join(", ");
        lines.push(`Top labels: ${labelStr}${suffix}`);
      }
    } else if (r.rule_key === "avg_per_ticket") {
      lines.push(`Avg labels per ticket: ${r.rule_value}${suffix}`);
    } else if (r.rule_key === "usage_rate") {
      lines.push(`${r.rule_value} of tickets have labels${suffix}`);
    }
  }
  lines.push("");
  return lines;
}

function formatComponentsSection(compRules: TeamRule[]): string[] {
  const lines: string[] = ["### Components", ""];

  for (const r of compRules) {
    const suffix = ruleSuffix(r);
    if (r.rule_key === "top_components") {
      const comps: { component: string; percentage: string }[] = JSON.parse(r.rule_value);
      if (comps.length > 0) {
        const compStr = comps.map((c) => `${c.component} (${c.percentage})`).join(", ");
        lines.push(`Top components: ${compStr}${suffix}`);
      }
    } else if (r.rule_key === "usage_rate") {
      lines.push(`${r.rule_value} of tickets have components${suffix}`);
    }
  }
  lines.push("");
  return lines;
}

function formatWorkflowSection(wfRules: TeamRule[]): string[] {
  const lines: string[] = ["### Workflow", ""];

  for (const r of wfRules) {
    const suffix = ruleSuffix(r);
    if (r.rule_key === "happy_path") {
      const path: string[] = JSON.parse(r.rule_value);
      lines.push(`Happy path: ${path.join(" → ")}${suffix}`);
    } else if (r.rule_key === "bottleneck") {
      lines.push(`Bottleneck status: **${r.rule_value}**${suffix}`);
    } else if (r.rule_key === "avg_total_days") {
      lines.push(`Avg lead time: ${r.rule_value} days${suffix}`);
    }
  }
  lines.push("");
  return lines;
}

function formatSprintSection(sprintRules: TeamRule[]): string[] {
  const lines: string[] = ["### Sprint Composition", ""];

  for (const r of sprintRules) {
    if (r.rule_key === "type_mix") {
      const mix: Record<string, string> = JSON.parse(r.rule_value);
      const mixStr = Object.entries(mix)
        .map(([t, p]) => `${t} ${p}`)
        .join(", ");
      lines.push(`Type mix: ${mixStr}`);
    } else if (r.rule_key === "avg_points_per_ticket") {
      lines.push(`Avg points per ticket: ${r.rule_value}`);
    }
  }
  lines.push("");
  return lines;
}

// ─── Formatting ─────────────────────────────────────────────────────────────────

/**
 * Format rules into a human-readable markdown "Team Style Guide".
 */
export function formatTeamStyleGuide(rules: TeamRule[]): string {
  if (rules.length === 0) return "## Team Style Guide\n\nNo rules available.";

  const totalSamples = Math.max(...rules.map((r) => r.sample_size), 0);
  const byCategory = groupBy(rules, (r) => r.category);

  const ticketSuffix = totalSamples > 0 ? ` (learned from ${totalSamples} tickets)` : "";
  const lines: string[] = [`## Team Style Guide${ticketSuffix}`, ""];

  const sections: [string, (rules: TeamRule[]) => string[]][] = [
    ["description_structure", formatDescriptionSection],
    ["naming_convention", formatNamingSection],
    ["story_points", formatPointsSection],
    ["label_patterns", formatLabelsSection],
    ["component_patterns", formatComponentsSection],
    ["workflow", formatWorkflowSection],
    ["sprint_composition", formatSprintSection],
  ];

  for (const [category, formatter] of sections) {
    const categoryRules = byCategory.get(category);
    if (categoryRules) {
      lines.push(...formatter(categoryRules));
    }
  }

  return lines.join("\n");
}
