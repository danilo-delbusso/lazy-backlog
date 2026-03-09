import { z } from "zod";
import type { ProjectConfig } from "../config/schema.js";
import type { KnowledgeBase } from "./db.js";

/** Schema for the stored (non-auth) project settings in SQLite. */
const StoredConfigSchema = z
  .object({
    jiraProjectKey: z.string().optional(),
    jiraBoardId: z.string().optional(),
    confluenceSpaces: z.array(z.string()).optional(),
    rootPageIds: z.array(z.string()).optional(),
  })
  .passthrough();

/** Resolve project config from env vars (preferred) or stored config. */
export function resolveConfig(kb: KnowledgeBase): ProjectConfig {
  const siteUrl = process.env.ATLASSIAN_SITE_URL;
  const email = process.env.ATLASSIAN_EMAIL;
  const apiToken = process.env.ATLASSIAN_API_TOKEN;

  if (!siteUrl || !email || !apiToken) {
    throw new Error(
      "Missing Atlassian credentials. Set ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN as env vars in your MCP server config.",
    );
  }

  // Project settings from SQLite (persisted via configure tool)
  const stored = kb.getConfig("atlassian");
  const extra = parseStoredConfig(stored);

  return {
    siteUrl,
    email,
    apiToken,
    // Project settings: env var override → SQLite stored → undefined
    jiraProjectKey: process.env.JIRA_PROJECT_KEY || extra.jiraProjectKey,
    jiraBoardId: process.env.JIRA_BOARD_ID || extra.jiraBoardId,
    confluenceSpaces:
      process.env.CONFLUENCE_SPACES?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ??
      extra.confluenceSpaces ??
      [],
    rootPageIds: extra.rootPageIds ?? [],
  };
}

/** Safely parse stored config with Zod validation. Returns empty object on failure. */
function parseStoredConfig(raw: string | undefined) {
  if (!raw) return {};
  try {
    return StoredConfigSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Helper to return MCP error response. */
export function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Helper to return MCP text response. */
export function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Format JSON labels array as a clean comma-separated string. */
export function formatLabels(labelsJson: string): string {
  try {
    const arr = JSON.parse(labelsJson);
    return Array.isArray(arr) && arr.length > 0 ? arr.join(", ") : "none";
  } catch {
    return "none";
  }
}
