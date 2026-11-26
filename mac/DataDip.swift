// DataDip.app: native macOS WKWebView shell around `datadip serve` with fast startup, auto-restart on disconnect, swipe navigation, and signed self-updates.
import Cocoa
import Security
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let appVersion = info["CFBundleShortVersionString"] as? String
let appBundleId = Bundle.main.bundleIdentifier ?? "dev.datadip.app"
let bundledServer: String? = {
	let path = "\(Bundle.main.bundlePath)/Contents/MacOS/datadip-server"
	return FileManager.default.isExecutableFile(atPath: path) ? path : nil
}()
let checkout = info["DataDipCheckout"] as? String ?? "\(NSHomeDirectory())/.datadip"
let bun = info["DataDipBun"] as? String ?? "\(NSHomeDirectory())/.bun/bin/bun"
let startWait: TimeInterval = 15

let updateRepo = "anttikissa/datadip"
let updateReleasesUrl = "https://github.com/\(updateRepo)/releases"
let updateApiLatestUrl = "https://api.github.com/repos/\(updateRepo)/releases/latest"
let updateWebLatestUrl = "https://github.com/\(updateRepo)/releases/latest"
let updateCheckInterval: TimeInterval = 12 * 3600
let updateLastCheckKey = "DataDipLastUpdateCheckAt"

#if arch(arm64)
let currentArch = "arm64"
#elseif arch(x86_64)
let currentArch = "x86_64"
#else
let currentArch = "arm64"
#endif

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

struct HealthStatus {
	let ok: Bool
	let version: String?
}

func probeHealth(_ url: URL) -> HealthStatus {
	guard let health = URL(string: "\(url.absoluteString)/api/health") else { return HealthStatus(ok: false, version: nil) }
	var req = URLRequest(url: health)
	req.timeoutInterval = 1.0
	let sem = DispatchSemaphore(value: 0)
	var status = HealthStatus(ok: false, version: nil)
	URLSession.shared.dataTask(with: req) { data, resp, _ in
		if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
			var ver: String? = nil
			if let data, let text = String(data: data, encoding: .utf8),
			   let regex = try? NSRegularExpression(pattern: "\\bversion\\s*:\\s*'([^']+)'"),
			   let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
			   let r = Range(match.range(at: 1), in: text) {
				ver = String(text[r])
			}
			status = HealthStatus(ok: true, version: ver)
		}
		sem.signal()
	}.resume()
	_ = sem.wait(timeout: .now() + 1.2)
	return status
}

