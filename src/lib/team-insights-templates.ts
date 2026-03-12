/**
 * Template insight extraction for the Team Insights Analysis system.
 *
 * Analyzes ticket descriptions to discover common heading structures,
 * acceptance criteria formats, and generate template skeletons per issue type.
 */

import type { TemplateInsight } from "./team-insights-types.js";
import type { TicketData } from "./team-rules-types.js";
import { mean } from "./team-rules-utils.js";
import { groupBy } from "./utils.js";

// ─── Pre-compiled regex ──────────────────────────────────────────────────────────

const MARKDOWN_HEADING_RE = /^#{1,3}\s+(.+)$/gm;
const BOLD_HEADING_RE = /^\*\*([^*]+?)(?::)?\*\*\s*$/gm;
const CHECKBOX_RE = /- \[[ x]\]/g;
const GHERKIN_RE = /\b(given|when|then)\b/gi;
const NUMBERED_RE = /^\d+\.\s+/gm;

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** Extract all headings from a markdown description. */
function extractHeadings(description: string): string[] {
  const headings: string[] = [];

  // Markdown headings: # Heading, ## Heading, ### Heading
  for (const match of description.matchAll(MARKDOWN_HEADING_RE)) {
    if (match[1]) headings.push(match[1].trim().toLowerCase());
  }

  // Bold section headings: **Section:** or **Section**
  for (const match of description.matchAll(BOLD_HEADING_RE)) {
    if (match[1]) headings.push(match[1].trim().toLowerCase());
  }

  return headings;
}

type AcFormat = "checkbox" | "given-when-then" | "numbered" | "prose" | "none";

/** Detect the acceptance criteria format used in a description. */
function detectAcFormat(description: string): AcFormat {
  if (!description) return "none";

  const checkboxCount = (description.match(CHECKBOX_RE) ?? []).length;
  const gherkinCount = (description.match(GHERKIN_RE) ?? []).length;
  const numberedCount = (description.match(NUMBERED_RE) ?? []).length;

  if (checkboxCount >= 2) return "checkbox";
  if (gherkinCount >= 3) return "given-when-then";
  if (numberedCount >= 2) return "numbered";
  if (description.length > 50) return "prose";
  return "none";
}

/** Count acceptance criteria items based on format. */
function countAcItems(description: string, format: AcFormat): number {
  if (format === "checkbox") {
    return (description.match(CHECKBOX_RE) ?? []).length;
  }
  if (format === "numbered") {
    return (description.match(NUMBERED_RE) ?? []).length;
  }
  return 0;
}

/** Build a template skeleton from the most common headings. */
function buildSkeleton(headings: Array<{ text: string; frequency: number }>, acFormat: AcFormat): string {
  const lines: string[] = [];

  for (const h of headings) {
    // Title-case the heading
    const title = h.text.replaceAll(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`## ${title}`);

    // Add placeholder content based on heading type
    const lower = h.text.toLowerCase();
    if (lower.includes("acceptance criteria") || lower.includes("ac")) {
      if (acFormat === "checkbox") {
        lines.push("- [ ] [Criterion 1]", "- [ ] [Criterion 2]");
      } else if (acFormat === "given-when-then") {
        lines.push("Given [precondition]", "When [action]", "Then [expected result]");
      } else if (acFormat === "numbered") {
        lines.push("1. [Criterion 1]", "2. [Criterion 2]");
      } else {
        lines.push("[Describe acceptance criteria]");
      }
    } else {
      lines.push(`[Describe the ${lower}]`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────────

/** Count heading frequency across all descriptions in a group. */
function aggregateHeadingCounts(group: TicketData[]): Map<string, number> {
  const headingCounts = new Map<string, number>();
  for (const t of group) {
    if (!t.description) continue;
    const seen = new Set<string>();
    for (const h of extractHeadings(t.description)) {
      if (!seen.has(h)) {
        seen.add(h);
        headingCounts.set(h, (headingCounts.get(h) ?? 0) + 1);
      }
    }
  }
  return headingCounts;
}

/** Filter and sort headings appearing in >30% of tickets. */
function filterCommonHeadings(
  headingCounts: Map<string, number>,
  groupSize: number,
): Array<{ text: string; frequency: number }> {
  const threshold = groupSize * 0.3;
  return [...headingCounts.entries()]
    .filter(([, count]) => count > threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({
      text,
      frequency: Math.round((count / groupSize) * 100) / 100,
    }));
}

/** Detect the dominant AC format and average item count for a group. */
function detectGroupAcFormat(group: TicketData[]): { acFormat: AcFormat; avgAcItems: number } {
  const formatCounts: Record<AcFormat, number> = {
    checkbox: 0,
    "given-when-then": 0,
    numbered: 0,
    prose: 0,
    none: 0,
  };
  const acItemCounts: number[] = [];

  for (const t of group) {
    const format = detectAcFormat(t.description ?? "");
    formatCounts[format]++;
    const items = countAcItems(t.description ?? "", format);
    if (items > 0) acItemCounts.push(items);
  }

  const acFormat = (Object.entries(formatCounts) as [AcFormat, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
  const avgAcItems = acItemCounts.length > 0 ? Math.round(mean(acItemCounts) * 10) / 10 : 0;

  return { acFormat, avgAcItems };
}

// ─── Main extractor ──────────────────────────────────────────────────────────────

/**
 * Extract template insights from ticket descriptions.
 *
 * Groups tickets by issue type, discovers common heading structures,
 * detects AC format, and builds template skeletons.
 * Only returns insights for issue types with ≥5 tickets.
 */
export function extractTemplateInsights(tickets: TicketData[]): TemplateInsight[] {
  const byType = groupBy(tickets, (t) => t.issueType);
  const insights: TemplateInsight[] = [];

  for (const [issueType, group] of byType) {
    if (group.length < 5) continue;

    const headingCounts = aggregateHeadingCounts(group);
    const headings = filterCommonHeadings(headingCounts, group.length);
    const { acFormat, avgAcItems } = detectGroupAcFormat(group);
    const templateSkeleton = buildSkeleton(headings, acFormat);

    insights.push({
      issueType,
      headings,
      acFormat,
      avgAcItems,
      templateSkeleton,
      sampleSize: group.length,
    });
  }

  return insights;
}
