# Lazy Backlog - AI-Powered Jira Ticket Generation

## Project Overview
MCP server that indexes project context from multiple sources (Confluence, future: GitHub, Google Docs, SharePoint) into a source-agnostic SQLite FTS5 knowledge base, and uses that context to generate rich Jira tickets with duplicate detection, team convention enforcement, and structured preview cards.

## Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** @modelcontextprotocol/sdk (MCP server)
- **Database:** SQLite via `better-sqlite3` with FTS5
- **API:** Atlassian REST API v2/v3 (Confluence + Jira)
- **Language:** TypeScript (strict mode)
- **Linting:** Biome
- **Package manager:** npm (not bun)

## Commands
- `npm start` — start the MCP server
- `npm run typecheck` — type check
- `npm run lint` — lint with Biome
- `npm run lint:fix` — auto-fix lint issues
- `npm test` — run tests
- `npm run check` — typecheck + lint + test
- `npm run build` — compile TypeScript to `dist/` for npm publishing

## Architecture

All source files are ≤400 lines. Barrel re-exports in parent files preserve import paths.

```
src/
  index.ts                — MCP server entry point (8 tools), graceful shutdown
  tools/
    configure.ts          — Configuration (setup, set, get — setup runs full onboarding)
    knowledge.ts          — Source-agnostic KB (search, stats, get-page) — stats includes context summary, freshness, stale docs
    confluence.ts         — Confluence source connector (spider, list-spaces)
    insights.ts           — Team intelligence + analytics (team-profile, epic-progress, retro, plan)
      insights-plan.ts    — Sprint planning assistant with capacity analysis and backlog bin-packing
    preview-builder.ts    — Structured preview cards (buildPreviewCard, buildBulkPreviewCard)
    suggestions.ts        — Output-driven discovery: contextual next-step suggestions for all tools
    issues.ts             — Jira issues (get, create, update, search) — create handles single/bulk/decompose
      issues-helpers.ts   — Shared helpers, formatting, retrieveKbContext, checkEnrichmentGaps
      issues-get.ts       — get + search action handlers
      issues-create.ts    — create + decompose with previews, duplicates, conventions
      issues-bulk.ts      — bulk-create with previews, duplicates, conventions
    bugs.ts               — Bug triage pipeline (triage) — completeness + severity + sprint recommendation
      bugs-helpers.ts     — Triage intelligence: assess, infer severity, conventions, rework warnings
    backlog.ts            — Backlog management (list, rank) — list includes health flags + duplicate detection
    sprints.ts            — Sprint management (list, get, create, update, move-issues)
      sprints-get.ts      — Context-adaptive get: active=dashboard, since=standup, closed=release notes
      sprints-utils.ts    — Formatting helpers, data fetching, standup/release-notes formatting
      sprints-analytics.ts — Health computation, velocity handlers
      sprints-retro.ts    — Retro handler with velocity trends, carryover, estimation accuracy, workload
      sprints-mutations.ts — create, update, move-issues handlers
  lib/
    utils.ts              — Shared helpers (groupBy)
    http-utils.ts         — Shared fetchWithRetry, retry constants, exponential backoff
    sqlite.ts             — better-sqlite3 re-export + type aliases
    config.ts             — Config resolution (env vars + SQLite)
    adf.ts                — Atlassian Document Format conversion (markdownToAdf, adfToText)
    jira-types.ts         — All Jira interfaces and types
    jira-auth.ts          — Auth headers, URL validation, SSRF protection
    jira-schema.ts        — Schema discovery, board/status resolution
    jira-agile.ts         — Sprint, backlog, changelog, dev-status (standalone functions)
    jira.ts               — JiraClient class (HTTP, issue CRUD, search) + barrel re-exports
    db-types.ts           — DB interfaces with source field (PageRecord, ChunkRecord, SearchResult)
    db-schema.ts          — Schema init, migration (source column), pragmas, prepared statements
    db-search.ts          — FTS5 search, key-based filter dispatch (16 variants), sanitization
    db.ts                 — KnowledgeBase class (source-aware CRUD, config, stats) + barrel re-exports
    html-to-markdown.ts   — HTML→Markdown conversion, Semaphore class
    confluence.ts         — ConfluenceClient class + barrel re-exports
    indexer.ts            — Spider (bounded concurrency, incremental, source='confluence') + classifier
    chunker.ts            — Markdown-aware section chunking (remark AST)
    analytics.ts          — Pure computation: velocity, cycle time, capacity, sprint health
    duplicate-detect.ts   — Jaccard similarity, findDuplicates(), tokenize()
    team-rules-types.ts   — Team rule interfaces (TicketData, ChangelogItem, TeamRule, etc.)
    team-rules-utils.ts   — Math helpers, scoring, DEFAULT_RULES, mergeWithDefaults
    team-rules-quality.ts — Quality scoring, description analysis
    team-rules-extract.ts — Pattern extraction (labels, components, workflow, sprints)
    team-rules-format.ts  — evaluateConventions(), formatConventionsSection()
    team-rules.ts         — formatTeamStyleGuide + barrel re-exports
    team-insights-types.ts  — Insight interfaces (Estimation, Ownership, Template, Pattern)
    team-insights-estimation.ts — Cycle time, points-to-days ratio, estimation accuracy
    team-insights-ownership.ts  — Component → assignee mapping with percentages
    team-insights-templates.ts  — Description heading patterns, AC format detection, scaffolds
    team-insights-patterns.ts   — Priority distribution, label co-occurrence, rework rates
    team-insights-suggest.ts    — generateSmartDefaults(), generateDescriptionScaffold()
    team-insights.ts            — analyzeTeamInsights() orchestrator + barrel re-exports
  config/
    schema.ts             — Zod schemas for config and options
```

## CI
GitHub Actions workflow (`.github/workflows/ci.yml`) runs on push/PR to `main`:
typecheck → lint → test → build → SonarQube scan

## Publishing
- `npm run build` compiles to `dist/` via `tsconfig.build.json`
- `prepublishOnly` hook runs the build automatically
- Published to npm as `lazy-backlog`
- Users install via: `npx -y lazy-backlog`

## Conventions
- Do NOT use Bun-specific APIs in source code — use the sqlite adapter and standard Node APIs
- All MCP tools use `server.registerTool()` (not the deprecated `server.tool()`)
- All MCP tools use Zod for parameter validation
- Page types: adr, design, runbook, meeting, spec, other
- Config stored in SQLite `config` table, not filesystem
- Data stored in `.lazy-backlog/knowledge.db`
- Team field uses plain UUID string per Atlassian Teams REST API
