# T3 Code for World of Warcraft

Watch and run your [T3 Code](https://t3.codes) agent threads without leaving the game. It's a native addon for World of Warcraft: Forever, built from Blizzard's own UI templates so it looks and plays like the rest of the interface, plus a small bridge that connects it to T3 Code.

> [!WARNING]
> **Early release, still experimental.** It's built for and tested on one setup: **Omarchy 4.5.0**, **T3 Code Nightly** (0.1.7-nightly) and **World of Warcraft: Forever** (1.60.x) under Proton. **macOS** with the native client and **CachyOS** with KDE Plasma are new and less tested (see [macOS](#macos) and [CachyOS and KDE Plasma](#cachyos-and-kde-plasma)). **Windows** 10 and 11 are newer still and the least tested (see [Windows](#windows)). Other setups may work but aren't supported yet. T3 Code Nightly's API changes often, so a T3 update can break things until this catches up. Expect rough edges, and please [report them](https://github.com/ryanrhughes/t3code-wow/issues).

## What it does

- **T3 Code window** (`/t3`): your threads grouped into Open, Working, Snoozed and Settled, filtered by project or machine. Read a thread, reply, steer a working thread or queue follow-ups, stop a run, settle or reopen it, snooze it until one of your T3 Code snooze presets or wake it, start new threads, answer the agent's questions and approve its requests.
- **Quest tracker**: what's running, what needs you and what just finished, right under your quests, with live timers.
- **Notices**: a toast, a sound and a chat line when a thread finishes or needs you. They wait until combat ends, and stay quiet in dungeons and raids if you like.
- **Full controller support**: the D-pad moves between controls, A selects, B goes back, LB/RB switch tabs, X reads aloud and holding Y dictates. Hold both triggers and press Back to open it from anywhere.
- **Voice**: dictate replies with Omarchy's dictation, and have replies read aloud by your desktop voice (on macOS, the system voice) or the game's.
- **Screenshots**: attach what's on your screen to a message so the agent can see your game.
- **Every machine**: threads from your other computers via T3 Connect, all in one list.
- **Usage**: your providers' plans and limits, the same as Omarchy's Agents panel shows.
- A minimap button and a game-menu entry, for opening it without a keyboard.

## Requirements

- **Omarchy 4.5.0** (Hyprland), **CachyOS** with KDE Plasma (see [CachyOS and KDE Plasma](#cachyos-and-kde-plasma)), **macOS** (see [macOS](#macos)), or **Windows** 10 or 11 (see [Windows](#windows)). On Omarchy the bridge reads the game window with Hyprland's screen capture, and dictation and usage come from Omarchy's own tools.
- **T3 Code Nightly**, installed and running. Its `t3` command gives the bridge a login.
- **World of Warcraft: Forever**, installed with Battle.net: Omarchy's Battle.net (Proton), Battle.net in Faugus Launcher, Lutris or Steam on CachyOS, or the native Mac or Windows app.
- **Node.js 22** or newer.
- **Game sound on.** The addon learns about new updates through silent sounds; with sound off it falls back to slower polling.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
```

It finds World of Warcraft: Forever in Omarchy's Battle.net, in the prefixes Faugus Launcher and Lutris recorded, or wherever Battle.net installed it (for anything unusual, add `bash -s -- --wow "/path/to/World of Warcraft"`). It installs the addon into the game, gives the bridge a T3 Code session limited to reading and running threads, and starts the bridge as the `orca-wow` user service.

Then it tells you what to do in the game and waits until the game checks in. The first time, **fully quit and restart World of Warcraft**: the game only finds new addon folders when it starts. After that, updates only need a `/reload`.

To install from a clone instead, run `./install.sh` in it.

On Windows the command is different. See [Windows](#windows).

### Update

Run the same install command again:

```bash
curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
```

It downloads the latest version, replaces the installed copy and restarts the bridge, keeping your settings, T3 Code session and machines. Then type `/reload` in game; the installer tells you when an update needs a full game restart instead. To install a specific release, pipe to `ORCA_WOW_REF=v0.2.0 bash` instead of `bash`. From a clone, `git pull` and run `./install.sh` again.

### macOS

The same install command works on a Mac with the native WoW: Forever client. Install Node.js 22 first (`brew install node`). The installer finds the game in `/Applications/World of Warcraft` or wherever Battle.net put it, and runs the bridge as a launch agent (`~/Library/LaunchAgents/orca-wow.plist`) instead of a systemd service.

- **Screen Recording permission.** The bridge reads the strip with macOS's `screencapture`, so it needs Screen Recording. The first time it runs, macOS asks, or lists `node` switched off under System Settings > Privacy & Security > Screen & System Audio Recording. Turn it on, then restart the bridge with `launchctl kickstart -k gui/$(id -u)/orca-wow`. If the link stays down, `orca-wow status` names the exact `node` it needs. The permission belongs to that `node` binary, so other programs that run with it can record the screen too. After you upgrade Node, macOS asks again for the new one.
- **Display settings.** Run the game at the display's full resolution (its Retina resolution on a Retina display), fullscreen or windowed. A resolution the display stretches blurs the strip.
- **Speech** uses the system voice (`say`). **Dictation** isn't available on macOS yet, and the Usage tab shows what T3 Code reports.
- `~/.local/bin` isn't on a Mac's PATH by default. The installer says so; add it to your shell profile, or run `~/.local/bin/orca-wow`.

### Windows

The bridge also runs on Windows 10 and 11, with the native WoW: Forever client. This is the newest setup. It has been checked in game on one Windows 11 PC, in Windowed mode at 100 percent scaling, so expect rough edges and please [report them](https://github.com/ryanrhughes/t3code-wow/issues). What was measured, and what wasn't, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#windows-notes).

Install Node.js 22 first (`winget install OpenJS.NodeJS.LTS`, then open a new PowerShell window). Then run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1 | iex
```

The installer finds the game wherever Battle.net installed it, and needs no administrator rights. It installs the addon into the game, gives the bridge a T3 Code session limited to reading and running threads, and registers the bridge as the `orca-wow` task in Task Scheduler. That task starts the bridge each time you sign in. If the game is somewhere unusual, pass its folder:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1))) --wow "D:\Games\World of Warcraft"
```

- **In the background.** The bridge runs without a window, and starts again 3 seconds after it stops for any reason. Its log is `%USERPROFILE%\.local\state\orca-wow\bridge.log`, and `orca-wow status --log` shows the latest lines.
- **Screen link.** The bridge reads the top-left corner of the game window off the screen. While another window covers that corner, it reads the game window itself instead. An overlay that another program draws over that corner, such as a frame-rate counter, hides the strip while it's there, as on the other platforms. The bridge can't tell that a click-through overlay is in the way, so keep overlays out of the game's top-left corner. While the game isn't responding, the bridge can't read the game window itself, so a covered corner isn't read and a screenshot is refused until the game answers again. The game must not be minimized, and must be on the current virtual desktop. Which display modes and scaling settings work in game hasn't been checked yet.
- **Speech and dictation.** The desktop voice and dictation aren't available on Windows yet. The addon uses the game's own voice for reading aloud instead, and the Usage tab shows what T3 Code reports.
- **Update** by running the install command again. **Uninstall** with `orca-wow uninstall`, which also removes the task. If the game is running and still has some of the addon's files open, uninstall stops and says so. Quit the game and run it again to finish.
- The bridge's files are in `%USERPROFILE%\.local\share\orca-wow` and its settings in `%USERPROFILE%\.config\orca-wow`. The `orca-wow` command is a one-line file in `%LOCALAPPDATA%\Microsoft\WindowsApps`, a folder Windows already has on your PATH.
- To install from a clone, run `powershell -ExecutionPolicy Bypass -File install.ps1` in it.

### CachyOS and KDE Plasma

The same install command works on CachyOS (or another Arch system) running KDE Plasma 6. Install Node.js first (`sudo pacman -S nodejs`). The installer finds Battle.net in any prefix Faugus Launcher or Lutris knows about, in `~/Faugus`, or in Steam, Bottles and Heroic prefixes.

- **Screen link.** KWin doesn't support the screen capture `grim` uses, so the bridge reads the game through KWin's own D-Bus screenshot interface with `busctl`, which ships with systemd. There's nothing to install or allow. The game must be on the current virtual desktop and not minimized.
- **Screenshots** come out as JPEG when ImageMagick is installed (`sudo pacman -S imagemagick`), and as PNG otherwise.
- **Speech** needs a desktop voice: `sudo pacman -S speech-dispatcher espeak-ng`. **Dictation** uses `voxtype` with `pw-record` if you have them. The Usage tab shows what T3 Code reports.
- Other desktops on CachyOS: Hyprland works like Omarchy (install `grim`), and an X11 session uses ImageMagick's `import`. GNOME isn't supported, since it doesn't let other programs capture the screen without asking every time.

### Uninstall

```bash
orca-wow uninstall
```

This removes the addon and its update folders, its settings in the game, the bridge service (the launch agent on macOS, the logon task on Windows), the bridge's T3 Code sessions (here and on any machine you added) and its files. On macOS, also turn `node` off under Screen & System Audio Recording: uninstalling can't do that for you.

## Using it

- `/t3` opens or closes the window. You can also use the minimap button, the game menu (Esc), or hold both triggers and press Back on a controller.
- `/t3 new` starts a thread, `/t3 usage` opens the usage tab, `/t3 settings` the settings.
- `/t3 unlock` lets you drag the tracker section somewhere else; Settings → Reset tracker puts it back under your quests.
- To see threads from another machine on your tailnet, run `orca-wow env add <host>`. It finds the machine's T3 Code over Tailscale and creates a session for the bridge over SSH.

## Commands

```bash
orca-wow status         # what the bridge sees: T3 Code, the game, the screen link, the addon
orca-wow status --log   # the same, with recent log lines
orca-wow env            # other machines shown in game (add <host> / remove <name>)
orca-wow uninstall      # remove everything (see above)
```

## When something's wrong

1. Run `orca-wow status --log` and check each line.
2. In game, run `/t3 selftest`. It checks each step between the game and T3 Code and says which one fails.
3. `/t3 report` fills the T3 Code message box with diagnostics and attaches a screenshot of your game. Send it to an agent, or copy the text into an issue.

If the tracker says live updates are paused, do a `/reload`: the game allows a fixed number of updates per session (1,200 by default), which normally lasts many hours.

## How it works

Addons can't open network connections or read files, so the addon and the bridge talk through what the game does allow:

| Direction | How |
| --- | --- |
| Game → bridge | A small strip of coloured squares in the top-left corner for about a second after you do something. The bridge reads it with a screen capture (`grim` on Hyprland, KWin's D-Bus screenshot interface on KDE Plasma, `screencapture` on macOS, a copy of that corner of the screen on Windows). |
| Bridge → game | Load-on-demand "slot" addons. The game reads a slot's Lua from disk when it loads, so the bridge writes a fresh snapshot there first. |
| "New data" signal | Large silent sound files the bridge fills or empties. The game re-reads big sounds every time it plays them, so the addon knows when to load the next slot. |

The bridge talks to T3 Code over the same WebSocket API its apps use. Details, measurements and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **The strip is encrypted.** Streams and recordings show it, so every frame is encrypted and authenticated (ChaCha20 and HMAC-SHA-256) with a key only the bridge and your addon have. To anyone else it's noise, and the bridge ignores anything it can't authenticate.
- **Addon managers.** WowUp shows a single "T3 Code" entry. Leave the `Orca_S###` folders alone: the addon needs them.
- **Nothing else.** The addon never sends anything to Blizzard. The bridge doesn't read game memory or press keys for you; it reads pixels and writes files in the addon folder.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Coding agents should start with [AGENTS.md](AGENTS.md).

## Credits

- [wow-ai](https://github.com/chelinho139/wow-ai) and [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured how the Forever client loads files, plays sounds and handles the gamepad. The strip-and-slot approach builds on their work.
- [Bellular](https://www.youtube.com/@BellularGaming) ([@BellularGaming](https://x.com/BellularGaming)) gave the idea of making this an in-game addon instead of a desktop overlay.

## License

[MIT](LICENSE). This is a fan project, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment. Use it at your own discretion.
