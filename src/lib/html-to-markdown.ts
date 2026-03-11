// ── Semaphore for bounded concurrency ──────────────────────────────────────

export class Semaphore {
  private readonly queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

// ── Pre-compiled regex for HTML→Markdown (avoids re-compilation per call) ──

const RE_MACRO = /<ac:structured-macro[^>]*>[\s\S]*?<\/ac:structured-macro>/gi;
const RE_STYLE = /<style[^>]*>[\s\S]*?<\/style>/gi;
const RE_SCRIPT = /<script[^>]*>[\s\S]*?<\/script>/gi;
const RE_HEADING = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
const RE_BOLD = /<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi;
const RE_ITALIC = /<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi;
const RE_CODE = /<code>([\s\S]*?)<\/code>/gi;
const RE_PRE = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
const RE_BR = /<br\s*\/?>/gi;
const RE_P_CLOSE = /<\/p>/gi;
const RE_LI_OPEN = /<li[^>]*>/gi;
const RE_LI_CLOSE = /<\/li>/gi;
const RE_TABLE_ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const RE_TABLE_HEADER = /<th[^>]*>([\s\S]*?)<\/th>/g;
const RE_TABLE_CELL = /<td[^>]*>([\s\S]*?)<\/td>/g;
const RE_LINK = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const RE_ALL_TAGS = /<[^>]+>/g;
const RE_MULTI_NEWLINE = /\n{3,}/g;

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&#x2F;": "/",
  "&#x27;": "'",
};
const RE_ENTITY = /&(?:amp|lt|gt|quot|nbsp|#39|#x2F|#x27);/g;

// ── HTML→Markdown helper functions (extracted to reduce cognitive complexity) ─

function stripTags(text: string): string {
  return text.replaceAll(RE_ALL_TAGS, "");
}

function removeNoise(md: string): string {
  return md.replaceAll(RE_MACRO, "").replaceAll(RE_STYLE, "").replaceAll(RE_SCRIPT, "");
}

function convertCodeBlocks(md: string): string {
  md = md.replaceAll(RE_PRE, (_, content: string) => `\n\`\`\`\n${content}\n\`\`\`\n`);
  md = md.replaceAll(RE_CODE, "`$1`");
  return md;
}

function convertHeadings(md: string): string {
  return md.replaceAll(RE_HEADING, (_, level: string, content: string) => {
    const prefix = "#".repeat(Number.parseInt(level, 10));
    return `\n${prefix} ${stripTags(content).trim()}\n`;
  });
}

function convertTableRow(_match: string, rowContent: string): string {
  const headers: string[] = [];
  const cells: string[] = [];
  rowContent.replaceAll(RE_TABLE_HEADER, (__, cellContent: string) => {
    headers.push(stripTags(cellContent).trim());
    return "";
  });
  rowContent.replaceAll(RE_TABLE_CELL, (__, cellContent: string) => {
    cells.push(stripTags(cellContent).trim());
    return "";
  });

  if (headers.length > 0) {
    return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
  }
  if (cells.length > 0) {
    return `| ${cells.join(" | ")} |`;
  }
  return "";
}

function convertLinks(md: string): string {
  return md.replaceAll(RE_LINK, (_, href: string, text: string) => {
    const clean = stripTags(text).trim();
    return clean === href ? clean : `[${clean}](${href})`;
  });
}

function convertInlineFormatting(md: string): string {
  md = md.replaceAll(RE_BOLD, "**$1**");
  md = md.replaceAll(RE_ITALIC, "*$1*");
  return md;
}

function convertBlockElements(md: string): string {
  md = md.replaceAll(RE_BR, "\n");
  md = md.replaceAll(RE_P_CLOSE, "\n\n");
  md = md.replaceAll(RE_LI_OPEN, "- ");
  md = md.replaceAll(RE_LI_CLOSE, "\n");
  return md;
}

function decodeEntities(md: string): string {
  return md.replaceAll(RE_ENTITY, (match) => ENTITY_MAP[match] || match);
}

// ── HTML→Markdown converter (preserves structure, maximises context density) ─

export function htmlToMarkdown(html: string): string {
  let md = removeNoise(html);
  md = convertCodeBlocks(md);
  md = convertHeadings(md);
  md = md.replaceAll(RE_TABLE_ROW, convertTableRow);
  md = convertLinks(md);
  md = convertInlineFormatting(md);
  md = convertBlockElements(md);
  md = stripTags(md);
  md = decodeEntities(md);
  md = md.replaceAll(RE_MULTI_NEWLINE, "\n\n");
  return md.trim();
}
