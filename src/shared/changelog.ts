// Structured release changelog shared by the in-app What's New modal and version badge.

export const APP_VERSION = '0.4.0'

export type ChangelogTag = 'new' | 'fix' | 'safety' | 'sql' | 'sqlite' | 'macos'

export interface ChangelogItem {
	tag: ChangelogTag
	title: string
	detail: string
	shortcut?: string
}

export interface ChangelogRelease {
	version: string
	date: string
	headline: string
	summary: string
	items: ChangelogItem[]
}

export const CHANGELOG: ChangelogRelease[] = [
	{
		version: '0.4.0',
		date: '2026-11-27',
		headline: 'Multi-Runtime SSH SQLite, Serverless SQLite (Turso & D1), & Passive FK Learning',
		summary:
			'Connect to remote SQLite over SSH without installing Bun (auto-detecting bun, python3, or sqlite3 CLI), query Turso/libSQL and Cloudflare D1 natively, and watch DataDip learn undeclared foreign keys automatically as you browse.',
		items: [
			{
				tag: 'sqlite',
				title: 'Multi-runtime SSH SQLite (auto / bun / python3 / sqlite3 CLI) + opt-in Bun install',
				detail:
					'Runs over one persistent SSH pipe without writing files to the remote host, auto-detecting bun -> python3 (stdlib sqlite3 with concurrent queries and conn.interrupt() cancellation) -> sqlite3 CLI (>= 3.33). Includes a per-connection runtime selector and an explicit user-confirmed "Install Bun" fallback when no runtime is present.',
			},
			{
				tag: 'sqlite',
				title: 'Serverless SQLite: Turso / libSQL & Cloudflare D1',
				detail:
					'Zero-dependency native HTTP adapters for Turso / libSQL (Hrana v2 /v2/pipeline with Bearer auth, PRAGMA query_only in Read-Only mode, atomic conditional batch transactions, and token masking) and Cloudflare D1 REST API.',
			},
			{
				tag: 'new',
				title: 'Passive ID-signature & PK-verified foreign-key learning',
				detail:
					'Fingerprints string/UUID/ULID/typed IDs from already-loaded browse and SELECT rows (zero upfront scans on connect), verifies candidate links via O(k log N) batched PK-index lookups, handles retroactive discovery and polymorphic drift, and lights up learned FKs live via SSE with provenance tooltips and Save/Dismiss actions.',
			},
			{
				tag: 'new',
				title: 'Upgraded schema FK inference (irregular plurals & unique PK names)',
				detail:
					'Tier 1 schema-only inference now handles irregular plurals and unique single-PK column name matches (e.g. course_id -> courses.course_id) with SQL type-family checks.',
			},
		],
	},
	{
		version: '0.3.0',
		date: '2026-11-26',
		headline: 'Signed macOS Self-Updater, Virtual & Inferred Foreign Keys, & Accurate Postgres Counts',
		summary:
			'DataDip.app now updates itself securely with Apple Developer ID verification, infers and links undeclared foreign keys across schemas and ER diagrams, and computes exact row counts for small Postgres tables.',
		items: [
			{
				tag: 'macos',
				title: 'Built-in signed macOS self-updater (DataDip -> Check for Updates…)',
				detail:
					'Checks GitHub Releases manually or passively every 12h (surfacing a subtle Update pill in the top bar), downloads the signed notarized DMG over HTTPS, verifies the Apple Developer ID signature and Team ID via SecStaticCodeCheckValidity, swaps the app bundle atomically, and relaunches cleanly.',
			},
			{
				tag: 'new',
				title: 'Automatic FK inference & configurable Virtual Foreign Keys',
				detail:
					'Infers undeclared <stem>_id / <stem>Id relationships automatically across tables with compatible PK types, and lets you link or dismiss custom foreign keys locally in connections.ason (even in Read-Only / Production mode) — reflected in table grids, hover peeks, reverse-FK counts, SQL results, and ER Diagram edges.',
			},
			{
				tag: 'fix',
				title: 'Accurate small-table Postgres row counts & clean large estimates',
				detail:
					'Probes small readable Postgres tables (<= 512 KB, LIMIT 1001) in one batched query for exact counts, displays floored lower bounds (1,000+, 14,100+, 1,920,000+) for larger tables, caches schema metadata per adapter for faster browsing, and fixes masked Postgres password display.',
			},
			{
				tag: 'macos',
				title: 'Styled Retina DMG installer & typographic baseline polish',
				detail:
					'Redesigned drag-to-Applications DMG with a Retina HiDPI background and aligned adjacent mixed-size text baselines across table headers, sidebar, and metadata rows.',
			},
		],
	},
	{
		version: '0.2.1',
		date: '2026-11-26',
		headline: 'PostgreSQL TLS Auto-Negotiation (Supabase / RDS / Cloud) & Upgrade Server Refresh',
		summary:
			'Critical hotfix making bare cloud PostgreSQL connection strings work out of the box and ensuring DataDip.app upgrades never stay attached to an older background server.',
		items: [
			{
				tag: 'fix',
				title: 'PostgreSQL defaults to sslmode=prefer (fixes Supabase / cloud Postgres)',
				detail:
					'Matches libpq by sending PostgreSQL SSLRequest when no sslmode/ssl query param is set: upgrades to TLS automatically for Supabase, RDS, Neon, and Render while seamlessly falling back to plaintext for local non-SSL Postgres.',
			},
			{
				tag: 'macos',
				title: 'Auto-restart stale background servers on DataDip.app upgrade',
				detail:
					'DataDip.app now checks /api/health version against the app bundle before joining an existing server, stopping any older background version automatically.',
			},
		],
	},
	{
		version: '0.2.0',
		date: '2026-11-26',
		headline: 'ER Diagram, 1-Key Column Profiling, Workspaces, & Locked Production Guardrails',
		summary:
			'Ten major upgrades for investigating schemas faster, organizing multi-client databases, locking down production replicas, and inspecting SQLite internals.',
		items: [
			{
				tag: 'new',
				title: 'Interactive Schema / ER Diagram',
				detail:
					'Pure-SVG pan/zoom table graph (/c/:id/er) with draggable table cards, PK/FK badges, Bezier foreign-key edges, hover neighborhood highlighting, search, and click-to-browse.',
			},
			{
				tag: 'new',
				title: 'One-keystroke column profiling',
				detail:
					'Press p on any focused column (or click Σ in a column header) for total/non-null/null %, distinct count, min/max, and top-10 proportional bars that filter the table on click.',
				shortcut: 'p',
			},
			{
				tag: 'sql',
				title: 'Cross-connection searchable query history',
				detail:
					'Filter executed SQL live in the Console History drawer across This DB or All DBs with source connection badges.',
			},
			{
				tag: 'safety',
				title: 'Enforceable alwaysReadOnly connection lock',
				detail:
					'Lock production read replicas permanently Read-Only: hides Write controls in the UI (LOCKED RO badge) and blocks RW arming on the server (403).',
			},
			{
				tag: 'safety',
				title: 'Target-bound production write approval',
				detail:
					'Arming Read-Write on Production now requires typing the exact database name and auto-relocks when switching databases or after 10 min idle.',
			},
			{
				tag: 'new',
				title: 'Client workspaces — folders, tags, & color-coding',
				detail:
					'Organize connections with workspace groups, #tags, and color accents across Home, connection switcher, window title, and Cmd+K search.',
			},
			{
				tag: 'new',
				title: '~/.ssh/config host alias picker',
				detail:
					'Pick saved SSH host aliases (including Include files) in Connection and Auto-Discover modals to autofill host, user, and port.',
			},
			{
				tag: 'new',
				title: 'Teammate-shareable slug links',
				detail:
					'Click Share in the top bar to copy /c/<db-name>/... URLs resolved by connection name/slug instead of machine-local IDs.',
			},
			{
				tag: 'new',
				title: 'Duplicate Row & transactional CSV/JSON Import',
				detail:
					'Duplicate any row from the Row Inspector (clearing single integer PKs) or import CSV/JSON files with column mapping and preview in a single transaction.',
			},
			{
				tag: 'sqlite',
				title: 'SQLite internals, Triggers, FTS5 grouping, & Apple discovery',
				detail:
					'Inspect Triggers in Schema view, collapse FTS5/RTree shadow tables automatically, view PRAGMA/WAL stats with RW-gated Checkpoint & VACUUM, and scan iOS Simulators & macOS App Containers.',
			},
			{
				tag: 'new',
				title: "In-app What's New & Changelog",
				detail:
					'Click the version pill in the top bar or search "Changelog" in Cmd+K to review release highlights anytime.',
			},
		],
	},
	{
		version: '0.1.0',
		date: '2026-11-26',
		headline: 'Initial Signed & Apple-Notarized Release for SQLite & PostgreSQL',
		summary:
			'Fast, keyboard-first database browser, foreign-key navigator, and parallel SQL console packaged as a lightweight WKWebView macOS app (no Electron).',
		items: [
			{
				tag: 'new',
				title: 'SQLite & PostgreSQL (local, direct TLS, & SSH)',
				detail:
					'Local SQLite (bun:sqlite), multiplexed SSH SQLite, native PostgreSQL via Bun.SQL (one-paste DATABASE_URL), and OpenSSH TCP tunnels (ssh -N -L) with in-app SSH_ASKPASS prompts.',
			},
			{
				tag: 'new',
				title: 'Web-native foreign-key navigation & Omnibar ID search',
				detail:
					'Hover FK cells to peek target rows, click to jump, inspect incoming Referenced By counts (Space), navigate with Back/Forward, and paste any ticket ID into Cmd+K to find it across every table.',
				shortcut: 'Cmd+K',
			},
			{
				tag: 'sql',
				title: 'Parallel, cancellable SQL Consoles & full exports',
				detail:
					'CodeMirror 6 tabbed and split consoles with schema autocomplete, SQL formatting, EXPLAIN, clickable FKs in results, real query cancel (Cmd+.), column resize/freeze, and 100k-row CSV/TSV/JSON/Markdown/SQL exports.',
				shortcut: 'Cmd+E',
			},
			{
				tag: 'safety',
				title: 'Read-Only by default & Production guardrails',
				detail:
					'Driver/transaction Read-Only enforcement, crimson Production banner with 10-minute auto-relock, staged inline edits with SQL preview, and destructive SQL confirmation.',
			},
			{
				tag: 'macos',
				title: 'Self-contained notarized macOS DataDip.app & live WAL refresh',
				detail:
					'Zero external dependencies, Finder double-click, Dock drop, Cmd+O file open, CLI opener (datadip ./app.db), and automatic live reload on .db/-wal changes.',
			},
		],
	},
]
