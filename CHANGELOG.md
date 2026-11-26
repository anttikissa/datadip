# Changelog

All notable changes to DataDip are documented here.

## [0.2.1] - 2026-11-26

**PostgreSQL TLS Auto-Negotiation & Upgrade Server Refresh**

### Fixed
- **PostgreSQL `sslmode=prefer` default**: bare `DATABASE_URL`s without `?sslmode=...` (such as Supabase, RDS, Neon, and Render) now match `libpq` by sending PostgreSQL `SSLRequest` first and negotiating TLS automatically, while seamlessly falling back to plaintext for local non-SSL servers.
- **Stale background server reuse on `DataDip.app` upgrade**: `DataDip.app` now compares `/api/health`'s reported `version` against `CFBundleShortVersionString` before joining an existing server and restarts any older background server automatically.

## [0.2.0] - 2026-11-26

**ER Diagram, 1-Key Column Profiling, Workspaces, & Locked Production Guardrails**

### Added
- **Interactive Schema / ER Diagram** (`/c/:id/er`): pure-SVG pan/zoom table graph with draggable table cards, PK/FK badges, Bezier foreign-key edges, hover neighborhood highlighting, table/column search, and click-to-browse.
- **One-keystroke column profiling** (`p` or column header `Σ`): computes total/non-null/null %, distinct count, min/max, and top-10 proportional value bars that filter the table on click (local SQLite, SSH SQLite, and PostgreSQL).
- **Searchable cross-connection query history** (`GET /api/history`): live SQL substring search across **This DB** or **All DBs** in the Console History drawer with source connection badges.
- **Enforceable `alwaysReadOnly` connection lock**: hides Write controls in the UI (`LOCKED RO` pill) and rejects Read-Write arming on the server (`403`).
- **Target-bound production write approval**: arming Read-Write on Production requires typing the exact database name and auto-relocks when switching databases or after 10 minutes idle.
- **Client workspaces**: optional `group` folders, `tags`, and `color` accents in `connections.ason`, grouping cards on Home and indexing groups/tags in Home filter, topbar switcher, window title, and `Cmd+K` Omnibar.
- **`~/.ssh/config` host alias picker** (`GET /api/ssh/hosts`): parses concrete `Host` entries (including `Include` directives, skipping wildcards) to autofill SSH host, user, and port in Connection and Auto-Discover modals.
- **Teammate-shareable slug links**: `Share` button copies `/c/<db-slug>/...` URLs resolved by connection name/slug instead of machine-local IDs.
- **Dev data tools**: one-click **Duplicate Row** in Row Inspector (clearing single integer PKs) and transactional **Import CSV / JSON** with column mapping and 5-row preview.
- **macOS Apple discovery & SQLite internals**: one-click **iOS Simulators** and **macOS App Containers** presets in Auto-Discover, **Triggers** in Schema view, collapsible **Internal / FTS5** shadow tables in the sidebar, and a **Database Info & PRAGMA/WAL Inspector** with RW-gated `WAL Checkpoint` and `VACUUM`.
- **In-app What's New / Changelog modal**: accessible via the top-bar version pill, `Cmd+K` Omnibar, and `DataDip -> What's New (Changelog)...` menu item.

## [0.1.0] - 2026-11-26

**Initial Signed & Apple-Notarized Release**

### Added
- **SQLite & PostgreSQL support**: local SQLite (`bun:sqlite`), multiplexed SSH SQLite, native PostgreSQL (`Bun.SQL`) with one-paste `DATABASE_URL`, and OpenSSH TCP port-forwarding tunnels (`ssh -N -L`) with interactive `SSH_ASKPASS` prompts.
- **Web-native foreign-key navigation**: hover peek cards, click-to-jump FKs, `Space` Row Inspector with incoming reverse-FK counts, browser Back/Forward history (`Cmd+[` / `Cmd+]`), and `Cmd+K` Omnibar cross-table ID search.
- **Read-Only defaults & Production safety**: driver/transaction Read-Only enforcement, crimson Production strip, 10-minute auto-relock, staged inline edits with parameterized SQL preview, and destructive SQL confirmation.
- **Parallel cancellable SQL Consoles**: CodeMirror 6 tabbed and split consoles, schema autocomplete, SQL lint/format, `EXPLAIN`, clickable FKs in query results, real query cancellation (`Cmd+.`), column drag-resize/auto-fit, `Freeze 1st`, and full-result exports (CSV, TSV, JSON, Markdown, SQL INSERT).
- **Self-contained signed & notarized macOS `DataDip.app`**: lightweight `WKWebView` shell (no Electron), Finder double-click, Dock drop, `Cmd+O`, `datadip ./app.db` CLI, and live `.db` / `-wal` auto-refresh.
