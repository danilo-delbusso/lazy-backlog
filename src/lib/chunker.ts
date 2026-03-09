/**
 * Markdown-aware section chunker using remark AST.
 *
 * Splits markdown on heading boundaries, preserving heading breadcrumbs
 * (e.g. "Architecture > Authentication > OAuth2") for each chunk.
 * Designed for Confluence content that's already been converted to markdown.
 */

import type { Content, Heading, Root } from "mdast";
import { toString as nodeToString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Chunk {
  /** Heading breadcrumb path, e.g. "Architecture > Auth > OAuth2" */
  breadcrumb: string;
  /** The heading that starts this section (empty for preamble) */
  heading: string;
  /** Heading depth (1-6), 0 for preamble content before first heading */
  depth: number;
  /** Plain text content of this section (no child headings) */
  content: string;
  /** Character offset in the original markdown */
  startOffset: number;
  /** Order index within the document */
  index: number;
}

export interface ChunkOptions {
  /** Minimum chunk size in chars — sections smaller than this merge into parent (default: 50) */
  minChunkSize?: number;
  /** Maximum chunk size in chars — sections larger than this get split at paragraph boundaries (default: 2000) */
  maxChunkSize?: number;
  /** Overlap chars to prepend from previous chunk for context continuity (default: 100) */
  overlapChars?: number;
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  minChunkSize: 50,
  maxChunkSize: 2000,
  overlapChars: 100,
};

// ── Parser ────────────────────────────────────────────────────────────────────

const parser = unified().use(remarkParse);

/** Parse markdown into remark AST. */
function parse(md: string): Root {
  return parser.parse(md);
}

// ── Chunking ──────────────────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  depth: number;
  nodes: Content[];
  startOffset: number;
}

/**
 * Walk the AST and collect sections split on heading boundaries.
 * Each section contains all nodes between two headings of equal or higher level.
 */
function collectSections(tree: Root): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection = {
    heading: "",
    depth: 0,
    nodes: [],
    startOffset: 0,
  };

  for (const node of tree.children) {
    if (node.type === "heading") {
      const h = node as Heading;
      // Flush current section if it has content
      if (current.nodes.length > 0) {
        sections.push(current);
      }
      current = {
        heading: nodeToString(h),
        depth: h.depth,
        nodes: [],
        startOffset: h.position?.start.offset ?? 0,
      };
    } else {
      current.nodes.push(node);
    }
  }

  // Flush final section
  if (current.nodes.length > 0 || current.heading) {
    sections.push(current);
  }

  return sections;
}

/** Build breadcrumb from heading stack. */
function buildBreadcrumb(stack: { heading: string; depth: number }[]): string {
  return stack.map((s) => s.heading).join(" > ");
}

/** Extract plain text from a list of AST nodes. */
function nodesToText(nodes: Content[]): string {
  return nodes
    .map((n) => nodeToString(n))
    .join("\n\n")
    .trim();
}

/**
 * Split oversized text at paragraph boundaries.
 * Returns chunks of at most maxSize chars, splitting at double-newline boundaries.
 */
function splitAtParagraphs(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const parts: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > maxSize) {
      parts.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts;
}

/**
 * Chunk a markdown document into heading-aware sections with breadcrumbs.
 *
 * - Splits on heading boundaries
 * - Merges tiny sections into parent
 * - Splits oversized sections at paragraph boundaries
 * - Adds overlap for context continuity
 */
export function chunkMarkdown(markdown: string, options?: ChunkOptions): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tree = parse(markdown);
  const sections = collectSections(tree);

  if (sections.length === 0) {
    // No structure — return whole document as single chunk
    const text = markdown.trim();
    if (!text) return [];
    return [{ breadcrumb: "", heading: "", depth: 0, content: text, startOffset: 0, index: 0 }];
  }

  // Build breadcrumbs using a heading stack
  const headingStack: { heading: string; depth: number }[] = [];
  const chunks: Chunk[] = [];
  let prevChunkEnd = "";

  for (const section of sections) {
    const text = nodesToText(section.nodes);

    // Update heading stack — pop anything at same or deeper level
    while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.depth >= section.depth) {
      headingStack.pop();
    }
    if (section.heading) {
      headingStack.push({ heading: section.heading, depth: section.depth });
    }

    const breadcrumb = buildBreadcrumb(headingStack);

    // Skip empty sections
    if (!text && !section.heading) continue;

    // Merge tiny sections — append to previous chunk if possible
    if (text.length < opts.minChunkSize && text.length > 0 && chunks.length > 0) {
      const prev = chunks[chunks.length - 1]!;
      prev.content += `\n\n## ${section.heading}\n${text}`;
      continue;
    }

    // Split oversized sections
    const textParts = splitAtParagraphs(text || section.heading, opts.maxChunkSize);

    for (let i = 0; i < textParts.length; i++) {
      let content = textParts[i]!;

      // Add overlap from previous chunk
      if (opts.overlapChars > 0 && prevChunkEnd && chunks.length > 0) {
        const overlap = prevChunkEnd.slice(-opts.overlapChars);
        content = `…${overlap}\n\n---\n\n${content}`;
      }

      chunks.push({
        breadcrumb,
        heading: section.heading + (textParts.length > 1 ? ` (${i + 1}/${textParts.length})` : ""),
        depth: section.depth,
        content,
        startOffset: section.startOffset,
        index: chunks.length,
      });
    }

    prevChunkEnd = text;
  }

  return chunks;
}

/** Strip common Confluence boilerplate patterns from markdown before chunking. */
export function stripBoilerplate(md: string): string {
  return (
    md
      // Page properties macro remnants
      .replace(/\|?\s*Created by.*?\d{4}\s*\|?/gi, "")
      // "Last updated" lines
      .replace(/Last (updated|modified|edited).*?\n/gi, "")
      // Empty table rows
      .replace(/\|\s*\|\s*\|\s*\n/g, "")
      // Confluence status macros
      .replace(/\{status[^}]*\}/gi, "")
      // TOC macros
      .replace(/\{toc[^}]*\}/gi, "")
      // Panel/info/warning macro wrappers (keep content)
      .replace(/\{(panel|info|warning|note|tip|expand)[^}]*\}/gi, "")
      // Jira issue macro
      .replace(/\{jira[^}]*\}/gi, "")
      // Multiple blank lines → max 2
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
