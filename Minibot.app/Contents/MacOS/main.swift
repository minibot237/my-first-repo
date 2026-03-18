import Cocoa
import WebKit

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

let bundle = Bundle.main
let macosDir = bundle.bundlePath + "/Contents/MacOS"
let repoDir: String = {
    // Minibot.app/Contents/MacOS → repo root (3 levels up)
    var url = URL(fileURLWithPath: macosDir)
    for _ in 0..<3 { url = url.deletingLastPathComponent() }
    return url.path
}()
let distDir = repoDir + "/dist/host"
let supervisorScript = distDir + "/supervisor.js"
let logsDir = repoDir + "/logs"

// Find node
let nodePath: String = {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ]
    for c in candidates {
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    // Fall back to PATH search
    let pipe = Pipe()
    let which = Process()
    which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
    which.arguments = ["node"]
    which.standardOutput = pipe
    try? which.run()
    which.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return out.isEmpty ? "/opt/homebrew/bin/node" : out
}()

// ---------------------------------------------------------------------------
// App Delegate
// ---------------------------------------------------------------------------

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var supervisor: Process?
    var statusItem: NSStatusItem?
    let dashboardPort = 9100
    var retryTimer: Timer?
    let usagePoller = UsagePoller()

    func applicationDidFinishLaunching(_ notification: Notification) {
        startSupervisor()
        createWindow()
        createStatusItem()

        // Start usage poller
        usagePoller.onUpdate = { [weak self] snapshot in
            self?.updateUsageDisplay(snapshot)
        }
        usagePoller.start()

        // Give supervisor a moment to boot, then load dashboard
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            self?.tryLoadDashboard(timer: timer)
        }
    }

    // MARK: - Supervisor lifecycle

    func startSupervisor() {
        // Kill any stale process holding our dashboard port
        killProcessOnPort(dashboardPort)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [supervisorScript]
        proc.currentDirectoryURL = URL(fileURLWithPath: repoDir)
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "RUNTIME": "docker",
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        ]) { _, new in new }

        // Log stdout/stderr to files
        try? FileManager.default.createDirectory(atPath: logsDir, withIntermediateDirectories: true)
        let outHandle = FileHandle(forWritingAtPath: logsDir + "/supervisor.out.log")
            ?? { FileManager.default.createFile(atPath: logsDir + "/supervisor.out.log", contents: nil); return FileHandle(forWritingAtPath: logsDir + "/supervisor.out.log")! }()
        let errHandle = FileHandle(forWritingAtPath: logsDir + "/supervisor.err.log")
            ?? { FileManager.default.createFile(atPath: logsDir + "/supervisor.err.log", contents: nil); return FileHandle(forWritingAtPath: logsDir + "/supervisor.err.log")! }()
        outHandle.seekToEndOfFile()
        errHandle.seekToEndOfFile()
        proc.standardOutput = outHandle
        proc.standardError = errHandle

        proc.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                // Don't restart if we're quitting (supervisor set to nil in stopSupervisor)
                guard self?.supervisor != nil else { return }

                let status = process.terminationStatus
                let reason = process.terminationReason == .uncaughtSignal ? "signal" : "exit"
                NSLog("Minibot: supervisor died (%@ %d), restarting in 3s...", reason, status)

                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    self?.startSupervisor()
                    self?.retryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
                        self?.tryLoadDashboard(timer: timer)
                    }
                }
            }
        }

        do {
            try proc.run()
            supervisor = proc
            NSLog("Minibot: supervisor started (pid %d)", proc.processIdentifier)
        } catch {
            NSLog("Minibot: failed to start supervisor: %@", error.localizedDescription)
        }
    }

    func stopSupervisor() {
        guard let proc = supervisor, proc.isRunning else { return }
        NSLog("Minibot: stopping supervisor (pid %d)", proc.processIdentifier)
        let ref = proc
        supervisor = nil  // Clear first so termination handler doesn't restart
        ref.terminate()
        ref.waitUntilExit()
    }

    // MARK: - Window

    func createWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")  // Transparent while loading

        // Loading placeholder
        let loadingHTML = """
        <html><body style="background:#1a1a2e;color:#555;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center"><div style="font-size:24px;margin-bottom:8px;">minibot</div><div style="font-size:12px;">starting supervisor...</div></div>
        </body></html>
        """
        webView.loadHTMLString(loadingHTML, baseURL: nil)

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let windowWidth: CGFloat = min(1400, screenFrame.width * 0.85)
        let windowHeight: CGFloat = min(900, screenFrame.height * 0.85)
        let windowX = screenFrame.midX - windowWidth / 2
        let windowY = screenFrame.midY - windowHeight / 2

        window = NSWindow(
            contentRect: NSRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Minibot"
        window.contentView = webView
        window.minSize = NSSize(width: 600, height: 400)
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
    }

    func tryLoadDashboard(timer: Timer) {
        let url = URL(string: "http://localhost:\(dashboardPort)")!
        var request = URLRequest(url: url, timeoutInterval: 2)
        request.httpMethod = "HEAD"

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async {
                    timer.invalidate()
                    self?.retryTimer = nil
                    self?.webView.load(URLRequest(url: url))
                    NSLog("Minibot: dashboard loaded")
                }
            }
        }.resume()
    }

    // MARK: - Status item (menu bar)

    func createStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem?.button {
            // Build icon shifted down 1px by adding padding at top
            let original = MinibotIcon.menuBarImage()
            let shifted = NSImage(size: NSSize(width: original.size.width, height: original.size.height))
            shifted.lockFocus()
            original.draw(at: NSPoint(x: 0, y: -1), from: .zero, operation: .sourceOver, fraction: 1.0)
            shifted.unlockFocus()
            shifted.isTemplate = true
            button.image = shifted
            button.imagePosition = .imageLeading
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show Dashboard", action: #selector(showDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem.separator())

        let usageItem = NSMenuItem(title: "Usage: --", action: nil, keyEquivalent: "")
        usageItem.tag = 100 // tag to find it later
        menu.addItem(usageItem)

        menu.addItem(NSMenuItem(title: "Refresh Usage", action: #selector(refreshUsage), keyEquivalent: "u"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Restart Supervisor", action: #selector(restartSupervisor), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit Minibot", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem?.menu = menu
    }

    // MARK: - Usage display

    /// How far through a window we are (0.0–1.0), based on resets_at
    func windowElapsedFraction(resetsAt: String?, windowHours: Double) -> Double {
        guard let resetsAt = resetsAt else { return 0.5 } // unknown → assume midpoint

        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var resetDate = fmt.date(from: resetsAt)
        if resetDate == nil {
            let basic = ISO8601DateFormatter()
            basic.formatOptions = [.withInternetDateTime]
            resetDate = basic.date(from: resetsAt)
        }
        guard let reset = resetDate else { return 0.5 }

        let windowSeconds = windowHours * 3600
        let now = Date()
        let remaining = reset.timeIntervalSince(now)
        let elapsed = windowSeconds - remaining
        return max(0, min(1, elapsed / windowSeconds))
    }

    /// Pace-based color: green if well under pace, yellow within threshold, red over pace
    let paceThreshold: Double = 20 // pp of yellow band below pace (twiddleable)

    func paceColor(utilization: Double, resetsAt: String?, windowHours: Double) -> NSColor {
        let fraction = windowElapsedFraction(resetsAt: resetsAt, windowHours: windowHours)
        let pace = fraction * 100 // expected % at this point in the window

        if utilization > pace {
            return NSColor(srgbRed: 0.94, green: 0.27, blue: 0.27, alpha: 1) // red
        } else if utilization > pace - paceThreshold {
            return NSColor(srgbRed: 0.98, green: 0.75, blue: 0.14, alpha: 1) // yellow
        } else {
            return NSColor(srgbRed: 0.29, green: 0.85, blue: 0.50, alpha: 1) // green
        }
    }

    func updateUsageDisplay(_ snapshot: UsageSnapshot) {
        guard let data = snapshot.data else {
            if let button = statusItem?.button {
                button.attributedTitle = NSAttributedString(string: "")
                button.toolTip = snapshot.error ?? "No usage data"
            }
            if let menu = statusItem?.menu, let item = menu.item(withTag: 100) {
                item.title = "Usage: \(snapshot.error ?? "unavailable")"
            }
            return
        }

        let fiveH = Int(data.five_hour.utilization)
        let sevenD = Int(data.seven_day.utilization)

        let fiveHColor = paceColor(utilization: data.five_hour.utilization, resetsAt: data.five_hour.resets_at, windowHours: 5)
        let sevenDColor = paceColor(utilization: data.seven_day.utilization, resetsAt: data.seven_day.resets_at, windowHours: 168)

        // Menu bar: "<icon> d:12% w:39%" with per-value coloring
        if let button = statusItem?.button {
            let menuFont = NSFont.monospacedDigitSystemFont(ofSize: 16, weight: .medium)
            let dimAttrs: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.secondaryLabelColor, .font: menuFont]

            // Center vertically using a paragraph style
            let paraStyle = NSMutableParagraphStyle()
            paraStyle.alignment = .center

            let dimAttrsP = dimAttrs.merging([.paragraphStyle: paraStyle]) { _, new in new }

            let offset: CGFloat = -3 // shift text down 3px
            let str = NSMutableAttributedString()
            str.append(NSAttributedString(string: " D", attributes: dimAttrsP.merging([.baselineOffset: offset]) { _, n in n }))
            str.append(NSAttributedString(string: "\(fiveH)%", attributes: [.foregroundColor: fiveHColor, .font: menuFont, .paragraphStyle: paraStyle, .baselineOffset: offset]))
            str.append(NSAttributedString(string: " W", attributes: dimAttrsP.merging([.baselineOffset: offset]) { _, n in n }))
            str.append(NSAttributedString(string: "\(sevenD)%", attributes: [.foregroundColor: sevenDColor, .font: menuFont, .paragraphStyle: paraStyle, .baselineOffset: offset]))

            button.attributedTitle = str

            // Tooltip with more detail
            let frac5 = windowElapsedFraction(resetsAt: data.five_hour.resets_at, windowHours: 5)
            let frac7 = windowElapsedFraction(resetsAt: data.seven_day.resets_at, windowHours: 168)
            button.toolTip = "5h: \(fiveH)% (pace: \(Int(frac5 * 100))%)\n7d: \(sevenD)% (pace: \(Int(frac7 * 100))%)"
        }

        // Dropdown menu detail line
        if let menu = statusItem?.menu, let item = menu.item(withTag: 100) {
            var parts = ["5h: \(fiveH)%", "7d: \(sevenD)%"]
            if let opus = data.seven_day_opus {
                parts.append("opus: \(Int(opus.utilization))%")
            }
            item.title = "Usage: " + parts.joined(separator: " | ")
        }
    }

    @objc func refreshUsage() {
        usagePoller.refresh()
    }

    @objc func showDashboard() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func restartSupervisor() {
        stopSupervisor()
        // Show loading state
        let loadingHTML = """
        <html><body style="background:#1a1a2e;color:#555;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center"><div style="font-size:24px;margin-bottom:8px;">minibot</div><div style="font-size:12px;">restarting supervisor...</div></div>
        </body></html>
        """
        webView.loadHTMLString(loadingHTML, baseURL: nil)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.startSupervisor()
            self?.retryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
                self?.tryLoadDashboard(timer: timer)
            }
        }
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - Port cleanup

    func killProcessOnPort(_ port: Int) {
        let pipe = Pipe()
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-ti", ":\(port)"]
        lsof.standardOutput = pipe
        lsof.standardError = FileHandle.nullDevice
        try? lsof.run()
        lsof.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        for line in output.components(separatedBy: .newlines) {
            if let pid = Int32(line.trimmingCharacters(in: .whitespaces)), pid > 0 {
                NSLog("Minibot: killing stale process on port %d (pid %d)", port, pid)
                kill(pid, SIGTERM)
            }
        }

        if !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Give processes a moment to die
            usleep(500_000)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        usagePoller.stop()
        stopSupervisor()
    }
}

