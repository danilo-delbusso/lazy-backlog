import { describe, expect, it } from "vitest";
import type { PageType } from "../config/schema.js";
// Import schemas and types to exercise them
import { PAGE_TYPES } from "../config/schema.js";

describe("PAGE_TYPES", () => {
  it("contains all expected page types", () => {
    expect(PAGE_TYPES).toContain("adr");
    expect(PAGE_TYPES).toContain("design");
    expect(PAGE_TYPES).toContain("runbook");
    expect(PAGE_TYPES).toContain("meeting");
    expect(PAGE_TYPES).toContain("spec");
    expect(PAGE_TYPES).toContain("other");
  });

  it("has exactly 6 types", () => {
    expect(PAGE_TYPES).toHaveLength(6);
  });
});

describe("PageType", () => {
  it("accepts valid page types", () => {
    const valid: PageType[] = ["adr", "design", "runbook", "meeting", "spec", "other"];
    for (const t of valid) {
      expect(typeof t).toBe("string");
    }
  });
});

describe("SpiderOptions (via Zod)", () => {
  // Re-import the schema to validate
  // We test the schema shapes by parsing sample data
  it("accepts valid spider options", async () => {
    const { SpiderOptionsSchema } = await import("../config/schema.js");
    const result = SpiderOptionsSchema.parse({
      spaceKey: "ENG",
      maxDepth: 5,
      maxConcurrency: 3,
      includeLabels: ["adr"],
      excludeLabels: ["draft"],
    });
    expect(result.spaceKey).toBe("ENG");
    expect(result.maxDepth).toBe(5);
  });

  it("applies defaults", async () => {
    const { SpiderOptionsSchema } = await import("../config/schema.js");
    const result = SpiderOptionsSchema.parse({});
    expect(result.maxDepth).toBe(10);
    expect(result.maxConcurrency).toBe(5);
    expect(result.includeLabels).toEqual([]);
    expect(result.excludeLabels).toEqual([]);
  });

  it("rejects invalid types", async () => {
    const { SpiderOptionsSchema } = await import("../config/schema.js");
    expect(() => SpiderOptionsSchema.parse({ maxDepth: "not-a-number" })).toThrow();
  });
});

describe("ProjectConfigSchema (via Zod)", () => {
  it("accepts valid project config", async () => {
    const { ProjectConfigSchema } = await import("../config/schema.js");
    const result = ProjectConfigSchema.parse({
      siteUrl: "https://test.atlassian.net",
      email: "test@example.com",
      apiToken: "tok_123",
      confluenceSpaces: ["ENG"],
      rootPageIds: [],
    });
    expect(result.siteUrl).toBe("https://test.atlassian.net");
    expect(result.email).toBe("test@example.com");
  });

  it("rejects missing required fields", async () => {
    const { ProjectConfigSchema } = await import("../config/schema.js");
    expect(() => ProjectConfigSchema.parse({})).toThrow();
  });
});
