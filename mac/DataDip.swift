// DataDip.app: native macOS WKWebView shell around `datadip serve` with fast startup, auto-restart on disconnect, and swipe navigation.
import Cocoa
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let bundledServer: String? = {
	let path = "\(Bundle.main.bundlePath)/Contents/MacOS/datadip-server"
	return FileManager.default.isExecutableFile(atPath: path) ? path : nil
}()
let checkout = info["DataDipCheckout"] as? String ?? "\(NSHomeDirectory())/.datadip"
let bun = info["DataDipBun"] as? String ?? "\(NSHomeDirectory())/.bun/bin/bun"
let startWait: TimeInterval = 15

func dataDir() -> String {
	let a = CommandLine.arguments
	if let i = a.firstIndex(of: "--data"), i + 1 < a.count { return a[i + 1] }
	return "\(NSHomeDirectory())/.datadip/data"
}

func dataArgs() -> [String] {
	let a = CommandLine.arguments
	if let i = a.firstIndex(of: "--data"), i + 1 < a.count { return ["--data", a[i + 1]] }
	return []
}

// Fast non-interactive login shell env lookup (-lc avoids interactive prompt/compinit hangs).
func shellEnvironment() -> [String: String] {
	var env = ProcessInfo.processInfo.environment
	let p = Process()
	p.executableURL = URL(fileURLWithPath: env["SHELL"] ?? "/bin/zsh")
	p.arguments = ["-lc", "/usr/bin/env -0"]
	p.standardInput = FileHandle.nullDevice
	p.standardError = FileHandle.nullDevice
	let out = Pipe()
	p.standardOutput = out
	guard (try? p.run()) != nil else { return env }
	let killer = DispatchWorkItem { p.terminate() }
	DispatchQueue.global().asyncAfter(deadline: .now() + 3, execute: killer)
	let data = out.fileHandleForReading.readDataToEndOfFile()
	p.waitUntilExit()
	killer.cancel()
	guard p.terminationStatus == 0 else { return env }
	for entry in data.split(separator: 0) {
		guard let s = String(data: Data(entry), encoding: .utf8), let eq = s.firstIndex(of: "=") else { continue }
		env[String(s[..<eq])] = String(s[s.index(after: eq)...])
	}
	return env
}

final class Tail {
	private var data = Data()
	private let lock = NSLock()
	func clear() {
		lock.lock(); defer { lock.unlock() }
		data.removeAll()
	}
	func attach(_ p: Process) {
		let pipe = Pipe()
		p.standardOutput = pipe
		p.standardError = pipe
		pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
			let chunk = h.availableData
			if chunk.isEmpty { h.readabilityHandler = nil; return }
			self?.append(chunk)
		}
	}
	func append(_ chunk: Data) {
		lock.lock(); defer { lock.unlock() }
		data.append(chunk)
		if data.count > 16_384 { data = data.suffix(16_384) }
	}
	var text: String {
		lock.lock(); defer { lock.unlock() }
		return String(decoding: data, as: UTF8.self)
	}
}

func escapeHtml(_ s: String) -> String {
	s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
}

func statusPage(_ body: String) -> String {
	"<html><body style='background:#f7f7f8;color:#141518;font:13px -apple-system,ui-monospace,monospace;padding:2em;line-height:1.5'>\(body)</body></html>"
}

func extractHttpUrl(from text: String) -> URL? {
	for line in text.split(separator: "\n") {
		if let range = line.range(of: "http://127.0.0.1:") ?? line.range(of: "http://localhost:") {
			let tail = String(line[range.lowerBound...])
			let token = tail.split(whereSeparator: { $0 == " " || $0 == "'" || $0 == "\"" || $0 == "," || $0 == ")" }).first
			if let token, let u = URL(string: String(token)) { return u }
		}
	}
	return nil
}

func isHealthy(_ url: URL) -> Bool {
	guard let health = URL(string: "\(url.absoluteString)/api/health") else { return false }
	var req = URLRequest(url: health)
	req.timeoutInterval = 1.0
	let sem = DispatchSemaphore(value: 0)
	var ok = false
	URLSession.shared.dataTask(with: req) { _, resp, _ in
		if let http = resp as? HTTPURLResponse, http.statusCode == 200 { ok = true }
		sem.signal()
	}.resume()
	_ = sem.wait(timeout: .now() + 1.2)
	return ok
}

func readServerAsonUrl() -> URL? {
	let path = "\(dataDir())/server.ason"
	guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
	return extractHttpUrl(from: content)
}

