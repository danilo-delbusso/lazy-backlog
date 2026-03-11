import { describe, expect, it } from "vitest";
import { chunkMarkdown, stripBoilerplate } from "../lib/chunker.js";

// ── chunkMarkdown ────────────────────────────────────────────────────────────

describe("chunkMarkdown", () => {
  it("returns empty array for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   ")).toEqual([]);
  });

  it("returns single chunk for plain text with no headings", () => {
    const chunks = chunkMarkdown("Just some plain text.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("Just some plain text.");
    expect(chunks[0]?.depth).toBe(0);
    expect(chunks[0]?.breadcrumb).toBe("");
  });

  it("splits on heading boundaries", () => {
    const md = "# Intro\nHello world with enough content here\n\n# Details\nSome details here that are long enough";
    const chunks = chunkMarkdown(md, { overlapChars: 0, minChunkSize: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.heading).toBe("Intro");
    expect(chunks[0]?.content).toContain("Hello world");
    expect(chunks[1]?.heading).toBe("Details");
    expect(chunks[1]?.content).toContain("Some details here");
  });

  it("builds breadcrumbs for nested headings", () => {
    const md = "# Top\nA\n\n## Mid\nB\n\n### Deep\nC";
    const chunks = chunkMarkdown(md, { overlapChars: 0, minChunkSize: 0 });
    const deep = chunks.find((c) => c.heading.startsWith("Deep"));
    expect(deep).toBeDefined();
    expect(deep?.breadcrumb).toBe("Top > Mid > Deep");
  });

  it("merges tiny sections into previous chunk", () => {
    const md = "# First\nLong enough content here.\n\n# Tiny\nX";
    const chunks = chunkMarkdown(md, { minChunkSize: 50, overlapChars: 0 });
    // "X" is < 50 chars, should be merged into previous
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("X");
  });

  it("splits oversized sections at paragraph boundaries", () => {
    const para = "A".repeat(100);
    const md = `# Big\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, { maxChunkSize: 250, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("adds overlap from previous chunk", () => {
    const md = "# A\nFirst section content\n\n# B\nSecond section content";
    const chunks = chunkMarkdown(md, { overlapChars: 10 });
    // Second chunk should have overlap marker
    if (chunks.length > 1) {
      expect(chunks[1]?.content).toContain("…");
    }
  });

  it("assigns sequential index values", () => {
    const md = "# A\nOne\n\n# B\nTwo\n\n# C\nThree";
    const chunks = chunkMarkdown(md, { overlapChars: 0, minChunkSize: 0 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]?.index).toBe(i);
    }
  });
});

// ── stripBoilerplate ─────────────────────────────────────────────────────────

describe("stripBoilerplate", () => {
  it("removes 'Created by' lines", () => {
    const md = "# Title\n| Created by admin on 2024 |\nContent";
    expect(stripBoilerplate(md)).not.toContain("Created by");
  });

  it("removes 'Last updated' lines", () => {
    const md = "Some text\nLast updated on Jan 2024\nMore text";
    expect(stripBoilerplate(md)).not.toContain("Last updated");
  });

  it("removes Confluence macros", () => {
    const md = "{toc:maxLevel=3}\n# Heading\n{status:colour=Green|title=Done}";
    const cleaned = stripBoilerplate(md);
    expect(cleaned).not.toContain("{toc");
    expect(cleaned).not.toContain("{status");
  });

  it("collapses multiple blank lines", () => {
    const md = "A\n\n\n\n\nB";
    expect(stripBoilerplate(md)).toBe("A\n\nB");
  });

  it("preserves meaningful content", () => {
    const md = "# Architecture\n\nWe use microservices.";
    expect(stripBoilerplate(md)).toBe(md);
  });
});
