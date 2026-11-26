# DataDip TODO & Product Roadmap

Collected from 6 developer persona reviews (Startup Founding Eng, Staff Data/Analytics Eng, Fintech Principal Eng, Multi-Client Consultant, Weekend Indie Hacker, macOS/iOS Local-First Dev).

## High-Impact Priorities (Common Denominators)

- [x] **Real PostgreSQL adapter** (`Bun.SQL`, zero external deps) + `DATABASE_URL` one-paste connection parsing + full FK/reverse-FK/hover-peek/schema/EXPLAIN/cancel support (`server/db/postgres.ts`)
- [x] **OpenSSH TCP port-forwarding tunnels** (`ssh -N -L` with `~/.ssh/config` `ProxyJump` + `SSH_ASKPASS`, no remote Bun needed for TCP DBs) (`server/db/ssh-tunnel.ts`)
- [x] **Instant ad-hoc file opening** (`datadip ./app.db`, `POST /api/connections/open-file`, plus Finder double-click, Dock drop, and `Cmd+O` in `DataDip.app`)
- [x] **Full-result file export** (CSV, TSV, JSON, Markdown, SQL INSERT -- download to disk up to 100k rows, not clipboard-only or capped at current page / 2,000 rows) (`server/export.ts`, `POST /api/connections/:id/export`)
- [x] **Safe large-table browsing** (skip automatic exact `COUNT(*)` on large SQLite >50 MB & Postgres >50k-row tables, show estimated/unknown totals)
- [x] **README overhaul, screenshots/GIF & MIT LICENSE** (`LICENSE`, `README.md` with SQLite & PostgreSQL support on line 1, live demo GIF + screenshots, no ASON/internal jargon, `./install` disclosure, plus static marketing site in `site/`)
- [x] **Console result grid resize & sticky first-column freeze** (column drag-resize + double-click auto-fit + `Freeze 1st` toggle in both `TableView` and `ConsoleView`)
- [x] **Local SQLite live `.db` / `-wal` auto-refresh** (`fs.watch` + SSE `db-changed` + `Live` toggle in `TableView`, paused automatically while edits are staged)
- [x] **Keyboard shortcuts parity** (completed in `4c48d8d`: fixed `Cmd+[` / `Cmd+]` in editor, macOS Emacs keys, `Cmd+R` data refresh, `Cmd+C`/`Cmd+Shift+C`, `Cmd+S`, `Cmd+F`, `Cmd+P`, `Cmd+.` cancel, `Cmd+T`/`Cmd+W` tabs, console result grid nav)
- [x] **System dark mode default** (honor `prefers-color-scheme: dark` when no explicit theme preference is saved)
- [x] **Signed & notarized self-contained macOS `.dmg`** (`mac/build-dmg`, bundled `bun build --compile` server + Vite assets, `Install 'datadip' CLI...`, zero git clone / Bun / `swiftc` needed) -- still todo: `brew install --cask datadip`, GitHub Releases automation

---

## All 30 Desired Features by Persona

### Maya -- Startup Founding Engineer (Postgres + Litestream SQLite)
- [ ] 1. **Postgres adapter with full FK support** (schemas, enums, `jsonb`, arrays) for Neon/RDS production debugging.
- [ ] 2. **Save results to file (CSV/JSON)** streaming the full result to disk with no 2,000-row cap.
- [ ] 3. **Teammate-shareable links** resolved by connection name/alias instead of per-machine random connection IDs, with a "Copy link for teammate" button.
- [ ] 4. **Homebrew & signed-binary install with auto-update** (no manual Bun/`swiftc` or source clone).
- [ ] 5. **Ticket-to-row FK bookmarks**: save recurring multi-hop FK paths (`customer -> org -> subscription -> invoices`) as named views with an ID placeholder.

### Priya -- Staff Data & Analytics Engineer (Postgres Replicas + DuckDB + Warehouse)
- [ ] 6. **DuckDB adapter** (covering local Parquet, CSV, JSON files, plus DuckDB extensions).
- [ ] 7. **Postgres adapter honoring read-replica realities** (server-side query cancel, statement timeouts, schema-qualified autocomplete).
- [ ] 8. **Virtualized query-results grid with TableView's full toolkit** (cell viewer with pretty JSON, column resize/auto-fit, frozen first columns, keyboard range selection + `Cmd+C`) smooth at 100k rows x 80 columns.
- [ ] 9. **Full-result export (file or clipboard)** in CSV, TSV, JSON, Markdown, and SQL INSERT without visible-page or 2,000-row caps.
- [ ] 10. **One-keystroke column profiling** (null %, distinct count, min/max, top values) + **searchable cross-connection query history & saved SQL snippets**.