func pathAndQuery(of url: URL?) -> String {
	guard let url, let scheme = url.scheme, scheme == "http" || scheme == "https" else { return "/" }
	let p = url.path.isEmpty ? "/" : url.path
	if let q = url.query, !q.isEmpty { return "\(p)?\(q)" }
	return p
}

func urlWithPath(_ base: URL, _ pathQuery: String) -> URL {
	let baseStr = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
	let suffix = pathQuery.hasPrefix("/") ? pathQuery : "/\(pathQuery)"
	return URL(string: baseStr + suffix) ?? base
}

final class ScriptBridge: NSObject, WKScriptMessageHandler {
	weak var app: App?
	init(_ app: App) { self.app = app }
	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		guard let body = message.body as? String, body == "ensureServer" else { return }
		app?.ensureServerRunning(forceReload: false, pathQuery: nil)
	}
}

// Adds Copy Page URL to every right-click menu, since WKWebView has no address bar.
final class DipWebView: WKWebView {
	override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
		super.willOpenMenu(menu, with: event)
		menu.addItem(.separator())
		menu.addItem(withTitle: "Copy Page URL", action: #selector(App.copyPageUrl(_:)), keyEquivalent: "")
	}
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
	var window: NSWindow!
	var web: WKWebView!
	var env: [String: String] = [:]
	var serve: Process?
	let serveOutput = Tail()
	var origin = ""
	var titleObs: NSKeyValueObservation?
	private let recoverLock = NSLock()
	private var recovering = false
	private var pendingOpenFile: String?

