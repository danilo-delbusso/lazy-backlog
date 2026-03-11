/**
 * Atlassian Document Format (ADF) builder — converts markdown to ADF and back.
 */

// ── ADF Node type ────────────────────────────────────────────────────────────

/** Minimal ADF node types for Jira descriptions. */
export type AdfNode =
  | { type: "doc"; version: 1; content: AdfNode[] }
  | { type: "paragraph"; content: AdfNode[] }
  | { type: "heading"; attrs: { level: number }; content: AdfNode[] }
  | { type: "text"; text: string; marks?: { type: string; attrs?: Record<string, string> }[] }
  | { type: "bulletList"; content: AdfNode[] }
  | { type: "orderedList"; content: AdfNode[] }
  | { type: "listItem"; content: AdfNode[] }
  | { type: "taskList"; attrs: { localId: string }; content: AdfNode[] }
  | { type: "taskItem"; attrs: { localId: string; state: "TODO" | "DONE" }; content: AdfNode[] }
  | { type: "codeBlock"; attrs?: { language?: string }; content: AdfNode[] }
  | { type: "rule" }
  | { type: "hardBreak" };

// ── Internal helpers ─────────────────────────────────────────────────────────

function textNode(text: string, marks?: { type: string; attrs?: Record<string, string> }[]): AdfNode {
  return marks?.length ? { type: "text", text, marks } : { type: "text", text };
}

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: parseInline(text) };
}

/** Parse inline markdown (bold, italic, code, links) into ADF text nodes. */
function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Markdown links, bold, italic, inline code, or bare URLs
  const re = /(\[([^\]]+)]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|(?<![(\[])(https?:\/\/[^\s)>\]]+))/g;
  let last = 0;
  let match: RegExpExecArray | null = re.exec(text);

  while (match !== null) {
    if (match.index > last) nodes.push(textNode(text.slice(last, match.index)));
    if (match[2] && match[3]) nodes.push(textNode(match[2], [{ type: "link", attrs: { href: match[3] } }]));
    else if (match[4]) nodes.push(textNode(match[4], [{ type: "strong" }]));
    else if (match[5]) nodes.push(textNode(match[5], [{ type: "em" }]));
    else if (match[6]) nodes.push(textNode(match[6], [{ type: "code" }]));
    else if (match[7]) nodes.push(textNode(match[7], [{ type: "link", attrs: { href: match[7] } }]));
    last = match.index + match[0].length;
    match = re.exec(text);
  }

  if (last < text.length) nodes.push(textNode(text.slice(last)));
  if (nodes.length === 0) nodes.push(textNode(text || " "));
  return nodes;
}

