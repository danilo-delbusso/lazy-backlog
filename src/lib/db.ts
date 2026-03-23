import fs from "node:fs";
import path from "node:path";
import type { PageType } from "../config/schema.js";
import {
  clearInsights as clearInsightsHelper,
  clearTeamRules as clearTeamRulesHelper,
  getAllInsights as getAllInsightsHelper,
  getInsights as getInsightsHelper,
  getLatestAnalysis as getLatestAnalysisHelper,
  getTeamRules as getTeamRulesHelper,
  type InsightRow,
  recordAnalysis as recordAnalysisHelper,
  upsertInsight as upsertInsightHelper,
  upsertInsightsBatch,
  upsertTeamRule as upsertTeamRuleHelper,
  upsertTeamRulesBatch,
} from "./db-insights.js";
import {
  configurePragmas,
  initSchema,
  migrateSchema,
  type PreparedStatements,
  prepareStatements,
} from "./db-schema.js";
import { prepareSearchVariants, type SearchStatements, searchChunks, searchPages } from "./db-search.js";
import type {
  BacklogAnalysisRecord,
  CachedChangelogEntry,
  CachedSprint,
  ChunkSearchResult,
  IndexedPage,
  PageSummary,
  SearchFilter,
  SearchResult,
  StoredTeamRule,
} from "./db-types.js";
import { Database, type SqliteDatabase } from "./sqlite.js";

export * from "./db-insights.js";
export * from "./db-search.js";
export * from "./db-types.js";
export { groupBy } from "./utils.js";

/** Size threshold (100 MB) above which optimize() will also VACUUM. */
const VACUUM_THRESHOLD_BYTES = 100 * 1024 * 1024;

interface CountRow {
  count: number;
}
interface ConfigRow {
  value: string;
}
interface StatsRow {
  group_type: string;
  key: string;
  count: number;
}
interface UpdatedAtRow {
  id: string;
  updated_at: string | null;
}

