import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  let web = WebWindow()
  let feed = ChatFeed()
  let notifier = Notifier()
  private(set) var chatCount = 0
  private var statusMenu: StatusMenu!
  private lazy var settings: SettingsWindow = {
    let settings = SettingsWindow()
    settings.onSave = { [weak self] in self?.connect() }
    return settings
  }()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.appearance = NSAppearance(named: .darkAqua) // the UI is always dark
    NSApp.mainMenu = mainMenu()
    statusMenu = StatusMenu(app: self)
    Server.shared.onStatus = { [weak self] status in self?.statusMenu.render(status) }
    web.onPower = { _ in Server.shared.refresh() }
    web.onStart = { [weak self] in self?.startServer(nil) }
    web.onSettings = { [weak self] in self?.showSettings(nil) }
    notifier.onOpen = { [weak self] id in self?.web.open(chat: id) }
    feed.onChats = { [weak self] chats in
      guard let self else { return }
      chatCount = chats.count
      let window = web.window
      let inFront = NSApp.isActive && window.isVisible && !window.isMiniaturized
      notifier.update(chats, quiet: inFront) // in front, the page's own notice says it
    }
    feed.onDisconnect = { Server.shared.refresh() }

    #if DEBUG
      if let out = UserDefaults.standard.string(forKey: "selfTest") {
        notifier.setUp(askPermission: false)
        connect()
        web.window.orderFrontRegardless()
        SelfTest(app: self, out: URL(fileURLWithPath: out)).run()
        return
      }
    #endif
    notifier.setUp(askPermission: true)
    connect()
    web.show()
  }

  // On launch and whenever the server setting changes.
  func connect() {
    web.load()
    feed.start()
    Server.shared.refresh()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { web.show() }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false // the menu-bar item, notifications and the badge keep working
  }

  // MARK: - Actions

  @objc func showWindow(_ sender: Any?) {
    web.show()
  }

  @objc func showSettings(_ sender: Any?) {
    settings.show()
  }

  @objc func turnOff(_ sender: Any?) {
    let off = { Server.shared.setPower(false) }
    if web.autoConfirm { return off() }
    let alert = NSAlert()
    alert.messageText = "Turn off?"
    alert.informativeText = "Every device gets a \"Turned off\" screen and the Mac can sleep again. Chats that are still working stop."
    alert.addButton(withTitle: "Turn Off")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate()
    if alert.runModal() == .alertFirstButtonReturn { off() }
  }

  @objc func turnOn(_ sender: Any?) {
    Server.shared.setPower(true) { [weak self] in self?.web.reload() } // leave the "Turned off" screen at once
  }

  @objc func startServer(_ sender: Any?) {
    Server.shared.startService { [weak self] in
      guard let self else { return }
      if Server.shared.status.reachable {
        web.load()
        feed.start()
      }
    }
  }

  @objc func toggleLoginItem(_ sender: Any?) {
    do { try LoginItem.set(!LoginItem.enabled) } catch { NSAlert(error: error).runModal() }
    statusMenu.render(Server.shared.status)
  }

  @objc func reload(_ sender: Any?) {
    web.reload()
  }

  @objc func zoom(_ sender: NSMenuItem) {
    web.zoom(sender.tag)
  }

  // Page shortcuts: the menu item carries the key, the page decides what it does.
  @objc func pageShortcut(_ sender: NSMenuItem) {
    guard let key = sender.representedObject as? [String] else { return }
    let mods = sender.keyEquivalentModifierMask
    web.shortcut(code: key[0], key: key[1], control: mods.contains(.control), shift: mods.contains(.shift))
  }

  #if DEBUG
    var settingsWindow: NSWindow { settings.window }

    // The menu-bar icon as drawn, for the self-test.
    func statusImage() -> NSImage? {
      guard let button = statusMenu.item.button, let rep = button.bitmapImageRepForCachingDisplay(in: button.bounds) else { return nil }
      button.cacheDisplay(in: button.bounds, to: rep)
      let image = NSImage(size: button.bounds.size)
      image.addRepresentation(rep)
      return image
    }
  #endif

  // MARK: - Main menu

  private func mainMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      holder.submenu = menu
      main.addItem(holder)
      return menu
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.keyEquivalentModifierMask = mods
      item.target = target
      return item
    }
    func page(_ title: String, _ key: String, code: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let item = item(title, #selector(pageShortcut(_:)), key, mods, target: self)
      item.representedObject = [code, key]
      return item
    }

    _ = submenu("Mothership", [
      item("About Mothership", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Settings…", #selector(showSettings(_:)), ",", target: self),
      .separator(),
      item("Hide Mothership", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit Mothership", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = submenu("File", [
      page("New Chat", "n", code: "KeyN"),
      page("Rename Chat…", "e", code: "KeyE", [.command, .shift]),
      page("Pin / Unpin", "p", code: "KeyP", [.command, .shift]),
      page("Delete Chat…", "d", code: "KeyD", [.command, .shift]),
      .separator(),
      item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
    ])
    // Plain responder actions: WKWebView handles them (text fields, terminal paste).
    _ = submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let zoomIn = item("Zoom In", #selector(zoom(_:)), "=", target: self)
    zoomIn.tag = 1
    let zoomOut = item("Zoom Out", #selector(zoom(_:)), "-", target: self)
    zoomOut.tag = -1
    _ = submenu("View", [
      page("Show / Hide Sidebar", "b", code: "KeyB"),
      page("Show / Hide Terminal", "j", code: "KeyJ"),
      page("Go to Message Box", "k", code: "KeyK"),
      page("Settings", "/", code: "Slash"),
      .separator(),
      item("Reload", #selector(reload(_:)), "r", target: self),
      item("Actual Size", #selector(zoom(_:)), "0", target: self),
      zoomIn,
      zoomOut,
      .separator(),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    var go = [page("Latest Reply", "j", code: "KeyJ", [.command, .shift]), page("Archived Chats", "a", code: "KeyA", [.command, .shift])]
    // ⌘1…⌘9 (the sidebar's chats) work without cluttering the menu.
    for n in 1...9 {
      let item = page("Item \(n)", "\(n)", code: "Digit\(n)")
      item.isHidden = true
      item.allowsKeyEquivalentWhenHidden = true
      go.append(item)
    }
    _ = submenu("Go", go)
    let window = submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
    NSApp.windowsMenu = window
    return main
  }
}
