/**
 * Statistical helpers and scoring utilities for the Backlog Intelligence Engine.
 */

import type { QualityScore, TeamRule, TicketData } from "./team-rules-types.js";
import { groupBy } from "./utils.js";

// ─── Pre-compiled regex ────────────────────────────────────────────────────────

export const HEADING_RE = /^#{1,3}\s+(.+)/gm;
export const BOLD_SECTION_RE = /\*\*([^*]+)\*\*/g;
export const CHECKBOX_RE = /- \[[ x]\]/g;
export const GHERKIN_RE = /\b(given|when|then)\b/gi;
export const BULLET_RE = /^[-*]\s+/gm;
export const TAG_PREFIX_RE = /^\[([^\]]+)\]/;
export const AC_TEXT_RE = /acceptance\s+criteria/i;
export const CONTEXT_SECTION_RE = /\b(context|background|requirements|overview|motivation)\b/i;
export const STRUCTURED_RE = /^#{1,3}\s+|\*\*[^*]+\*\*/m;

export const ACTION_VERBS = new Set([
  "add",
  "fix",
  "implement",
  "create",
  "update",
  "remove",
  "refactor",
  "migrate",
  "enable",
  "configure",
  "handle",
  "resolve",
  "investigate",
  "optimize",
  "improve",
  "integrate",
  "deploy",
  "set",
  "build",
  "design",
  "document",
  "test",
  "validate",
  "support",
]);

