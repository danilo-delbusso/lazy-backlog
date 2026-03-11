import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { handleAssess, handleFindBugs, handleSearchBugs, handleTriage } from "./bugs-helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_KEYWORDS: Record<string, string[]> = {
  critical: ["data loss", "security", "crash", "production down", "outage"],
  high: ["blocks", "blocking", "broken", "regression", "all users"],
  low: ["cosmetic", "typo", "minor", "edge case", "workaround"],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Infer severity from issue text content. */
export function inferSeverity(text: string): { severity: string; matches: string[] } {
  const lower = text.toLowerCase();
  const matches: string[] = [];

  for (const keyword of SEVERITY_KEYWORDS.critical ?? []) {
    if (lower.includes(keyword)) matches.push(`critical: "${keyword}"`);
  }
  if (matches.length > 0) return { severity: "critical", matches };

  for (const keyword of SEVERITY_KEYWORDS.high ?? []) {
    if (lower.includes(keyword)) matches.push(`high: "${keyword}"`);
  }
  if (matches.length > 0) return { severity: "high", matches };

  for (const keyword of SEVERITY_KEYWORDS.low ?? []) {
    if (lower.includes(keyword)) matches.push(`low: "${keyword}"`);
  }
  if (matches.length > 0) return { severity: "low", matches };

  return { severity: "medium", matches: ["no specific keywords found"] };
}

/** Score a bug's completeness (0-100). */
export function assessCompleteness(
  description: string | undefined,
  labels: string[],
  components: string[],
): {
  score: number;
  missing: string[];
} {
  let score = 0;
  const missing: string[] = [];
  const desc = description || "";

  if (desc.length > 50) {
    score += 25;
  } else {
    missing.push("Detailed description (>50 chars)");
  }

  const lowerDesc = desc.toLowerCase();
  if (lowerDesc.includes("steps to reproduce") || lowerDesc.includes("steps to repro")) {
    score += 25;
  } else {
    missing.push("Steps to reproduce");
  }

  if (lowerDesc.includes("expected") && lowerDesc.includes("actual")) {
    score += 20;
  } else {
    missing.push("Expected vs actual behavior");
  }

  if (lowerDesc.includes("environment") || lowerDesc.includes("version") || lowerDesc.includes("browser")) {
    score += 15;
  } else {
    missing.push("Environment/version info");
  }

  if (labels.length > 0 || components.length > 0) {
    score += 15;
  } else {
    missing.push("Labels or components");
  }

  return { score, missing };
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerBugsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "bugs",
    {
      description:
        "Bug discovery, assessment, and triage. Actions: 'find-bugs' list untriaged bugs by date range. 'search' query bugs via JQL (auto-enforces type=Bug and project filter). 'assess' score a bug report's completeness (0-100). 'triage' prioritize a bug — recommends severity, sprint placement, and trade-offs. To get full details or update a bug, use the 'issues' tool with get/update actions.",
      inputSchema: z.object({
        action: z.enum(["find-bugs", "search", "assess", "triage"]),
        jql: z.string().optional().describe("[find-bugs, search] JQL query string"),
        maxResults: z.number().max(100).default(50).optional().describe("[find-bugs, search] Max issues to return"),
        dateRange: z
          .enum(["7d", "30d", "90d"])
          .default("30d")
          .optional()
          .describe("[find-bugs] Only bugs created within this window"),
        component: z.string().optional().describe("[find-bugs] Filter by component name"),
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[assess, triage] Issue keys to assess or triage, e.g. ['BP-1','BP-2']"),
        autoComment: z
          .boolean()
          .default(true)
          .optional()
          .describe("[assess] Auto-add a comment to incomplete bugs requesting missing info"),
        autoUpdate: z
          .boolean()
          .default(false)
          .optional()
          .describe("[triage] Auto-update priority based on severity analysis"),
        severity: z
          .enum(["critical", "high", "medium", "low"])
          .optional()
          .describe("[triage] Override inferred severity for sprint assignment"),
        autoAssign: z.boolean().default(false).optional().describe("[triage] Auto-move issue to recommended sprint"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "find-bugs":
          return handleFindBugs(params, kb);
        case "search":
          return handleSearchBugs(params, kb);
        case "assess":
          return handleAssess(params, kb);
        case "triage":
          return handleTriage(params, kb);
        default:
          return errorResponse(`Unknown action: ${params.action}`);
      }
    },
  );
}
