# DataDip macOS App (`mac/`)

Specific rules for `DataDip.app` (`mac/DataDip.swift`) and its
`WKWebView` integration.

- `WKWebView` error delegates (`didFailProvisionalNavigation`,
  `didFail`) must always ignore `NSURLErrorCancelled` (`-999`), because
  replacing the startup status HTML with the live URL (or reloading)
  cancels the prior provisional navigation and calling `showError` would
  abort the real page load.
- Set `config.preferences.tabFocusesLinks = true` on
  `WKWebViewConfiguration`, because macOS WebKit omits `<button>`,
  `<a>`, `<select>`, and checkboxes from Tab navigation by default when
  macOS Keyboard Navigation is off.
- Auto-restart `datadip serve` when the server goes down (via
  `WKScriptMessageHandler` `ensureServer` and connect-failure recovery).
- Never bind editor keys (`Cmd+[`, `Cmd+]`) as `NSMenu` key equivalents
  in `mac/DataDip.swift`, so CodeMirror indent/dedent continues to work.
- Remember that `Edit -> Select All` invokes `selectAll:` on the
  `WKWebView` directly, which selects the entire document when focus is
  on a non-input element like `<pre>` (read-only viewer popovers in the
  web client use `<textarea readonly>` for this reason).
- When bundling the server with `bun build --compile` (`mac/build-dmg`),
  `import.meta.url` inside the compiled executable resolves under
  `/$bunfs/root/`, while additional worker entrypoints keep their path
  relative to the common source root (e.g.
  `/$bunfs/root/db/sqlite-query-worker.js`). Never assume relative
  `new URL('./...', import.meta.url)` resolves identically in dev and
  compiled modes; branch on `import.meta.url.includes('/$bunfs/')` and
  smoke-test the signed binary directly.
- Sign `Contents/MacOS/datadip-server` with `--options runtime` and
  `mac/entitlements.plist` (Bun JavaScriptCore JIT entitlements) before
  signing `DataDip.app` so Apple notarization and Hardened Runtime pass.
- Before joining an already-running local server from `server.ason`,
  compare `/api/health`'s reported `version` against `Bundle.main`'s
  `CFBundleShortVersionString`; if they differ, stop the stale server
  and launch the bundled one so app upgrades never stay stuck on an
  older background server.
- Built-in self-updates (`mac/DataDip.swift`) must verify every staged
  `.app` bundle with `SecStaticCodeCheckValidity` (strict nested code,
  Apple Developer ID cert OIDs, matching `CFBundleIdentifier`, matching
  `TeamIdentifier` read from `Bundle.main`, and strictly newer semver)
  before calling `replaceItemAt`, enforce HTTPS-only redirects during
  download, fall back to opening the `.dmg` when the install path is not
  writable or ad-hoc signed, and suppress `ensureServerRunning` while
  swapping the bundle so SSE disconnect cannot respawn the old server.
