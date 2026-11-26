# Changelog

All notable changes to DataDip are documented here.

## [0.4.0] - 2026-11-27

**Multi-Runtime SSH SQLite, Serverless SQLite (Turso & D1), & Passive FK Learning**

### Added
- **Multi-runtime SSH SQLite (`auto` / `bun` / `python3` / `sqlite3` CLI)**: one persistent `ssh -T` pipe auto-detects `bun` -> `python3` (stdlib `sqlite3` with `ThreadPoolExecutor` concurrency and `conn.interrupt()` cancellation) -> `sqlite3` CLI (`>= 3.33` via base64-framed POSIX `sh` loop) without installing files on the remote server. Selectable per connection in the Connection modal, with an explicit user-confirmed **Install Bun** button (`POST /api/ssh/install-bun`) if no runtime is installed.
- **Serverless SQLite -- Turso / libSQL & Cloudflare D1**: zero-dependency native `fetch()` adapters sharing `AsyncSqliteAdapter`. Turso speaks Hrana v2 (`/v2/pipeline`) with Bearer auth, `PRAGMA query_only = ON` in Read-Only mode, atomic conditional `batch` transactions with auto-`ROLLBACK`, `AbortController` cancel, and token masking; Cloudflare D1 speaks the D1 REST API (`d1://<accountId>/<databaseId>`).
- **Passive ID-signature & PK-verified foreign-key learning**: fingerprints UUID, ULID, delimited typed (`usr_...`), delimiterless typed (`u...`), and opaque IDs from already-loaded browse/query rows with zero upfront scans on connect, verifies candidates via batched PK-index lookups (`checkKeysExist`), supports retroactive discovery and polymorphic drift demotion, and pushes live `schema-changed` SSE updates with `LEARNED` badges, provenance tooltips, and one-click Save/Dismiss.
- **Upgraded Tier 1 schema FK inference**: adds irregular plurals and unique single-PK column-name matching (`course_id -> courses.course_id`) with SQL type-family checks.

## [0.3.0] - 2026-11-26

**Signed macOS Self-Updater, Virtual & Inferred Foreign Keys, & Accurate Postgres Counts**

### Added
- **Built-in signed macOS self-updater** (`DataDip -> Check for Updates...`): checks GitHub Releases manually or every 12h in the background (showing an unobtrusive `Update vX.Y.Z` top-bar pill), downloads the notarized `.dmg` over HTTPS-only redirects, verifies the staged bundle with `SecStaticCodeCheckValidity` (strict nested code + Apple Developer ID cert OIDs + matching `CFBundleIdentifier` and `TeamIdentifier` + no downgrade), stops `datadip-server`, swaps atomically via `FileManager.replaceItemAt`, and relaunches cleanly.
- **Automatic FK inference & Virtual Foreign Keys**: infers undeclared `<stem>_id` / `<stem>Id` relationships across tables with compatible PK types, and lets you link or dismiss virtual foreign keys locally in `connections.ason` without altering the database (works in Read-Only / Production mode), integrated across table grids, hover peeks, reverse-FK counts, SQL Console results, and ER Diagram edges (dashed for virtual, dotted for inferred).
- **Styled Retina DMG installer**: HiDPI drag-to-Applications Finder layout with custom volume icon.

### Fixed
- **Accurate small-table PostgreSQL row counts & clean large estimates**: probes small readable tables (`<= 512 KB`, `LIMIT 1001`) in one batched query for exact counts, displays floored lower bounds (`1,000+`, `14,100+`, `1,920,000+`) for larger tables, caches schema metadata for snappier browsing, and fixes masked PostgreSQL password display (`••••` instead of percent-encoded characters).
- **Typographic baseline alignment**: aligned adjacent mixed-size text across table headers, sidebar, and UI rows.

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
