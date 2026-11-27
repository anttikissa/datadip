# DataDip

A utilitarian database browser, foreign-key navigator, and SQL console
IDE for local and SSH-remote databases (SQLite first, adapter-ready for
Postgres). Runs as a localhost web server and native macOS WKWebView app
(`DataDip.app`). Read DECISIONS.md before changing behavior. Record each
new decision there, by topic. When working on `mac/`, also read
`mac/AGENTS.md`.

## General coding guidance

Climb the lazy ladder: skip code that need not exist; prefer the
standard library, native platform features (Bun, Web APIs), installed
dependencies, one line, then the minimum code that works. Never cut
trust-boundary validation, data-loss handling, security,
accessibility or explicit requirements.

Use as few dependencies as possible, above all ones that reach users
(the server at runtime, the client bundle); dev-only type packages
such as `@types/bun` are fine. No new dependency without the user's
approval.

Avoid defensive, just-in-case code. Rate how often each case occurs:
always, often, sometimes, rarely, almost never or practically never.
For a case rated "rarely" or below, ask the user whether to handle it
before you write code for it.

Generalize every bug fix. Find the root cause: the design choice or
missing rule that made this bug possible. Search for its other
instances, fix them, or list them for the user if the fix is not
straightforward. Then add a rule to this file (or `mac/AGENTS.md` for
macOS app rules) that prevents the whole class of bugs. State to the
user which rule you added. If no rule can prevent it, say why.

Start each source file with a comment that says why the module exists.

Ids come from `tid()`, secrets (sessions, tokens) from `secretId()`.
Never use UUIDs or a hand-written random string. Raw random bytes are
only for crypto keys, IVs, salts and protocol fields.

Make random ids and secrets as short as their use allows. Size each one
from how many valid values exist, how long they live and how fast an
attacker can guess (rate limits cut the odds a lot); a temporary image
URL needs only enough characters to stop guessing. One-time codes can
be shortest: 4 base32 characters have the entropy of 6 digits.

Encode alphanumeric ids and codes in Crockford base32: write lower
case, read leniently (any case; o as 0; i and l as 1).

Store and send data as ASON. Use UUIDs or JSON only where an external
system's protocol requires them.

Stack: Bun, bun:sqlite, TypeScript. Format with `bunx oxfmt`.
Typecheck with `bun check`.

## Specific coding details

Reference rules for agents (humans can skip this section).

Open every SQLite database with `PRAGMA busy_timeout=5000;` BEFORE
`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`. Without
`busy_timeout` set first, concurrent openers crash with
`SQLITE_BUSY_RECOVERY` during WAL initialization/recovery; without
WAL+NORMAL, the default mode waits for disk on every write.

CLI probe and control commands (`url`, `status`, `open`, `stop`, and the
duplicate-server check in `serve`) must read only `server.ason` via
`readServerInfo()` and never instantiate `DataStore`, open `state.db`,
or start file watchers.

Never let the connection to the local DataDip server fail or hang
silently, and never hold per-tab persistent HTTP/1.1 connections (such
as `EventSource` SSE) against localhost: browsers cap plaintext HTTP/1.1
at 6 concurrent connections per origin, so 6 open tabs deadlock every
`fetch()` and page load. Use WebSocket (`/api/ws`) with a fast connect
timeout (2.5s) and active `ping`/`pong` heartbeat watchdog (5s/3s), fail
fast on local API calls (5s timeout on local metadata routes; 2.5s
`/api/health` liveness probe on slow DB/SSH routes), cap legacy
`/api/events` SSE streams well below 6, and immediately surface an
offline/unresponsive alert banner and clear error state whenever the
local server stops responding.

In the web client, trap and wrap `Tab` / `Shift-Tab` across visible
focusable descendants of the topmost open `dialog:modal` so focus never
escapes to `document.body` or lands on the `<dialog>` container itself
in WebKit or Safari.

In the SolidJS web client, every controlled `<select>` whose `<option>`
or `<optgroup>` children are rendered dynamically (`<For>` / `<Show>`)
must set `selected={...}` on each `<option>` AND sync `el.value` in a
`createEffect` tracking both the selected value and the options list,
because replacing `<option>` DOM nodes resets the browser's
`selectedIndex` to `0`.