// ─── Statistical helpers ───────────────────────────────────────────────────────

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (idx - lo);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function topN<T>(freq: Map<T, number>, n: number): { value: T; count: number }[] {
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

export function pct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

// Re-export groupBy so team-rules modules can use it without importing utils directly
export { groupBy };

// ─── Quality scoring helpers ───────────────────────────────────────────────────

/**
 * Score the quality of a single ticket on a 0-100 scale across
 * description (0-40), metadata (0-30), and process (0-30) dimensions.
 */
export function scoreTicketQuality(ticket: TicketData): QualityScore {
  let description = 0;
  let metadata = 0;
  let process = 0;

  // Description quality (0-40)
  const desc = ticket.description ?? "";
  if (desc.length > 0) description += 10;
  if (desc.length > 100) description += 5;
  if (desc.length > 300) description += 5;
  if (desc.length > 500) description += 5;
  if (STRUCTURED_RE.test(desc)) description += 5;
  if (CHECKBOX_RE.test(desc) || AC_TEXT_RE.test(desc)) description += 5;
  if (CONTEXT_SECTION_RE.test(desc)) description += 5;

  // Metadata quality (0-30)
  if (ticket.storyPoints != null && ticket.storyPoints > 0) metadata += 10;
  if (ticket.labels.length > 0) metadata += 5;
  if (ticket.components.length > 0) metadata += 5;
  if (ticket.priority !== "Medium") metadata += 5;
  // fix version not in TicketData — skip the 5 pts (metadata max effectively 25)
  metadata = Math.min(metadata, 30);

  // Process quality (0-30)
  const doneStatuses = new Set(["done", "closed", "resolved"]);
  if (doneStatuses.has(ticket.status.toLowerCase())) process += 10;
  if (ticket.changelog.length > 0) process += 5;

  const statuses = new Set<string>();
  for (const c of ticket.changelog) {
    if (c.field === "status") {
      if (c.from) statuses.add(c.from);
      if (c.to) statuses.add(c.to);
    }
  }
  if (statuses.size >= 3) process += 5;
  if (ticket.resolutionDate) process += 5;

  const descUpdated = ticket.changelog.some((c) => c.field === "description");
  if (descUpdated) process += 5;

  const total = description + metadata + process;
  return { total, description, metadata, process };
}

/**
 * Build a quality score map for a list of tickets, keyed by ticket key.
 */
export function buildQualityMap(tickets: TicketData[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tickets) {
    map.set(t.key, scoreTicketQuality(t).total);
  }
  return map;
}

// ─── Default rules ──────────────────────────────────────────────────────────────

/**
 * Best-practice default rules used when team data is insufficient.
 */
export const DEFAULT_RULES: TeamRule[] = [
  // Description defaults
  {
    category: "description_structure",
    rule_key: "section_headings/Story",
    issue_type: "Story",
    rule_value: JSON.stringify(["context", "requirements", "acceptance criteria", "technical notes"]),
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "description_structure",
    rule_key: "section_headings/Bug",
    issue_type: "Bug",
    rule_value: JSON.stringify(["steps to reproduce", "expected behavior", "actual behavior", "environment"]),
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "description_structure",
    rule_key: "ac_format/Story",
    issue_type: "Story",
    rule_value: "checkbox",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "description_structure",
    rule_key: "ac_format/Bug",
    issue_type: "Bug",
    rule_value: "checkbox",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "description_structure",
    rule_key: "avg_length/Story",
    issue_type: "Story",
    rule_value: "400",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "description_structure",
    rule_key: "avg_length/Bug",
    issue_type: "Bug",
    rule_value: "400",
    confidence: 1.0,
    sample_size: 0,
  },

  // Naming defaults
  {
    category: "naming_convention",
    rule_key: "pattern/Story",
    issue_type: "Story",
    rule_value: "verb-first",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "naming_convention",
    rule_key: "pattern/Bug",
    issue_type: "Bug",
    rule_value: "verb-first",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "naming_convention",
    rule_key: "first_verb/Bug",
    issue_type: "Bug",
    rule_value: JSON.stringify([
      { verb: "fix", percentage: "40%" },
      { verb: "resolve", percentage: "30%" },
      { verb: "handle", percentage: "20%" },
    ]),
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "naming_convention",
    rule_key: "first_verb/Story",
    issue_type: "Story",
    rule_value: JSON.stringify([
      { verb: "add", percentage: "30%" },
      { verb: "implement", percentage: "30%" },
      { verb: "create", percentage: "20%" },
    ]),
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "naming_convention",
    rule_key: "avg_words/Story",
    issue_type: "Story",
    rule_value: "8",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "naming_convention",
    rule_key: "avg_words/Bug",
    issue_type: "Bug",
    rule_value: "8",
    confidence: 1.0,
    sample_size: 0,
  },

  // Points defaults
  {
    category: "story_points",
    rule_key: "range/Bug",
    issue_type: "Bug",
    rule_value: "1-3",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "story_points",
    rule_key: "range/Story",
    issue_type: "Story",
    rule_value: "3-8",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "story_points",
    rule_key: "range/Task",
    issue_type: "Task",
    rule_value: "2-5",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "story_points",
    rule_key: "range/Epic",
    issue_type: "Epic",
    rule_value: "13-21",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "story_points",
    rule_key: "median/Bug",
    issue_type: "Bug",
    rule_value: "2",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "story_points",
    rule_key: "median/Story",
    issue_type: "Story",
    rule_value: "5",
    confidence: 1.0,
    sample_size: 0,
  },
  {
    category: "story_points",
    rule_key: "median/Task",
    issue_type: "Task",
    rule_value: "3",
    confidence: 1.0,
    sample_size: 0,
  },

  // Label defaults
  {
    category: "label_patterns",
    rule_key: "avg_per_ticket",
    issue_type: null,
    rule_value: "1.5",
    confidence: 1.0,
    sample_size: 0,
  },

  // Workflow defaults
  {
    category: "workflow",
    rule_key: "happy_path",
    issue_type: null,
    rule_value: JSON.stringify(["To Do", "In Progress", "In Review", "Done"]),
    confidence: 1.0,
    sample_size: 0,
  },
];

// ─── Merge with defaults ────────────────────────────────────────────────────────

/**
 * Merge team-extracted rules with best-practice defaults.
 * Team rules override defaults when confidence >= 0.5 and sample_size >= 10.
 */
export function mergeWithDefaults(teamRules: TeamRule[], defaults: TeamRule[] = DEFAULT_RULES): TeamRule[] {
  const teamMap = new Map<string, TeamRule>();
  for (const r of teamRules) {
    const key = `${r.category}|${r.rule_key}|${r.issue_type ?? "null"}`;
    teamMap.set(key, r);
  }

  const merged: TeamRule[] = [...teamRules];
  const seen = new Set<string>();
  for (const r of teamRules) {
    seen.add(`${r.category}|${r.rule_key}|${r.issue_type ?? "null"}`);
  }

  for (const d of defaults) {
    const key = `${d.category}|${d.rule_key}|${d.issue_type ?? "null"}`;
    const team = teamMap.get(key);

    if (team && team.confidence >= 0.5 && team.sample_size >= 10) {
      // Team rule already in merged, skip default
      continue;
    }

    if (team) {
      // Team rule exists but low confidence — replace with default
      const idx = merged.indexOf(team);
      if (idx >= 0) merged[idx] = d;
    } else if (!seen.has(key)) {
      // No team rule — add default
      merged.push(d);
      seen.add(key);
    }
  }

  return merged;
}
