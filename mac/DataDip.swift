// DataDip.app: native macOS WKWebView shell around `datadip serve` with back/forward swipe and shortcut support.
import Cocoa
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let checkout = info["DataDipCheckout"] as? String ?? "\(NSHomeDirectory())/.datadip"
let bun = info["DataDipBun"] as? String ?? "\(NSHomeDirectory())/.bun/bin/bun"
let startWait: TimeInterval = 20

func dataArgs() -> [String] {
	let a = CommandLine.arguments
	if let i = a.firstIndex(of: "--data"), i + 1 < a.count { return ["--data", a[i + 1]] }
	return []
}

func shellEnvironment() -> [String: String] {
	var env = ProcessInfo.processInfo.environment
	let p = Process()
	p.executableURL = URL(fileURLWithPath: env["SHELL"] ?? "/bin/zsh")
	p.arguments = ["-ilc", "/usr/bin/env -0"]
	p.standardInput = FileHandle.nullDevice
	p.standardError = FileHandle.nullDevice
	let out = Pipe()
	p.standardOutput = out
	guard (try? p.run()) != nil else { return env }
	let killer = DispatchWorkItem { p.terminate() }
	DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: killer)
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
	"<html><body style='background:#f4f5f7;color:#161616;font:13px ui-monospace,monospace;padding:2em'>\(body)</body></html>"
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
	var window: NSWindow!
	var web: WKWebView!
	var env: [String: String] = [:]
	var serve: Process?
	let serveOutput = Tail()
	var origin = ""

	func applicationDidFinishLaunching(_ note: Notification) {
		NSApp.mainMenu = buildMenu()
		web = makeWebView(WKWebViewConfiguration())
		window = makeWindow(web)
		web.loadHTMLString(statusPage("DataDip is starting…"), baseURL: nil)
		NSApp.activate(ignoringOtherApps: true)
		DispatchQueue.global().async {
			self.env = shellEnvironment()
			DispatchQueue.main.sync { self.startServe() }
			self.join()
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
		p.executableURL = URL(fileURLWithPath: bun)
		p.arguments = ["\(checkout)/server/index.ts"] + args + dataArgs()
		p.environment = env
		p.currentDirectoryURL = URL(fileURLWithPath: checkout)
		p.standardInput = FileHandle.nullDevice
		return p
	}

	func startServe() {
		let p = datadip(["serve"])
		serveOutput.attach(p)
		do {
			try p.run()
			serve = p
		} catch {
			serveOutput.append(Data("cannot start \(bun): \(error)\n".utf8))
		}
	}

	func join() {
		let deadline = Date().addingTimeInterval(startWait)
		var lastErr = ""
		while Date() < deadline {
			let p = datadip(["url"])
			let out = Pipe(), err = Pipe()
			p.standardOutput = out
			p.standardError = err
			if (try? p.run()) != nil {
				let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
				lastErr = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
				p.waitUntilExit()
				let line = text.split(separator: "\n").first { $0.hasPrefix("Local: ") }
				if p.terminationStatus == 0,
				   let addr = line?.split(separator: " ", maxSplits: 1).last,
				   let u = URL(string: String(addr))
				{
					DispatchQueue.main.async {
						self.origin = "\(u.scheme ?? "http")://\(u.host ?? ""):\(u.port ?? 80)"
						self.web.load(URLRequest(url: u))
					}
					return
				}
			} else {
				lastErr = "cannot run \(bun)\n"
			}
			Thread.sleep(forTimeInterval: 0.1)
		}
		let msg = "DataDip did not start within \(Int(startWait)) s.\n\ndatadip url:\n\(lastErr)\ndatadip serve:\n\(serveOutput.text)"
		DispatchQueue.main.async { self.web.loadHTMLString(statusPage("<pre>\(escapeHtml(msg))</pre>"), baseURL: nil) }
	}

	func makeWebView(_ config: WKWebViewConfiguration) -> WKWebView {
		let w = WKWebView(frame: .zero, configuration: config)
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
	@objc func reloadPage(_ sender: Any?) { web.reload() }

	func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
		if let t = w.title, !t.isEmpty { window.title = t }
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
		sub("DataDip", [
			("Hide DataDip", #selector(NSApplication.hide(_:)), "h"),
			("-", nil, ""),
			("Quit DataDip", #selector(NSApplication.terminate(_:)), "q"),
		])
		sub("Edit", [
			("Undo", Selector(("undo:")), "z"),
			("Redo", Selector(("redo:")), "Z"),
			("-", nil, ""),
			("Cut", #selector(NSText.cut(_:)), "x"),
			("Copy", #selector(NSText.copy(_:)), "c"),
			("Paste", #selector(NSText.paste(_:)), "v"),
			("Select All", #selector(NSText.selectAll(_:)), "a"),
		])
		sub("Navigate", [
			("Back", #selector(goBack(_:)), "["),
			("Forward", #selector(goForward(_:)), "]"),
			("-", nil, ""),
			("Reload", #selector(reloadPage(_:)), "r"),
		])
		sub("Window", [
			("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
			("Close", #selector(NSWindow.performClose(_:)), "w"),
		])
		return bar
	}
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
