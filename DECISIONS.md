# Decisions

By topic. Each entry: the decision, then the reason when it is not
obvious.

## Architecture (v1)

- Local-first Bun server (`datadip serve` on `127.0.0.1:4747`) with a
  Solid 2 + Vite web client and a thin native macOS `WKWebView` shell
  (`DataDip.app`). All API traffic lives under `/api/*` using ASON so v2
  can add remote deployment, authentication, and AI query features
  without reshaping the client.
- Self-contained macOS distribution (`mac/build-dmg`, `mac/render-dmg-bg.swift`,
  `mac/entitlements.plist`): bundles the `swiftc`-compiled `DataDip`
  shell, `bun build --compile` standalone `Contents/MacOS/datadip-server`
  (including the SQLite query worker and `__ssh_askpass` subcommand),
  Vite `Contents/Resources/dist/`, `ssh-askpass.sh`, and `AppIcon.icns`
  into a single drag-to-Applications `DataDip.app` and signed/notarized
  `arm64` `.dmg` (`dev.datadip.app`) with a CoreGraphics-rendered HiDPI
  Retina TIFF background (`tiffutil -cathidpicheck`), custom volume icon,
  and Finder icon-view layout, requiring zero git clone, system Bun, or
  `swiftc` for end users. Data stays in `~/.datadip/data` so CLI
  (`DataDip -> Install 'datadip' CLI…`) and `.app` share one config.
  `DataDip.app` registers `.db`/`.sqlite`/`.sqlite3`/`.db3` document
  types for Finder double-click, Dock drop, and `Cmd+O` file open. Dev
  builds via `mac/build` continue to launch from the local checkout when
  `Contents/MacOS/datadip-server` is absent.
- Built-in signed macOS self-updater (`mac/DataDip.swift`): checks GitHub
  Releases (`releases/latest` API with zero-rate-limit web redirect +
  `HEAD` fallback) manually via `DataDip -> Check for Updates…` and
  passively every 12h on signed release builds (surfacing an unobtrusive
  `Update vX.Y.Z` topbar pill), downloads the existing signed/notarized
  `DataDip-<version>-<arch>.dmg` over HTTPS-only redirects, mounts and
  extracts via `hdiutil` + `ditto`, verifies the staged bundle with
  `SecStaticCodeCheckValidity` (strict nested code + Apple Developer ID
  OIDs + matching `CFBundleIdentifier` and `TeamIdentifier` + no
  downgrade), stops `datadip-server`, swaps the bundle atomically with
  `FileManager.replaceItemAt`, and relaunches cleanly. Falls back to
  opening the downloaded `.dmg` in Finder when running from a
  non-writable location (mounted DMG, App Translocation, or restricted
  `/Applications`) or ad-hoc build, avoiding Sparkle framework/XPC
  complexity and extra signing keys.
- Adapter abstraction (`server/db/types.ts`): all table listing, schema
  inspection, browsing, querying, mutations, FK peeks, and reverse-FK
  counts flow through `DbAdapter` for SQLite (local and SSH) and
  PostgreSQL (direct TCP/TLS and SSH TCP port forwarding via `Bun.SQL`,
  zero external dependencies).
- PostgreSQL adapter (`server/db/postgres.ts`) & OpenSSH TCP tunnel
  (`server/db/ssh-tunnel.ts`): uses Bun's native `Bun.SQL` client with
  `sslmode=prefer` default (matching `libpq` so bare cloud `DATABASE_URL`s
  like Supabase/RDS negotiate TLS while local plaintext Postgres still
  falls back cleanly), `BEGIN READ ONLY` enforcement in Read-Only mode,
  `pg_class.reltuples` row estimates (no automatic `COUNT(*)` on large
  tables >50k rows), server-side `query.cancel()`, and `ssh -N -L` local
  port forwarding reusing `SSH_ASKPASS` while preserving real-endpoint
  TLS `serverName` when TLS is required (no remote Bun required).
  Connection URL passwords are always masked in the UI (`maskConnectionPath`).
- Large-table browsing guard: both SQLite (`>50 MB` files) and
  PostgreSQL (`>50k` estimated rows) skip automatic full-table `COUNT(*)`
  scans during table browsing, using `sqlite_stat1` / `pg_class.reltuples`
  when unfiltered and `null` when filtered.
