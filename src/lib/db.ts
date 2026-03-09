import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import type { PageType } from "../config/schema.js";

// ── Domain types ───────────────────────────────────────────────────────────

export interface IndexedPage {
  id: string;
  space_key: string;
  title: string;
  url: string | null;
  content: string;
  page_type: PageType;
  labels: string; // JSON array
  parent_id: string | null;
  author_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  indexed_at: string;
}

/** Lightweight projection — no content body. */
export interface PageSummary {
  id: string;
  space_key: string;
  title: string;
  url: string | null;
  page_type: PageType;
  labels: string;
  updated_at: string | null;
  content_preview: string;
}

export interface SearchResult {
  id: string;
  space_key: string;
  title: string;
  url: string | null;
  snippet: string;
  page_type: PageType;
  labels: string;
  rank: number;
}

export interface ChunkSearchResult {
  chunk_id: number;
  page_id: string;
  breadcrumb: string;
  heading: string;
  depth: number;
  space_key: string;
  page_title: string;
  url: string | null;
  page_type: PageType;
  labels: string;
  snippet: string;
  rank: number;
}

interface CountRow {
  count: number;
}

interface ConfigRow {
  value: string;
}

/** Filter options shared by page and chunk search. */
export interface SearchFilter {
  pageType?: string;
  spaceKey?: string;
  limit?: number;
}

/** Pick the correct pre-prepared statement variant and bind params. */
function runFilteredQuery<T>(
  stmts: { none: any; type: any; space: any; both: any },
  query: string,
  filter: SearchFilter,
  defaultLimit: number,
): T[] {
  const limit = filter.limit || defaultLimit;
  if (filter.pageType && filter.spaceKey) {
    return stmts.both.all(query, filter.pageType, filter.spaceKey, limit) as T[];
  }
  if (filter.pageType) {
    return stmts.type.all(query, filter.pageType, limit) as T[];
  }
  if (filter.spaceKey) {
    return stmts.space.all(query, filter.spaceKey, limit) as T[];
  }
  return stmts.none.all(query, limit) as T[];
}

/** Execute an FTS5 query with automatic fallback to phrase escaping on syntax errors. */
function ftsQuery<T>(
  query: string,
  filter: SearchFilter,
  defaultLimit: number,
  stmts: { none: any; type: any; space: any; both: any },
): T[] {
  try {
    return runFilteredQuery<T>(stmts, query, filter, defaultLimit);
  } catch (err) {
    if (err instanceof Error && err.message.includes("fts5")) {
      return runFilteredQuery<T>(stmts, `"${query.replace(/"/g, '""')}"`, filter, defaultLimit);
    }
    throw err;
  }
}

// ── Knowledge base ─────────────────────────────────────────────────────────

export class KnowledgeBase {
  private db: Database;
  private stmts!: ReturnType<typeof this.prepareStatements>;
  // Pre-prepared search variants (avoids dynamic SQL)
  private searchStmts!: ReturnType<typeof this.prepareSearchVariants>;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || path.join(process.cwd(), ".lazy-backlog", "knowledge.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.configurePragmas();
    this.initSchema();
    this.stmts = this.prepareStatements();
    this.searchStmts = this.prepareSearchVariants();
  }

