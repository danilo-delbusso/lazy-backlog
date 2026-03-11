import type { ProjectConfig } from "../config/schema.js";
import { htmlToMarkdown, Semaphore } from "./html-to-markdown.js";
import { fetchWithRetry } from "./http-utils.js";

export * from "./html-to-markdown.js";

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

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 10;

// ── URL helper ────────────────────────────────────────────────────────────

function buildUrl(path: string, baseUrl: string, params?: Record<string, string>): URL {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
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
    const url = buildUrl(path, this.baseUrl, params);

    await this.semaphore.acquire();
    try {
      const res = await fetchWithRetry(url.toString(), {
        headers: this.headers,
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: "Confluence",
      });

      if (!res.ok) {
        throw new Error(`Confluence API error (status ${res.status})`);
      }

      return (await res.json()) as T;
    } finally {
      this.semaphore.release();
    }
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