- Full-result file export (`server/export.ts`, `POST /api/connections/:id/export`):
  downloads table views or read-only SQL query results directly to disk
  (up to 100k rows) in CSV, TSV, JSON, Markdown, or SQL `INSERT` format.
- Ad-hoc CLI file opening (`datadip ./app.db`, `POST /api/connections/open-file`):
  validates the SQLite header, deduplicates by resolved `realpath`, and
  opens the database directly in the UI.
- Multiplexed SSH transport (`server/db/ssh-mux.ts`, `remote-worker.ts`,
  `remote-worker-python.ts`, `remote-worker-sqlite3.ts`): one persistent
  `ssh -T` process per remote host supports user-selectable or
  auto-detected runtimes (`auto` -> `bun` -> `python3` -> `sqlite3` CLI)
  via a single-line stdout handshake (`{"select":"..."}`) before
  streaming the matching worker over stdin with zero files written to
  the remote host. Both `bun` (Worker threads) and `python3` (stdlib
  `sqlite3` + `ThreadPoolExecutor` + `conn.interrupt()`) deliver full
  concurrent multiplexing and real mid-flight cancellation; `sqlite3`
  CLI (`>= 3.33 -json`) uses a tab-delimited base64-framed POSIX `sh`
  loop routed through `AsyncSqliteAdapter` for minimal containers. An
  explicit user-confirmed `POST /api/ssh/install-bun` endpoint offers
  remote Bun installation when no runtime is present.
- Serverless SQLite adapters (`server/db/sqlite-async.ts`, `turso.ts`,
  `d1.ts`): zero-dependency native `fetch()` adapters under `driver:
  'sqlite'` with `location: 'turso'` (Turso/libSQL Hrana v2
  `/v2/pipeline` with Bearer auth, `PRAGMA query_only`, atomic batched
  transactions, and `AbortController` cancel) and `location: 'd1'`
  (Cloudflare D1 REST API `d1://<accountId>/<databaseId>` with
  loopback-only custom endpoint guard), sharing one `AsyncSqliteAdapter`
  engine. `maskConnectionPath` also masks `authToken`/`token` query
  params on `libsql://` and `https://` URLs.
- Interactive SSH auth (`server/db/ssh-prompts.ts`, `ssh-askpass.sh`/`.ts`):
  OpenSSH runs with `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` talking
  back to `/api/internal/ssh-askpass` using a per-process `secretId()`
  token in memory/env. Key passphrases, SSH passwords, 2FA prompts, and
  unknown host-key confirmations are pushed to the UI over `/api/events`
  (`ssh-prompts`) and answered via a native `<dialog>` without ever
  logging or persisting secrets; connect timeouts pause while waiting on
  the user.

## Safety & Production Mode

- Every connection defaults to Read-Only. In Read-Only mode, SQLite
  handles are opened `{ readonly: true }` AND the server rejects write
  statements before execution.
- Connections marked `isProduction: true` display a persistent crimson
  top edge and `PROD` alert badge. Arming Read-Write on a production
  connection requires target-bound confirmation (typing the exact
  connection name), automatically relocks to Read-Only after 10 minutes
  of inactivity, and automatically relocks when switching away to
  another connection or Home.
- Connections marked `alwaysReadOnly: true` are enforced permanently
  Read-Only at the server layer (`setRwMode` returns `403`, `getRwState`
  always returns unarmed) and hide all Write arming / edit controls in
  the UI (`LOCKED RO` badge).
- Destructive SQL (`DROP`, `TRUNCATE`, `ALTER`, or `DELETE`/`UPDATE`
  without a `WHERE` clause) requires explicit confirmation via an in-app
  `<dialog>` on every database, not only production.
- Inline table edits are staged client-side and shown in a pending-edits
  bar with SQL preview before committing in a single transaction.

## Navigation & URLs

- Browser history (`history.pushState` / `popstate`) drives all table
  navigation and foreign-key traversal, so browser Back/Forward,
  trackpad swipes, and `Cmd+[` / `Cmd+]` work naturally.
- Table URLs encode connection, table, selected fields, filters, sort
  order, limit, and keyset cursor (`start=...`) or offset.
- Teammate-shareable links (`Share` button & Omnibar) encode the
  slugified connection name (`/c/<slug>/...`) instead of per-machine
  random IDs; `resolveConnectionRef` resolves ID, exact name, or slug
  on load and canonicalizes to the local connection ID.