func isHealthy(_ url: URL) -> Bool {
	probeHealth(url).ok
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

struct Semver: Comparable {
	let major: Int
	let minor: Int
	let patch: Int
	let prerelease: String?

	init?(_ raw: String) {
		var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
		if let plus = s.firstIndex(of: "+") { s = String(s[..<plus]) }
		var pre: String? = nil
		if let dash = s.firstIndex(of: "-") {
			let tail = String(s[s.index(after: dash)...])
			if !tail.isEmpty { pre = tail }
			s = String(s[..<dash])
		}
		let parts = s.split(separator: ".", omittingEmptySubsequences: false)
		guard parts.count >= 2, parts.count <= 3,
		      let maj = Int(parts[0]), let min = Int(parts[1]),
		      maj >= 0, min >= 0 else { return nil }
		let pat: Int
		if parts.count == 3 {
			guard let p = Int(parts[2]), p >= 0 else { return nil }
			pat = p
		} else {
			pat = 0
		}
		self.major = maj
		self.minor = min
		self.patch = pat
		self.prerelease = pre
	}

	var normalized: String {
		let core = "\(major).\(minor).\(patch)"
		if let pre = prerelease { return "\(core)-\(pre)" }
		return core
	}

	static func < (lhs: Semver, rhs: Semver) -> Bool {
		if lhs.major != rhs.major { return lhs.major < rhs.major }
		if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
		if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
		switch (lhs.prerelease, rhs.prerelease) {
		case (nil, nil), (nil, .some): return false
		case (.some, nil): return true
		case (.some(let a), .some(let b)): return a.compare(b, options: .numeric) == .orderedAscending
		}
	}
}

struct UpdateInfo {
	let version: String
	let assetName: String
	let downloadUrl: URL
	let releaseUrl: URL
	let assetSize: Int64?
	let notes: String
}

enum UpdateError: LocalizedError {
	case message(String)
	var errorDescription: String? {
		switch self {
		case .message(let m): return m
		}
	}
}

func currentBundleTeamId() -> String? {
	var code: SecCode?
	guard SecCodeCopySelf([], &code) == errSecSuccess, let selfCode = code else { return nil }
	var staticCode: SecStaticCode?
	guard SecCodeCopyStaticCode(selfCode, [], &staticCode) == errSecSuccess, let sc = staticCode else { return nil }
	var infoCF: CFDictionary?
	guard SecCodeCopySigningInformation(sc, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
	      let signingInfo = infoCF as? [String: Any] else { return nil }
	let team = signingInfo[kSecCodeInfoTeamIdentifier as String] as? String
	return (team?.isEmpty == false) ? team : nil
}

func isAllowedUpdateUrl(_ url: URL) -> Bool {
	guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
	return host == "github.com"
		|| host == "api.github.com"
		|| host.hasSuffix(".github.com")
		|| host.hasSuffix(".githubusercontent.com")
}

func canReplaceInPlace(_ appUrl: URL) -> Bool {
	let path = appUrl.path
	if path.contains("/AppTranslocation/") || path.hasPrefix("/Volumes/") { return false }
	if let vals = try? appUrl.resourceValues(forKeys: [.volumeIsReadOnlyKey]), vals.volumeIsReadOnly == true {
		return false
	}
	let fm = FileManager.default
	let parent = appUrl.deletingLastPathComponent().path
	return fm.isWritableFile(atPath: path) && fm.isWritableFile(atPath: parent)
}

func verifyCandidateApp(_ candidateUrl: URL, expectedVersion: String, expectedBundleId: String, expectedTeamId: String) throws {
	let plistUrl = candidateUrl.appendingPathComponent("Contents/Info.plist")
	guard let plistData = try? Data(contentsOf: plistUrl),
	      let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any] else {
		throw UpdateError.message("Downloaded app is missing a valid Info.plist.")
	}
	guard let candBundleId = plist["CFBundleIdentifier"] as? String, candBundleId == expectedBundleId else {
		throw UpdateError.message("Bundle identifier mismatch in downloaded update.")
	}
	guard let candVersion = plist["CFBundleShortVersionString"] as? String,
	      let candSemver = Semver(candVersion),
	      let expectedSemver = Semver(expectedVersion),
	      candSemver == expectedSemver else {
		throw UpdateError.message("Downloaded app version does not match expected v\(expectedVersion).")
	}
	if let curVer = appVersion, let curSemver = Semver(curVer), !(candSemver > curSemver) {
		throw UpdateError.message("Refusing downgrade from v\(curVer) to v\(candVersion).")
	}

	let fm = FileManager.default
	let appBin = candidateUrl.appendingPathComponent("Contents/MacOS/DataDip").path
	let srvBin = candidateUrl.appendingPathComponent("Contents/MacOS/datadip-server").path
	guard fm.isExecutableFile(atPath: appBin), fm.isExecutableFile(atPath: srvBin) else {
		throw UpdateError.message("Downloaded app bundle is incomplete (missing DataDip binaries).")
	}

	var staticCode: SecStaticCode?
	let createStatus = SecStaticCodeCreateWithPath(candidateUrl as CFURL, [], &staticCode)
	guard createStatus == errSecSuccess, let sc = staticCode else {
		throw UpdateError.message("Could not inspect code signature (OSStatus \(createStatus)).")
	}
	// Require strict nested code validity + Apple Developer ID Application cert + exact bundle ID & Team ID.
	let reqString = "identifier \"\(expectedBundleId)\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"\(expectedTeamId)\""
	var requirement: SecRequirement?
	let reqStatus = SecRequirementCreateWithString(reqString as CFString, [], &requirement)
	guard reqStatus == errSecSuccess, let req = requirement else {
		throw UpdateError.message("Could not build code-signing requirement (OSStatus \(reqStatus)).")
	}
	let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
	let validStatus = SecStaticCodeCheckValidity(sc, flags, req)
	guard validStatus == errSecSuccess else {
		let desc = (SecCopyErrorMessageString(validStatus, nil) as String?) ?? "OSStatus \(validStatus)"
		throw UpdateError.message("Code signature verification failed: \(desc)")
	}
}

final class HttpsOnlyRedirectDelegate: NSObject, URLSessionTaskDelegate {
	func urlSession(
		_ session: URLSession,
		task: URLSessionTask,
		willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest,
		completionHandler: @escaping (URLRequest?) -> Void
	) {
		if request.url?.scheme?.lowercased() == "https" {
			completionHandler(request)
		} else {
			completionHandler(nil)
		}
	}
}

final class UpdateDownloader: NSObject, URLSessionDownloadDelegate, URLSessionTaskDelegate {
	private let destUrl: URL
	private let onProgress: (Int64, Int64) -> Void
	private let onComplete: (Result<URL, Error>) -> Void
	private let lock = NSLock()
	private var finished = false
	private var session: URLSession?
	private var task: URLSessionDownloadTask?

	init(destUrl: URL, onProgress: @escaping (Int64, Int64) -> Void, onComplete: @escaping (Result<URL, Error>) -> Void) {
		self.destUrl = destUrl
		self.onProgress = onProgress
		self.onComplete = onComplete
		super.init()
	}

	func start(_ url: URL) {
		let cfg = URLSessionConfiguration.ephemeral
		cfg.timeoutIntervalForRequest = 30
		cfg.timeoutIntervalForResource = 600
		let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
		self.session = s
		var req = URLRequest(url: url)
		req.setValue("DataDip/\(appVersion ?? "0")", forHTTPHeaderField: "User-Agent")
		let t = s.downloadTask(with: req)
		self.task = t
		t.resume()
	}

	func cancel() {
		task?.cancel()
		session?.invalidateAndCancel()
	}

	func urlSession(
		_ session: URLSession,
		task: URLSessionTask,
		willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest,
		completionHandler: @escaping (URLRequest?) -> Void
	) {
		if request.url?.scheme?.lowercased() == "https" {
			completionHandler(request)
		} else {
			completionHandler(nil)
		}
	}

	func urlSession(
		_ session: URLSession,
		downloadTask: URLSessionDownloadTask,
		didWriteData bytesWritten: Int64,
		totalBytesWritten: Int64,
		totalBytesExpectedToWrite: Int64
	) {
		onProgress(totalBytesWritten, totalBytesExpectedToWrite)
	}

	func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
		if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
			finish(.failure(UpdateError.message("Download failed with HTTP \(http.statusCode).")))
			return
		}
		do {
			try? FileManager.default.removeItem(at: destUrl)
			try FileManager.default.moveItem(at: location, to: destUrl)
			finish(.success(destUrl))
		} catch {
			finish(.failure(error))
		}
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		if let error { finish(.failure(error)) }
	}

	private func finish(_ result: Result<URL, Error>) {
		lock.lock()
		if finished { lock.unlock(); return }
		finished = true
		lock.unlock()
		session?.finishTasksAndInvalidate()
		onComplete(result)
	}
}

