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
            button.title = "m"
            button.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
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
// Main
// ---------------------------------------------------------------------------

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
