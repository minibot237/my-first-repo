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

    func applicationDidFinishLaunching(_ notification: Notification) {
        startSupervisor()
        createWindow()
        createStatusItem()

        // Give supervisor a moment to boot, then load dashboard
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            self?.tryLoadDashboard(timer: timer)
        }
    }

    // MARK: - Supervisor lifecycle

    func startSupervisor() {
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
                // Auto-restart if it crashed (not if we killed it on quit)
                if process.terminationReason == .uncaughtSignal && self?.supervisor != nil {
                    NSLog("Minibot: supervisor crashed (signal %d), restarting...", process.terminationStatus)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        self?.startSupervisor()
                        self?.retryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
                            self?.tryLoadDashboard(timer: timer)
                        }
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
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            button.image = MinibotIcon.menuBarImage()
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show Dashboard", action: #selector(showDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Restart Supervisor", action: #selector(restartSupervisor), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit Minibot", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem?.menu = menu
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

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopSupervisor()
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