func formatMegabytes(_ bytes: Int64) -> String {
	String(format: "%.1f MB", Double(bytes) / 1_048_576.0)
}

func summarizeReleaseNotes(_ raw: String) -> String {
	let lines = raw
		.replacingOccurrences(of: "\r\n", with: "\n")
		.split(separator: "\n", omittingEmptySubsequences: false)
		.map { line -> String in
			var s = String(line).trimmingCharacters(in: .whitespaces)
			while s.hasPrefix("#") { s.removeFirst() }
			return s.trimmingCharacters(in: .whitespaces)
		}
		.filter { !$0.isEmpty && !$0.hasPrefix("SHA-256") && !$0.hasPrefix("```") }
	let joined = lines.prefix(6).joined(separator: "\n")
	if joined.count <= 420 { return joined }
	let idx = joined.index(joined.startIndex, offsetBy: 417)
	return String(joined[..<idx]) + "…"
}

func fetchLatestReleaseViaWebRedirect(session: URLSession, completion: @escaping (Result<UpdateInfo?, Error>) -> Void) {
	guard let url = URL(string: updateWebLatestUrl) else {
		completion(.failure(UpdateError.message("Invalid release URL.")))
		return
	}
	var req = URLRequest(url: url)
	req.httpMethod = "HEAD"
	req.setValue("DataDip/\(appVersion ?? "0")", forHTTPHeaderField: "User-Agent")
	session.dataTask(with: req) { _, resp, err in
		if let err {
			completion(.failure(err))
			return
		}
		guard let http = resp as? HTTPURLResponse, (200..<400).contains(http.statusCode),
		      let finalUrl = http.url,
		      finalUrl.path.contains("/releases/tag/") else {
			completion(.success(nil))
			return
		}
		let tag = finalUrl.lastPathComponent
		guard let sv = Semver(tag), sv.prerelease == nil else {
			completion(.success(nil))
			return
		}
		let ver = sv.normalized
		let assetName = "DataDip-\(ver)-\(currentArch).dmg"
		guard let dlUrl = URL(string: "https://github.com/\(updateRepo)/releases/download/\(tag)/\(assetName)"),
		      isAllowedUpdateUrl(dlUrl) else {
			completion(.success(nil))
			return
		}
		var headReq = URLRequest(url: dlUrl)
		headReq.httpMethod = "HEAD"
		headReq.setValue("DataDip/\(appVersion ?? "0")", forHTTPHeaderField: "User-Agent")
		session.dataTask(with: headReq) { _, headResp, headErr in
			if let headErr {
				completion(.failure(headErr))
				return
			}
			guard let headHttp = headResp as? HTTPURLResponse, (200..<300).contains(headHttp.statusCode) else {
				completion(.success(nil))
				return
			}
			let size = headHttp.expectedContentLength > 0 ? headHttp.expectedContentLength : nil
			completion(.success(UpdateInfo(
				version: ver,
				assetName: assetName,
				downloadUrl: dlUrl,
				releaseUrl: finalUrl,
				assetSize: size,
				notes: ""
			)))
		}.resume()
	}.resume()
}

