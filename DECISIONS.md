# Decisions

By topic. Each entry: the decision, then the reason when it is not
obvious.

## Architecture (v1)

- Local-first Bun server (`datadip serve` on `127.0.0.1:4747`) with a
  Solid 2 + Vite web client and a thin native macOS `WKWebView` shell
  (`DataDip.app`). All API traffic lives under `/api/*` using ASON so v2
  can add remote deployment, authentication, and AI query features
  without reshaping the client.
- Adapter abstraction (`server/db/types.ts`): all table listing, schema
  inspection, browsing, querying, mutations, FK peeks, and reverse-FK
  counts flow through `DbAdapter` for SQLite (local and SSH) and
  PostgreSQL (direct TCP/TLS and SSH TCP port forwarding via `Bun.SQL`,
  zero external dependencies).
- PostgreSQL adapter (`server/db/postgres.ts`) & OpenSSH TCP tunnel
  (`server/db/ssh-tunnel.ts`): uses Bun's native `Bun.SQL` client with
  `BEGIN READ ONLY` enforcement in Read-Only mode, `pg_class.reltuples`
  row estimates (no automatic `COUNT(*)` on large tables >50k rows),
  server-side `query.cancel()`, and `ssh -N -L` local port forwarding
  reusing `SSH_ASKPASS` while preserving real-endpoint TLS `serverName`
  (no remote Bun required). Connection URL passwords are always masked
  in the UI (`maskConnectionPath`).
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
- Multiplexed SSH transport (`server/db/ssh-mux.ts`): one persistent SSH
  process per remote host runs an inline Bun SQLite worker speaking
  NDJSON-RPC over stdin/stdout. Concurrent queries share one connection
  without repeated SSH handshakes, and using remote Bun avoids stale
  system `sqlite3` binaries.
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
  connection automatically relocks to Read-Only after 10 minutes of
  inactivity.
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