	func applicationDidFinishLaunching(_ note: Notification) {
		NSApp.mainMenu = buildMenu()
		let config = WKWebViewConfiguration()
		config.preferences.tabFocusesLinks = true
		config.userContentController.add(ScriptBridge(self), name: "datadip")
		web = makeWebView(config)
		window = makeWindow(web)
		titleObs = web.observe(\.title, options: [.new]) { [weak self] w, _ in
			guard let self, let t = w.title, !t.isEmpty else { return }
			DispatchQueue.main.async { self.window.title = t }
		}
		web.loadHTMLString(statusPage("DataDip is starting…"), baseURL: nil)
		NSApp.activate(ignoringOtherApps: true)
		DispatchQueue.global().async {
			self.env = shellEnvironment()
			self.ensureServerRunning(forceReload: true, pathQuery: "/")
		}
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

	func applicationWillTerminate(_ note: Notification) {
		guard let p = serve, p.isRunning else { return }
		let done = DispatchSemaphore(value: 0)
		p.terminationHandler = { _ in done.signal() }
		p.terminate()
		_ = done.wait(timeout: .now() + 5)
	}

	func datadip(_ args: [String]) -> Process {
		let p = Process()
		var runEnv = env
		if let serverBin = bundledServer {
			p.executableURL = URL(fileURLWithPath: serverBin)
			p.arguments = args + dataArgs()
			runEnv["DATADIP_ASSETS_DIR"] = Bundle.main.resourcePath ?? "\(Bundle.main.bundlePath)/Contents/Resources"
			p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
		} else {
			p.executableURL = URL(fileURLWithPath: bun)
			p.arguments = ["\(checkout)/server/index.ts"] + args + dataArgs()
			p.currentDirectoryURL = URL(fileURLWithPath: checkout)
		}
		p.environment = runEnv
		p.standardInput = FileHandle.nullDevice
		return p
	}

	func startServe() {
		serveOutput.clear()
		let p = datadip(["serve"])
		serveOutput.attach(p)
		do {
			try p.run()
			serve = p
		} catch {
			serveOutput.append(Data("cannot start \(bun): \(error)\n".utf8))
		}
	}

	func openUrl(_ base: URL, pathQuery: String = "/") {
		let target = urlWithPath(base, pathQuery)
		DispatchQueue.main.async {
			self.origin = "\(base.scheme ?? "http")://\(base.host ?? ""):\(base.port ?? 80)"
			if let pending = self.pendingOpenFile {
				self.pendingOpenFile = nil
				self.openDatabaseFile(pending)
				return
			}
			self.web.load(URLRequest(url: target))
		}
	}

	func application(_ sender: NSApplication, openFile filename: String) -> Bool {
		openDatabaseFile(filename)
		return true
	}

	func application(_ application: NSApplication, open urls: [URL]) {
		for url in urls where url.isFileURL {
			openDatabaseFile(url.path)
		}
	}

	func openDatabaseFile(_ path: String) {
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			guard !self.origin.isEmpty, let endpoint = URL(string: "\(self.origin)/api/connections/open-file") else {
				self.pendingOpenFile = path
				return
			}
			let escaped = path
				.replacingOccurrences(of: "\\", with: "\\\\")
				.replacingOccurrences(of: "'", with: "\\'")
			var req = URLRequest(url: endpoint)
			req.httpMethod = "POST"
			req.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
			req.httpBody = Data("{ path: '\(escaped)' }".utf8)
			req.timeoutInterval = 10

			let currentOrigin = self.origin
			URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
				guard let self else { return }
				let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
				let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
				if status >= 200 && status < 300,
				   let regex = try? NSRegularExpression(pattern: "\\bid\\s*:\\s*'([^']+)'"),
				   let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
				   let idRange = Range(match.range(at: 1), in: text),
				   let baseUrl = URL(string: currentOrigin) {
					let connId = String(text[idRange])
					let encoded = connId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? connId
					self.openUrl(baseUrl, pathQuery: "/c/\(encoded)")
					DispatchQueue.main.async {
						self.window.makeKeyAndOrderFront(nil)
						NSApp.activate(ignoringOtherApps: true)
					}
					return
				}
				var msg = err?.localizedDescription ?? "Could not open database file."
				if let regex = try? NSRegularExpression(pattern: "\\berror\\s*:\\s*'([^']+)'"),
				   let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
				   let errRange = Range(match.range(at: 1), in: text) {
					msg = String(text[errRange])
				}
				DispatchQueue.main.async {
					let alert = NSAlert()
					alert.messageText = "Cannot Open Database"
					alert.informativeText = "\(path)\n\n\(msg)"
					alert.alertStyle = .warning
					alert.runModal()
				}
			}.resume()
		}
	}

	@objc func openDatabaseDialog(_ sender: Any?) {
		let panel = NSOpenPanel()
		panel.title = "Open SQLite Database"
		panel.canChooseFiles = true
		panel.canChooseDirectories = false
		panel.allowsMultipleSelection = false
		if panel.runModal() == .OK, let url = panel.url {
			openDatabaseFile(url.path)
		}
	}

	@objc func installCli(_ sender: Any?) {
		guard let serverBin = bundledServer else { return }
		let binDir = "\(NSHomeDirectory())/.local/bin"
		let linkPath = "\(binDir)/datadip"
		let fm = FileManager.default
		do {
			try fm.createDirectory(atPath: binDir, withIntermediateDirectories: true)
			if fm.fileExists(atPath: linkPath) || (try? fm.attributesOfItem(atPath: linkPath)) != nil {
				try fm.removeItem(atPath: linkPath)
			}
			try fm.createSymbolicLink(atPath: linkPath, withDestinationPath: serverBin)
			let pathEnv = env["PATH"] ?? ""
			let inPath = pathEnv.split(separator: ":").contains { String($0) == binDir }
			let alert = NSAlert()
			alert.messageText = "Installed 'datadip' CLI"
			alert.informativeText = inPath
				? "Linked ~/.local/bin/datadip -> \(serverBin)\n\nRun 'datadip ./app.db' from any terminal."
				: "Linked ~/.local/bin/datadip -> \(serverBin)\n\nAdd ~/.local/bin to your PATH to run 'datadip ./app.db' from any terminal."
			alert.runModal()
		} catch {
			let alert = NSAlert()
			alert.messageText = "CLI Install Failed"
			alert.informativeText = error.localizedDescription
			alert.alertStyle = .warning
			alert.runModal()
		}
	}

	func showError(_ msg: String) {
		let log = serveOutput.text.trimmingCharacters(in: .whitespacesAndNewlines)
		let full = log.isEmpty ? msg : "\(msg)\n\ndatadip serve:\n\(log)"
		DispatchQueue.main.async {
			self.web.loadHTMLString(statusPage("<pre>\(escapeHtml(full))</pre>"), baseURL: nil)
		}
	}

	// Ensures a live server is reachable; restarts `datadip serve` if an external or owned server stopped.
	func ensureServerRunning(forceReload: Bool, pathQuery: String?) {
		recoverLock.lock()
		if recovering {
			recoverLock.unlock()
			return
		}
		recovering = true
		recoverLock.unlock()

		DispatchQueue.global().async {
			defer {
				self.recoverLock.lock()
				self.recovering = false
				self.recoverLock.unlock()
			}
			var savedPath = pathQuery ?? "/"
			var currentOrigin = ""
			DispatchQueue.main.sync {
				if pathQuery == nil {
					savedPath = pathAndQuery(of: self.web.url)
				}
				currentOrigin = self.origin
			}

			// Fast path: join an already-running DataDip server immediately
			if let existing = readServerAsonUrl(), isHealthy(existing) {
				let nextOrigin = "\(existing.scheme ?? "http")://\(existing.host ?? ""):\(existing.port ?? 80)"
				if forceReload || currentOrigin != nextOrigin {
					self.openUrl(existing, pathQuery: savedPath)
				}
				return
			}

			var needsStart = true
			DispatchQueue.main.sync {
				if let p = self.serve, p.isRunning { needsStart = false }
				if needsStart { self.startServe() }
			}
			self.join(forceReload: forceReload, pathQuery: savedPath, currentOrigin: currentOrigin)
		}
	}

	// Waits for the server URL from serve stdout or server.ason without spawning polling subprocesses.
	func join(forceReload: Bool, pathQuery: String, currentOrigin: String) {
		let deadline = Date().addingTimeInterval(startWait)
		var retried = false
		while Date() < deadline {
			if let u = extractHttpUrl(from: serveOutput.text) ?? readServerAsonUrl(), isHealthy(u) {
				let nextOrigin = "\(u.scheme ?? "http")://\(u.host ?? ""):\(u.port ?? 80)"
				if forceReload || currentOrigin != nextOrigin {
					openUrl(u, pathQuery: pathQuery)
				}
				return
			}
			if let p = serve, !p.isRunning {
				// If serve exited 0 ("already running") right as an old server shut down, retry once
				if p.terminationStatus == 0 && !retried {
					retried = true
					Thread.sleep(forTimeInterval: 0.2)
					if let u = readServerAsonUrl(), isHealthy(u) {
						let nextOrigin = "\(u.scheme ?? "http")://\(u.host ?? ""):\(u.port ?? 80)"
						if forceReload || currentOrigin != nextOrigin {
							openUrl(u, pathQuery: pathQuery)
						}
						return
					}
					DispatchQueue.main.sync { self.startServe() }
					continue
				}
				showError("DataDip server exited with status \(p.terminationStatus).")
				return
			}
			Thread.sleep(forTimeInterval: 0.05)
		}
		showError("DataDip did not start within \(Int(startWait)) s.")
	}

	func makeWebView(_ config: WKWebViewConfiguration) -> WKWebView {
		let w = DipWebView(frame: .zero, configuration: config)
		w.navigationDelegate = self
		w.uiDelegate = self
		w.allowsBackForwardNavigationGestures = true
		w.isInspectable = true
		return w
	}

	func makeWindow(_ view: NSView) -> NSWindow {
		let w = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		w.title = "DataDip"
		w.contentView = view
		w.isReleasedWhenClosed = false
		w.center()
		w.setFrameAutosaveName("DataDip")
		w.makeKeyAndOrderFront(nil)
		return w
	}

	@objc func goBack(_ sender: Any?) { web.goBack() }
	@objc func goForward(_ sender: Any?) { web.goForward() }
	@objc func newConsoleTab(_ sender: Any?) {
		guard let u = web.url, u.scheme == "http" || u.scheme == "https" else { return }
		web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('datadip:new-tab'))", completionHandler: nil)
	}
	@objc func closeTabOrWindow(_ sender: Any?) {
		guard let u = web.url, u.scheme == "http" || u.scheme == "https" else {
			window.performClose(sender)
			return
		}
		web.evaluateJavaScript("!window.dispatchEvent(new CustomEvent('datadip:close-tab', { cancelable: true }))") { [weak self] result, _ in
			let handled = (result as? Bool) ?? false
			if !handled {
				DispatchQueue.main.async { self?.window.performClose(sender) }
			}
		}
	}
	@objc func refreshData(_ sender: Any?) {
		if let u = web.url, u.scheme == "http" || u.scheme == "https" {
			web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('datadip:refresh'))", completionHandler: nil)
		} else {
			ensureServerRunning(forceReload: true, pathQuery: "/")
		}
	}
	@objc func reloadPage(_ sender: Any?) {
		if let u = web.url, u.scheme == "http" || u.scheme == "https" {
			web.reload()
		} else {
			ensureServerRunning(forceReload: true, pathQuery: "/")
		}
	}
	@objc func copyPageUrl(_ sender: Any?) {
		guard let u = web.url, u.scheme == "http" || u.scheme == "https" else { return }
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(u.absoluteString, forType: .string)
	}
	@objc func showChangelog(_ sender: Any?) {
		guard let u = web.url, u.scheme == "http" || u.scheme == "https" else { return }
		web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('datadip:changelog'))", completionHandler: nil)
	}
	@objc func showAbout(_ sender: Any?) {
		var options: [NSApplication.AboutPanelOptionKey: Any] = [:]
		if let u = web.url, u.scheme == "http" || u.scheme == "https", let host = u.host, let port = u.port {
			let origin = "\(u.scheme!)://\(host):\(port)"
			let credits = NSMutableAttributedString(string: "Web URL\n", attributes: [.font: NSFont.systemFont(ofSize: 11)])
			credits.append(NSAttributedString(string: origin, attributes: [.link: origin, .font: NSFont.systemFont(ofSize: 11)]))
			let center = NSMutableParagraphStyle()
			center.alignment = .center
			credits.addAttribute(.paragraphStyle, value: center, range: NSRange(location: 0, length: credits.length))
			options[.credits] = credits
		}
		NSApp.orderFrontStandardAboutPanel(options: options)
		NSApp.activate(ignoringOtherApps: true)
	}

	func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
		if let t = w.title, !t.isEmpty { window.title = t }
	}

	func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		let nsErr = error as NSError
		// Ignore superseded/cancelled navigations (e.g. initial "starting..." HTML replaced by live URL load).
		if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
		if nsErr.domain == NSURLErrorDomain && (
			nsErr.code == NSURLErrorCannotConnectToHost ||
			nsErr.code == NSURLErrorNetworkConnectionLost ||
			nsErr.code == NSURLErrorTimedOut
		) {
			let failingUrl = nsErr.userInfo[NSURLErrorFailingURLErrorKey] as? URL
			let savedPath = pathAndQuery(of: failingUrl)
			w.loadHTMLString(statusPage("Local DataDip server stopped — restarting…"), baseURL: nil)
			ensureServerRunning(forceReload: true, pathQuery: savedPath)
			return
		}
		showError("Failed to load DataDip UI:\n\(error.localizedDescription)")
	}

	func webView(_ w: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		let nsErr = error as NSError
		if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
		showError("Navigation error:\n\(error.localizedDescription)")
	}

	func buildMenu() -> NSMenu {
		let bar = NSMenu()
		func sub(_ title: String, _ items: [(String, Selector?, String)]) {
			let m = NSMenu(title: title)
			for (name, action, key) in items {
				if name == "-" { m.addItem(.separator()); continue }
				m.addItem(withTitle: name, action: action, keyEquivalent: key)
			}
			let item = NSMenuItem()
			item.submenu = m
			bar.addItem(item)
		}
		var appItems: [(String, Selector?, String)] = [
			("About DataDip", #selector(showAbout(_:)), ""),
			("What's New (Changelog)…", #selector(showChangelog(_:)), ""),
		]
		if bundledServer != nil {
			appItems.append(("Install 'datadip' CLI…", #selector(installCli(_:)), ""))
		}
		appItems += [
			("-", nil, ""),
			("Hide DataDip", #selector(NSApplication.hide(_:)), "h"),
			("-", nil, ""),
			("Quit DataDip", #selector(NSApplication.terminate(_:)), "q"),
		]
		sub("DataDip", appItems)
		sub("File", [
			("Open Database File…", #selector(openDatabaseDialog(_:)), "o"),
			("New Console Tab", #selector(newConsoleTab(_:)), "t"),
			("-", nil, ""),
			("Close Tab", #selector(closeTabOrWindow(_:)), "w"),
			("Close Window", #selector(NSWindow.performClose(_:)), "W"),
		])
		sub("Edit", [
			("Undo", Selector(("undo:")), "z"),
			("Redo", Selector(("redo:")), "Z"),
			("-", nil, ""),
			("Cut", #selector(NSText.cut(_:)), "x"),
			("Copy", #selector(NSText.copy(_:)), "c"),
			("Paste", #selector(NSText.paste(_:)), "v"),
			("Select All", #selector(NSText.selectAll(_:)), "a"),
			("-", nil, ""),
			("Copy Page URL", #selector(copyPageUrl(_:)), "l"),
		])
		sub("View", [
			("Refresh Data", #selector(refreshData(_:)), "r"),
			("Reload Page", #selector(reloadPage(_:)), "R"),
		])
		sub("Navigate", [
			("Back", #selector(goBack(_:)), ""),
			("Forward", #selector(goForward(_:)), ""),
		])
		sub("Window", [
			("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
		])
		return bar
	}
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
