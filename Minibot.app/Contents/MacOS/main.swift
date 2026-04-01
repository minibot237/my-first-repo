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

    // Dialog state
    private var editFields: [NSTextField] = []
    private var editIndex: Int? = nil
    private var statusLabel: NSTextField?
    private var dialogStatusLabel: NSTextField?

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

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: w, height: h),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "Email Accounts"
        win.center()
        win.minSize = NSSize(width: 500, height: 300)
        win.isReleasedWhenClosed = false

        // --- Table view ---
        let tv = NSTableView()
        tv.headerView = NSTableHeaderView()
        tv.usesAlternatingRowBackgroundColors = true
        tv.allowsMultipleSelection = false

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
            tv.addTableColumn(col)
        }

        tv.dataSource = self
        tv.delegate = self
        tv.doubleAction = #selector(editAccount)
        tv.target = self
        tableView = tv

        let scrollView = NSScrollView()
        scrollView.documentView = tv
        scrollView.hasVerticalScroller = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        // --- Buttons (segmented-style at bottom) ---
        let addBtn = makeButton("+", action: #selector(addAccount))
        let removeBtn = makeButton("−", action: #selector(removeAccount))
        let editBtn = makeButton("Edit", action: #selector(editAccount))
        let fetchBtn = makeButton("Fetch Now", action: #selector(fetchNow))

        let buttonBar = NSStackView(views: [addBtn, removeBtn, editBtn, fetchBtn])
        buttonBar.orientation = .horizontal
        buttonBar.spacing = 6
        buttonBar.translatesAutoresizingMaskIntoConstraints = false

        // Status label for feedback
        let status = NSTextField(labelWithString: "")
        status.font = NSFont.systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        status.translatesAutoresizingMaskIntoConstraints = false
        statusLabel = status

        let contentView = NSView()
        contentView.addSubview(scrollView)
        contentView.addSubview(buttonBar)
        contentView.addSubview(status)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
            scrollView.bottomAnchor.constraint(equalTo: buttonBar.topAnchor, constant: -8),

            buttonBar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            buttonBar.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),

            status.leadingAnchor.constraint(equalTo: buttonBar.trailingAnchor, constant: 12),
            status.centerYAnchor.constraint(equalTo: buttonBar.centerYAnchor),
            status.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -8),
        ])

        win.contentView = contentView
        self.window = win
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeButton(_ title: String, action: Selector) -> NSButton {
        let btn = NSButton(title: title, target: self, action: action)
        btn.bezelStyle = .rounded
        if title == "+" || title == "−" {
            btn.font = NSFont.systemFont(ofSize: 14, weight: .bold)
        }
        return btn
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
        showEditDialog(account: nil, index: nil)
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

        guard let win = window else { return }
        alert.beginSheetModal(for: win) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self = self else { return }
            let email = self.store.accounts[row].email
            self.store.remove(at: row)
            self.fetcher.timers[email]?.invalidate()
            self.fetcher.timers.removeValue(forKey: email)
            self.tableView.reloadData()
        }
    }

    @objc func editAccount() {
        let row = tableView.selectedRow
        guard row >= 0 else { return }
        showEditDialog(account: store.accounts[row], index: row)
    }

    @objc func fetchNow() {
        let row = tableView.selectedRow
        guard row >= 0 else {
            statusLabel?.stringValue = "Select an account first."
            return
        }
        let account = store.accounts[row]
        statusLabel?.stringValue = "Fetching \(account.email)..."
        fetcher.restart(for: account.email)
    }

    @objc func checkConnection() {
        // Reads from the currently open dialog fields
        let server = editFields[1].stringValue.trimmingCharacters(in: .whitespaces)
        let port = editFields[2].stringValue.trimmingCharacters(in: .whitespaces)
        let username = editFields[3].stringValue.trimmingCharacters(in: .whitespaces)
        var password = editFields[4].stringValue

        guard !server.isEmpty, !username.isEmpty else {
            dialogStatusLabel?.stringValue = "Server and username required."
            dialogStatusLabel?.textColor = .systemOrange
            return
        }

        // If editing and password is blank, try Keychain
        if password.isEmpty, let idx = editIndex {
            password = Keychain.load(account: store.accounts[idx].keychainKey) ?? ""
        }
        guard !password.isEmpty else {
            dialogStatusLabel?.stringValue = "Password required to check."
            dialogStatusLabel?.textColor = .systemOrange
            return
        }

        dialogStatusLabel?.stringValue = "Checking..."
        dialogStatusLabel?.textColor = .secondaryLabelColor

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            let script = """
            import imaplib, json, os, sys
            try:
                m = imaplib.IMAP4_SSL(sys.argv[1], int(sys.argv[2]))
                m.login(sys.argv[3], os.environ["IMAP_PASSWORD"])
                status, boxes = m.list()
                count = len(boxes) if status == "OK" else 0
                m.select("INBOX", readonly=True)
                st, data = m.search(None, "UNSEEN")
                unseen = len(data[0].split()) if st == "OK" and data[0] else 0
                m.logout()
                print(json.dumps({"ok": True, "mailboxes": count, "unseen": unseen}))
            except Exception as e:
                print(json.dumps({"ok": False, "error": str(e)}))
            """
            proc.arguments = ["-c", script, server, port, username]
            proc.environment = ["IMAP_PASSWORD": password]

            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = FileHandle.nullDevice

            do {
                try proc.run()
                proc.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let ok = json["ok"] as? Bool ?? false
                    DispatchQueue.main.async {
                        if ok {
                            let unseen = json["unseen"] as? Int ?? 0
                            let boxes = json["mailboxes"] as? Int ?? 0
                            self?.dialogStatusLabel?.stringValue = "✓ Connected — \(boxes) mailboxes, \(unseen) unseen"
                            self?.dialogStatusLabel?.textColor = .systemGreen
                        } else {
                            let err = json["error"] as? String ?? "unknown error"
                            self?.dialogStatusLabel?.stringValue = "✗ \(err)"
                            self?.dialogStatusLabel?.textColor = .systemRed
                        }
                    }
                } else {
                    let output = String(data: data, encoding: .utf8) ?? "no output"
                    DispatchQueue.main.async {
                        self?.dialogStatusLabel?.stringValue = "✗ \(output)"
                        self?.dialogStatusLabel?.textColor = .systemRed
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self?.dialogStatusLabel?.stringValue = "✗ \(error.localizedDescription)"
                    self?.dialogStatusLabel?.textColor = .systemRed
                }
            }
        }
    }

    // MARK: - Edit dialog (modal)

    func showEditDialog(account: EmailAccount?, index: Int?) {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 340),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = account == nil ? "Add Email Account" : "Edit Email Account"
        panel.center()
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = false

        let grid = NSGridView(numberOfColumns: 2, rows: 0)
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 12
        grid.rowSpacing = 10
        grid.column(at: 0).xPlacement = .trailing

        func makeLabel(_ text: String) -> NSTextField {
            let l = NSTextField(labelWithString: text)
            l.font = NSFont.systemFont(ofSize: 13)
            return l
        }
        func makeField(_ value: String, placeholder: String = "", secure: Bool = false) -> NSTextField {
            let f: NSTextField = secure ? NSSecureTextField() : NSTextField()
            f.stringValue = value
            f.placeholderString = placeholder
            f.font = NSFont.systemFont(ofSize: 13)
            f.translatesAutoresizingMaskIntoConstraints = false
            f.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
            return f
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

        // Stash fields for save handler
        editFields = [emailField, serverField, portField, usernameField, passwordField, intervalField]
        editIndex = index

        // Check button + status in dialog
        let checkButton = NSButton(title: "Check Connection", target: self, action: #selector(checkConnection))
        checkButton.bezelStyle = .rounded

        let dlgStatus = NSTextField(labelWithString: "")
        dlgStatus.font = NSFont.systemFont(ofSize: 11)
        dlgStatus.textColor = .secondaryLabelColor
        dlgStatus.lineBreakMode = .byTruncatingTail
        dialogStatusLabel = dlgStatus

        let checkRow = NSStackView(views: [checkButton, dlgStatus])
        checkRow.orientation = .horizontal
        checkRow.spacing = 8
        checkRow.translatesAutoresizingMaskIntoConstraints = false

        let saveButton = NSButton(title: account == nil ? "Add" : "Save", target: self, action: #selector(dialogSave(_:)))
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(dialogCancel(_:)))
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}"

        let buttonRow = NSStackView(views: [cancelButton, saveButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.translatesAutoresizingMaskIntoConstraints = false

        let cv = NSView()
        cv.addSubview(grid)
        cv.addSubview(checkRow)
        cv.addSubview(buttonRow)

        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: cv.topAnchor, constant: 20),
            grid.centerXAnchor.constraint(equalTo: cv.centerXAnchor),
            checkRow.topAnchor.constraint(equalTo: grid.bottomAnchor, constant: 14),
            checkRow.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: 20),
            checkRow.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -20),
            buttonRow.topAnchor.constraint(equalTo: checkRow.bottomAnchor, constant: 14),
            buttonRow.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -20),
            buttonRow.bottomAnchor.constraint(equalTo: cv.bottomAnchor, constant: -16),
        ])

        panel.contentView = cv

        // Run as modal
        NSApp.runModal(for: panel)
    }

    @objc func dialogSave(_ sender: NSButton) {
        let email = editFields[0].stringValue.trimmingCharacters(in: .whitespaces)
        let server = editFields[1].stringValue.trimmingCharacters(in: .whitespaces)
        let port = Int(editFields[2].stringValue) ?? 993
        let username = editFields[3].stringValue.trimmingCharacters(in: .whitespaces)
        let password = editFields[4].stringValue
        let interval = Int(editFields[5].stringValue) ?? 1

        guard !email.isEmpty, !server.isEmpty, !username.isEmpty else {
            let alert = NSAlert()
            alert.messageText = "Email, server, and username are required."
            alert.runModal()
            return
        }

        let acct = EmailAccount(
            email: email,
            imapServer: server,
            imapPort: port,
            username: username,
            checkIntervalMinutes: max(1, interval)
        )

        if let idx = editIndex {
            store.update(at: idx, account: acct, password: password.isEmpty ? nil : password)
        } else {
            guard !password.isEmpty else {
                let alert = NSAlert()
                alert.messageText = "Password is required for new accounts."
                alert.runModal()
                return
            }
            store.add(acct, password: password)
        }

        sender.window?.close()
        NSApp.stopModal()
        tableView.reloadData()
        fetcher.restart(for: email)
        statusLabel?.stringValue = editIndex != nil ? "Updated \(email)" : "Added \(email)"
        statusLabel?.textColor = .secondaryLabelColor
    }

    @objc func dialogCancel(_ sender: NSButton) {
        sender.window?.close()
        NSApp.stopModal()
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