- Interactive Schema / ER Diagram (`/c/:id/er`, `ErDiagramView.tsx`)
  renders tables, PK/FK columns, and Bezier FK edges in pure SVG with
  pan, zoom, draggable cards, neighborhood highlighting, and
  click-to-browse with zero external graph dependencies.
- Automatic FK inference & Virtual Foreign Keys (`src/shared/virtual-fks.ts`,
  `VirtualFkModal.tsx`, `POST/DELETE /api/connections/:id/virtual-fks`,
  `POST/DELETE /api/connections/:id/ignored-fks`): columns without
  database-declared `FOREIGN KEY` constraints are automatically inferred
  when their `<stem>_id` / `<stem>Id` name matches a table's single PK
  with a compatible SQL type family (preferring same-schema tables), and
  any column can be manually linked or dismissed locally in
  `connections.ason` (`virtualForeignKeys` / `ignoredForeignKeys`) without
  touching the database (works in Read-Only / Production mode). Merged
  non-mutatingly into schema, hover peeks, reverse-FK counts, SQL Console
  results, and ER Diagram edges (dashed for virtual, dotted for inferred).

## Inspection, Profiling, Workspaces & Internals (v0.2.0)

- One-keystroke column profiling (`p` or column header `Σ`,
  `POST /api/connections/:id/profile`) computes total/non-null/null %,
  distinct count, min/max, and top 10 values with click-to-filter across
  local SQLite, SSH SQLite, and PostgreSQL (`BEGIN READ ONLY` with 10s
  `statement_timeout`).
- Query history supports cross-connection search (`GET /api/history?connectionId=all&q=...`)
  with a `This DB` / `All DBs` toggle and live SQL substring filtering in
  the Console History drawer.
- Connection workspaces support optional `group`, `tags`, and `color`
  fields in `connections.ason`, grouping cards on HomeView and indexing
  groups/tags in Home filter and Omnibar search.
- `~/.ssh/config` alias discovery (`GET /api/ssh/hosts`,
  `server/db/ssh-config.ts`) parses concrete `Host` entries (following
  `Include` directives and skipping wildcards) to populate pickers in
  ConnectionModal and DiscoverModal.
- Dev data tools in Read-Write mode include one-click Row Duplication
  (pre-filling Insert Row while clearing single integer PKs) and
  transactional CSV/JSON import (`src/lib/import-parse.ts`,
  `ImportModal.tsx`, capped at 5,000 rows per batch).
- Local macOS Auto-Discover (`server/db/discover.ts`) adds presets for
  iOS Simulators (`~/Library/Developer/CoreSimulator/Devices`, naming
  from `device.plist`) and macOS App Containers (`~/Library/Containers`).
- SQLite & Postgres schemas expose triggers (`sqlite_master` /
  `pg_trigger`); SQLite FTS5/FTS4/RTree shadow tables are flagged
  `isInternal: true` and grouped under a collapsible sidebar section;
  `GET /api/connections/:id/info` + `POST /api/connections/:id/maintenance`
  provide a PRAGMA/WAL inspector with RW-gated `wal_checkpoint(TRUNCATE)`
  and `VACUUM`.
- Structured release notes live in `src/shared/changelog.ts` (mirrored in
  `CHANGELOG.md` and `site/index.html`) powering the in-app
  `ChangelogModal` (`v<version>` pill with unseen-release dot persisted
  via `preferences.lastSeenVersion`, `Omnibar`, and `DataDip -> What's
  New (Changelog)…` in `DataDip.app`).

## UI & Defaults

- English only, ISO 8601 timestamps (`YYYY-MM-DD HH:mm:ss` / UTC).
- Native system UI font (`-apple-system`, `SF Pro Text`) paired with
  `'Berkeley Mono', 'SF Mono', ui-monospace` for tables and SQL, with
  no external Google Fonts dependency so `DataDip.app` renders
  instantly offline.
- Follows macOS/OS `prefers-color-scheme` on first launch, with a manual
  light/dark toggle persisted in local state (using slightly lighter body
  weight in dark mode to offset irradiation).
- CodeMirror 6 provides SQL editing with SQLite syntax highlighting,
  live schema autocomplete, custom SQLite linting, active-statement
  highlighting, and SQL formatting.
