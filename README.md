# Lazy Backlog

[![CI](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-backlog/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Ricky-Stevens_lazy-backlog&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Ricky-Stevens_lazy-backlog)

AI-powered MCP server that spiders Confluence for project context and generates rich Jira tickets. Let AI do your backlog refinement.

## What it does

1. **Spiders Confluence** — crawls your spaces, indexes pages into a local SQLite database with FTS5 full-text search
2. **Classifies content** — automatically detects ADRs, design docs, specs, runbooks, and meeting notes
3. **Chunks intelligently** — splits pages into heading-aware sections with breadcrumbs for precise search
4. **Discovers Jira schema** — maps issue types, fields, priorities, board config, and team assignment
5. **Generates grounded tickets** — plans tickets with full Confluence context, converts markdown to ADF, auto-fills required fields

## MCP Tools

| Tool | Description |
|---|---|
| `setup` | One-shot: discover Jira schema + spider Confluence spaces |
| `configure` | Store project settings (project key, board ID, spaces) |
| `discover-jira` | Discover Jira project structure standalone |
| `spider` | Crawl and index Confluence pages (incremental) |
| `plan-tickets` | Plan tickets grounded in Confluence context |
| `create-tickets` | Create Jira tickets with dry-run preview |
| `get-ticket` | Fetch full ticket details |
| `update-ticket` | Update any ticket field or add comments |
| `search` | Search indexed content (section-level chunks) |
| `get-page` | Retrieve full page content |
| `get-adrs` | List all indexed ADRs |
| `get-context-summary` | Synthesized project context summary |
| `list-spaces` | List accessible Confluence spaces |
| `rebuild-index` | Rebuild FTS5 search index |

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- Atlassian Cloud account with API token

### 1. Install

```bash
git clone https://github.com/YOUR_USERNAME/lazy-backlog.git
cd lazy-backlog
bun install
```

### 2. Configure your MCP client

Add to your `.mcp.json` (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "lazy-backlog": {
      "command": "bun",
      "args": ["run", "/path/to/lazy-backlog/src/index.ts"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://yoursite.atlassian.net",
        "ATLASSIAN_EMAIL": "you@example.com",
        "ATLASSIAN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### 3. Initialize

In your AI client, run:

```
configure with jiraProjectKey="PROJ", jiraBoardId="123", confluenceSpaces=["Engineering"]
setup
```

This discovers your Jira schema and indexes Confluence in one step.

### 4. Create tickets

```
plan-tickets with description="Add OAuth2 support for API authentication"
create-tickets with dryRun=true ...
create-tickets with dryRun=false ...
```

## Development

```bash
bun run start       # Start the MCP server
bun run check       # TypeScript typecheck + Biome lint
bun run lint:fix    # Auto-fix lint issues
bun run format      # Format with Biome
```

## License

MIT