// ---------------------------------------------------------------------------
// Claude Usage Poller
// ---------------------------------------------------------------------------

struct UsageLimit: Codable {
    let utilization: Double
    let resets_at: String?
}

struct UsageData: Codable {
    let five_hour: UsageLimit
    let seven_day: UsageLimit
    let seven_day_sonnet: UsageLimit?
    let seven_day_opus: UsageLimit?
    let seven_day_oauth_apps: UsageLimit?
    let seven_day_cowork: UsageLimit?
    let extra_usage: UsageLimit?
}

struct UsageSnapshot: Codable {
    var data: UsageData?
    var error: String?
    var lastFetch: String?
    var nextFetch: String?
}

class UsagePoller {
    private let pollInterval: TimeInterval = 300 // 5 minutes
    private var timer: Timer?
    private var sessionKey: String?
    private var orgId: String?
    private(set) var snapshot = UsageSnapshot()
    var onUpdate: ((UsageSnapshot) -> Void)?

    private let cachePath: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return home + "/.minibot/claude-usage.json"
    }()

    private var secretsDir: String {
        // workshop/.local/secrets/ — one level up from the repo
        var url = URL(fileURLWithPath: repoDir)
        url = url.deletingLastPathComponent()
        return url.path + "/.local/secrets"
    }

    func start() {
        loadCredentials()
        guard sessionKey != nil, orgId != nil else {
            NSLog("UsagePoller: missing credentials in %@", secretsDir)
            snapshot.error = "Missing credentials"
            persistCache()
            return
        }

        NSLog("UsagePoller: starting (every %.0fs)", pollInterval)
        poll() // immediate first fetch
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        poll()
    }

    private func loadCredentials() {
        let keyPath = secretsDir + "/claude-session-key"
        let orgPath = secretsDir + "/claude-org-id"

        sessionKey = (try? String(contentsOfFile: keyPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        orgId = (try? String(contentsOfFile: orgPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func poll() {
        guard let sessionKey = sessionKey, let orgId = orgId else { return }

        let urlString = "https://claude.ai/api/organizations/\(orgId)/usage"
        guard let url = URL(string: urlString) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("*/*", forHTTPHeaderField: "accept")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("web_claude_ai", forHTTPHeaderField: "anthropic-client-platform")
        request.setValue("sessionKey=\(sessionKey)", forHTTPHeaderField: "Cookie")
        // Identify as a real browser to avoid Cloudflare challenges
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", forHTTPHeaderField: "User-Agent")

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            let now = self.pacificTimestamp()

            if let error = error {
                self.snapshot.error = error.localizedDescription
                self.snapshot.lastFetch = now
                NSLog("UsagePoller: fetch error: %@", error.localizedDescription)
                self.persistCache()
                DispatchQueue.main.async { self.onUpdate?(self.snapshot) }
                return
            }

            guard let http = response as? HTTPURLResponse else {
                self.snapshot.error = "invalid response"
                self.snapshot.lastFetch = now
                self.persistCache()
                DispatchQueue.main.async { self.onUpdate?(self.snapshot) }
                return
            }

            // Capture rotated session key
            if let newKey = self.parseSessionKey(from: http), newKey != sessionKey {
                self.sessionKey = newKey
                self.persistSessionKey(newKey)
                NSLog("UsagePoller: session key rotated")
            }

            guard (200...299).contains(http.statusCode), let data = data else {
                self.snapshot.error = "http \(http.statusCode)"
                self.snapshot.lastFetch = now
                NSLog("UsagePoller: http error %d", http.statusCode)
                // Log first 200 chars of body for debugging
                if let data = data, let body = String(data: data.prefix(200), encoding: .utf8) {
                    NSLog("UsagePoller: response body: %@", body)
                }
                self.persistCache()
                DispatchQueue.main.async { self.onUpdate?(self.snapshot) }
                return
            }

            do {
                let usage = try JSONDecoder().decode(UsageData.self, from: data)
                self.snapshot = UsageSnapshot(
                    data: usage,
                    error: nil,
                    lastFetch: now,
                    nextFetch: nil
                )
                self.persistCache()
                NSLog("UsagePoller: 5h=%.0f%% 7d=%.0f%%",
                      usage.five_hour.utilization,
                      usage.seven_day.utilization)
                DispatchQueue.main.async { self.onUpdate?(self.snapshot) }
            } catch {
                self.snapshot.error = "decode: \(error.localizedDescription)"
                self.snapshot.lastFetch = now
                NSLog("UsagePoller: decode error: %@", error.localizedDescription)
                self.persistCache()
                DispatchQueue.main.async { self.onUpdate?(self.snapshot) }
            }
        }.resume()
    }

    private func parseSessionKey(from response: HTTPURLResponse) -> String? {
        guard let setCookie = response.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        for part in setCookie.components(separatedBy: ";") {
            let trimmed = part.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("sessionKey=") {
                return String(trimmed.dropFirst("sessionKey=".count))
            }
        }
        return nil
    }

    private func persistSessionKey(_ key: String) {
        let keyPath = secretsDir + "/claude-session-key"
        try? key.write(toFile: keyPath, atomically: true, encoding: .utf8)
    }

    private func persistCache() {
        let dir = (cachePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let json = try? encoder.encode(snapshot) {
            try? json.write(to: URL(fileURLWithPath: cachePath))
        }
    }

    private func pacificTimestamp() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        fmt.timeZone = TimeZone(identifier: "America/Los_Angeles")
        return fmt.string(from: Date())
    }
}

// ---------------------------------------------------------------------------
// Robot icon generator
// ---------------------------------------------------------------------------

enum MinibotIcon {

    /// Draw a playful robot face into a context of the given size
    static func draw(in ctx: CGContext, size: CGFloat) {
        let s = size

        // Head (rounded rect)
        let headInset = s * 0.15
        let headRect = CGRect(x: headInset, y: s * 0.18, width: s - headInset * 2, height: s * 0.62)
        let headPath = CGPath(roundedRect: headRect, cornerWidth: s * 0.1, cornerHeight: s * 0.1, transform: nil)

        // Antenna
        let antennaX = s * 0.5
        let antennaBase = headRect.maxY
        let antennaTip = s * 0.92
        let ballRadius = s * 0.045

        // Ears
        let earWidth = s * 0.08
        let earHeight = s * 0.18
        let earY = headRect.midY - earHeight / 2
        let leftEar = CGRect(x: headInset - earWidth + s * 0.02, y: earY, width: earWidth, height: earHeight)
        let rightEar = CGRect(x: s - headInset - s * 0.02, y: earY, width: earWidth, height: earHeight)

        // Eyes (square-ish with round corners, slightly tilted inward for personality)
        let eyeSize = s * 0.16
        let eyeY = headRect.midY + s * 0.02
        let eyeGap = s * 0.08
        let leftEye = CGRect(x: s * 0.5 - eyeGap - eyeSize, y: eyeY, width: eyeSize, height: eyeSize)
        let rightEye = CGRect(x: s * 0.5 + eyeGap, y: eyeY, width: eyeSize, height: eyeSize)
        let eyeRadius = s * 0.03

        // Mouth (wide friendly smile)
        let mouthY = headRect.minY + s * 0.12
        let mouthWidth = s * 0.3
        let mouthX = s * 0.5 - mouthWidth / 2

        // --- Draw ---

        // Shadow
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.02), blur: s * 0.06, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.3))

        // Head fill — dark blue-purple matching dashboard
        ctx.setFillColor(CGColor(srgbRed: 0.16, green: 0.16, blue: 0.28, alpha: 1.0))
        ctx.addPath(headPath)
        ctx.fillPath()
        ctx.restoreGState()

        // Head stroke
        ctx.setStrokeColor(CGColor(srgbRed: 0.55, green: 0.45, blue: 0.85, alpha: 1.0))
        ctx.setLineWidth(s * 0.025)
        ctx.addPath(headPath)
        ctx.strokePath()

        // Antenna line
        ctx.setStrokeColor(CGColor(srgbRed: 0.55, green: 0.45, blue: 0.85, alpha: 1.0))
        ctx.setLineWidth(s * 0.025)
        ctx.move(to: CGPoint(x: antennaX, y: antennaBase))
        ctx.addLine(to: CGPoint(x: antennaX, y: antennaTip))
        ctx.strokePath()

        // Antenna ball — green (like "detected" in pentest)
        ctx.setFillColor(CGColor(srgbRed: 0.29, green: 0.85, blue: 0.5, alpha: 1.0))
        ctx.fillEllipse(in: CGRect(x: antennaX - ballRadius, y: antennaTip - ballRadius, width: ballRadius * 2, height: ballRadius * 2))

        // Ears
        ctx.setFillColor(CGColor(srgbRed: 0.22, green: 0.22, blue: 0.38, alpha: 1.0))
        let leftEarPath = CGPath(roundedRect: leftEar, cornerWidth: s * 0.03, cornerHeight: s * 0.03, transform: nil)
        let rightEarPath = CGPath(roundedRect: rightEar, cornerWidth: s * 0.03, cornerHeight: s * 0.03, transform: nil)
        ctx.addPath(leftEarPath)
        ctx.addPath(rightEarPath)
        ctx.fillPath()

        // Eyes — glowing cyan/purple
        let eyeColor = CGColor(srgbRed: 0.77, green: 0.71, blue: 0.99, alpha: 1.0)
        ctx.setFillColor(eyeColor)
        let leftEyePath = CGPath(roundedRect: leftEye, cornerWidth: eyeRadius, cornerHeight: eyeRadius, transform: nil)
        let rightEyePath = CGPath(roundedRect: rightEye, cornerWidth: eyeRadius, cornerHeight: eyeRadius, transform: nil)
        ctx.addPath(leftEyePath)
        ctx.addPath(rightEyePath)
        ctx.fillPath()

        // Eye shine (small white dot, top-right of each eye)
        ctx.setFillColor(CGColor(gray: 1.0, alpha: 0.7))
        let shineSize = s * 0.045
        ctx.fillEllipse(in: CGRect(x: leftEye.maxX - shineSize * 1.5, y: leftEye.maxY - shineSize * 1.5, width: shineSize, height: shineSize))
        ctx.fillEllipse(in: CGRect(x: rightEye.maxX - shineSize * 1.5, y: rightEye.maxY - shineSize * 1.5, width: shineSize, height: shineSize))

        // Mouth — friendly smile arc
        ctx.setStrokeColor(CGColor(srgbRed: 0.77, green: 0.71, blue: 0.99, alpha: 0.8))
        ctx.setLineWidth(s * 0.025)
        ctx.setLineCap(.round)
        ctx.move(to: CGPoint(x: mouthX, y: mouthY))
        ctx.addQuadCurve(to: CGPoint(x: mouthX + mouthWidth, y: mouthY),
                         control: CGPoint(x: s * 0.5, y: mouthY - s * 0.1))
        ctx.strokePath()
    }

    /// Create an NSImage of the robot at the given size
    static func image(size: CGFloat) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size))
        img.lockFocus()
        if let ctx = NSGraphicsContext.current?.cgContext {
            draw(in: ctx, size: size)
        }
        img.unlockFocus()
        return img
    }

    /// Create a template image for the menu bar (white on transparent)
    static func menuBarImage() -> NSImage {
        let size: CGFloat = 18
        let img = NSImage(size: NSSize(width: size, height: size))
        img.lockFocus()
        if let ctx = NSGraphicsContext.current?.cgContext {
            // Menu bar template: draw all in white, macOS handles the rest
            ctx.setFillColor(CGColor(gray: 1, alpha: 1))
            ctx.setStrokeColor(CGColor(gray: 1, alpha: 1))

            let s = size
            // Simplified robot head for small size
            let headRect = CGRect(x: s * 0.15, y: s * 0.15, width: s * 0.7, height: s * 0.55)
            let headPath = CGPath(roundedRect: headRect, cornerWidth: s * 0.08, cornerHeight: s * 0.08, transform: nil)
            ctx.setLineWidth(1.5)
            ctx.addPath(headPath)
            ctx.strokePath()

            // Antenna
            ctx.setLineWidth(1.5)
            ctx.move(to: CGPoint(x: s * 0.5, y: headRect.maxY))
            ctx.addLine(to: CGPoint(x: s * 0.5, y: s * 0.88))
            ctx.strokePath()
            ctx.fillEllipse(in: CGRect(x: s * 0.5 - 2, y: s * 0.86, width: 4, height: 4))

            // Eyes
            let eyeSize: CGFloat = 3
            ctx.fill(CGRect(x: s * 0.32, y: headRect.midY, width: eyeSize, height: eyeSize))
            ctx.fill(CGRect(x: s * 0.58, y: headRect.midY, width: eyeSize, height: eyeSize))

            // Mouth
            ctx.setLineWidth(1.0)
            ctx.move(to: CGPoint(x: s * 0.35, y: headRect.minY + s * 0.1))
            ctx.addQuadCurve(to: CGPoint(x: s * 0.65, y: headRect.minY + s * 0.1),
                             control: CGPoint(x: s * 0.5, y: headRect.minY + s * 0.02))
            ctx.strokePath()
        }
        img.unlockFocus()
        img.isTemplate = true
        return img
    }

    /// Generate app icon as icns-ready images and set as app icon
    static func setAppIcon() {
        let icon = image(size: 256)
        NSApp.applicationIconImage = icon
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
MinibotIcon.setAppIcon()
app.run()