func fetchLatestRelease(completion: @escaping (Result<UpdateInfo?, Error>) -> Void) {
	let cfg = URLSessionConfiguration.ephemeral
	cfg.timeoutIntervalForRequest = 12
	cfg.timeoutIntervalForResource = 20
	let redirectGuard = HttpsOnlyRedirectDelegate()
	let session = URLSession(configuration: cfg, delegate: redirectGuard, delegateQueue: nil)
	let done: (Result<UpdateInfo?, Error>) -> Void = { result in
		session.finishTasksAndInvalidate()
		completion(result)
	}
	guard let apiUrl = URL(string: updateApiLatestUrl) else {
		done(.failure(UpdateError.message("Invalid GitHub API URL.")))
		return
	}
	var req = URLRequest(url: apiUrl)
	req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
	req.setValue("DataDip/\(appVersion ?? "0")", forHTTPHeaderField: "User-Agent")
	session.dataTask(with: req) { data, resp, err in
		if let err {
			done(.failure(err))
			return
		}
		guard let http = resp as? HTTPURLResponse else {
			done(.failure(UpdateError.message("No HTTP response from GitHub.")))
			return
		}
		// Fallback to zero-rate-limit /releases/latest redirect if GitHub API rate-limits shared IP.
		if http.statusCode == 403 || http.statusCode == 429 {
			fetchLatestReleaseViaWebRedirect(session: session, completion: done)
			return
		}
		if http.statusCode == 404 {
			done(.success(nil))
			return
		}
		guard (200..<300).contains(http.statusCode), let data else {
			done(.failure(UpdateError.message("GitHub returned HTTP \(http.statusCode).")))
			return
		}
		guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			done(.failure(UpdateError.message("Invalid release metadata from GitHub.")))
			return
		}
		if (json["draft"] as? Bool) == true || (json["prerelease"] as? Bool) == true {
			done(.success(nil))
			return
		}
		guard let tag = json["tag_name"] as? String, let sv = Semver(tag), sv.prerelease == nil else {
			done(.success(nil))
			return
		}
		let ver = sv.normalized
		let expectedAsset = "DataDip-\(ver)-\(currentArch).dmg"
		let assets = json["assets"] as? [[String: Any]] ?? []
		guard let asset = assets.first(where: { ($0["name"] as? String) == expectedAsset }),
		      let dlStr = asset["browser_download_url"] as? String,
		      let dlUrl = URL(string: dlStr),
		      isAllowedUpdateUrl(dlUrl) else {
			// Release tag exists, but DMG for this architecture is not uploaded yet.
			done(.success(nil))
			return
		}
		let releaseUrl = (json["html_url"] as? String).flatMap(URL.init(string:))
			?? URL(string: "https://github.com/\(updateRepo)/releases/tag/\(tag)")!
		let size = (asset["size"] as? NSNumber)?.int64Value
		let notes = (json["body"] as? String) ?? ""
		done(.success(UpdateInfo(
			version: ver,
			assetName: expectedAsset,
			downloadUrl: dlUrl,
			releaseUrl: releaseUrl,
			assetSize: size,
			notes: notes
		)))
	}.resume()
}

func runTool(_ executable: String, _ args: [String]) throws -> (stdout: Data, stderr: Data) {
	let p = Process()
	p.executableURL = URL(fileURLWithPath: executable)
	p.arguments = args
	let out = Pipe()
	let err = Pipe()
	p.standardOutput = out
	p.standardError = err
	p.standardInput = FileHandle.nullDevice
	try p.run()
	let outData = out.fileHandleForReading.readDataToEndOfFile()
	let errData = err.fileHandleForReading.readDataToEndOfFile()
	p.waitUntilExit()
	guard p.terminationStatus == 0 else {
		let errText = String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
		let name = URL(fileURLWithPath: executable).lastPathComponent
		throw UpdateError.message("\(name) failed: \(errText.isEmpty ? "exit \(p.terminationStatus)" : errText)")
	}
	return (outData, errData)
}

func attachDmg(_ dmgUrl: URL) throws -> String {
	let (outData, _) = try runTool("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-plist", dmgUrl.path])
	guard let plist = try? PropertyListSerialization.propertyList(from: outData, format: nil) as? [String: Any],
	      let entities = plist["system-entities"] as? [[String: Any]],
	      let mountPoint = entities.compactMap({ $0["mount-point"] as? String }).first(where: { !$0.isEmpty }) else {
		throw UpdateError.message("Could not determine mount point of disk image.")
	}
	return mountPoint
}

func detachDmg(_ mountPoint: String) {
	if (try? runTool("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"])) == nil {
		_ = try? runTool("/usr/bin/hdiutil", ["detach", mountPoint, "-force", "-quiet"])
	}
}

