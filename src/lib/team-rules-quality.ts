/**
 * Quality analysis functions for the Backlog Intelligence Engine.
 *
 * ADF conversion, description structure analysis, naming convention extraction,
 * and story point rule extraction.
 */

import type { TeamRule, TicketData } from "./team-rules-types.js";
import {
  ACTION_VERBS,
  BOLD_SECTION_RE,
  BULLET_RE,
  buildQualityMap,
  CHECKBOX_RE,
  GHERKIN_RE,
  groupBy,
  HEADING_RE,
  mean,
  median,
  pct,
  percentile,
  stddev,
  TAG_PREFIX_RE,
  topN,
} from "./team-rules-utils.js";

// Re-export adfToText so existing `import { adfToText } from "team-rules"` paths keep working.
export { adfToText } from "./adf.js";

// ─── Description structure helpers ───────────────────────────────────────────────

/** Collect heading frequencies and structured ticket counts from a group. */
function analyzeDescriptions(group: TicketData[]) {
  const headingFreq = new Map<string, number>();
  let structuredCount = 0;
  let checkboxCount = 0;
  let gherkinCount = 0;
  let bulletCount = 0;
  let totalLength = 0;

  for (const t of group) {
    const desc = t.description ?? "";
    totalLength += desc.length;

    const ticketHeadings = collectHeadings(desc, headingFreq);
    if (ticketHeadings.length > 0) structuredCount++;
    if (CHECKBOX_RE.test(desc)) checkboxCount++;
    if (GHERKIN_RE.test(desc)) gherkinCount++;
    if (BULLET_RE.test(desc)) bulletCount++;
  }

  return { headingFreq, structuredCount, checkboxCount, gherkinCount, bulletCount, totalLength };
}

/** Extract headings from a description and update frequency map. */
function collectHeadings(desc: string, headingFreq: Map<string, number>): string[] {
  const ticketHeadings: string[] = [];
  let m: RegExpExecArray | null;

  HEADING_RE.lastIndex = 0;
  for (m = HEADING_RE.exec(desc); m !== null; m = HEADING_RE.exec(desc)) {
    const h = m[1]?.trim().toLowerCase() ?? "";
    ticketHeadings.push(h);
    headingFreq.set(h, (headingFreq.get(h) ?? 0) + 1);
  }

  BOLD_SECTION_RE.lastIndex = 0;
  for (m = BOLD_SECTION_RE.exec(desc); m !== null; m = BOLD_SECTION_RE.exec(desc)) {
    const h = m[1]?.trim().toLowerCase() ?? "";
    ticketHeadings.push(h);
    headingFreq.set(h, (headingFreq.get(h) ?? 0) + 1);
  }

  return ticketHeadings;
}

/** Determine the dominant acceptance-criteria format. */
function detectAcFormat(checkboxCount: number, gherkinCount: number, bulletCount: number): string {
  const maxAc = Math.max(checkboxCount, gherkinCount, bulletCount);
  if (maxAc === 0) return "none";
  if (checkboxCount === maxAc && gherkinCount === maxAc) return "mixed";
  if (checkboxCount === maxAc) return "checkbox";
  if (gherkinCount === maxAc) return "gherkin";
  return "bullet";
}

// ─── Description structure extraction ───────────────────────────────────────────

/**
 * Extract description structure rules grouped by issue type.
 * Detects section headings, acceptance criteria format, and length patterns.
 */
export function extractDescriptionRules(tickets: TicketData[]): TeamRule[] {
  if (tickets.length === 0) return [];
  const rules: TeamRule[] = [];
  const groups = groupBy(tickets, (t) => t.issueType);

  for (const [type, group] of groups) {
    const { headingFreq, structuredCount, checkboxCount, gherkinCount, bulletCount, totalLength } =
      analyzeDescriptions(group);

    const n = group.length;
    const threshold = n * 0.3;

    // Top headings appearing in >30% of tickets
    const topHeadings = [...headingFreq.entries()]
      .filter(([, c]) => c > threshold)
      .sort((a, b) => b[1] - a[1])
      .map(([h]) => h);

    rules.push({
      category: "description_structure",
      rule_key: `section_headings/${type}`,
      issue_type: type,
      rule_value: JSON.stringify(topHeadings),
      confidence:
        topHeadings.length > 0
          ? Math.min(1, topHeadings.reduce((s, h) => s + (headingFreq.get(h) ?? 0), 0) / (topHeadings.length * n))
          : 0,
      sample_size: n,
    });

    const acFormat = detectAcFormat(checkboxCount, gherkinCount, bulletCount);

    rules.push(
      {
        category: "description_structure",
        rule_key: `ac_format/${type}`,
        issue_type: type,
        rule_value: acFormat,
        confidence: n > 0 ? Math.max(checkboxCount, gherkinCount, bulletCount) / n : 0,
        sample_size: n,
      },
      {
        category: "description_structure",
        rule_key: `avg_length/${type}`,
        issue_type: type,
        rule_value: String(n > 0 ? Math.round(totalLength / n) : 0),
        confidence: Math.min(1, n / 20),
        sample_size: n,
      },
      {
        category: "description_structure",
        rule_key: `has_structure_pct/${type}`,
        issue_type: type,
        rule_value: `${pct(structuredCount, n)}%`,
        confidence: Math.min(1, n / 20),
        sample_size: n,
      },
    );
  }

  return rules;
}

