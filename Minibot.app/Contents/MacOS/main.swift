import Cocoa
import WebKit
import Security

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
let imapFetchScript = macosDir + "/imap-fetch.py"
let emailAccountsPath: String = {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return home + "/.minibot/email-accounts.json"
}()
let emailIngestBase: String = {
    return repoDir + "/.local/ingest/email"
}()

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
// Keychain helpers
// ---------------------------------------------------------------------------

enum Keychain {
    static let service = "com.minibot.email"

    static func save(account: String, password: String) -> Bool {
        let data = password.data(using: .utf8)!
        // Delete existing first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// ---------------------------------------------------------------------------
// Email account model
// ---------------------------------------------------------------------------

struct EmailAccount: Codable {
    var email: String
    var imapServer: String
    var imapPort: Int
    var username: String
    var checkIntervalMinutes: Int

    // Keychain key is the email address
    var keychainKey: String { email }
}

class EmailAccountStore {
    var accounts: [EmailAccount] = []

    func load() {
        guard FileManager.default.fileExists(atPath: emailAccountsPath),
              let data = try? Data(contentsOf: URL(fileURLWithPath: emailAccountsPath)),
              let decoded = try? JSONDecoder().decode([EmailAccount].self, from: data) else {
            return
        }
        accounts = decoded
    }

    func save() {
        let dir = (emailAccountsPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(accounts) {
            try? data.write(to: URL(fileURLWithPath: emailAccountsPath))
        }
    }

    func add(_ account: EmailAccount, password: String) {
        accounts.append(account)
        _ = Keychain.save(account: account.keychainKey, password: password)
        save()
    }

    func remove(at index: Int) {
        let account = accounts[index]
        Keychain.delete(account: account.keychainKey)
        accounts.remove(at: index)
        save()
    }

    func update(at index: Int, account: EmailAccount, password: String?) {
        let oldKey = accounts[index].keychainKey
        if oldKey != account.keychainKey {
            Keychain.delete(account: oldKey)
        }
        accounts[index] = account
        if let pw = password, !pw.isEmpty {
            _ = Keychain.save(account: account.keychainKey, password: pw)
        }
        save()
    }
}

// ---------------------------------------------------------------------------
// IMAP Fetcher — runs per-account timers, calls imap-fetch.py, notifies supervisor
// ---------------------------------------------------------------------------

class IMAPFetcher {
    let store: EmailAccountStore
    var timers: [String: Timer] = [:]  // keyed by email

    init(store: EmailAccountStore) {
        self.store = store
    }

    func startAll() {
        stopAll()
        for account in store.accounts {
            startTimer(for: account)
        }
    }

    func stopAll() {
        for (_, timer) in timers { timer.invalidate() }
        timers.removeAll()
    }

    func restart(for email: String) {
        timers[email]?.invalidate()
        timers.removeValue(forKey: email)
        if let account = store.accounts.first(where: { $0.email == email }) {
            startTimer(for: account)
        }
    }

    private func startTimer(for account: EmailAccount) {
        // Fire immediately, then on interval
        fetchMail(for: account)
        let interval = TimeInterval(account.checkIntervalMinutes * 60)
        let timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.fetchMail(for: account)
        }
        timers[account.email] = timer
    }

    private func fetchMail(for account: EmailAccount) {
        guard let password = Keychain.load(account: account.keychainKey) else {
            NSLog("Minibot: no password in keychain for %@", account.email)
            return
        }

        let outputDir = emailIngestBase + "/" + account.email
        try? FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

        DispatchQueue.global(qos: .utility).async {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            proc.arguments = [imapFetchScript, account.imapServer, "\(account.imapPort)", account.username, outputDir]
            proc.environment = ["IMAP_PASSWORD": password]

            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = FileHandle.nullDevice

            do {
                try proc.run()
                proc.waitUntilExit()

                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                NSLog("Minibot: imap-fetch %@ → %@", account.email, output.trimmingCharacters(in: .whitespacesAndNewlines))

                // Parse result and notify supervisor if we got mail
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let fetched = json["fetched"] as? Int, fetched > 0 {
                    self.notifySupervisor(account: account.email, count: fetched)
                }
            } catch {
                NSLog("Minibot: imap-fetch error for %@: %@", account.email, error.localizedDescription)
            }
        }
    }

    private func notifySupervisor(account: String, count: Int) {
        guard let url = URL(string: "http://localhost:9100/api/mail-notify") else { return }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["account": account, "count": count]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error {
                NSLog("Minibot: mail-notify failed: %@", error.localizedDescription)
            } else if let http = response as? HTTPURLResponse {
                NSLog("Minibot: mail-notify %@ count=%d → %d", account, count, http.statusCode)
            }
        }.resume()
    }
}

// ---------------------------------------------------------------------------
// Email Accounts Window (AppKit)
// ---------------------------------------------------------------------------

class EmailAccountsWindowController: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let store: EmailAccountStore
    let fetcher: IMAPFetcher
    var window: NSWindow?
    var tableView: NSTableView!