- Dialogs use native `<dialog>` elements (never `alert`/`confirm`) and
  trap/wrap `Tab` and `Shift-Tab` across visible focusable controls
  inside the topmost open `dialog:modal`, preventing WebKit/Safari focus
  escape to `document.body` or the `<dialog>` frame itself.
- `DataDip.app` sets `WKPreferences.tabFocusesLinks = true` so `Tab`
  navigates buttons, links, and form controls across the native app even
  when macOS system Keyboard Navigation is off.
- `DataDip.app` has no address bar, so it shows the local web URL in
  `About DataDip` and offers `Copy Page URL` in the Edit menu
  (`Cmd+L`) and every right-click menu.
- Focus uses `:focus-visible` with a single 2px ring across the app.
- Auto-Discover follows directory symlinks safely (deduplicating via
  `realpathSync`) so symlinked storage volumes are found.
- Truncated table cells support four complementary inspection modes:
  double-click / `Enter` opens an anchored Cell Viewer popover (with
  JSON pretty-print, Copy, and multi-line editor in Read-Write mode),
  column header dividers drag to resize and double-click to auto-fit
  (in both Table Browser and SQL Console result grids, alongside a
  CSS-sticky `Freeze 1st` column toggle), a toolbar `Wrap` toggle expands
  rows vertically, and hovering a truncated non-FK cell shows a delayed
  preview card.
- Local SQLite live auto-refresh (`server/db/manager.ts`, `TableView.tsx`):
  open local SQLite adapters watch their directory for `.db`, `-wal`, and
  `-shm` writes (250ms debounce) and push SSE `db-changed` events; a
  `Live` toggle in `TableView` auto-reloads silently when no staged edits
  or inline cell editors are active.
- Server liveness is tracked continuously via `/api/events` (SSE). When
  the local server stops, the web UI shows a clear offline banner and
  auto-reconnects/reloads on recovery; inside `DataDip.app`, both SSE
  disconnect (`ensureServer` message) and connect-error navigations
  automatically restart `datadip serve` while ignoring `NSURLErrorCancelled`.

## Local Data

- Gitignored `data/` directory holds `connections.ason`, `state.db`
  (opened with `PRAGMA busy_timeout=5000;` before
  `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`), and
  `server.ason`. Private hostnames and local paths never enter git.
- `connections.ason` is backed by `liveFile` (`src/shared/live-file.ts`)
  with `keepBroken: true` and directory watching. Hand-written ASON
  comments survive saves, malformed edits surface a non-fatal warning
  banner without overwriting the file, and `GET /api/events` (SSE with
  ASON payloads) pushes live updates to open UI clients.
- Connection visit timestamps live in `state.db` (`connection_visits`)
  rather than `connections.ason`, so browsing or querying never dirties
  a user-edited config file.
- Removing an active connection from `connections.ason` externally keeps
  its live adapter snapshot in memory marked `orphaned: true` so active
  queries/tabs keep working; the UI shows an orphaned banner with
  Re-save to config (`POST /api/connections/:id/restore`) and Close
  actions.
- Active (open) connections are honest, visible state: opening or closing
  an adapter pushes live updates over `/api/events`, Home displays a
  compact Active Connections list (plus live green dots, `RW` badges,
  and `Disconnect` via `POST /api/connections/:id/disconnect`), and the
  top-bar switcher groups active connections first.