// ─── Naming convention helpers ───────────────────────────────────────────────────

/** Determine the naming pattern for a group based on verb/tag counts. */
function detectNamingPattern(
  verbFirstCount: number,
  tagPrefixCount: number,
  n: number,
): { pattern: string; confidence: number } {
  const safeN = Math.max(n, 1);
  if (verbFirstCount / safeN > 0.6) {
    return { pattern: "verb-first", confidence: verbFirstCount / safeN };
  }
  if (tagPrefixCount / safeN > 0.3) {
    return { pattern: "tag-prefix", confidence: tagPrefixCount / safeN };
  }
  return { pattern: "noun-phrase", confidence: 0.5 };
}

// ─── Naming convention extraction ───────────────────────────────────────────────

/**
 * Extract summary naming convention rules grouped by issue type.
 * Detects verb-first patterns, tag prefixes, and typical word counts.
 */
export function extractNamingRules(tickets: TicketData[]): TeamRule[] {
  if (tickets.length === 0) return [];
  const rules: TeamRule[] = [];
  const groups = groupBy(tickets, (t) => t.issueType);
  const qualityMap = buildQualityMap(tickets);

  for (const [type, group] of groups) {
    const verbFreq = new Map<string, number>();
    let verbFirstCount = 0;
    let tagPrefixCount = 0;
    const wordCounts: number[] = [];

    for (const t of group) {
      const words = t.summary.trim().split(/\s+/);
      wordCounts.push(words.length);

      const firstWord = words[0]?.toLowerCase().replaceAll(/[^a-z]/g, "") ?? "";
      if (ACTION_VERBS.has(firstWord)) {
        verbFirstCount++;
        verbFreq.set(firstWord, (verbFreq.get(firstWord) ?? 0) + 1);
      }

      if (TAG_PREFIX_RE.test(t.summary)) tagPrefixCount++;
    }

    const n = group.length;

    // Top verbs
    const topVerbs = topN(verbFreq, 3).map((v) => ({
      verb: v.value,
      percentage: `${pct(v.count, n)}%`,
    }));

    rules.push({
      category: "naming_convention",
      rule_key: `first_verb/${type}`,
      issue_type: type,
      rule_value: JSON.stringify(topVerbs),
      confidence: n > 0 ? verbFirstCount / n : 0,
      sample_size: n,
    });

    rules.push({
      category: "naming_convention",
      rule_key: `avg_words/${type}`,
      issue_type: type,
      rule_value: String(Math.round(mean(wordCounts))),
      confidence: Math.min(1, n / 20),
      sample_size: n,
    });

    const { pattern, confidence } = detectNamingPattern(verbFirstCount, tagPrefixCount, n);

    rules.push({
      category: "naming_convention",
      rule_key: `pattern/${type}`,
      issue_type: type,
      rule_value: pattern,
      confidence,
      sample_size: n,
    });

    // Best examples (top 3 by quality)
    const sorted = [...group].sort((a, b) => (qualityMap.get(b.key) ?? 0) - (qualityMap.get(a.key) ?? 0));
    const examples = sorted.slice(0, 3).map((t) => t.summary);

    rules.push({
      category: "naming_convention",
      rule_key: `examples/${type}`,
      issue_type: type,
      rule_value: JSON.stringify(examples),
      confidence: Math.min(1, n / 10),
      sample_size: n,
    });
  }

  return rules;
}

// ─── Story point extraction ─────────────────────────────────────────────────────

/**
 * Extract story point estimation rules grouped by issue type.
 * Calculates median, mode, mean, percentiles, and distribution.
 */
export function extractPointRules(tickets: TicketData[]): TeamRule[] {
  const pointed = tickets.filter((t) => t.storyPoints != null && t.storyPoints > 0);
  if (pointed.length === 0) return [];

  const rules: TeamRule[] = [];
  const groups = groupBy(pointed, (t) => t.issueType);

  for (const [type, group] of groups) {
    const pts = group.map((t) => t.storyPoints ?? 0);
    const n = pts.length;
    const p25 = percentile(pts, 25);
    const p75 = percentile(pts, 75);
    const sd = stddev(pts);
    const m = mean(pts);
    const normalizedStd = m > 0 ? sd / m : 0;

    const confidence = Math.min(1, n / 30) * Math.max(0, 1 - normalizedStd);

    // Distribution
    const dist = new Map<number, number>();
    for (const p of pts) dist.set(p, (dist.get(p) ?? 0) + 1);
    const distObj: Record<string, string> = {};
    for (const [v, c] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
      distObj[String(v)] = `${pct(c, n)}%`;
    }

    rules.push(
      {
        category: "story_points",
        rule_key: `median/${type}`,
        issue_type: type,
        rule_value: String(median(pts)),
        confidence,
        sample_size: n,
      },
      {
        category: "story_points",
        rule_key: `range/${type}`,
        issue_type: type,
        rule_value: `${p25}-${p75}`,
        confidence,
        sample_size: n,
      },
      {
        category: "story_points",
        rule_key: `distribution/${type}`,
        issue_type: type,
        rule_value: JSON.stringify(distObj),
        confidence,
        sample_size: n,
      },
      {
        category: "story_points",
        rule_key: `mean/${type}`,
        issue_type: type,
        rule_value: m.toFixed(1),
        confidence,
        sample_size: n,
      },
    );
  }

  return rules;
}