### Henrik -- Principal Backend/Platform Engineer (AWS RDS Aurora Postgres, Fintech)
- [ ] 11. **Aurora PostgreSQL investigation profile** showing endpoint, DB, schema, effective role, and reader/writer status together, with plain `EXPLAIN` first and separately confirmed `EXPLAIN (ANALYZE, BUFFERS)`.
- [ ] 12. **AWS-native verified connections**: AWS SSO-profile IAM token renewal, SSM port forwarding or OpenSSH `ProxyJump`, and real-endpoint TLS hostname/cert verification through local tunnels.
- [ ] 13. **Production browsing budget**: disable automatic exact `COUNT(*)` and reverse-FK counts on large tables (use estimates/unknown), stable composite-key cursors, disclose expensive sort fallbacks, enforce DB-side statement/lock timeouts with verified cancellation.
- [ ] 14. **Enforceable always-read-only production profile**: verify least-privilege DB role on connect, hide write-arm controls completely on RO profiles, and isolate writes to a separate short-lived connection (never shared across open tabs).
- [ ] 15. **Attributable audit trail with redaction**: export operator, target, role, query fingerprint, timing, outcome, cancellations, and privilege changes to central logs without storing sensitive literals locally.

### Tomasz -- Senior Multi-Client Full-Stack Consultant (40+ Client DBs)
- [ ] 16. **Working Postgres and MySQL/MariaDB profiles with `DATABASE_URL` paste & TLS review** (without exposing passwords).
- [ ] 17. **OpenSSH-backed TCP port-forwarding tunnels with `~/.ssh/config` alias picker** honoring `ProxyJump` and askpass to reach remote loopback / Docker-published ports with no remote Bun requirement.
- [ ] 18. **Client workspaces with folders, tags, and color-coding** keeping `Client > Environment > Database` visible in search, window title, and every console.
- [ ] 19. **Target-bound production write approval**: arm only the active console after typing/confirming the exact `Client / DB` name, re-locking automatically when switching targets.
- [ ] 20. **Table & whole-database dump/restore** using engine-native tools / consistent SQLite backups over saved tunnels, with side-by-side source vs destination confirmation so prod-to-staging cannot be reversed accidentally.

### Leo -- Weekend & Midnight Indie Hacker (Supabase, Turso, D1, Local SQLite)
- [ ] 21. **Zero-friction install & instant ad-hoc file open** (`brew install --cask datadip` / signed `.dmg` + `datadip ./dev.db` + drag-and-drop).
- [ ] 22. **One-paste `DATABASE_URL` & modern serverless drivers** (Supabase Postgres, Turso/libSQL, Cloudflare D1, PlanetScale).
- [ ] 23. **Interactive visual Schema / ER diagram**: pan/zoom table graph from foreign keys where clicking a table opens its data grid.
- [ ] 24. **Frictionless local dev data tools**: Duplicate Row, Import CSV/JSON, "Generate N mock rows" seeder, and optional Read-Write default for local non-prod DBs.
- [ ] 25. **Visual table & column builder (no-SQL DDL tweaks) + follow macOS `prefers-color-scheme`** by default instead of starting in light mode.

### Sora -- Senior macOS/iOS & Local-First Developer (GRDB/CoreData SQLite)
- [ ] 26. **Self-contained macOS app with native file & multi-tab/window workflow**: Finder double-click (`CFBundleDocumentTypes` + `application(_:open:)`), Dock drop, `Cmd+O` file picker, `datadip ./app.db`, unlimited table tabs, multi-window (`Cmd+N`), and `Cmd+W` closing the tab/window instead of quitting.
- [ ] 27. **Live WAL / file-change auto-refresh + iOS Simulator & macOS App Container discovery** (watch open `.db`/`-wal` files and include a Simulator / `~/Library/Containers` picker).
- [ ] 28. **Full on-demand BLOB inspector & Apple data formatters**: Hex/ASCII, UTF-8, inline image preview (PNG/JPEG/WebP/HEIC), `bplist00` & 16-byte UUID decoding, save BLOB to file, and CoreData `NSDate` (2001 epoch) hints.
- [ ] 29. **Complete SQLite internals & visual DDL**: expose triggers, group/hide FTS5 shadow tables, PRAGMA/WAL inspector (`user_version`, checkpoint, `VACUUM`), implicit `rowid` inline editing, and visual create/alter table & index editing with SQL preview.
- [ ] 30. **Working PostgreSQL adapter (with SSH tunnel + URI paste)** to inspect sync backends without keeping TablePlus installed.

---

## README, Branding, & Marketing Site Notes

- [ ] Lead `README.md` with supported engines on line 1 ("SQLite & PostgreSQL...") and an explicit support matrix (remove unimplemented drivers from UI dropdowns).
- [ ] Add hero app icon (`public/icon.svg`), dark/light screenshot, and a 15-second GIF of `Cmd+K` ID search -> hover FK -> click FK -> Back -> `PROD` badge.
- [ ] Remove unexplained ASON / URL-param / internal architecture jargon from the README hero; disclose remote Bun requirement (for SSH SQLite) and `./install` side effects upfront.
- [ ] Add a `LICENSE` file.
- [ ] Unify tone: keep the name "DataDip", pair it with a crisp speed + relationship-nav + production-safety tagline (avoid underselling craft with "utilitarian" or overpromising "native app" vs "lightweight WKWebView shell, no Electron").
- [ ] Keep GitHub-only until Postgres + signed `.dmg` / Homebrew cask ship; then launch a crisp single-page marketing site (optionally with an in-browser read-only sample DB demo).
