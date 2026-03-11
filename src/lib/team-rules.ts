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

// ─── Formatting ─────────────────────────────────────────────────────────────────

/**
 * Format rules into a human-readable markdown "Team Style Guide".
 */
export function formatTeamStyleGuide(rules: TeamRule[]): string {
  if (rules.length === 0) return "## Team Style Guide\n\nNo rules available.";

  const totalSamples = Math.max(...rules.map((r) => r.sample_size), 0);

  const byCategory = groupBy(rules, (r) => r.category);
  const lines: string[] = [
    `## Team Style Guide${totalSamples > 0 ? ` (learned from ${totalSamples} tickets)` : ""}`,
    "",
  ];

  // Description Structure
  const descRules = byCategory.get("description_structure");
  if (descRules) {
    const avgConf = mean(descRules.map((r) => r.confidence));
    lines.push(`### Description Structure (confidence: ${Math.round(avgConf * 100)}%)`);
    lines.push("");

    for (const r of descRules) {
      const typeLabel = r.issue_type ?? "All";
      const isDefault = r.sample_size === 0;
      const suffix = isDefault ? " *(default)*" : "";

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
  }

  // Naming Conventions
  const namingRules = byCategory.get("naming_convention");
  if (namingRules) {
    lines.push("### Naming Conventions");
    lines.push("");

    for (const r of namingRules) {
      const typeLabel = r.issue_type ?? "All";
      const isDefault = r.sample_size === 0;
      const suffix = isDefault ? " *(default)*" : "";

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
    lines.push("");
  }

  // Story Points
  const pointRules = byCategory.get("story_points");
  if (pointRules) {
    lines.push("### Story Points");
    lines.push("");

    for (const r of pointRules) {
      const typeLabel = r.issue_type ?? "All";
      const isDefault = r.sample_size === 0;
      const suffix = isDefault ? " *(default)*" : "";

      if (r.rule_key.startsWith("range/")) {
        lines.push(`- **${typeLabel}**: typical range ${r.rule_value}${suffix}`);
      } else if (r.rule_key.startsWith("median/")) {
        lines.push(`- **${typeLabel}**: median ${r.rule_value}${suffix}`);
      } else if (r.rule_key.startsWith("mean/")) {
        lines.push(`- **${typeLabel}**: mean ${r.rule_value}${suffix}`);
      }
    }
    lines.push("");
  }

  // Labels
  const labelRules = byCategory.get("label_patterns");
  if (labelRules) {
    lines.push("### Labels");
    lines.push("");
    for (const r of labelRules) {
      const isDefault = r.sample_size === 0;
      const suffix = isDefault ? " *(default)*" : "";
      if (r.rule_key === "top_labels") {
        const labels: { label: string; percentage: string }[] = JSON.parse(r.rule_value);
        if (labels.length > 0) {
          lines.push(`Top labels: ${labels.map((l) => `${l.label} (${l.percentage})`).join(", ")}${suffix}`);
        }
      } else if (r.rule_key === "avg_per_ticket") {
        lines.push(`Avg labels per ticket: ${r.rule_value}${suffix}`);
      } else if (r.rule_key === "usage_rate") {
        lines.push(`${r.rule_value} of tickets have labels${suffix}`);
      }
    }
    lines.push("");
  }

  // Components
  const compRules = byCategory.get("component_patterns");
  if (compRules) {
    lines.push("### Components");
    lines.push("");
    for (const r of compRules) {
      const isDefault = r.sample_size === 0;
      const suffix = isDefault ? " *(default)*" : "";
      if (r.rule_key === "top_components") {
        const comps: { component: string; percentage: string }[] = JSON.parse(r.rule_value);
        if (comps.length > 0) {
          lines.push(`Top components: ${comps.map((c) => `${c.component} (${c.percentage})`).join(", ")}${suffix}`);
        }
      } else if (r.rule_key === "usage_rate") {
        lines.push(`${r.rule_value} of tickets have components${suffix}`);
      }
    }
    lines.push("");
  }

  // Workflow
  const wfRules = byCategory.get("workflow");
  if (wfRules) {
    lines.push("### Workflow");
    lines.push("");
    for (const r of wfRules) {
      const isDefault = r.sample_size === 0;
      const suffix = isDefault ? " *(default)*" : "";
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
  }

  // Sprint Composition
  const sprintRules = byCategory.get("sprint_composition");
  if (sprintRules) {
    lines.push("### Sprint Composition");
    lines.push("");
    for (const r of sprintRules) {
      if (r.rule_key === "type_mix") {
        const mix: Record<string, string> = JSON.parse(r.rule_value);
        lines.push(
          `Type mix: ${Object.entries(mix)
            .map(([t, p]) => `${t} ${p}`)
            .join(", ")}`,
        );
      } else if (r.rule_key === "avg_points_per_ticket") {
        lines.push(`Avg points per ticket: ${r.rule_value}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
