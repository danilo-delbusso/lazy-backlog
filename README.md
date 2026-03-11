# Lazy Backlog

**AI-powered Jira management with Confluence context**

[![npm version](https://img.shields.io/npm/v/lazy-backlog.svg)](https://www.npmjs.com/package/lazy-backlog)
[![CI](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Lazy Backlog is an [MCP](https://modelcontextprotocol.io) server that connects your AI assistant to Jira and Confluence. It spiders your Confluence spaces, indexes them locally with SQLite FTS5, and uses that context to generate rich, well-grounded Jira tickets. It also provides sprint management, backlog ranking, velocity tracking, bug triage, and retrospective workflows — all through natural language.

---

## Installation & Setup

Requires [Node.js](https://nodejs.org) 18+ and an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).

### Claude Code

```bash
claude mcp add lazy-backlog \
  -e ATLASSIAN_SITE_URL=https://your-site.atlassian.net \
  -e ATLASSIAN_EMAIL=you@company.com \
  -e ATLASSIAN_API_TOKEN=your-api-token \
  -- npx -y lazy-backlog
```

Then just ask: *"Set up my Jira project"* — the AI will prompt you for your project key, board ID, and Confluence spaces, then run `configure action=setup` to get everything ready.

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "npx",
      "args": ["-y", "lazy-backlog"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token",
        "JIRA_PROJECT_KEY": "BP",
        "JIRA_BOARD_ID": "266",
        "CONFLUENCE_SPACES": "ENG,PRODUCT"
      }
    }
  }
}
```

### Cursor / Windsurf / Other MCP Clients

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "npx",
      "args": ["-y", "lazy-backlog"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token",
        "JIRA_PROJECT_KEY": "BP",
        "JIRA_BOARD_ID": "266",
        "CONFLUENCE_SPACES": "ENG,PRODUCT"
      }
    }
  }
}
```

### From Source

```bash
git clone https://github.com/Ricky-Stevens/lazy-backlog.git
cd lazy-backlog
npm install
npm run build
```

Then point your MCP client at the local build:

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "node",
      "args": ["/path/to/lazy-backlog/dist/index.js"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ATLASSIAN_SITE_URL` | Yes | Your Atlassian site URL (e.g. `https://acme.atlassian.net`) |
| `ATLASSIAN_EMAIL` | Yes | Atlassian account email |
| `ATLASSIAN_API_TOKEN` | Yes | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | No | Default Jira project key (e.g. `BP`) — can also be set via `configure` |
| `JIRA_BOARD_ID` | No | Default Jira board ID — required for sprint ops and board-scoped queries |
| `CONFLUENCE_SPACES` | No | Comma-separated space keys to index (e.g. `ENG,PRODUCT`) |

Settings can also be saved to the local SQLite database via the `configure` tool, which is the recommended approach since setup also discovers your Jira schema and learns team conventions.

---

## Tool Reference

Lazy Backlog exposes **6 tools**, each with multiple actions. The tools cross-reference each other so the AI knows which tool to use for any given request.

### 1. `configure` — Setup & Configuration

One-stop setup for your project. The `setup` action discovers your Jira schema (issue types, fields, priorities), spiders Confluence spaces, and learns team conventions from existing tickets — all in one call.

| Action | Description | Key Params |
|--------|-------------|------------|
| `setup` | **Run this first.** Discovers Jira schema, spiders Confluence, learns team patterns | `projectKey`, `boardId`, `spaceKeys`, `maxDepth`, `maxTickets` |
| `set` | Save individual settings | `jiraProjectKey`, `jiraBoardId`, `confluenceSpaces`, `rootPageIds` |
| `get` | Show current config and setup status | — |

**Example:** *"Set up my Jira project"* → AI asks for project key, board ID, Confluence spaces, then calls `configure action=setup`

---

### 2. `confluence` — Knowledge Base

Spider, search, and manage your Confluence knowledge base. Content is indexed locally with SQLite FTS5 for fast, section-level search.

| Action | Description | Key Params |
|--------|-------------|------------|
| `spider` | Crawl and index Confluence pages | `spaceKey`, `rootPageId`, `maxDepth`, `maxConcurrency`, `includeLabels`, `excludeLabels`, `force` |
| `search` | Full-text search, context summary, stale detection, recent changes, or KB stats | `query`, `pageType`, `spaceKey`, `limit`, `summarize`, `stale`, `staleDays`, `since` |
| `get-page` | Retrieve full page content | `pageId` |
| `list-spaces` | Show available Confluence spaces | — |

Page types: `adr`, `design`, `runbook`, `meeting`, `spec`, `other`

**Example:** *"Search docs for OAuth2"* → `confluence action=search query="OAuth2"`

---

### 3. `issues` — Issue CRUD & Planning

Create, read, update, and search Jira issues. **All creates use a preview-first flow** — the first call returns a preview with Confluence context, schema guidance, and team conventions. Set `confirmed=true` to submit.

| Action | Description | Key Params |
|--------|-------------|------------|
| `get` | Fetch full issue details (description, comments, links, metadata) | `issueKey` |
| `create` | Create a single issue (preview first, then `confirmed=true`) | `summary`, `description`, `issueType`, `priority`, `labels`, `storyPoints`, `parentKey`, `components`, `namedFields`, `confirmed` |
| `bulk-create` | Create multiple issues (preview first, then `confirmed=true`) | `tickets` (array), `confirmed` |
| `update` | Modify fields, transition status, assign, rank, or link issues | `issueKey`, `summary`, `description`, `priority`, `status`, `assignee`, `links`, `rankBefore`, `rankAfter` |
| `search` | Query issues via JQL (auto-scoped to configured board/project) | `jql`, `maxResults` |
| `epic-progress` | Show epic completion stats (done/in-progress/todo breakdown) | `epicKey` |
| `decompose` | Break an epic into suggested child stories using Confluence context | `epicKey`, `spaceKey` |

**Example:** *"Create a task for migrating to OAuth2"* → returns preview → *"Looks good, confirm"* → `confirmed=true`

---

### 4. `bugs` — Bug Discovery & Triage

Find, assess, and triage bugs. Search auto-enforces `type=Bug` and scopes to your configured board.

| Action | Description | Key Params |
|--------|-------------|------------|
| `find-bugs` | List untriaged bugs by date range | `dateRange` (`7d`/`30d`/`90d`), `component`, `jql`, `maxResults` |
| `search` | Query bugs via JQL (auto-enforces `type=Bug` + board scope) | `jql`, `maxResults` |
| `assess` | Score bug report completeness (0–100%) and auto-comment on incomplete bugs | `issueKeys`, `autoComment` |
| `triage` | Prioritize a bug — infers severity, recommends sprint, suggests trade-offs | `issueKeys`, `severity`, `autoUpdate`, `autoAssign` |

**Example:** *"Find bugs from the last week"* → `bugs action=find-bugs dateRange="7d"`

---

### 5. `backlog` — Backlog Management

List, search, and rank backlog items. All queries are board-scoped via the Agile API.

| Action | Description | Key Params |
|--------|-------------|------------|
| `list` | Show the board's backlog items | `maxResults` |
| `search` | Query backlog items via JQL (auto-enforces `sprint is EMPTY` + board scope) | `jql`, `maxResults` |
| `rank` | Reorder backlog items — `top`/`bottom` or precise `rankBefore`/`rankAfter` | `issueKey`, `position`, `rankBefore`, `rankAfter` |

**Example:** *"Show me the backlog"* → `backlog action=list`

---

### 6. `sprints` — Sprint Management & Analytics

Manage sprints, track velocity, monitor health, and generate retrospective data.

| Action | Description | Key Params |
|--------|-------------|------------|
| `list` | Show sprints (active + future by default) | `state` (`active`, `future`, `closed`) |
| `get` | Sprint details with issues grouped by status and assignee | `sprintId` |
| `create` | Create a new sprint | `name`, `goal`, `startDate`, `endDate` |
| `move-issues` | Assign issues to a sprint | `sprintId`, `issueKeys` |
| `velocity` | Team velocity trends with optional bug rate and scope change metrics | `sprintCount`, `trendMetrics` |
| `health` | Active sprint health: blockers, stale items, progress, capacity | `sprintId`, `staleDays` |
| `retro` | Retrospective data: scope creep, carry-over, cycle time, bug ratio | `sprintId`, `sprintCount` |
| `goal` | Read or set sprint goal | `sprintId`, `goal` |

Health assessment levels: `[OK]`, `[WARNING]`, `[CRITICAL]`

**Example:** *"How's the current sprint going?"* → `sprints action=health`

---

## Example Workflows

### First-Time Setup

> *"Set up my Jira project and index our engineering docs"*

The AI will ask for your project key, board ID, and Confluence spaces, then run:

1. **`configure action=setup`** — Discovers Jira schema, spiders Confluence, learns team patterns
2. **`confluence action=search`** — Verify KB stats (no query returns page counts and type breakdown)

---

### Sprint Planning

> *"Help me plan the next sprint"*

1. **`sprints action=velocity`** — Review velocity trends over the last 5 sprints
2. **`sprints action=health`** — Check current sprint progress and capacity
3. **`backlog action=list`** — Review prioritized backlog items
4. **`sprints action=move-issues`** — Assign selected issues to the next sprint

---

### Ticket Creation with Context

> *"Create tickets for migrating to the new payment gateway"*

1. **`issues action=create summary="Migrate payment processing to Stripe v2"`** — Returns a preview grounded in Confluence context, with schema guidance and team conventions
2. Review the preview — it shows matching docs, field rules, and sample tickets
3. **`issues action=create ... confirmed=true`** — Submit to Jira

For multiple tickets:
1. **`issues action=bulk-create tickets=[...]`** — Preview all tickets
2. **`issues action=bulk-create tickets=[...] confirmed=true`** — Create them all

---

### Bug Triage Session

> *"Let's triage the recent bugs"*

1. **`bugs action=find-bugs dateRange="7d"`** — Find bugs from the last week
2. **`bugs action=assess issueKeys=[...]`** — Score completeness; auto-comments on incomplete bugs
3. **`bugs action=triage issueKeys=["BP-101"] autoAssign=true`** — Prioritize and assign to sprint

---

### Backlog Grooming

> *"Review the backlog and prioritize"*

1. **`backlog action=list`** — View current backlog items with story points
2. **`backlog action=search jql="priority = High"`** — Find high-priority items
3. **`backlog action=rank issueKey="BP-42" position="top"`** — Move critical items to the top

---

### Sprint Retrospective

> *"Prepare data for our sprint retrospective"*

1. **`sprints action=retro`** — Full retrospective data: scope creep, carry-over, cycle time, bug ratio
2. **`sprints action=velocity trendMetrics=["velocity","bugRate","scopeChange"]`** — Multi-metric trend analysis

---

### Confluence Knowledge Review

> *"Are there any stale docs we should update?"*

1. **`confluence action=search stale=true staleDays=90`** — Find pages not updated in 90+ days
2. **`confluence action=search since="2025-01-01"`** — See recently indexed changes
3. **`confluence action=search query="authentication" pageType="adr"`** — Search within a document type

---

## Architecture

```
                    +-----------+
                    | MCP Client|
                    | (Claude,  |
                    |  Cursor,  |
                    |  etc.)    |
                    +-----+-----+
                          |
                   JSON-RPC (stdio)
                          |
                    +-----v-----+
                    | MCP Server|
                    | (6 tools) |
                    +-----+-----+
                          |
            +-------------+-------------+
            |             |             |
    +-------v------+ +---v---+ +------v------+
    | Confluence   | | Jira  | | SQLite FTS5 |
    | REST API v2  | | REST  | | Knowledge   |
    |              | | v3 +  | | Base        |
    |              | | Agile | |             |
    |              | | v1    | |             |
    +--------------+ +-------+ +-------------+
```

### Operational Modes

- **Confluence-only** — Spider and search docs without any Jira config.
- **Jira-only** — Create and manage tickets, sprints, and analytics without Confluence.
- **Combined** (recommended) — Full power: spider docs, ground tickets in context, manage sprints, and triage bugs.

### Data Flow

```
Spider  -->  Extract & Classify  -->  Index (SQLite FTS5)  -->  Search
                                                                  |
                                                                  v
                                                       Create (preview)
                                                                  |
                                                                  v
                                                       Confirm (Jira API)
```

All indexed data is stored locally in `.lazy-backlog/knowledge.db`. No data is sent to third-party services beyond Atlassian's own APIs.

---

## Development

```bash
# Install dependencies
npm install

# Run all checks (typecheck + lint + test)
npm run check

# Individual commands
npm run typecheck    # TypeScript strict mode checking
npm run lint         # Biome linter
npm run lint:fix     # Auto-fix lint issues
npm test             # Run tests via vitest

# Build for publishing
npm run build        # Compile TypeScript to dist/
```

### Project Structure

```
src/
  index.ts              -- MCP server entry point
  tools/
    configure.ts        -- Project setup (setup, set, get)
    confluence.ts       -- Confluence operations (spider, search, get-page, list-spaces)
    issues.ts           -- Jira CRUD + planning (get, create, bulk-create, update, search, epic-progress, decompose)
    bugs.ts             -- Bug workflows (find-bugs, search, assess, triage)
    backlog.ts          -- Backlog management (list, search, rank)
    sprints.ts          -- Sprint management + analytics (list, get, create, move-issues, velocity, health, retro, goal)
  lib/
    sqlite.ts           -- Runtime-adaptive SQLite adapter (better-sqlite3)
    confluence.ts       -- Confluence REST API v2 client
    jira.ts             -- Jira REST API v3 + Agile v1 client + schema discovery
    db.ts               -- SQLite + FTS5 knowledge base (STRICT tables)
    indexer.ts          -- Spider + content extraction + page classification
    chunker.ts          -- Markdown-aware section chunking (remark AST)
    analytics.ts        -- Velocity, capacity, and sprint health computations
    team-rules.ts       -- Backlog intelligence: quality scoring, pattern extraction, team conventions
    config.ts           -- Config resolution (env vars + SQLite)
  config/
    schema.ts           -- Zod validation schemas
```

---

## License

[MIT](LICENSE)