final class UpdateProgressPanel: NSObject {
	let panel: NSPanel
	private let label: NSTextField
	private let bar: NSProgressIndicator
	private let cancelBtn: NSButton
	private var onCancel: (() -> Void)?

	init(title: String, onCancel: @escaping () -> Void) {
		self.onCancel = onCancel
		let p = NSPanel(
			contentRect: NSRect(x: 0, y: 0, width: 390, height: 118),
			styleMask: [.titled],
			backing: .buffered,
			defer: false
		)
		p.title = title
		p.isReleasedWhenClosed = false
		p.isFloatingPanel = false
		p.center()

		let content = NSView(frame: NSRect(x: 0, y: 0, width: 390, height: 118))
		let lbl = NSTextField(labelWithString: "Starting download…")
		lbl.font = NSFont.systemFont(ofSize: 13)
		lbl.lineBreakMode = .byTruncatingMiddle
		lbl.frame = NSRect(x: 20, y: 78, width: 350, height: 20)
		content.addSubview(lbl)

		let prog = NSProgressIndicator(frame: NSRect(x: 20, y: 50, width: 350, height: 18))
		prog.style = .bar
		prog.isIndeterminate = true
		prog.minValue = 0
		prog.maxValue = 1
		prog.startAnimation(nil)
		content.addSubview(prog)

		let btn = NSButton(title: "Cancel", target: nil, action: nil)
		btn.bezelStyle = .rounded
		btn.frame = NSRect(x: 292, y: 12, width: 78, height: 28)
		content.addSubview(btn)

		p.contentView = content
		self.panel = p
		self.label = lbl
		self.bar = prog
		self.cancelBtn = btn
		super.init()
		btn.target = self
		btn.action = #selector(cancelClicked)
	}

	func show() {
		panel.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	func setStatus(_ text: String, fraction: Double? = nil, cancelEnabled: Bool = true) {
		label.stringValue = text
		cancelBtn.isEnabled = cancelEnabled
		if let f = fraction {
			bar.isIndeterminate = false
			bar.doubleValue = min(max(f, 0), 1)
		} else {
			if !bar.isIndeterminate {
				bar.isIndeterminate = true
				bar.startAnimation(nil)
			}
		}
	}

	func close() {
		onCancel = nil
		panel.orderOut(nil)
		panel.close()
	}

	@objc private func cancelClicked() {
		cancelBtn.isEnabled = false
		label.stringValue = "Cancelling…"
		onCancel?()
	}
}

final class ScriptBridge: NSObject, WKScriptMessageHandler {
	weak var app: App?
	init(_ app: App) { self.app = app }
	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		guard let body = message.body as? String else { return }
		if body == "ensureServer" {
			app?.ensureServerRunning(forceReload: false, pathQuery: nil)
		} else if body == "installUpdate" {
			DispatchQueue.main.async { self.app?.promptAndInstallAvailableUpdate() }
		} else if body == "checkForUpdates" {
			DispatchQueue.main.async { self.app?.checkForUpdates(nil) }
		}
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
	private var isUpdating = false
	private var pendingOpenFile: String?
	private var checkingForUpdate = false
	private var availableUpdate: UpdateInfo?
	private var checkForUpdatesItem: NSMenuItem?
	private var activeDownloader: UpdateDownloader?
	private var progressPanel: UpdateProgressPanel?

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
		scheduleBackgroundUpdateCheck()
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

	func stopExternalServer() {
		let p = datadip(["stop"])
		p.standardOutput = FileHandle.nullDevice
		p.standardError = FileHandle.nullDevice
		if (try? p.run()) != nil {
			p.waitUntilExit()
		}
	}

	func setUpdatingState(_ flag: Bool) {
		recoverLock.lock()
		isUpdating = flag
		recoverLock.unlock()
	}

	func isCurrentlyUpdating() -> Bool {
		recoverLock.lock()
		defer { recoverLock.unlock() }
		return isUpdating
	}