  private configurePragmas() {
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL"); // Safe with WAL, 2x faster than FULL
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA cache_size = -64000"); // 64MB cache for bulk indexing
    this.db.run("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O
    this.db.run("PRAGMA temp_store = MEMORY");
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        space_key TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        content TEXT NOT NULL,
        page_type TEXT NOT NULL DEFAULT 'other',
        labels TEXT NOT NULL DEFAULT '[]',
        parent_id TEXT,
        author_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        indexed_at TEXT NOT NULL
      ) STRICT
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_key)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(page_type)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pages_space_type ON pages(space_key, page_type)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at)");

    // ── Chunks table: section-level content with heading breadcrumbs ──
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        breadcrumb TEXT NOT NULL DEFAULT '',
        heading TEXT NOT NULL DEFAULT '',
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0
      ) STRICT
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);

    // ── FTS5 on pages (kept for backward compat) ──
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        title,
        content,
        labels,
        content='pages',
        content_rowid='rowid'
      )
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
        INSERT INTO pages_fts(rowid, title, content, labels)
        VALUES (new.rowid, new.title, new.content, new.labels);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, title, content, labels)
        VALUES ('delete', old.rowid, old.title, old.content, old.labels);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, title, content, labels)
        VALUES ('delete', old.rowid, old.title, old.content, old.labels);
        INSERT INTO pages_fts(rowid, title, content, labels)
        VALUES (new.rowid, new.title, new.content, new.labels);
      END
    `);

    // ── FTS5 on chunks (primary search target) ──
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        heading,
        breadcrumb,
        content,
        content='chunks',
        content_rowid='id'
      )
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
        VALUES (new.id, new.heading, new.breadcrumb, new.content);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, heading, breadcrumb, content)
        VALUES ('delete', old.id, old.heading, old.breadcrumb, old.content);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, heading, breadcrumb, content)
        VALUES ('delete', old.id, old.heading, old.breadcrumb, old.content);
        INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
        VALUES (new.id, new.heading, new.breadcrumb, new.content);
      END
    `);
  }

  private prepareStatements() {
    return {
      upsert: this.db.prepare(
        `INSERT INTO pages (id, space_key, title, url, content, page_type, labels, parent_id, author_id, created_at, updated_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           space_key=excluded.space_key, title=excluded.title, url=excluded.url,
           content=excluded.content, page_type=excluded.page_type, labels=excluded.labels,
           parent_id=excluded.parent_id, author_id=excluded.author_id,
           created_at=excluded.created_at, updated_at=excluded.updated_at,
           indexed_at=excluded.indexed_at`,
      ),
      getById: this.db.prepare("SELECT * FROM pages WHERE id = ?"),
      getByType: this.db.prepare("SELECT * FROM pages WHERE page_type = ? ORDER BY title"),
      getByTypeAndSpace: this.db.prepare("SELECT * FROM pages WHERE page_type = ? AND space_key = ? ORDER BY title"),
      // Lightweight queries — no content body, just preview
      summariesByType: this.db.prepare(
        `SELECT id, space_key, title, url, page_type, labels, updated_at,
         substr(content, 1, 300) as content_preview
         FROM pages WHERE page_type = ? ORDER BY title`,
      ),
      summariesByTypeAndSpace: this.db.prepare(
        `SELECT id, space_key, title, url, page_type, labels, updated_at,
         substr(content, 1, 300) as content_preview
         FROM pages WHERE page_type = ? AND space_key = ? ORDER BY title`,
      ),
      // Stats in a single query
      stats: this.db.prepare(`
        SELECT
          'total' as group_type, 'all' as key, COUNT(*) as count FROM pages
        UNION ALL
        SELECT 'type', page_type, COUNT(*) FROM pages GROUP BY page_type
        UNION ALL
        SELECT 'space', space_key, COUNT(*) FROM pages GROUP BY space_key
        UNION ALL
        SELECT 'chunks', 'all', COUNT(*) FROM chunks
      `),
      getConfig: this.db.prepare("SELECT value FROM config WHERE key = ?"),
      setConfig: this.db.prepare(
        "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),
      deleteBySpace: this.db.prepare("DELETE FROM pages WHERE space_key = ?"),
      countBySpaceKey: this.db.prepare("SELECT COUNT(*) as count FROM pages WHERE space_key = ?"),
      getUpdatedAt: this.db.prepare("SELECT id, updated_at FROM pages WHERE id = ?"),
      // Chunk statements
      insertChunk: this.db.prepare(
        `INSERT INTO chunks (page_id, breadcrumb, heading, depth, content, chunk_index)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      deleteChunksByPage: this.db.prepare("DELETE FROM chunks WHERE page_id = ?"),
      getChunksByPage: this.db.prepare("SELECT * FROM chunks WHERE page_id = ? ORDER BY chunk_index"),
    };
  }

  /** Pre-prepare all 4 search filter combinations to avoid dynamic SQL. */
  private prepareSearchVariants() {
    // Page-level search (legacy, still useful for title/label matching)
    const pageBase = (filters: string) => `
      SELECT p.id, p.space_key, p.title, p.url, p.page_type, p.labels,
        snippet(pages_fts, 1, '**', '**', '…', 48) AS snippet, rank
      FROM pages_fts
      JOIN pages p ON p.rowid = pages_fts.rowid
      WHERE pages_fts MATCH ?${filters}
      ORDER BY rank LIMIT ?
    `;

    // Chunk-level search (primary — returns focused sections with breadcrumbs)
    const chunkBase = (filters: string) => `
      SELECT c.id as chunk_id, c.page_id, c.breadcrumb, c.heading, c.depth,
        p.space_key, p.title as page_title, p.url, p.page_type, p.labels,
        snippet(chunks_fts, 2, '**', '**', '…', 48) AS snippet, rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN pages p ON p.id = c.page_id
      WHERE chunks_fts MATCH ?${filters}
      ORDER BY rank LIMIT ?
    `;

    return {
      none: this.db.prepare(pageBase("")),
      type: this.db.prepare(pageBase(" AND p.page_type = ?")),
      space: this.db.prepare(pageBase(" AND p.space_key = ?")),
      both: this.db.prepare(pageBase(" AND p.page_type = ? AND p.space_key = ?")),
      // Chunk variants
      chunkNone: this.db.prepare(chunkBase("")),
      chunkType: this.db.prepare(chunkBase(" AND p.page_type = ?")),
      chunkSpace: this.db.prepare(chunkBase(" AND p.space_key = ?")),
      chunkBoth: this.db.prepare(chunkBase(" AND p.page_type = ? AND p.space_key = ?")),
    };
  }

  /** Insert or update a single page in the knowledge base. */
  upsertPage(page: IndexedPage): void {
    this.stmts.upsert.run(
      page.id,
      page.space_key,
      page.title,
      page.url,
      page.content,
      page.page_type,
      page.labels,
      page.parent_id,
      page.author_id,
      page.created_at,
      page.updated_at,
      page.indexed_at,
    );
  }

  /** Batch upsert pages in a single transaction for performance. */
  upsertMany(pages: IndexedPage[]): void {
    this.db.transaction(() => {
      for (const page of pages) {
        this.upsertPage(page);
      }
    })();
  }

  /** Check if a page needs re-indexing based on updated_at timestamp. */
  needsReindex(pageId: string, remoteUpdatedAt: string | undefined): boolean {
    const row = this.stmts.getUpdatedAt.get(pageId) as { updated_at: string | null } | undefined;
    if (!row) return true; // Not indexed yet
    if (!remoteUpdatedAt) return true; // Can't compare, re-index to be safe
    return row.updated_at !== remoteUpdatedAt;
  }

  /** Full-text search across indexed pages. Falls back to phrase escaping on FTS5 syntax errors. */
  search(query: string, options?: SearchFilter): SearchResult[] {
    const { none, type, space, both } = this.searchStmts;
    return ftsQuery<SearchResult>(query, options ?? {}, 10, { none, type, space, both });
  }

  /** Retrieve a single page by Confluence page ID. */
  getPage(id: string): IndexedPage | undefined {
    return this.stmts.getById.get(id) as IndexedPage | undefined;
  }

  /** Get all pages of a given type, optionally filtered by space. */
  getPagesByType(pageType: PageType, spaceKey?: string): IndexedPage[] {
    if (spaceKey) {
      return this.stmts.getByTypeAndSpace.all(pageType, spaceKey) as IndexedPage[];
    }
    return this.stmts.getByType.all(pageType) as IndexedPage[];
  }

  /** Lightweight version — returns title/labels/preview, no full content. */
  getPageSummaries(pageType: PageType, spaceKey?: string): PageSummary[] {
    if (spaceKey) {
      return this.stmts.summariesByTypeAndSpace.all(pageType, spaceKey) as PageSummary[];
    }
    return this.stmts.summariesByType.all(pageType) as PageSummary[];
  }

  /** Get aggregate stats: total pages, breakdown by type and space. */
  getStats(): { total: number; byType: Record<string, number>; bySpace: Record<string, number> } {
    const rows = this.stmts.stats.all() as { group_type: string; key: string; count: number }[];
    let total = 0;
    const byType: Record<string, number> = {};
    const bySpace: Record<string, number> = {};

    for (const row of rows) {
      if (row.group_type === "total") total = row.count;
      else if (row.group_type === "type") byType[row.key] = row.count;
      else bySpace[row.key] = row.count;
    }

    return { total, byType, bySpace };
  }

  /** Read a config value from the key-value store. */
  getConfig(key: string): string | undefined {
    const row = this.stmts.getConfig.get(key) as ConfigRow | undefined;
    return row?.value;
  }

  /** Write a config value to the key-value store. */
  setConfig(key: string, value: string): void {
    this.stmts.setConfig.run(key, value);
  }

  /** Delete all pages in a space. Returns the count of deleted pages. */
  clearSpace(spaceKey: string): number {
    const count = (this.stmts.countBySpaceKey.get(spaceKey) as CountRow).count;
    this.stmts.deleteBySpace.run(spaceKey);
    return count;
  }

  /** Store chunks for a page, replacing any existing chunks. */
  upsertChunks(
    pageId: string,
    chunks: { breadcrumb: string; heading: string; depth: number; content: string; index: number }[],
  ): void {
    this.db.transaction(() => {
      this.stmts.deleteChunksByPage.run(pageId);
      for (const chunk of chunks) {
        this.stmts.insertChunk.run(pageId, chunk.breadcrumb, chunk.heading, chunk.depth, chunk.content, chunk.index);
      }
    })();
  }

  /** Search chunks — returns focused sections with heading breadcrumbs. */
  searchChunks(query: string, options?: SearchFilter): ChunkSearchResult[] {
    const { chunkNone: none, chunkType: type, chunkSpace: space, chunkBoth: both } = this.searchStmts;
    return ftsQuery<ChunkSearchResult>(query, options ?? {}, 5, { none, type, space, both });
  }

  rebuildFts(): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM pages_fts");
      this.db.run(`
        INSERT INTO pages_fts(rowid, title, content, labels)
        SELECT rowid, title, content, labels FROM pages
      `);
      this.db.run("DELETE FROM chunks_fts");
      this.db.run(`
        INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
        SELECT id, heading, breadcrumb, content FROM chunks
      `);
    })();
  }

  /** Optimize and close the database connection. Call on shutdown. */
  close(): void {
    this.db.run("PRAGMA optimize");
    this.db.close();
  }
}
