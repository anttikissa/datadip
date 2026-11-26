# DataDip

A fast, utilitarian database browser, foreign-key navigator, and SQL
console IDE for local and SSH-remote databases.

## Features

- **URL-driven Table Browser**: Browse tables with filter chips, column
  picker (`fields=...`), multi-sort (`order=...`), and keyset pagination
  (`start=...`). Click foreign-key cells to follow links across tables
  using normal browser Back/Forward history (`Cmd+[` / `Cmd+]`, trackpad
  swipe).
- **FK Hover Peek & Reverse FKs**: Hover foreign-key cells to preview the
  target row without leaving your grid. Open the Row Inspector (`Space`)
  to see formatted JSON/ASON, timestamps, outgoing FKs, and incoming
  ("Referenced by") counts across other tables.
- **SQL Console (`Cmd+Shift+L` / `Cmd+E`)**: Auto-saved multi-statement
  documents with CodeMirror 6, SQLite syntax highlighting, live schema
  autocomplete, custom SQL linter, SQL formatter (`Cmd+Shift+F`),
  active-statement highlighting (`Cmd+Enter` runs the statement under
  cursor; `Cmd+Shift+Enter` runs all), `EXPLAIN QUERY PLAN`
  (`Cmd+Shift+E`), and clickable FK cells directly inside query results.
- **Production Safety**: Mark connections as Production for a persistent
  crimson header bar and `PROD` alert badge. Every connection opens
  Read-Only by default (enforced both in SQLite handle flags and server
  validation). Arming Read-Write on Production auto-relocks after 10
  minutes idle. Destructive SQL requires confirmation on every database.
- **Multiplexed SSH Access**: Connects once per SSH host to a lightweight
  remote Bun worker so concurrent queries execute in milliseconds without
  spawning a new SSH process per query. Includes an Auto-Discover wizard
  for local and SSH hosts.
- **Omnibar (`Cmd+K`)**: Jump to tables, columns, consoles, or
  connections — or paste an ID to locate matching rows across tables.

## Install & Run

```sh
./install
datadip            # start server and open in browser
datadip stop       # stop the background server
datadip serve      # run server in foreground (default 127.0.0.1:4747)
open -a DataDip    # launch the native macOS app
```

## Development

```sh
bun install
bun run serve      # API server on :4747
bun run dev        # Vite HMR client on :4748
./test             # typecheck + unit tests
```