/** Try to parse a heading line into an ADF heading node. */
function parseHeading(line: string): AdfNode | null {
  const headingRe = /^(#{1,6})\s+(.+)/;
  const hm = headingRe.exec(line);
  if (!hm) return null;
  return { type: "heading", attrs: { level: hm[1]?.length ?? 1 }, content: parseInline(hm[2] ?? "") };
}

/** Parse a fenced code block starting at index `i`. Returns the node and the new index. */
function parseCodeBlock(lines: string[], i: number): { node: AdfNode; next: number } {
  const lang = lines[i]?.slice(3).trim() || undefined;
  const codeLines: string[] = [];
  i++;
  while (i < lines.length && !lines[i]?.startsWith("```")) {
    codeLines.push(lines[i] ?? "");
    i++;
  }
  i++;
  const node = {
    type: "codeBlock",
    ...(lang ? { attrs: { language: lang } } : {}),
    content: [textNode(codeLines.join("\n"))],
  } as AdfNode;
  return { node, next: i };
}

let taskIdCounter = 0;
function nextTaskId(): string {
  return `task-${++taskIdCounter}`;
}

const taskItemRe = /^[-*]\s\[([ xX])]\s/;

/** Collect consecutive task list items and return a taskList node. */
function parseTaskList(lines: string[], i: number): { node: AdfNode; next: number } {
  const items: AdfNode[] = [];
  while (i < lines.length && taskItemRe.test(lines[i] ?? "")) {
    const line = lines[i] ?? "";
    const m = taskItemRe.exec(line);
    const state = m?.[1] === " " ? "TODO" : "DONE";
    const text = line.replace(taskItemRe, "");
    items.push({ type: "taskItem", attrs: { localId: nextTaskId(), state }, content: parseInline(text) });
    i++;
  }
  const listId = nextTaskId();
  return { node: { type: "taskList", attrs: { localId: listId }, content: items }, next: i };
}

/** Detect indent level (number of leading spaces) of a line. */
function indentLevel(line: string): number {
  const m = /^( *)/.exec(line);
  return m?.[1]?.length ?? 0;
}

/** Check if a line (after stripping indent) is a bullet or ordered list item. */
function detectListItem(line: string): { listType: "bulletList" | "orderedList"; text: string } | null {
  const stripped = line.trimStart();
  const bullet = /^[-*]\s(.*)/.exec(stripped);
  if (bullet) return { listType: "bulletList", text: bullet[1] ?? "" };
  const ordered = /^\d+\.\s(.*)/.exec(stripped);
  if (ordered) return { listType: "orderedList", text: ordered[1] ?? "" };
  return null;
}

/** Recursively collect list items at the given indent level, nesting deeper items. */
function parseList(lines: string[], i: number, baseIndent: number): { node: AdfNode; next: number } {
  const firstItem = detectListItem(lines[i] ?? "");
  const listType = firstItem?.listType ?? "bulletList";
  const items: AdfNode[] = [];

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const indent = indentLevel(line);

    // Stop if we've dedented past our level or hit a non-list / blank line at our level
    if (indent < baseIndent) break;
    if (indent === baseIndent) {
      const item = detectListItem(line);
      if (!item) break;

      const itemContent: AdfNode[] = [paragraph(item.text)];

      // Check if next line is indented deeper — that's a nested list
      i++;
      if (i < lines.length && detectListItem(lines[i] ?? "") && indentLevel(lines[i] ?? "") > baseIndent) {
        const nested = parseList(lines, i, indentLevel(lines[i] ?? ""));
        itemContent.push(nested.node);
        i = nested.next;
      }

      items.push({ type: "listItem", content: itemContent });
      continue;
    }

    // Line is indented deeper than base but we're not inside an item — skip
    i++;
  }

  return { node: { type: listType, content: items }, next: i };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Convert markdown-ish text to an ADF document node. */
export function markdownToAdf(md: string): AdfNode {
  // Normalise literal \n sequences (common from AI clients double-escaping newlines)
  const normalised = md.replace(/\\n/g, "\n");
  const lines = normalised.split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Headings
    const heading = parseHeading(line);
    if (heading) {
      content.push(heading);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      content.push({ type: "rule" });
      i++;
      continue;
    }

    // Code block
    if (line.startsWith("```")) {
      const result = parseCodeBlock(lines, i);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Task list (must check before bullet list since `- [ ]` also matches `[-*]\s`)
    if (taskItemRe.test(line)) {
      const result = parseTaskList(lines, i);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Bullet or ordered list
    if (detectListItem(line)) {
      const result = parseList(lines, i, 0);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Empty line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph
    content.push(paragraph(line));
    i++;
  }

  return { type: "doc", version: 1, content };
}

/**
 * Convert Jira ADF (Atlassian Document Format) JSON to plain text.
 * Recursively extracts all text nodes, inserting newlines between
 * block-level elements and markdown prefixes for headings/lists/code.
 */
export function adfToText(adf: unknown): string {
  if (adf == null || typeof adf !== "object") return "";
  const node = adf as Record<string, unknown>;

  if (node.type === "text") return (node.text as string) ?? "";

  const children = Array.isArray(node.content) ? node.content : [];
  const isBlock = [
    "doc",
    "paragraph",
    "heading",
    "listItem",
    "bulletList",
    "orderedList",
    "tableRow",
    "tableCell",
    "tableHeader",
    "codeBlock",
    "blockquote",
    "mediaSingle",
    "rule",
  ].includes(node.type as string);

  const childTexts = children.map((c: unknown) => adfToText(c));
  let joined = childTexts.join("");

  // Add prefix/wrapping for specific block types
  if (node.type === "heading") {
    const level = (node.attrs as Record<string, unknown>)?.level ?? 1;
    const prefix = "#".repeat(level as number);
    joined = `${prefix} ${joined}`;
  } else if (node.type === "listItem") {
    joined = `- ${joined}`;
  } else if (node.type === "codeBlock") {
    joined = `\`\`\`\n${joined}\n\`\`\``;
  }

  if (isBlock && joined.length > 0) {
    joined = `${joined}\n`;
  }

  return joined;
}
