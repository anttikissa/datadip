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
