import { z } from "zod";

export const PAGE_TYPES = ["adr", "design", "runbook", "meeting", "spec", "other"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const ProjectConfigSchema = z.object({
  siteUrl: z.string().describe("Atlassian Cloud site URL, e.g. https://yoursite.atlassian.net"),
  email: z.string().email().describe("Atlassian account email"),
  apiToken: z.string().describe("Atlassian API token"),
  jiraProjectKey: z.string().optional().describe("Default Jira project key for ticket creation"),
  jiraBoardId: z.string().optional().describe("Jira board ID for sprint/workflow context"),
  confluenceSpaces: z.array(z.string()).default([]).describe("Confluence space keys to index"),
  rootPageIds: z.array(z.string()).default([]).describe("Specific Confluence page IDs to spider from"),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const SpiderOptionsSchema = z.object({
  spaceKey: z.string().optional().describe("Confluence space key to crawl"),
  rootPageId: z.string().optional().describe("Specific page ID to start crawling from"),
  maxDepth: z.number().default(10).describe("Maximum depth to crawl"),
  maxConcurrency: z.number().default(5).describe("Max parallel page fetches"),
  includeLabels: z.array(z.string()).default([]).describe("Only include pages with these labels"),
  excludeLabels: z.array(z.string()).default([]).describe("Exclude pages with these labels"),
});

export type SpiderOptions = z.infer<typeof SpiderOptionsSchema>;