- Keyboard shortcuts follow TablePlus / DataGrip / VS Code conventions
  while preserving OS and browser hygiene (`src/lib/shortcuts.ts`):
  - App shortcuts use `isPrimaryMod` (`Cmd` without `Ctrl` on macOS;
    `Ctrl` without `Cmd` elsewhere) so macOS Emacs editing keys
    (`Ctrl+A/E/K/B/L/P/N`) always work in inputs and CodeMirror.
  - `Ctrl+R` opens Recent Databases & Tables on macOS (`Alt+R` on
    non-Mac so browser `Ctrl+R` reload is never broken).
  - `Cmd+K` / `Cmd+P` open the Omnibar; `Cmd+B` toggles the sidebar;
    `Cmd+E` / `Cmd+Shift+L` open or focus the active Console; `Cmd+[` /
    `Cmd+]` navigate Back/Forward only outside editors (and are not
    bound as `NSMenu` key equivalents in `DataDip.app`) so CodeMirror
    indent/dedent works cleanly.
  - Browser-owned shortcuts (`Cmd+L`, `Cmd+R`, `Cmd+T`, `Cmd+W`) are
    only intercepted inside `DataDip.app`: `Cmd+R` (`View -> Refresh
    Data`) dispatches `datadip:refresh` to refresh rows/schema without
    reloading the WebView or wiping staged edits/scroll/widths (full
    reload moves to `Cmd+Shift+R`), `Cmd+T` (`File -> New Console Tab`)
    dispatches `datadip:new-tab`, and `Cmd+W` (`File -> Close Tab`)
    dispatches cancelable `datadip:close-tab` so closing a console tab
    never closes or quits `DataDip.app` (`Cmd+Shift+W` closes the
    window).
  - Table Browser: `Cmd+1` / `Cmd+2` switch Data/Schema tabs, `Cmd+F` /
    `/` focus quick-search, `Cmd+S` commits staged edits, `Cmd+Enter` /
    `Cmd+ArrowDown` follow a focused FK cell in both Read-Only and
    Read-Write modes, `Cmd+C` / `c` copy the focused cell when no text
    is selected, and `Cmd+Shift+C` copies the focused row with headers
    as TSV.
  - SQL Console: `Cmd+Enter` runs the active statement, `Cmd+Shift+Enter`
    runs all, `Cmd+Shift+E` explains, `Cmd+Shift+F` formats, `Cmd+/`
    toggles `-- ` line comments, `Cmd+.` (and `Ctrl+C` without text
    selection) cancels a running query, `Cmd+Shift+H` toggles Query
    History (leaving `Cmd+H` for macOS Hide App), `Ctrl+Tab` /
    `Ctrl+Shift+Tab` and `Cmd+Shift+[` / `Cmd+Shift+]` cycle console
    tabs, and result grids support arrow/`hjkl` cell navigation, `Cmd+C`
    / `c`, `Cmd+Shift+C` (row TSV), and `Enter` / `Cmd+Enter` to follow
    FKs or open CellViewer.
- SQL query execution runs on dedicated Bun `Worker` threads both locally
  (`server/db/sqlite-query-worker.ts`) and inside the remote SSH Bun
  worker (`server/db/remote-worker.ts`), so multiple long-running queries
  against the same database execute truly in parallel over one SSH pipe
  without head-of-line blocking browsing or other consoles, and can be
  cancelled mid-flight via `POST /api/connections/:id/query/cancel`.
- Consoles have a DataGrip-style tab bar (with `×` close, middle-click
  close, `+` reusing the lowest unused `Console N` number, live running
  timers, and a Split Console mode to run two consoles side-by-side) and
  keep per-console execution state independent across navigation.
  `document.title` (mirrored live via KVO in `DataDip.app`), the sidebar
  header, the top-bar switcher, and a Console toolbar badge all display
  the active database prominently.
- CLI probe/control commands (`url`, `status`, `open`, `stop`, and the
  duplicate server check) read only `server.ason` without opening
  `state.db`.
- Foreign keys support three layers merged non-mutatingly in
  `src/shared/virtual-fks.ts`: DB-declared FKs, user-configured manual
  Virtual FKs (`virtualForeignKeys` in `connections.ason`), and
  automatic inference (dismissible per column via `ignoredForeignKeys`).
  Automatic inference combines three tiers:
  1. **Tier 1 (Schema-only, 0 queries)**: strict `*_id` / `*Id` stem
     matching (including irregular plurals) and unique single-PK column
     name matches (`course_id -> courses.course_id`) with compatible SQL
     type families. Only tier allowed to infer plain integer FKs.
  2. **Tier 2 (Passive ID-signature learning, 0 extra queries on browse)**:
     `src/shared/id-fingerprint.ts` fingerprints string/UUID values from
     rows already returned by `browseTable` and single-table `SELECT`
     queries, separating universal formats (`uuid`, `ulid` — defeating
     shared timestamp-prefix traps), delimited typed IDs (`usr_...`),
     delimiterless typed IDs (`u` + Crockford base32/ULID via alpha
     prefix + suffix entropy), high-entropy opaque IDs, and polymorphic
     columns while ignoring plain integers and low-entropy enums.
  3. **Tier 3 (O(k log N) PK-index verification, `server/db/fk-learner.ts`)**:
     runs async non-blocking batched PK existence checks
     (`checkKeysExist`, single `UNION ALL` read-only transaction with
     1.5s timeout on Postgres) against ranked candidate targets (plus
     retroactive checks when a parent table is browsed later), persists
     profiles and verified/negative-cached outcomes in `state.db`
     (`fk_column_profiles`, `learned_fks`), demotes on polymorphic drift,
     and pushes live `schema-changed` SSE updates so learned links appear
     immediately with provenance (`LEARNED` badge & reason).
