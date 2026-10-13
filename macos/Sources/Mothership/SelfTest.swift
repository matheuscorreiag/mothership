#if DEBUG
  import AppKit
  import WebKit

  // Debug builds only: `Mothership -selfTest <dir> -localPort <test server's port>`
  // drives the app against a test server — real key events through AppKit,
  // the menu-bar switch, the native dialogs, the chat feed — and writes
  // results.txt plus snapshots of what the window shows. Never production.
  final class SelfTest {
    private let app: AppDelegate
    private let out: URL
    private var lines: [String] = []
    private var web: WebWindow { app.web }

    init(app: AppDelegate, out: URL) {
      self.app = app
      self.out = out
    }

    func run() {
      guard Prefs.serverURL.port != 7680 else {
        print("self-test: refusing to run against port 7680 (production); pass -localPort")
        exit(2)
      }
      try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
      Task { @MainActor in
        await steps()
        try? lines.joined(separator: "\n").write(to: out.appending(path: "results.txt"), atomically: true, encoding: .utf8)
        NSApp.terminate(nil)
      }
    }

    private func check(_ name: String, _ ok: Bool, _ detail: Any? = nil) {
      let line = "\(ok ? "PASS" : "FAIL")  \(name)" + (detail.map { "  (\($0))" } ?? "")
      lines.append(line)
      print(line)
    }

    @discardableResult
    @MainActor private func js(_ code: String) async -> Any? {
      try? await web.webView.evaluateJavaScript(code)
    }

    private func wait(_ seconds: Double) async {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    @MainActor private func until(_ seconds: Double, _ test: () async -> Bool) async -> Bool {
      for _ in 0..<Int(seconds * 10) {
        if await test() { return true }
        await wait(0.1)
      }
      return await test()
    }

    // A real ⌘-key event, offered the way AppKit does: the focused view first
    // (WKWebView passes it to the page), then the menus.
    @MainActor private func press(_ chars: String, _ keyCode: UInt16, _ mods: NSEvent.ModifierFlags = .command) {
      let event = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: web.window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
        isARepeat: false, keyCode: keyCode)!
      if !web.webView.performKeyEquivalent(with: event) { _ = NSApp.mainMenu?.performKeyEquivalent(with: event) }
    }

    // Plain typing, one character at a time, as keystrokes.
    @MainActor private func type(_ text: String) async {
      for ch in text {
        let s = String(ch)
        for kind in [NSEvent.EventType.keyDown, .keyUp] {
          let event = NSEvent.keyEvent(
            with: kind, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: web.window.windowNumber, context: nil, characters: s, charactersIgnoringModifiers: s,
            isARepeat: false, keyCode: ch == " " ? 49 : 0)!
          NSApp.sendEvent(event)
        }
        await wait(0.03)
      }
    }

    @MainActor private func snapshot(_ name: String) async {
      guard let image = try? await web.webView.takeSnapshot(configuration: nil) else { return check("snapshot \(name)", false) }
      save(image, name)
    }

    private func save(_ image: NSImage, _ name: String) {
      guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
      try? png.write(to: out.appending(path: "\(name).png"))
    }

    @MainActor private func text(_ code: String) async -> String { await js(code) as? String ?? "" }
    @MainActor private func flag(_ code: String) async -> Bool { await js(code) as? Bool ?? false }

    @MainActor private func steps() async {
      web.autoConfirm = true
      web.window.makeFirstResponder(web.webView)

      // The page, its socket, and knowing it runs in the app.
      let online = await until(8) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" }
      check("page loads and connects", online)
      check("page knows it runs in the app (⌘N hint)", await text("document.querySelector('#new-chat-hint')?.textContent") == "⌘N")
      let firstChat = await text("location.hash.slice(1)")
      await snapshot("window")
      check("no title in the bar (the app's name only for the Window menu)", web.window.titleVisibility == .hidden && web.window.title == (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) && web.window.title != web.webView.title, web.window.title)
      check("status line shows the agent's folder", await until(3) { !(await self.text("document.querySelector('#chat-dir')?.textContent || ''")).isEmpty }, await text("document.querySelector('#chat-dir')?.textContent || ''"))

      // Typing isn't rewritten: real keystrokes into the message box. Text input
      // needs focus, so the app comes to the front for a moment.
      check("no inline word predictions", web.webView.configuration.allowsInlinePredictions == false)
      check("the message box opts out of autocorrect and suggestions", await flag("(() => { const i = document.querySelector('#input'); return !i.spellcheck && i.getAttribute('autocorrect') === 'off' && i.getAttribute('autocapitalize') === 'off' && i.getAttribute('writingsuggestions') === 'false'; })()"))
      let previous = NSWorkspace.shared.frontmostApplication
      NSApp.activate()
      web.window.makeKeyAndOrderFront(nil)
      web.window.makeFirstResponder(web.webView)
      await js("document.querySelector('#input').focus()")
      await wait(0.5)
      let typed = "\"hi\" -- teh "
      await type(typed)
      await wait(1.5)
      let value = await text("document.querySelector('#input').value")
      check("typing isn't rewritten (quotes, dashes, spelling)", value == typed, value)
      await js("(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input')); i.blur(); })()")
      previous?.activate()

      // The chat feed (its own socket) and the badge.
      check("feed receives the chat list", await until(5) { self.app.chatCount > 0 }, app.chatCount)

      // Shortcuts, as real key events.
      await js("document.activeElement?.blur()")
      press("k", 40)
      check("⌘K focuses the message box", await until(1) { await self.text("document.activeElement?.id") == "input" })
      // …also when the web view doesn't have the window's focus (just opened, or
      // shown again before a click): the menu delivers ⌘K then, and typing must
      // still land in the box.
      await js("document.activeElement?.blur()")
      NSApp.activate()
      web.window.makeKeyAndOrderFront(nil)
      web.window.makeFirstResponder(nil)
      press("k", 40)
      await wait(0.3)
      await type("z")
      check("⌘K without the page focused: typing lands in the box", await until(1) { await self.text("document.querySelector('#input').value") == "z" }, await text("document.querySelector('#input').value"))
      await js("(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input')); i.blur(); })()")
      web.window.orderOut(nil)
      web.window.makeFirstResponder(nil)
      web.show()
      check("showing the window gives the page the keys", web.window.firstResponder === web.webView)
      previous?.activate()
      let collapsed = await flag("document.body.classList.contains('sidebar-collapsed')")
      press("b", 11)
      await wait(0.5)
      check("⌘B toggles the sidebar exactly once", await flag("document.body.classList.contains('sidebar-collapsed')") != collapsed)
      press("b", 11)
      await wait(0.4)
      press("/", 44)
      check("⌘/ opens Settings", await until(1) { await self.text("location.hash") == "#settings" })
      press("1", 18)
      let first = (try? await web.webView.callAsyncJavaScript("return (await (await fetch('/api/chats')).json())[0]?.id || ''", contentWorld: .page)) as? String ?? ""
      check("⌘1 opens the first chat", await until(1.5) { await self.text("location.hash.slice(1)") == first && !first.isEmpty }, first)
      check("app hints are plain ⌘N / ⌘T", await text("document.querySelector('#new-chat-hint').textContent + ' ' + document.querySelector('#terminal-hint').textContent") == "⌘N ⌘T")
      press("n", 45)
      check("⌘N starts a new chat", await until(1.5) { await self.text("location.hash") == "" })
      press("t", 17)
      check("⌘T opens the terminal", await until(3) { await self.text("location.pathname") == "/terminal/" })
      _ = await until(3) { await self.text("document.readyState") == "complete" }
      await wait(0.8)
      press("t", 17)
      check("⌘T goes back to the chats", await until(3) { await self.text("location.pathname") == "/" })
      _ = await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" }

      // Rename / delete without the mouse: a dialog first, Esc backs out.
      web.open(chat: first)
      _ = await until(3) { await self.text("location.hash.slice(1)") == first }
      await wait(0.8)
      let escape = "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))"
      let title = await text("(document.querySelector('#sidebar .side-item.active .name') || {}).textContent || ''")
      press("e", 14, [.command, .shift])
      check("⇧⌘E opens the rename dialog with the name", await until(2) { await self.text("document.querySelector('.ask-input')?.value ?? '-'") == title && !title.isEmpty }, title)
      await js(escape)
      check("…Esc closes it", await until(1) { !(await self.flag("!!document.querySelector('.ask-backdrop')")) })
      press("d", 2, [.command, .shift])
      check("⇧⌘D asks before deleting", await until(2) { await self.flag("!!document.querySelector('.ask-ok.danger')") })
      await js(escape)
      check("…Esc keeps the chat", await until(1) {
        let open = await self.flag("!!document.querySelector('.ask-backdrop')")
        let here = await self.text("location.hash.slice(1)")
        return !open && here == first
      })
      let fileMenu = NSApp.mainMenu?.item(withTitle: "File")?.submenu
      if let item = fileMenu?.item(withTitle: "Delete Chat…"), let index = fileMenu?.index(of: item) { fileMenu?.performActionForItem(at: index) }
      check("File ▸ Delete Chat… asks too", await until(2) { await self.flag("!!document.querySelector('.ask-ok.danger')") })
      await js(escape)

      // Pin / unpin without the mouse: the open chat moves to Pinned (or out of
      // it) and back.
      let pinned = "!!document.querySelector('.pinned-list .side-item.active')"
      let wasPinned = await flag(pinned)
      press("p", 35, [.command, .shift])
      check("⇧⌘P pins / unpins the open chat", await until(2) { await self.flag(pinned) != wasPinned })
      press("p", 35, [.command, .shift])
      check("…and back", await until(2) { await self.flag(pinned) == wasPinned })

      // The menu path on its own: what a shortcut does when the page isn't focused.
      let before = await flag("document.body.classList.contains('sidebar-collapsed')")
      let viewMenu = NSApp.mainMenu?.item(withTitle: "View")?.submenu
      if let toggle = viewMenu?.item(withTitle: "Show / Hide Sidebar"), let index = viewMenu?.index(of: toggle) {
        viewMenu?.performActionForItem(at: index)
      }
      await wait(0.5)
      check("View ▸ Show / Hide Sidebar reaches the page", await flag("document.body.classList.contains('sidebar-collapsed')") != before)
      viewMenu.flatMap { menu in menu.item(withTitle: "Show / Hide Sidebar").map { menu.performActionForItem(at: menu.index(of: $0)) } }
      await wait(0.4)
      if !firstChat.isEmpty { web.open(chat: firstChat) }

      // Notifications: news only after the baseline, only for newly unread chats.
      let notifier = Notifier()
      notifier.update([["id": "a", "title": "A", "unread": false, "doneAt": 1]], quiet: false)
      notifier.update([["id": "a", "title": "A", "unread": true, "doneAt": 2, "preview": "Done: 3 files"]], quiet: false)
      notifier.update([["id": "a", "title": "A", "unread": true, "doneAt": 2, "preview": "Done: 3 files"]], quiet: false)
      check("a newly unread chat posts one notification", notifier.posted.count == 1 && notifier.posted.first?.body == "Done: 3 files", notifier.posted.count)
      check("Dock badge shows the unread count", NSApp.dockTile.badgeLabel == "1", NSApp.dockTile.badgeLabel ?? "nil")
      notifier.update([["id": "a", "title": "A", "unread": true, "doneAt": 3]], quiet: true)
      check("no notification while the app is in front", notifier.posted.count == 1)
      notifier.update([["id": "a", "title": "A", "unread": false, "doneAt": 3]], quiet: false)
      check("badge clears when read", NSApp.dockTile.badgeLabel == nil)

      // The menu-bar switch.
      await withCheckedContinuation { done in Server.shared.refresh { done.resume() } }
      check("menu bar sees the server on, on this Mac", Server.shared.status.reachable && Server.shared.status.on && Server.shared.status.thisMac)
      app.turnOff(nil)
      check("Turn Off turns the server off", await until(3) { Server.shared.status.reachable && !Server.shared.status.on })
      check("the page shows Turned off", await until(3) { await self.flag("!document.querySelector('#off-screen').hidden") })
      check("…with Turn on (this Mac)", await flag("!document.querySelector('#turn-on').hidden"))
      await snapshot("off")
      app.turnOn(nil)
      check("Turn On turns it back on", await until(3) { Server.shared.status.on })
      check("…and the page comes back", await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" })

      // The page's own switch, through the native confirm.
      await js("document.querySelector('#turn-off').click()")
      let off = await until(3) { await self.flag("!document.querySelector('#off-screen').hidden") }
      check("page Turn off goes through the native confirm", off && (web.lastConfirm ?? "").hasPrefix("Turn off?"), web.lastConfirm ?? "no dialog")
      await js("document.querySelector('#turn-on').click()")
      check("page Turn on brings it back", await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" })
      await withCheckedContinuation { done in Server.shared.refresh { done.resume() } }
      check("menu bar follows the page's switch", Server.shared.status.on)

      // Terminal page: ⌘E is the Files panel.
      web.load(path: "/terminal/")
      _ = await until(5) {
        let path = await self.text("location.pathname")
        let ready = await self.text("document.readyState")
        return path == "/terminal/" && ready == "complete"
      }
      await wait(1)
      let files = await flag("document.body.classList.contains('files-open')")
      press("e", 14)
      check("⌘E toggles Files on the terminal page", await until(1.5) { await self.flag("document.body.classList.contains('files-open')") != files })
      press("e", 14)
      await snapshot("terminal")

      // Nothing listening: the native "Not running" page.
      Prefs.testServerURL = URL(string: "http://127.0.0.1:7699")
      web.load()
      // This Mac's server can be started; on a Mac without one (-launchdLabel <none>), point at another.
      let expected = Server.shared.hasService ? "not running" : "no server on this mac"
      let shown = await until(5) { (await self.text("document.body?.innerText || ''")).lowercased().contains(expected) }
      check("unreachable server shows the native page (\(expected))", shown, shown ? nil : "url \(web.webView.url?.absoluteString ?? "nil"), text \(await text("document.body?.innerText || ''").prefix(80))")
      await snapshot(Server.shared.hasService ? "unreachable" : "no-server")
      if !Server.shared.hasService {
        await js("document.querySelector('button').click()")
        check("Connect to Another Mac… opens Settings", await until(2) { self.app.settingsWindow.isVisible })
        app.settingsWindow.orderOut(nil)
      }
      Prefs.testServerURL = nil
      web.load()
      _ = await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" }

      // The Settings window, as drawn.
      app.showSettings(nil)
      await wait(0.5)
      if let view = app.settingsWindow.contentView {
        // Cached drawings come out on white; the window's dark background is the window's, not the view's.
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor(srgbRed: 0.17, green: 0.17, blue: 0.18, alpha: 1).cgColor
        if let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
          view.cacheDisplay(in: view.bounds, to: rep)
          let image = NSImage(size: view.bounds.size)
          image.addRepresentation(rep)
          save(image, "settings")
        }
        view.layer?.backgroundColor = nil
      }
      check("Settings opens", app.settingsWindow.isVisible)
      app.settingsWindow.orderOut(nil)

      // Open at login (registers this debug build for a moment, then removes it).
      let wasOn = LoginItem.enabled
      do {
        try LoginItem.set(true)
        let registered = LoginItem.enabled
        try LoginItem.set(wasOn)
        check("Open at login registers and unregisters", registered && LoginItem.enabled == wasOn)
      } catch {
        check("Open at login registers and unregisters", false, error.localizedDescription)
      }

      // Menu-bar icon, as drawn.
      if let image = app.statusImage() { save(image, "status-item") }
    }
  }
#endif