    init(store: EmailAccountStore, fetcher: IMAPFetcher) {
        self.store = store
        self.fetcher = fetcher
    }

    func showWindow() {
        if let existing = window, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let w: CGFloat = 700
        let h: CGFloat = 400

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: w, height: h),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Email Accounts"
        window.center()
        window.minSize = NSSize(width: 500, height: 300)
        window.isReleasedWhenClosed = false

        // --- Table view ---
        tableView = NSTableView()
        tableView.headerView = NSTableHeaderView()
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.allowsMultipleSelection = false

        let columns: [(String, String, CGFloat)] = [
            ("email", "Email", 200),
            ("server", "IMAP Server", 160),
            ("port", "Port", 50),
            ("interval", "Check (min)", 80),
        ]
        for (id, title, width) in columns {
            let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            col.title = title
            col.width = width
            col.minWidth = 40
            tableView.addTableColumn(col)
        }

        tableView.dataSource = self
        tableView.delegate = self

        let scrollView = NSScrollView()
        scrollView.documentView = tableView
        scrollView.hasVerticalScroller = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        // --- Buttons ---
        let addButton = NSButton(title: "+", target: self, action: #selector(addAccount))
        addButton.bezelStyle = .smallSquare
        addButton.font = NSFont.systemFont(ofSize: 14, weight: .bold)

        let removeButton = NSButton(title: "−", target: self, action: #selector(removeAccount))
        removeButton.bezelStyle = .smallSquare
        removeButton.font = NSFont.systemFont(ofSize: 14, weight: .bold)

        let editButton = NSButton(title: "Edit", target: self, action: #selector(editAccount))
        editButton.bezelStyle = .smallSquare

        let fetchNowButton = NSButton(title: "Fetch Now", target: self, action: #selector(fetchNow))
        fetchNowButton.bezelStyle = .smallSquare

        let buttonStack = NSStackView(views: [addButton, removeButton, editButton, fetchNowButton])
        buttonStack.orientation = .horizontal
        buttonStack.spacing = 4
        buttonStack.translatesAutoresizingMaskIntoConstraints = false

        let contentView = NSView()
        contentView.addSubview(scrollView)
        contentView.addSubview(buttonStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
            scrollView.bottomAnchor.constraint(equalTo: buttonStack.topAnchor, constant: -8),

            buttonStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            buttonStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
        ])

        window.contentView = contentView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    // MARK: - Table data source

    func numberOfRows(in tableView: NSTableView) -> Int {
        return store.accounts.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let col = tableColumn else { return nil }
        let account = store.accounts[row]

        let text: String
        switch col.identifier.rawValue {
        case "email": text = account.email
        case "server": text = account.imapServer
        case "port": text = "\(account.imapPort)"
        case "interval": text = "\(account.checkIntervalMinutes)"
        default: text = ""
        }

        let cellId = NSUserInterfaceItemIdentifier("Cell_\(col.identifier.rawValue)")
        let cell: NSTextField
        if let existing = tableView.makeView(withIdentifier: cellId, owner: self) as? NSTextField {
            cell = existing
        } else {
            cell = NSTextField(labelWithString: "")
            cell.identifier = cellId
            cell.font = NSFont.systemFont(ofSize: 13)
        }
        cell.stringValue = text
        return cell
    }

    // MARK: - Actions

    @objc func addAccount() {
        showAccountSheet(account: nil, index: nil)
    }

    @objc func removeAccount() {
        let row = tableView.selectedRow
        guard row >= 0 else { return }

        let alert = NSAlert()
        alert.messageText = "Remove \(store.accounts[row].email)?"
        alert.informativeText = "This will also remove the password from Keychain."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning

        if alert.runModal() == .alertFirstButtonReturn {
            let email = store.accounts[row].email
            store.remove(at: row)
            fetcher.timers[email]?.invalidate()
            fetcher.timers.removeValue(forKey: email)
            tableView.reloadData()
        }
    }

    @objc func editAccount() {
        let row = tableView.selectedRow
        guard row >= 0 else { return }
        showAccountSheet(account: store.accounts[row], index: row)
    }

    @objc func fetchNow() {
        let row = tableView.selectedRow
        guard row >= 0 else { return }
        let account = store.accounts[row]
        NSLog("Minibot: manual fetch for %@", account.email)
        fetcher.restart(for: account.email)
    }

    // MARK: - Account edit sheet

    func showAccountSheet(account: EmailAccount?, index: Int?) {
        guard let parentWindow = window else { return }

        let sheet = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 280),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        sheet.title = account == nil ? "Add Email Account" : "Edit Email Account"

        let grid = NSGridView(numberOfColumns: 2, rows: 0)
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 12
        grid.rowSpacing = 10
        grid.column(at: 0).xPlacement = .trailing

        func makeLabel(_ text: String) -> NSTextField {
            let label = NSTextField(labelWithString: text)
            label.font = NSFont.systemFont(ofSize: 13)
            return label
        }
        func makeField(_ value: String, placeholder: String = "", secure: Bool = false) -> NSTextField {
            let field: NSTextField
            if secure {
                field = NSSecureTextField()
            } else {
                field = NSTextField()
            }
            field.stringValue = value
            field.placeholderString = placeholder
            field.font = NSFont.systemFont(ofSize: 13)
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
            return field
        }

        let emailField = makeField(account?.email ?? "", placeholder: "minibot@notverysmart.com")
        let serverField = makeField(account?.imapServer ?? "", placeholder: "mail.notverysmart.com")
        let portField = makeField(account != nil ? "\(account!.imapPort)" : "993")
        let usernameField = makeField(account?.username ?? "", placeholder: "minibot@notverysmart.com")
        let passwordField = makeField("", placeholder: account != nil ? "(unchanged)" : "password", secure: true)
        let intervalField = makeField(account != nil ? "\(account!.checkIntervalMinutes)" : "1")

        grid.addRow(with: [makeLabel("Email:"), emailField])
        grid.addRow(with: [makeLabel("IMAP Server:"), serverField])
        grid.addRow(with: [makeLabel("Port:"), portField])
        grid.addRow(with: [makeLabel("Username:"), usernameField])
        grid.addRow(with: [makeLabel("Password:"), passwordField])
        grid.addRow(with: [makeLabel("Check every (min):"), intervalField])

        let saveButton = NSButton(title: account == nil ? "Add" : "Save", target: nil, action: nil)
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"

        let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}"

        let buttonRow = NSStackView(views: [cancelButton, saveButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.translatesAutoresizingMaskIntoConstraints = false

        let contentView = NSView()
        contentView.addSubview(grid)
        contentView.addSubview(buttonRow)

        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 20),
            grid.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),

            buttonRow.topAnchor.constraint(equalTo: grid.bottomAnchor, constant: 20),
            buttonRow.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            buttonRow.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -16),
        ])

        sheet.contentView = contentView

        saveButton.target = self
        saveButton.action = #selector(sheetSave(_:))
        cancelButton.target = self
        cancelButton.action = #selector(sheetCancel(_:))

        // Stash context in the sheet for retrieval
        objc_setAssociatedObject(sheet, "fields", [emailField, serverField, portField, usernameField, passwordField, intervalField], .OBJC_ASSOCIATION_RETAIN)
        objc_setAssociatedObject(sheet, "editIndex", index as Any, .OBJC_ASSOCIATION_RETAIN)

        parentWindow.beginSheet(sheet)
    }

    @objc func sheetSave(_ sender: NSButton) {
        guard let sheet = sender.window,
              let parent = sheet.sheetParent,
              let fields = objc_getAssociatedObject(sheet, "fields") as? [NSTextField] else { return }

        let editIndex = objc_getAssociatedObject(sheet, "editIndex") as? Int

        let email = fields[0].stringValue.trimmingCharacters(in: .whitespaces)
        let server = fields[1].stringValue.trimmingCharacters(in: .whitespaces)
        let port = Int(fields[2].stringValue) ?? 993
        let username = fields[3].stringValue.trimmingCharacters(in: .whitespaces)
        let password = fields[4].stringValue
        let interval = Int(fields[5].stringValue) ?? 1

        guard !email.isEmpty, !server.isEmpty, !username.isEmpty else {
            let alert = NSAlert()
            alert.messageText = "Email, server, and username are required."
            alert.runModal()
            return
        }

        let account = EmailAccount(
            email: email,
            imapServer: server,
            imapPort: port,
            username: username,
            checkIntervalMinutes: max(1, interval)
        )

        if let idx = editIndex {
            store.update(at: idx, account: account, password: password.isEmpty ? nil : password)
        } else {
            guard !password.isEmpty else {
                let alert = NSAlert()
                alert.messageText = "Password is required for new accounts."
                alert.runModal()
                return
            }
            store.add(account, password: password)
        }

        parent.endSheet(sheet)
        tableView.reloadData()
        fetcher.restart(for: email)
    }

    @objc func sheetCancel(_ sender: NSButton) {
        guard let sheet = sender.window, let parent = sheet.sheetParent else { return }
        parent.endSheet(sheet)
    }
}

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
    let accountStore = EmailAccountStore()
    var imapFetcher: IMAPFetcher!
    var emailWindowController: EmailAccountsWindowController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Load email accounts and start fetcher
        accountStore.load()
        imapFetcher = IMAPFetcher(store: accountStore)
        emailWindowController = EmailAccountsWindowController(store: accountStore, fetcher: imapFetcher)

        startSupervisor()
        createWindow()
        createStatusItem()

        // Give supervisor a moment to boot, then load dashboard
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            self?.tryLoadDashboard(timer: timer)
        }

        // Start IMAP fetchers after a short delay (let supervisor start first)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.imapFetcher.startAll()
            NSLog("Minibot: IMAP fetchers started for %d accounts", self?.accountStore.accounts.count ?? 0)
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
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            let original = MinibotIcon.menuBarImage()
            let shifted = NSImage(size: NSSize(width: original.size.width, height: original.size.height))
            shifted.lockFocus()
            original.draw(at: NSPoint(x: 0, y: -1), from: .zero, operation: .sourceOver, fraction: 1.0)
            shifted.unlockFocus()
            shifted.isTemplate = true
            button.image = shifted
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show Dashboard", action: #selector(showDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem(title: "Email Accounts...", action: #selector(showEmailAccounts), keyEquivalent: "e"))
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

    @objc func showEmailAccounts() {
        emailWindowController.showWindow()
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
        imapFetcher.stopAll()
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
