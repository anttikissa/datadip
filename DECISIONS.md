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
  counts flow through `DbAdapter` so Postgres and other drivers can be
  added without changing the UI or routes.
- Multiplexed SSH transport (`server/db/ssh-mux.ts`): one persistent SSH
  process per remote host runs an inline Bun SQLite worker speaking
  NDJSON-RPC over stdin/stdout. Concurrent queries share one connection
  without repeated SSH handshakes, and using remote Bun avoids stale
  system `sqlite3` binaries.

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
- Light theme by default with an optional dark theme toggle persisted in
  local state (using slightly lighter body weight in dark mode to offset
  irradiation).
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
- Focus uses `:focus-visible` with a single 2px ring across the app.
- Auto-Discover follows directory symlinks safely (deduplicating via
  `realpathSync`) so symlinked storage volumes (e.g. `~/disk`) are found.
- Truncated table cells support four complementary inspection modes:
  double-click / `Enter` opens an anchored Cell Viewer popover (with
  JSON pretty-print, Copy, and multi-line editor in Read-Write mode),
  column header dividers drag to resize and double-click to auto-fit,
  a toolbar `Wrap` toggle expands rows vertically, and hovering a
  truncated non-FK cell shows a delayed preview card.
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
- `Ctrl+R` opens the Recent Databases & Tables modal (WebStorm/IDEA
  style, distinct from `Cmd+R` page reload) with MRU switching and
  instant filtering.
- SQL documents are labeled "Console" in the UI (matching DataGrip/DBeaver
  terminology while keeping the `scratchpads` SQLite table and API paths
  unchanged). `Cmd+Shift+L` (DataGrip) and `Cmd+E` (TablePlus) open or
  focus the active connection's Console (`Ctrl+E` stays unbound on macOS
  so Emacs end-of-line still works in inputs); `EXPLAIN QUERY PLAN` uses
  `Cmd+Shift+E`.
- CLI probe/control commands (`url`, `status`, `open`, `stop`, and the
  duplicate server check) read only `server.ason` without opening
  `state.db`.