- PostgreSQL table row counts (`server/db/postgres.ts`,
  `src/lib/format.ts`): avoid presenting stale `pg_class.reltuples` as
  exact counts. In `getSchema()`, probe up to 100 small readable regular
  tables (`pg_relation_size <= 512 KB`) in a single batched `UNION ALL`
  query with `LIMIT 1001` (exact for `<= 1,000` rows, zero risk of
  scanning large tables). Larger tables use `pg_stat_all_tables.n_live_tup`
  (falling back to `pg_class.reltuples`), flagged `rowCountEstimated: true`,
  and formatted as floored lower-bound steps (`1,000+`, `14,100+`,
  `1,920,000+`). Opening an unfiltered table syncs its exact `totalCount`
  back to the sidebar, and `PostgresAdapter` caches its latest schema
  for internal lookups (`browseTable`, `peekRow`, `mutate`, etc.) so
  browsing remote Postgres avoids redundant metadata round-trips.

## Product Analytics & Smart Value Lenses

- **Product Analytics workspace** (`src/shared/analytics.ts`,
  `server/db/analytics.ts`, `src/components/AnalyticsView.tsx`,
  `src/components/AnalyticsCharts.tsx`, route `/c/:id/analytics`):
  provides Amplitude / Mixpanel / PostHog / Datadog-style Trends,
  Conversion Funnels, Cohort Retention heatmaps, People/Actor session
  journeys, and Saved Charts (persisted in `state.db` `analytics_charts`
  table as ASON) directly over any SQLite or PostgreSQL event table with
  zero external charting dependencies (pure interactive SVG).
  - Auto-detects the best event table, time column and format
    (`epoch_ms`, `epoch_s`, `iso`), event column, user/visitor actor
    columns, status column, and admin exclusion column.
  - Normalizes dynamic URL/ID segments in HTTP-style event names (e.g.
    `GET /api/chats/<id>`) as an optional toggle so routes aggregate
    cleanly without losing raw event inspection.
  - Supports **Visitor -> User identity stitching** across anonymous
    `visitor_id` and authenticated `user_id` rows when computing signup
    and activation funnels, retention cohorts, and user timelines.
  - All analytics queries execute strictly read-only (`writable: false`)
    with bounded scans, anchor timestamps to the table's latest event,
    and offer one-click **Open in SQL** and drill-down into filtered
    Table Browser rows.
  - SQL Console results also include an instant **Table / Chart** view
    toggle (`QueryResultChart`) for plotting any ad-hoc `GROUP BY` or
    time-series query result as Line, Area, Bar, or Stacked Bar.
- **Smart Value Lenses** (`src/shared/lenses.ts`, integrated into
  `TableView`, `ConsoleView`, `RowInspector`, and `CellViewer`):
  automatically detects and decodes Unix timestamps (`epoch_ms`,
  `epoch_s`, `epoch_us`, `epoch_ns`, Apple Cocoa) and time-bearing IDs
  (Crockford `tid`, UUIDv7, UUIDv1, ULID, KSUID, MongoDB ObjectId,
  Twitter/Discord Snowflakes — including prefixed variants like
  `u...`, `usr_...`) in real time with zero extra DB queries.
  - Numeric timestamps default to human-readable UTC inline in cells;
    time-bearing IDs default to raw ID with hover-peek and RowInspector /
    CellViewer decoded timestamp strips, and every detected column has a
    header lens pill (`ms`, `sec`, `tid`, `v7`, `ulid`, etc.) to switch
    display mode (`Raw`, `UTC`, `Local`, `Relative`, `ID + time`) or
    override/disable the format per column.
  - Never mutates underlying database values or breaks inline editing
    (editing still edits the raw stored integer/string).
