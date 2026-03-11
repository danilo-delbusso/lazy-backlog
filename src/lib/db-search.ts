import type { ChunkSearchResult, SearchFilter, SearchResult } from "./db-types.js";
import type { SqliteDatabase, Statement } from "./sqlite.js";

// ── FTS5 sanitization ────────────────────────────────────────────────────────

/** Characters and operators that have special meaning in FTS5 MATCH syntax. */
const FTS5_SPECIAL_CHARS = /[*"()^+-]/g;
const FTS5_OPERATORS = /\b(NEAR|AND|OR|NOT)\b/gi;

/**
 * Sanitize user input for safe use in FTS5 MATCH queries.
 * Strips special characters, removes FTS5 operators, and wraps each
 * remaining word in double quotes for exact token matching.
 * Returns empty string for empty/whitespace-only input.
 */
export function sanitizeFtsQuery(query: string): string {
  const stripped = query.replace(FTS5_SPECIAL_CHARS, " ").replace(FTS5_OPERATORS, " ");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" ");
}

// ── Search helpers ──────────────────────────────────────────────────────────

/** Prepared statement variants for filtered queries. */
export interface FilteredStatements {
  none: Statement;
  type: Statement;
  space: Statement;
  both: Statement;
}

/**
 * Pick the correct pre-prepared statement variant and bind params.
 * Cast to T[] is required because the sqlite adapter's Statement.all()
 * returns `unknown[]` — the caller knows the row shape from the SQL.
 */
export function runFilteredQuery<T>(
  stmts: FilteredStatements,
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

/**
 * Execute an FTS5 query after sanitizing user input.
 * Returns empty array for empty/whitespace-only queries.
 */
export function ftsQuery<T>(query: string, filter: SearchFilter, defaultLimit: number, stmts: FilteredStatements): T[] {
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized === "") return [];
  try {
    return runFilteredQuery<T>(stmts, sanitized, filter, defaultLimit);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("fts5")) {
      // Last-resort fallback: wrap entire sanitized query as a single phrase
      return runFilteredQuery<T>(stmts, `"${sanitized.replaceAll('"', '""')}"`, filter, defaultLimit);
    }
    throw err;
  }
}

// ── Search functions (delegated from KnowledgeBase) ─────────────────────────

/** Page-level search statement keys used by the KnowledgeBase. */
export interface SearchStatements {
  none: Statement;
  type: Statement;
  space: Statement;
  both: Statement;
  chunkNone: Statement;
  chunkType: Statement;
  chunkSpace: Statement;
  chunkBoth: Statement;
}

/** Full-text search across indexed pages. Falls back to phrase escaping on FTS5 syntax errors. */
export function searchPages(query: string, options: SearchFilter, searchStmts: SearchStatements): SearchResult[] {
  const { none, type, space, both } = searchStmts;
  return ftsQuery<SearchResult>(query, options, 10, { none, type, space, both });
}

/** Search chunks — returns focused sections with heading breadcrumbs. */
export function searchChunks(query: string, options: SearchFilter, searchStmts: SearchStatements): ChunkSearchResult[] {
  const { chunkNone: none, chunkType: type, chunkSpace: space, chunkBoth: both } = searchStmts;
  return ftsQuery<ChunkSearchResult>(query, options, 5, { none, type, space, both });
}

// ── Search statement preparation ────────────────────────────────────────────

/** Pre-prepare all 4 search filter combinations to avoid dynamic SQL. */
export function prepareSearchVariants(db: SqliteDatabase): SearchStatements {
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
    none: db.prepare(pageBase("")),
    type: db.prepare(pageBase(" AND p.page_type = ?")),
    space: db.prepare(pageBase(" AND p.space_key = ?")),
    both: db.prepare(pageBase(" AND p.page_type = ? AND p.space_key = ?")),
    chunkNone: db.prepare(chunkBase("")),
    chunkType: db.prepare(chunkBase(" AND p.page_type = ?")),
    chunkSpace: db.prepare(chunkBase(" AND p.space_key = ?")),
    chunkBoth: db.prepare(chunkBase(" AND p.page_type = ? AND p.space_key = ?")),
  };
}
