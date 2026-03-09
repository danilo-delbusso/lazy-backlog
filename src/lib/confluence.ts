import type { ProjectConfig } from "../config/schema.js";

// ── Confluence API response types ──────────────────────────────────────────

interface ApiPage {
  id: string;
  title: string;
  spaceId?: string;
  parentId?: string;
  status: string;
  authorId?: string;
  createdAt?: string;
  version?: { createdAt?: string };
  body?: {
    storage?: { value: string };
  };
  _links?: { webui?: string };
}

interface ApiSpace {
  id: string;
  key: string;
  name: string;
  type: string;
}

interface ApiLabel {
  name: string;
}

interface PaginatedResponse<T> {
  results: T[];
  _links?: { next?: string };
}

interface SearchResult {
  content?: ApiPage & {
    space?: { id: string; key: string };
    metadata?: { labels?: { results: ApiLabel[] } };
  };
}

// ── Domain types ───────────────────────────────────────────────────────────

export interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  spaceKey?: string;
  parentId?: string;
  status: string;
  body?: string;
  labels: string[];
  authorId?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
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

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 10;

// ── Semaphore for bounded concurrency ──────────────────────────────────────

class Semaphore {
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

// ── Client ─────────────────────────────────────────────────────────────────

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly semaphore: Semaphore;

  constructor(config: ProjectConfig) {
    this.baseUrl = config.siteUrl.replace(/\/$/, "");
    const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
    this.headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    };
    this.semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    await this.semaphore.acquire();
    let lastError: Error | undefined;

    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const response = await fetch(url.toString(), {
            headers: this.headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

          if (response.status === 429) {
            const retryAfter = response.headers.get("Retry-After");
            const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : INITIAL_BACKOFF_MS * (1 << attempt);
            await Bun.sleep(waitMs);
            continue;
          }

          if (response.status >= 500) {
            lastError = new Error(`Confluence API ${response.status}`);
            await Bun.sleep(INITIAL_BACKOFF_MS * (1 << attempt));
            continue;
          }

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Confluence API ${response.status}: ${text.slice(0, 200)}`);
          }

          return response.json() as Promise<T>;
        } catch (err) {
          if (err instanceof Error && err.name === "TimeoutError") {
            lastError = new Error(`Confluence API timeout (${REQUEST_TIMEOUT_MS}ms)`);
          } else if (err instanceof Error && err.message.startsWith("Confluence API")) {
            throw err; // 4xx — don't retry
          } else {
            lastError = err instanceof Error ? err : new Error(String(err));
          }
          if (attempt < MAX_RETRIES - 1) {
            await Bun.sleep(INITIAL_BACKOFF_MS * (1 << attempt));
          }
        }
      }
    } finally {
      this.semaphore.release();
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async *paginateIter<T>(path: string, params?: Record<string, string>): AsyncGenerator<T> {
    let currentPath = path;
    let currentParams = params;

    while (true) {
      const response = await this.request<PaginatedResponse<T>>(currentPath, currentParams);
      for (const item of response.results) {
        yield item;
      }
      if (!response._links?.next) break;
      currentPath = response._links.next;
      currentParams = undefined;
    }
  }

  private async paginate<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this.paginateIter<T>(path, params)) {
      results.push(item);
    }
    return results;
  }

  /** List all Confluence spaces accessible to the authenticated user. */
  async getSpaces(): Promise<ConfluenceSpace[]> {
    return this.paginate<ApiSpace>("/wiki/api/v2/spaces", { limit: "50" });
  }

  /** Fetch a single space by its key. */
  async getSpace(spaceKey: string): Promise<ConfluenceSpace | undefined> {
    const resp = await this.request<PaginatedResponse<ApiSpace>>("/wiki/api/v2/spaces", {
      keys: spaceKey,
      limit: "1",
    });
    return resp.results[0];
  }

  /** Lightweight page list — no body content. */
  async listPagesInSpace(spaceId: string): Promise<ConfluencePage[]> {
    const raw = await this.paginate<ApiPage>(`/wiki/api/v2/spaces/${spaceId}/pages`, {
      limit: "50",
    });
    return raw.map((p) => this.mapPage(p));
  }

  /** Fetch a single page with body + labels in parallel. 2 requests, 1 round-trip. */
  async getPageFull(pageId: string): Promise<ConfluencePage> {
    const [raw, labelResult] = await Promise.all([
      this.request<ApiPage>(`/wiki/api/v2/pages/${pageId}`, {
        "body-format": "storage",
      }),
      this.request<PaginatedResponse<ApiLabel>>(`/wiki/api/v2/pages/${pageId}/labels`, { limit: "50" }),
    ]);

    const page = this.mapPage(raw);
    page.labels = labelResult.results.map((l) => l.name);
    return page;
  }

  /** Fetch direct child pages of a given page. */
  async getPageChildren(pageId: string): Promise<ConfluencePage[]> {
    const raw = await this.paginate<ApiPage>(`/wiki/api/v2/pages/${pageId}/children`, {
      limit: "50",
    });
    return raw.map((p) => this.mapPage(p));
  }

  /** Search Confluence via CQL query. Returns pages with body content. */
  async searchCQL(cql: string, limit = 25): Promise<ConfluencePage[]> {
    const result = await this.request<PaginatedResponse<SearchResult>>("/wiki/rest/api/search", {
      cql,
      limit: String(limit),
      expand: "content.body.storage",
    });

    return result.results.map((r) => {
      const c = r.content;
      if (!c) return { id: "0", title: "", spaceId: "", status: "current", labels: [], body: "" };
      return {
        id: String(c.id),
        title: c.title || "",
        spaceId: c.space?.id || "",
        spaceKey: c.space?.key || "",
        body: htmlToMarkdown(c.body?.storage?.value || ""),
        labels: (c.metadata?.labels?.results || []).map((l) => l.name),
        url: c._links?.webui ? `${this.baseUrl}/wiki${c._links.webui}` : undefined,
        status: c.status || "current",
      };
    });
  }

  private mapPage(raw: ApiPage): ConfluencePage {
    return {
      id: String(raw.id),
      title: raw.title || "",
      spaceId: raw.spaceId || "",
      parentId: raw.parentId ? String(raw.parentId) : undefined,
      status: raw.status || "current",
      body: raw.body?.storage?.value ? htmlToMarkdown(raw.body.storage.value) : undefined,
      labels: [],
      authorId: raw.authorId,
      createdAt: raw.createdAt,
      updatedAt: raw.version?.createdAt || raw.createdAt,
      url: raw._links?.webui ? `${this.baseUrl}/wiki${raw._links.webui}` : undefined,
    };
  }
}

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