	// Ensures a live server is reachable; restarts `datadip serve` if an external or owned server stopped or is a stale version.
	func ensureServerRunning(forceReload: Bool, pathQuery: String?) {
		recoverLock.lock()
		if recovering || isUpdating {
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

			// Fast path: join an already-running DataDip server only if its version matches this app bundle.
			if let existing = readServerAsonUrl() {
				let health = probeHealth(existing)
				if health.ok {
					let versionMismatch = appVersion != nil && health.version != appVersion
					if versionMismatch {
						self.stopExternalServer()
					} else {
						let nextOrigin = "\(existing.scheme ?? "http")://\(existing.host ?? ""):\(existing.port ?? 80)"
						if forceReload || currentOrigin != nextOrigin {
							self.openUrl(existing, pathQuery: savedPath)
						}
						return
					}
				}
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

	func scheduleBackgroundUpdateCheck() {
		guard bundledServer != nil, currentBundleTeamId() != nil,
		      let curVer = appVersion, Semver(curVer) != nil else { return }
		let now = Date().timeIntervalSince1970
		let last = UserDefaults.standard.double(forKey: updateLastCheckKey)
		if last > 0 && (now - last) < updateCheckInterval { return }
		DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5) { [weak self] in
			self?.runUpdateCheck(interactive: false)
		}
	}

	@objc func checkForUpdates(_ sender: Any?) {
		guard bundledServer != nil else { return }
		if isCurrentlyUpdating() {
			progressPanel?.show()
			return
		}
		if let existing = availableUpdate {
			promptAndInstallUpdate(existing)
			return
		}
		runUpdateCheck(interactive: true)
	}

	func promptAndInstallAvailableUpdate() {
		if isCurrentlyUpdating() {
			progressPanel?.show()
			return
		}
		if let existing = availableUpdate {
			promptAndInstallUpdate(existing)
		} else {
			runUpdateCheck(interactive: true)
		}
	}

	private func runUpdateCheck(interactive: Bool) {
		if isCurrentlyUpdating() { return }
		if checkingForUpdate { return }
		checkingForUpdate = true

		fetchLatestRelease { [weak self] result in
			DispatchQueue.main.async {
				guard let self else { return }
				self.checkingForUpdate = false
				switch result {
				case .success(let maybeInfo):
					UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: updateLastCheckKey)
					if let info = maybeInfo,
					   let curVer = appVersion,
					   let curSem = Semver(curVer),
					   let nextSem = Semver(info.version),
					   nextSem > curSem {
						self.availableUpdate = info
						self.checkForUpdatesItem?.title = "Install Update (v\(info.version))…"
						self.notifyWebUpdateAvailable()
						if interactive {
							self.promptAndInstallUpdate(info)
						}
					} else if interactive {
						let alert = NSAlert()
						alert.messageText = "You're Up to Date"
						alert.informativeText = "DataDip v\(appVersion ?? "?") is currently the latest version."
						alert.runModal()
					}
				case .failure(let err):
					guard interactive else { return }
					let alert = NSAlert()
					alert.messageText = "Update Check Failed"
					alert.informativeText = err.localizedDescription
					alert.alertStyle = .warning
					alert.addButton(withTitle: "OK")
					alert.addButton(withTitle: "Open Releases Page")
					if alert.runModal() == .alertSecondButtonReturn, let u = URL(string: updateReleasesUrl) {
						NSWorkspace.shared.open(u)
					}
				}
			}
		}
	}

	func notifyWebUpdateAvailable() {
		guard let info = availableUpdate else { return }
		let payload: [String: String] = [
			"version": info.version,
			"releaseUrl": info.releaseUrl.absoluteString,
		]
		guard let data = try? JSONSerialization.data(withJSONObject: payload),
		      let json = String(data: data, encoding: .utf8) else { return }
		let js = "window.__datadipAvailableUpdate = \(json); window.dispatchEvent(new CustomEvent('datadip:update-available', { detail: \(json) }));"
		DispatchQueue.main.async { [weak self] in
			self?.web?.evaluateJavaScript(js, completionHandler: nil)
		}
	}

	private func promptAndInstallUpdate(_ info: UpdateInfo) {
		guard !isCurrentlyUpdating() else {
			progressPanel?.show()
			return
		}
		let inPlace = canReplaceInPlace(Bundle.main.bundleURL) && currentBundleTeamId() != nil
		let alert = NSAlert()
		alert.messageText = "DataDip v\(info.version) is available"
		var parts: [String] = []
		let sizeText = info.assetSize.map { " (\(formatMegabytes($0)))" } ?? ""
		parts.append("You are running v\(appVersion ?? "?").\(sizeText)")
		let notes = summarizeReleaseNotes(info.notes)
		if !notes.isEmpty {
			parts.append(notes)
		}
		if inPlace {
			parts.append("DataDip will download the signed DMG, verify its Apple Developer ID signature, replace the app bundle, and restart.")
		} else {
			parts.append("DataDip is running from a non-writable or ad-hoc location and cannot replace itself in place. It will download and open the DMG so you can drag DataDip.app to Applications.")
		}
		alert.informativeText = parts.joined(separator: "\n\n")
		alert.addButton(withTitle: inPlace ? "Update & Restart" : "Download DMG")
		alert.addButton(withTitle: "Release Notes")
		alert.addButton(withTitle: "Later")

		let resp = alert.runModal()
		if resp == .alertFirstButtonReturn {
			performUpdate(info)
		} else if resp == .alertSecondButtonReturn {
			NSWorkspace.shared.open(info.releaseUrl)
		}
	}

	private func performUpdate(_ info: UpdateInfo) {
		guard !isCurrentlyUpdating() else { return }
		setUpdatingState(true)

		let currentAppUrl = Bundle.main.bundleURL
		let selfTeamId = currentBundleTeamId()
		let inPlace = canReplaceInPlace(currentAppUrl) && selfTeamId != nil

		let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("datadip-update-\(UUID().uuidString)")
		do {
			try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
		} catch {
			setUpdatingState(false)
			showUpdateError("Could not create temporary download folder: \(error.localizedDescription)", releaseUrl: info.releaseUrl)
			return
		}
		let dmgUrl = tmpDir.appendingPathComponent(info.assetName)

		var cancelled = false
		let panel = UpdateProgressPanel(title: "Updating DataDip to v\(info.version)") { [weak self] in
			cancelled = true
			self?.activeDownloader?.cancel()
		}
		self.progressPanel = panel
		panel.setStatus("Downloading \(info.assetName)…", fraction: nil, cancelEnabled: true)
		panel.show()

		let downloader = UpdateDownloader(
			destUrl: dmgUrl,
			onProgress: { [weak panel] written, expected in
				DispatchQueue.main.async {
					let total = expected > 0 ? expected : (info.assetSize ?? -1)
					if total > 0 {
						let pct = Double(written) / Double(total)
						panel?.setStatus("Downloading DataDip v\(info.version)… (\(formatMegabytes(written)) / \(formatMegabytes(total)))", fraction: pct, cancelEnabled: true)
					} else {
						panel?.setStatus("Downloading DataDip v\(info.version)… (\(formatMegabytes(written)))", fraction: nil, cancelEnabled: true)
					}
				}
			},
			onComplete: { [weak self] result in
				guard let self else { return }
				switch result {
				case .failure(let err):
					try? FileManager.default.removeItem(at: tmpDir)
					DispatchQueue.main.async {
						self.activeDownloader = nil
						self.progressPanel?.close()
						self.progressPanel = nil
						self.setUpdatingState(false)
						let nsErr = err as NSError
						if cancelled || (nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled) {
							return
						}
						self.showUpdateError("Download failed: \(err.localizedDescription)", releaseUrl: info.releaseUrl)
					}
				case .success(let downloadedDmg):
					DispatchQueue.main.async {
						self.activeDownloader = nil
					}
					if !inPlace {
						self.finishWithFallbackDmg(downloadedDmg, tmpDir: tmpDir, info: info, appUrl: currentAppUrl, hasTeamId: selfTeamId != nil)
						return
					}
					self.installDownloadedDmg(downloadedDmg, tmpDir: tmpDir, info: info, currentAppUrl: currentAppUrl, expectedTeamId: selfTeamId!)
				}
			}
		)
		self.activeDownloader = downloader
		downloader.start(info.downloadUrl)
	}

	private func finishWithFallbackDmg(_ downloadedDmg: URL, tmpDir: URL, info: UpdateInfo, appUrl: URL, hasTeamId: Bool) {
		defer { try? FileManager.default.removeItem(at: tmpDir) }
		let fm = FileManager.default
		let downloads = fm.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
		try? fm.createDirectory(at: downloads, withIntermediateDirectories: true)
		var dest = downloads.appendingPathComponent(info.assetName)
		var suffix = 2
		while fm.fileExists(atPath: dest.path) {
			let base = (info.assetName as NSString).deletingPathExtension
			dest = downloads.appendingPathComponent("\(base)-\(suffix).dmg")
			suffix += 1
		}
		do {
			try fm.moveItem(at: downloadedDmg, to: dest)
			DispatchQueue.main.async {
				self.progressPanel?.close()
				self.progressPanel = nil
				self.setUpdatingState(false)
				NSWorkspace.shared.open(dest)
				let alert = NSAlert()
				alert.messageText = "Downloaded \(dest.lastPathComponent)"
				alert.informativeText = hasTeamId
					? "DataDip could not replace \(appUrl.path) in place. The new disk image has been opened — drag DataDip.app to Applications to finish updating."
					: "This build is ad-hoc signed, so automatic in-place replacement is disabled. The new disk image has been opened — drag DataDip.app to Applications to finish updating."
				alert.runModal()
			}
		} catch {
			DispatchQueue.main.async {
				self.progressPanel?.close()
				self.progressPanel = nil
				self.setUpdatingState(false)
				self.showUpdateError("Could not save DMG to Downloads: \(error.localizedDescription)", releaseUrl: info.releaseUrl)
			}
		}
	}

	private func installDownloadedDmg(_ dmgUrl: URL, tmpDir: URL, info: UpdateInfo, currentAppUrl: URL, expectedTeamId: String) {
		var stoppedServer = false
		var stagingDir: URL? = nil
		var mountPoint: String? = nil

		defer {
			if let mp = mountPoint { detachDmg(mp) }
			if let sd = stagingDir { try? FileManager.default.removeItem(at: sd) }
			try? FileManager.default.removeItem(at: tmpDir)
		}

		do {
			DispatchQueue.main.async {
				self.progressPanel?.setStatus("Mounting disk image…", fraction: nil, cancelEnabled: false)
			}
			let mp = try attachDmg(dmgUrl)
			mountPoint = mp

			let mountedApp = URL(fileURLWithPath: mp).appendingPathComponent("DataDip.app")
			guard FileManager.default.fileExists(atPath: mountedApp.path) else {
				throw UpdateError.message("Disk image does not contain DataDip.app.")
			}

			DispatchQueue.main.async {
				self.progressPanel?.setStatus("Extracting DataDip.app…", fraction: nil, cancelEnabled: false)
			}
			let sd = try FileManager.default.url(
				for: .itemReplacementDirectory,
				in: .userDomainMask,
				appropriateFor: currentAppUrl,
				create: true
			)
			stagingDir = sd
			let stagedAppUrl = sd.appendingPathComponent("DataDip.app")
			_ = try runTool("/usr/bin/ditto", [mountedApp.path, stagedAppUrl.path])

			detachDmg(mp)
			mountPoint = nil

			DispatchQueue.main.async {
				self.progressPanel?.setStatus("Verifying Apple code signature…", fraction: nil, cancelEnabled: false)
			}
			try verifyCandidateApp(
				stagedAppUrl,
				expectedVersion: info.version,
				expectedBundleId: appBundleId,
				expectedTeamId: expectedTeamId
			)

			DispatchQueue.main.async {
				self.progressPanel?.setStatus("Installing & restarting DataDip…", fraction: nil, cancelEnabled: false)
			}

			// Stop local server cleanly before swapping the app bundle.
			stoppedServer = true
			var ownedServe: Process? = nil
			DispatchQueue.main.sync {
				ownedServe = self.serve
				self.serve = nil
			}
			if let p = ownedServe, p.isRunning {
				let done = DispatchSemaphore(value: 0)
				p.terminationHandler = { _ in done.signal() }
				p.terminate()
				_ = done.wait(timeout: .now() + 3)
			}
			stopExternalServer()

			// Atomic same-volume bundle swap.
			_ = try FileManager.default.replaceItemAt(currentAppUrl, withItemAt: stagedAppUrl, backupItemName: nil, options: [])

			// Clean up staging & temp before terminating.
			try? FileManager.default.removeItem(at: sd)
			stagingDir = nil
			try? FileManager.default.removeItem(at: tmpDir)

			// Wait for current PID to exit, then relaunch the replaced bundle cleanly.
			let relaunch = Process()
			relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
			relaunch.arguments = [
				"-c",
				"pid=\"$1\"; app=\"$2\"; i=0; while kill -0 \"$pid\" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; /usr/bin/open \"$app\"",
				"datadip-relaunch",
				String(ProcessInfo.processInfo.processIdentifier),
				currentAppUrl.path,
			]
			relaunch.standardInput = FileHandle.nullDevice
			relaunch.standardOutput = FileHandle.nullDevice
			relaunch.standardError = FileHandle.nullDevice
			try relaunch.run()

			DispatchQueue.main.async {
				self.progressPanel?.close()
				self.progressPanel = nil
				NSApp.terminate(nil)
			}
		} catch {
			DispatchQueue.main.async {
				self.progressPanel?.close()
				self.progressPanel = nil
				self.setUpdatingState(false)
				if stoppedServer {
					self.ensureServerRunning(forceReload: false, pathQuery: nil)
				}
				self.showUpdateError(error.localizedDescription, releaseUrl: info.releaseUrl)
			}
		}
	}

	private func showUpdateError(_ message: String, releaseUrl: URL) {
		let alert = NSAlert()
		alert.messageText = "Update Failed"
		alert.informativeText = message
		alert.alertStyle = .warning
		alert.addButton(withTitle: "OK")
		alert.addButton(withTitle: "Open Releases Page")
		if alert.runModal() == .alertSecondButtonReturn {
			NSWorkspace.shared.open(releaseUrl)
		}
	}

	func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
		if let t = w.title, !t.isEmpty { window.title = t }
		if availableUpdate != nil {
			notifyWebUpdateAvailable()
		}
	}

	func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		let nsErr = error as NSError
		// Ignore superseded/cancelled navigations (e.g. initial "starting..." HTML replaced by live URL load).
		if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
		if isCurrentlyUpdating() { return }
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
				let menuItem = m.addItem(withTitle: name, action: action, keyEquivalent: key)
				if action == #selector(checkForUpdates(_:)) {
					self.checkForUpdatesItem = menuItem
				}
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
			appItems.append(("Check for Updates…", #selector(checkForUpdates(_:)), ""))
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