export class KnowledgeBase {
  private readonly db: SqliteDatabase;
  private readonly dbPath: string;
  private readonly stmts: PreparedStatements;
  private readonly searchStmts: SearchStatements;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    configurePragmas(this.db);
    initSchema(this.db);
    migrateSchema(this.db);
    this.stmts = prepareStatements(this.db);
    this.searchStmts = prepareSearchVariants(this.db);
  }

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
      page.source,
    );
  }

  upsertMany(pages: IndexedPage[]): void {
    this.db.transaction(() => {
      for (const page of pages) {
        this.upsertPage(page);
      }
    })();
  }

  needsReindex(pageId: string, remoteUpdatedAt: string | undefined): boolean {
    const row = this.stmts.getUpdatedAt.get(pageId) as UpdatedAtRow | undefined;
    if (!row) return true; // Not indexed yet
    if (!remoteUpdatedAt) return true; // Can't compare, re-index to be safe
    return row.updated_at !== remoteUpdatedAt;
  }

  search(query: string, options?: SearchFilter): SearchResult[] {
    return searchPages(query, options ?? {}, this.searchStmts);
  }

  getPage(id: string): IndexedPage | undefined {
    return this.stmts.getById.get(id) as IndexedPage | undefined;
  }

  getPagesByType(pageType: PageType, spaceKey?: string): IndexedPage[] {
    if (spaceKey) {
      return this.stmts.getByTypeAndSpace.all(pageType, spaceKey) as IndexedPage[];
    }
    return this.stmts.getByType.all(pageType) as IndexedPage[];
  }

  getPageSummaries(pageType: PageType, spaceKey?: string, source?: string): PageSummary[] {
    if (source) {
      return this.stmts.summariesBySource.all(source, pageType) as PageSummary[];
    }
    if (spaceKey) {
      return this.stmts.summariesByTypeAndSpace.all(pageType, spaceKey) as PageSummary[];
    }
    return this.stmts.summariesByType.all(pageType) as PageSummary[];
  }

  getStats(): {
    total: number;
    byType: Record<string, number>;
    bySpace: Record<string, number>;
    bySource: Record<string, number>;
  } {
    const rows = this.stmts.stats.all() as StatsRow[];
    let total = 0;
    const byType: Record<string, number> = {};
    const bySpace: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const row of rows) {
      if (row.group_type === "total") total = row.count;
      else if (row.group_type === "type") byType[row.key] = row.count;
      else if (row.group_type === "space") bySpace[row.key] = row.count;
      else if (row.group_type === "source") bySource[row.key] = row.count;
    }

    return { total, byType, bySpace, bySource };
  }

  getConfig(key: string): string | undefined {
    const row = this.stmts.getConfig.get(key) as ConfigRow | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.stmts.setConfig.run(key, value);
  }

  clearSpace(spaceKey: string): number {
    const count = (this.stmts.countBySpaceKey.get(spaceKey) as CountRow).count;
    this.stmts.deleteBySpace.run(spaceKey);
    return count;
  }

  clearSource(source: string): number {
    const count = (this.stmts.countBySource.get(source) as CountRow).count;
    this.stmts.deleteBySource.run(source);
    return count;
  }

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

  searchChunks(query: string, options?: SearchFilter): ChunkSearchResult[] {
    return searchChunks(query, options ?? {}, this.searchStmts);
  }

  upsertSprint(sprint: CachedSprint): void {
    this.stmts.upsertSprint.run(
      sprint.id,
      sprint.board_id,
      sprint.name,
      sprint.state,
      sprint.goal,
      sprint.start_date,
      sprint.end_date,
      sprint.complete_date,
      sprint.cached_at,
    );
  }

  upsertSprints(sprints: CachedSprint[]): void {
    this.db.transaction(() => {
      for (const sprint of sprints) {
        this.upsertSprint(sprint);
      }
    })();
  }

  getSprint(id: string): CachedSprint | undefined {
    return this.stmts.getSprintById.get(id) as CachedSprint | undefined;
  }

  getSprintsByBoard(boardId: string, state?: string): CachedSprint[] {
    if (state) {
      return this.stmts.getSprintsByBoardAndState.all(boardId, state) as CachedSprint[];
    }
    return this.stmts.getSprintsByBoard.all(boardId) as CachedSprint[];
  }

  upsertChangelog(entries: CachedChangelogEntry[]): void {
    this.db.transaction(() => {
      for (const entry of entries) {
        this.stmts.insertChangelog.run(
          entry.id,
          entry.issue_key,
          entry.author_name,
          entry.author_id,
          entry.created,
          entry.field,
          entry.from_value,
          entry.to_value,
          entry.cached_at,
        );
      }
    })();
  }

  getChangelog(issueKey: string): CachedChangelogEntry[] {
    return this.stmts.getChangelogByIssue.all(issueKey) as CachedChangelogEntry[];
  }

  getChangelogByField(issueKey: string, field: string): CachedChangelogEntry[] {
    return this.stmts.getChangelogByIssueAndField.all(issueKey, field) as CachedChangelogEntry[];
  }

  clearChangelogForIssue(issueKey: string): void {
    this.stmts.deleteChangelogByIssue.run(issueKey);
  }

  getStalePages(cutoffDate: string, opts?: { spaceKey?: string; pageType?: string; source?: string }): IndexedPage[] {
    if (opts?.pageType && opts?.spaceKey) {
      return this.stmts.getStalePagesAll.all(cutoffDate, opts.pageType, opts.spaceKey) as IndexedPage[];
    }
    if (opts?.pageType) {
      return this.stmts.getStalePagesTyped.all(cutoffDate, opts.pageType) as IndexedPage[];
    }
    if (opts?.spaceKey) {
      return this.stmts.getStalePagesFiltered.all(cutoffDate, opts.spaceKey) as IndexedPage[];
    }
    return this.stmts.getStalePages.all(cutoffDate) as IndexedPage[];
  }

  getRecentlyIndexed(since: string, source?: string): IndexedPage[] {
    if (source) {
      return this.stmts.getRecentlyIndexedBySource.all(since, source) as IndexedPage[];
    }
    return this.stmts.getRecentlyIndexed.all(since) as IndexedPage[];
  }

  upsertTeamRule(rule: {
    category: string;
    rule_key: string;
    issue_type: string | null;
    rule_value: string;
    confidence: number;
    sample_size: number;
  }): void {
    upsertTeamRuleHelper(this.stmts, rule);
  }

  upsertTeamRules(
    rules: Array<{
      category: string;
      rule_key: string;
      issue_type: string | null;
      rule_value: string;
      confidence: number;
      sample_size: number;
    }>,
  ): void {
    upsertTeamRulesBatch(this.db, this.stmts, rules);
  }

  getTeamRules(category?: string, issueType?: string): StoredTeamRule[] {
    return getTeamRulesHelper(this.stmts, category, issueType);
  }

  clearTeamRules(): void {
    clearTeamRulesHelper(this.stmts);
  }

  getLatestAnalysis(): BacklogAnalysisRecord | null {
    return getLatestAnalysisHelper(this.stmts);
  }

  recordAnalysis(record: Omit<BacklogAnalysisRecord, "id">): void {
    recordAnalysisHelper(this.stmts, record);
  }

  upsertInsight(category: string, key: string, data: unknown, sampleSize: number, confidence: number): void {
    upsertInsightHelper(this.stmts, category, key, data, sampleSize, confidence);
  }

  upsertInsights(
    insights: Array<{ category: string; key: string; data: unknown; sampleSize: number; confidence: number }>,
  ): void {
    upsertInsightsBatch(this.db, this.stmts, insights);
  }

  getInsights(category: string): InsightRow[] {
    return getInsightsHelper(this.stmts, category);
  }

  getAllInsights(): InsightRow[] {
    return getAllInsightsHelper(this.stmts);
  }

  clearInsights(category?: string): void {
    clearInsightsHelper(this.stmts, category);
  }

  rebuildFts(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM pages_fts");
      this.db.exec(`
        INSERT INTO pages_fts(rowid, title, content, labels)
        SELECT rowid, title, content, labels FROM pages
      `);
      this.db.exec("DELETE FROM chunks_fts");
      this.db.exec(`
        INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
        SELECT id, heading, breadcrumb, content FROM chunks
      `);
    })();
  }

  getDbSizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  optimize(): void {
    this.db.exec("PRAGMA optimize");
    if (this.getDbSizeBytes() > VACUUM_THRESHOLD_BYTES) {
      this.db.exec("VACUUM");
    }
  }

  close(): void {
    this.optimize();
    this.db.close();
  }
}