Read-only text viewer popovers (e.g. `CellViewer`) must render selectable
text in an auto-focused `<textarea readonly>` (and handle `Cmd/Ctrl+A`),
because `WKWebView`'s `Edit -> Select All` invokes `selectAll:` directly
and selects the entire document when focus is on a non-input element
like `<pre>`.

Adjacent text on the same horizontal row (especially mixed font sizes,
weights, or metadata like column names beside types, counts, dates, or
inline badges) must share a typographic baseline (`align-items: baseline`),
never `align-items: center`. When a row mixes text with icons, dots,
checkboxes, or icon buttons, keep `align-items: baseline` on the flex
container and put `align-self: center` on the non-text graphics/controls
(and inside pill tags containing an icon, use `align-items: baseline`
with `svg { align-self: center }` so the tag exports its text baseline).

Always use `isPrimaryMod(e)` (`src/lib/shortcuts.ts`) rather than
`e.metaKey || e.ctrlKey` for app shortcuts so macOS Emacs editing keys
(`Ctrl+A/E/K/B/L/P/N`) stay free; never intercept browser-owned
shortcuts (`Cmd+L`, `Cmd+R`, `Cmd+T`, `Cmd+W`) outside `DataDip.app`;
and never hijack editor keys (`Cmd+[`, `Cmd+]`) in capture-phase JS
listeners when `isEditableTarget(e.target)` is true.

PostgreSQL connections via `Bun.SQL` must default to `sslmode=prefer`
when neither `sslmode` nor `ssl` is present in the URL, matching
`libpq` (send `SSLRequest` first, upgrade to TLS when supported, and
fall back to plaintext when the server replies `'N'`). Only pass an
explicit `tls` object to `new SQL(...)` when TLS is explicitly
required (e.g. SNI over SSH tunnels), because setting `tls` disables
`sslmode=prefer` plaintext fallback in `Bun.SQL`.

Never assign non-ASCII characters (such as `'••••'`) directly to
`URL.password` before calling `url.toString()`, because the WHATWG URL
serializer percent-encodes them (e.g. `%E2%80%A2`). Assign an ASCII
sentinel to `u.password` and replace it after `u.toString()`.

Never embed raw POSIX shell or Python scripts containing `${...}` or
backticks inside a `String.raw` template literal (template literals
still parse `${` and `` ` ``); build shell scripts as joined string
arrays (`[...].join('\n')`), avoid backticks/nested quotes/backslashes
inside Python f-string `{...}` expressions so Python 3.8-3.11 stay
compatible, and verify embedded scripts with `python3` / `sh -n`.

Never display raw `pg_class.reltuples` as an unqualified table row count
in PostgreSQL: autovacuum leaves small tables stale or `-1` until
`ANALYZE` runs. Probe small readable regular tables (`<= 512 KB`) in one
batched bounded query (`LIMIT 1001`) for exact counts, fall back to
`pg_stat_all_tables.n_live_tup` (then `reltuples`) for larger tables,
and mark estimated counts explicitly (`rowCountEstimated` -> `14,100+`,
`1,920,000+`).

## Tests

`./test` runs `bun check` beside `bun test --parallel`; run it for
every change.

Tests are maintenance debt; add one only if it catches a plausible
regression worth its cost. Keep full suites for self-contained modules
that could be libraries, for contracts between parts (API, stored
data, sync) and for trust boundaries. Write no tests for experimental
code; all UI code starts experimental.

Tests never use the network. Delete a flaky test; never retry it,
lengthen its timeout or skip it. Test behavior, not source text.

## Git

Commit as soon as each change works and is verified; don't leave
finished work uncommitted. Several agents share this checkout, so stage
and commit only your own changes: name files explicitly (never
`git add -A` or `.`), and when a file also holds someone else's edits,
stage only your hunks.

Wrap commit messages at 72 columns. End with these trailers:

    Implemented by: <model id>
    Session: <session id>

Keep in sync with GitHub: after every commit, run `git pull --rebase`
and then `git push`.

The repository is public. Never write a private host name or a path on
someone's machine (a home folder, a checkout) into a file, a commit or
a commit message. Use example.com in examples.

## Secrets

Secrets live in gitignored `.env.dev` and `.env.prod` (mode 600),
which hold only secrets; `config.ts` reads them. Never read them,
print them or log their values; the server logs only the names of
missing keys.
