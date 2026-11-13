# Architecture

```
 WoW: Forever (Wine, macOS, Windows)                   orca-wow bridge (Node, user service)
 ┌──────────────────────────────┐   pixels   ┌────────────────────────────────────────┐
 │ Orca addon                 │──────────▶│ capture.js  reads the strip's pixels    │
 │  Transport.lua  strip, queue │            │ bridge.js   commands, pacing, snapshots │
 │  Store.lua      snapshot     │◀──────────│ slots.js    Inbox.lua into Orca_S###  │
 │  UI/*           window,      │   files    │             Signals/NNNNN.wav           │
 │                 tracker, pad │            │ t3.js       WebSocket RPC to T3 Code ───┼──▶ T3 Code server
 └──────────────────────────────┘            │ voice.js    speech, dictation           │
                                              └────────────────────────────────────────┘
```

## Constraints this is built around

Measured on live Forever 1.60.1 clients (TOC 16001) by
[wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) and
[wow-ai](https://github.com/chelinho139/wow-ai). The approach here builds on that work:

1. Addons can't use sockets or read files. They can draw pixels.
2. The client indexes addon files **at launch**. Files that exist then can be loaded
   later. `LoadAddOn` reads a load-on-demand addon's Lua from disk when it loads, and
   each addon loads once per UI session (`/reload` resets that). New files need a
   full restart.
3. `PlaySoundFile` returns whether a file will play. A file that has never loaded is
   read fresh every time. Once one plays, the result is cached until the process exits.
4. SavedVariables are only written on `/reload` or logout, and `ReloadUI()` needs a
   key press or click.

## Game → bridge: the strip

`Codec.lua` and `codec.js` share one frame format:

```
'T' '3' version  seq(2)  len(2)  payload…  fletcher16(2)
```

**Encryption.** The strip is on screen, so streams and recordings capture it. Version 2
frames (all of them, once the addon has its keys) carry

```
nonce(12)  ChaCha20(records)  HMAC-SHA-256(version, seq, nonce, ciphertext)[0..8]
```

- The bridge makes a random master key per install (`~/.local/state/orca-wow/strip.key`,
  mode 0600) and derives an encryption key and a MAC key from it. Both go into every
  snapshot it writes to the slots. Slot files are never on screen. Windows has no file
  modes, so there the key relies on the profile folder, which other standard accounts
  can't open.
- The addon keeps the keys in file-local variables in `Transport.lua`. They aren't on
  the exported `Orca` table and aren't saved. The slot global is cleared on load.
- Nonces are a per-load prefix (time and random bytes) plus a counter, and a frame is
  re-sealed only when its content changes.
- Version 1 (plaintext) frames are only ever a bare hello with no thread id. The addon
  sends one before it has keys, and the bridge answers it with a snapshot carrying
  them. The bridge never runs commands from a plaintext frame and drops any encrypted
  frame that fails the tag.
- Replays are harmless: the bridge only runs command ids above the last one it ran
  for that session.
- `Crypto.lua` implements ChaCha20 and SHA-256 on the client's `bit` library; the bridge
  uses Node's. `bridge/test/crypto.test.js` checks they agree under both signed (LuaJIT)
  and unsigned (WoW-style) `bit` results, and that a strip the addon draws decrypts only
  with the right keys. Cost in game: about 0.2 ms per frame, a few ms for a full
  2,000-character message.

This keeps out viewers and anything else that can draw on the screen. It can't stop
another addon in the same game: addons share one Lua state, so a malicious addon could
drive T3 Code's UI directly. Only install addons you trust.

The frame is packed into 3-bit cells. Each cell is a 3×3-pixel square with R, G and B
each fully on or off. The strip is 160 cells per row and up to 40 rows (about 2.4 KB),
scaled so one UI unit is one physical pixel. It is anchored 9 physical pixels right of
and below the top-left corner of `UIParent`, on the TOOLTIP strata. Desktops that round
window corners cut into that corner and draw a border along its edges: Windows 11 rounds
by 8 pixels at 100 percent scaling and 16 at 200 percent, and Linux compositors can be
set to round too. 9 pixels in, the strip's first cell is clear of a corner rounded by
up to about 34 pixels. Bridges from before the inset look up to 9 pixels in, so they
find it only when their capture starts at the game's corner; a border of a pixel or more
(a windowed game on KDE Plasma, say) hides it from them until the bridge is updated. The bridge searches cell sizes 2–8 and offsets from the corner to a
little past the inset, so a border or scaling quirk doesn't break it, and a strip an
older addon draws in the corner itself is found too.

The payload is records separated by `RS` (0x1E), with fields separated by `US` (0x1F):

```
H  1  session  ui  nextSlot  sigNext  gen  flags  viewThreadId  addonVersion  slotCount  modelsHash  listHash  projectsHash  viewHash  familyHash
C  id  verb  args…                      (one per queued command)
```

- `session` is persistent (SavedVariables). `ui` is new every load, so the bridge can
  tell a `/reload` happened.
- `modelsHash` is the hash of the model list the addon holds (empty until it has one). The bridge sends the list (tens of KB with many commands and skills: at most 200 per provider, descriptions cut to 60 characters) only while this differs from its own, so it costs one publish after a `/reload` or a change in T3 Code instead of every publish.
- `listHash`, `projectsHash`, `viewHash` and `familyHash` are the hashes of the thread list, the project list, the transcript and the open thread's family the addon holds (empty until it has one). The bridge leaves the project list, the transcript (up to 60 KB) and the family out of a publish while they still match, and names them in the snapshot's `same` field (`p`, `v`, `f`) so the addon keeps them. Only a part the snapshot actually carried is recorded, and the bridge stops trusting a hash as soon as it publishes a different part, so a part can be repeated but never dropped. `PARTS` in `bridge.js` and `Store.PARTS` in the addon list these parts in the hello's order.
- The addon queues a command only if it would still fit beside the hello after the hello grows: another thread opened (a subagent's id is about 125 characters) and every hash filled in. A command that didn't fit would never go, and would hold up the commands behind it.
- `flags`:
  - `o`: window open
  - `t`: tracker on
  - `g`: gamepad UI
  - `r`: read finished replies with the desktop voice
  - `s`: sound signals unavailable
- Verbs:
  - `send`, `new`, `stop`
  - `model` (`threadId instanceId model [effort]`). `new` takes the same `instanceId model [effort]` after its text; without a model T3 Code's own default applies, and an empty `instanceId model` with an `effort` sets only the reasoning level on that default. `effort` is a level id from the model's list (`low`, `high`, …); without it the thread keeps the options last used with that model. `new` ends with an optional `worktree` (`1`): the thread starts in its own git worktree, a branch of its own based on the project's current checkout, named by T3 Code
  - `settle`, `unsettle`, `archive`, `read`
  - `approve`, `answer`
  - `speak`, `say`, `hush`, `dictate`
  - `ping`

The strip is drawn only while something is unacknowledged. "Something" means a status
change such as opening the window or switching threads, or a queued command. It is
redrawn when content changes and hidden as soon as a snapshot acknowledges its
sequence number, usually in under a second. If nothing answers for 20 s, it hides and
retries with backoff.

**macOS.** The bridge finds the game window in CoreGraphics' window list (through a JXA script run by `osascript`, so there's nothing to compile) and captures the corner with `screencapture -R`, which returns physical pixels on a Retina display. The strip can start below the window's top: under a windowed game's title bar, or below the notch of a MacBook display in fullscreen. So the decoder searches 40 extra points down instead of guessing either height. Both tools run as the bridge, which needs the Screen Recording permission; the bridge asks for it when it starts.

**KDE Plasma.** KWin doesn't implement wlroots' screencopy, so `grim` can't read it. The bridge uses KWin's D-Bus API through `busctl` (part of systemd): `org.kde.krunner1.Match` on `/WindowsRunner` lists windows captioned "World of Warcraft", `getWindowInfo` gives each one's frame geometry, pid, desktops and minimized state, and `org.kde.KWin.ScreenShot2.CaptureArea` writes the corner's raw pixels (a QImage format KWin names in its reply) into a pipe the bridge passes as fd 3. It asks for native resolution so the cells aren't resampled on a scaled display, and searches 40 pixels down for a windowed game's title bar, as on macOS. Screenshots use `CaptureWindow`, which renders the window even while it's covered. On KWin 6.8 these calls work without the `X-KDE-DBUS-Restricted-Interfaces` grant that Spectacle's desktop file carries; if a later KWin refuses them, the error shows in `orca-wow status`.

**Windows.** Node can't call the Windows API, and starting PowerShell for each capture costs 0.3 to 1.3 s, far too slow for a loop that runs every 150 ms. So the bridge keeps one Windows PowerShell 5.1 process running, which compiles `bridge/src/windows-helper.cs` with `Add-Type` when it starts. Both ship with Windows, so there's nothing to install or build. The bridge writes this helper one line of JSON per request, and reads back one line of JSON followed by the raw pixels. The helper is per-monitor DPI aware and reads the game window's client area in physical pixels. The client area starts exactly at the game's UI origin, so there's no title bar to search past. The helper reads the strip by copying that corner of the screen. While another window covers the corner, or the corner is off screen, it uses `PrintWindow` instead, which has Windows render the game window itself. Screenshots always use `PrintWindow`, so a window on top of the game never ends up in the picture. The same helper lists the running programs, which is how the bridge finds the client. What was measured, and what hasn't been checked in game, is under [Windows notes](#windows-notes).

## Bridge → game: slots and signals

`Orca_S001…S1200` (1,200 by default) are load-on-demand addons grouped under Orca in
the addon list (`## Group`). They deliberately have no `## Dependencies`: WowUp hides
an unrecognised load-on-demand folder only when all its dependencies are recognised, and
Orca isn't on CurseForge, so a dependency on it made every slot its own "Unknown" row
(1,200 rows, measured with WowUp 2.24). Without it WowUp shows one "T3 Code" entry.

Addon managers also fingerprint each folder (a 32-bit hash of the `.toc` and the files it
lists) and look it up across all of CurseForge. A slot that listed `Inbox.lua` directly
produced a fresh hash with every update, and one collided: WowUp took a slot for a
Minecraft modpack, which an "update" would have installed over it. So every slot's TOC is
identical and lists a static `Slot.xml`, which loads `Inbox.lua` with
`<Script file="Inbox.lua"></Script>`. The scanners only follow self-closing `<Script/>`
tags, so all slots share one fixed fingerprint that matches nothing on CurseForge
(checked with WowUp's own hashing code and a rescan).
Each contains `Inbox.lua`, which assigns `Orca_Inbox = { … }`. The bridge serializes
plain data with `luaser.js`, so thread text can never become code. All text is escaped
for WoW markup (`|` → `||`), then markdown is turned into colors and bullets.

A publish works like this:

1. Build the snapshot: threads, projects, the viewed thread's messages, pending
   question or approval, usage, bridge status, command results and the ack. The
   model list rides along only when the addon's `modelsHash` is out of date.
   It is grouped per machine and provider, and each model points at one of a few shared sets of reasoning levels instead of carrying its own. Each provider also carries its slash commands and skills, which the message box suggests when the player types `/` or `$`. Threads carry their reasoning level (`re`), projects the level their default model uses (`de`).
   The open thread's family (`fam`) is a part of its own. `up` is the thread it came from: the thread that started a subagent, a fork's source, a side chat's thread, or the thread on another machine that sent it here. `kids` are the threads it started, in the order they started. Each carries a title, a status, its kind (`sub`, `fork`, `side`, `sent`) and its machine when that's another one. A sender on a machine the bridge doesn't know has no id, so the game shows it but can't open it. When the open thread isn't in the list (an idle subagent), `me` carries its list row, so the window still has its header. The family leaves out activity, message text and update times, so it only changes when a relative's title or status does, or a relative comes or goes. It's absent when there's nothing to show.
2. Write it to the slots the addon will load next (from its last confirmed position
   to a little past the bridge's prediction) and to slots 1–3 (what a `/reload`
   bootstraps from). Slots 1–3 always carry the complete snapshot; the others leave
   out the transcript, the project list and the family when the addon's hello says it has them.
3. Ring the next **bell**.

**Bells (the "new update" signal).** Measured on this client:

- `PlaySoundFile` returns `willPlay = true` for *every* file, even empty or garbage
  ones, so its answer is useless.
- `C_Sound.IsPlaying(handle)` a fraction of a second later is reliable: real sounds
  play and empty files don't.
- Sound files bigger than `Sound_MaxCacheableSizeInBytes` (174,762 bytes here) are
  streamed and re-opened from disk on every play (confirmed by watching file
  access), so they're never stuck in the cache.

So a bell is a 10-second silent WAV (441 KB), and those ten files are all of `Signals/`. The bridge rings bell `k` by writing
that sound and empties bell `k-4`. The addon plays bells `sigNext … sigNext+3` every
0.5 s, checks which is really playing 0.15 s later, stops them all, and loads one slot
if one rang. Eight bells rotate forever, with no per-session limit. They live at
`Signals/03991–03998.wav`; `03999` (always long) and `04000` (always empty) are the
self-test controls. These names already existed when the client started, which
matters because the client only knows files that existed at launch.

**A file the game has open.** Windows refuses to replace a file another program has open, whatever sharing that program asked for (measured). Linux and macOS never refuse. So every slot and bell is written to a temp file and renamed into place, and on Windows a refused rename is retried for about 30 ms and then given up, with the old file intact. A publish that meets a file in use rings no bell and moves no counter, so the same publish is due again at the usual pacing. Bells follow two rules on every platform. A bell is written only when it's in the wrong state, and bell `k-4` is emptied before bell `k` is filled. A ring that stops between the two writes then leaves no bell rung that shouldn't be, and ringing again finishes it. A new game client isn't counted as started until every bell is empty.

If game sound is entirely off, the self-test fails and the addon falls back to
loading a slot on a timer (3 s while you're using the window, 20 s open, 90 s closed).

Measured in game: a 1.2 s round trip from strip to update, 1 slot per 2 idle minutes
with the window closed, and 2 per minute with it open.

**Pacing.** Each publish costs one slot, so the bridge paces by what you're doing:

| Situation | Interval |
| --- | --- |
| Acks and command results | ~0.5 s |
| Viewing a working thread | 2 s |
| Window open | 1.5–3 s |
| Window closed, status changes | 3 s |
| Window closed, minor changes | 20 s |
| Heartbeat (window open / closed) | 90 s / 240 s |

When few slots remain, intervals stretch 2–4×. When they run out, the addon offers
`/reload`.

## T3 Code side

`t3.js` uses the same API as T3's own clients:

- **Auth:** a session token from `t3 auth session issue --scope orchestration:read
  --scope orchestration:operate`, renewed a week before it expires.
- **Live data:** `POST /api/auth/websocket-ticket/rpc` gets a ticket, then
  `/ws?orchestrationProtocol=2` opens Effect RPC JSON frames.
- **Subscriptions:** `orchestration.subscribeShell` (thread list, live) and
  `subscribeServerConfig` (providers and usage limits).
- **Thread detail:** `GET /api/orchestration/threads/:id/bounded`, fetched for the
  viewed thread and for active threads so the tracker can say what they're doing.
- **Writes:** `orchestration.dispatchCommand` with `message.dispatch`, `run.interrupt`,
  `runtime-request.respond`, `thread.settle`, `thread.unsettle` and `thread.visit`;
  plus `orchestration.launchThread`.

## Controller

While the window is open it takes the gamepad itself (`EnableGamePadButton` /
`EnableGamePadStick`), so the character doesn't move and B closes the window. The D-pad
moves between controls by position, with explicit routes where position isn't enough
(thread list → message box, for example). Blizzard's `SmartNavigationPointerTemplate`
draws the cursor.

The addon never touches the binding-group APIs, which would taint the gamepad action
bars, and avoids Blizzard's `Menu` (it caused "blocked action" errors). LB/RB switch
tabs, X reads aloud, Y dictates, and the right stick scrolls the transcript. Forever has
no on-screen keyboard, so text input uses dictation, quick replies and option buttons.
The game menu gets a T3 Code button, and a controller chord opens the window.

## Windows notes

Windows support is new. This section says how the bridge runs in the background there, what was measured, and what hasn't been checked in game yet.

**In the background.** The bridge reads the screen, so it has to run in the player's own desktop session, which a Windows service can't. A Task Scheduler task starts it when the user signs in. A normal user can register that task without administrator rights. The task runs `conhost.exe --headless node orca-wow.js supervise`, because conhost is the only way found to start Node from a task without a window. The supervisor (`bridge/src/windows-service.js`) starts the bridge, sends its output to `bridge.log`, and starts it again 3 seconds after any exit. Task Scheduler can't do that restart here, because conhost exits with code 0 whatever Node's exit code was. Stopping the task ends conhost and nothing under it. So the supervisor and the bridge both watch conhost's pid and stop when it's gone, and the bridge saves its state as it stops.

**One bridge at a time.** Two bridges would both read the same strip frame and run the same command, so a message could reach the agent twice. The supervisor records itself and its bridge in `running.json` in the state folder, each as a pid and a start time, because Windows gives a pid to another program once its process is gone. A new supervisor doesn't start while a recorded one is running. Install, restart and uninstall wait for the recorded supervisor and bridge to be gone before they start or delete anything, and end them after 8 seconds if they're still there.

**What hides the strip.** A screen copy reads whatever is on screen. So before each copy the helper asks Windows which window is at 288 points over the strip, both where the addon draws it 9 pixels in and where older addons drew it in the corner: one every 16 pixels, and along the strip's far edges. If the window at any point isn't the game, the helper reads the game through `PrintWindow` instead. That catches every window at least 16 pixels wide and high over any part of the strip. A smaller window can sit between the points and hide part of the strip. An overlay that another program draws over the game's top-left corner, such as a frame-rate counter, also hides the strip while it's there, as on the other platforms. Windows doesn't report a click-through overlay as the window at a point, so the helper doesn't see one as covering.

**A game that isn't responding.** `PrintWindow` waits for the game's own window thread, however long that takes. So a game window that isn't answering can't be read through it, and the helper can do nothing else while it waits. Once Windows reports the window as not responding, the helper doesn't call `PrintWindow`: a covered corner reads as hidden, and a screenshot is refused with that reason. Windows puts its own stand-in window over a game in that state, which counts as a cover. Windows takes 5 seconds to report it. A `PrintWindow` call made in those 5 seconds still waits, and the bridge's time limit on the request ends the helper if the game takes longer.

**Measured** on one PC (Windows 11, Node.js 26, T3 Code Nightly 0.1.8, a 3840x2160 HDR display):

- Reading the corner of the game window, 2992x1683, with HDR on: a screen copy took 17 ms and `PrintWindow` 45 ms, both with correct colours. `PrintWindow` renders the whole window, so its cost grows with the window. That is why the screen copy is the normal path.
- A strip drawn in a test window decoded through both paths. `T3WOW_SCREEN_TEST` runs that check (see CONTRIBUTING.md).
- Asking which window is at the 279 points took 0.46 ms for each grab. A 16x16 window was seen at every place tried over the strip. A 15x15 window between the points wasn't seen. With a click-through overlay over the whole corner, the helper copied the screen and the strip wasn't found.
- A test window whose thread slept for 9 seconds: Windows reported it as not responding 5.0 seconds in, and its stand-in window was over it 0.06 seconds later. A `PrintWindow` call made 1 second in returned 8 seconds later, when the thread woke. With the check and nothing else over the corner, no grab during the sleep took longer than 8 ms. With another window over the corner, the grab at the start of the sleep waited out its 4-second limit, which ended the helper once. The next helper answered that the corner was hidden.
- Renaming over a file another program has open failed in every sharing mode that program could ask for.
- After the task was stopped, conhost was gone about 1 second later, and the Node processes under it kept running until they noticed. A Node program's own children ended the moment it exited.
- With a stand-in bridge under the real task, a restart left 0.3 to 0.8 seconds between the old bridge stopping and the new one starting. With the waiting taken out, the two ran together for 1.5 seconds.
- With the real bridge under the supervisor and no game running, everything was gone 0.7 seconds after the process the supervisor watches ended, and the bridge had saved its state.
- `Register-ScheduledTask` took the task from a normal user's shell and kept its settings: no time limit, runs on battery, one instance at a time.
- T3 Code's `t3.cmd` ran through `cmd.exe`, and created and revoked a session.
- In game (Windows 11, a 3840x2160 HDR display at 100 percent scaling, Windowed mode): the bridge found the client and the addon connected with the link encrypted. In the first 19 minutes the bridge decoded 431 frames and rejected none. The bells rang: every publish raised one bell and the addon loaded one slot, and it never reported its self-test failing. Across 80 publishes no rename was refused. `read`, `model` and `send` from the game reached T3 Code, including a thread on a second machine.
- With a small window over the strip corner, a grab went through `PrintWindow` in 33 to 41 ms and decoded. Uncovered, the screen copy took 4 to 11 ms.
- While the game was minimized the bridge read it as hidden. The addon used 30 slots in those 10 minutes before its first hello was read.
- In Windowed (Fullscreen) mode (the same display, 100 percent scaling, HDR on), with a tool that rounds every window's corners: the game window has no frame there, so its client area is the whole monitor, and its top-left corner was rounded by about 8 pixels, blended, black outside, with a 1-pixel grey border along the top row and the left column. Where the addon drew the strip then, in the corner itself, that blacked out its first cell: 181 of 181 screen copies over 75 s found no strip, although it was on screen with clean colours in every one. Read through `PrintWindow`, the same window decoded, so the game draws the strip whole and the corner is cut when Windows puts the window on the screen. `PrintWindow` took 52 ms per grab of the 3840x2160 window, and what that costs the game's frame time is unmeasured, so it isn't the way round this. In Windowed mode the rounded corners fall on the title bar, outside the client area, and the strip was read as before. With the strip drawn 9 pixels in from the corner (see the strip above), in the same mode with the same tool running, the addon connected with the link encrypted, and the bridge decoded 305 frames and rejected none.

**Not checked in game yet.** Each of these needs a session in game, and the results belong here:

- Whether the strip decodes with display scaling above 100 percent, and on a second monitor.
- The helper's check for a window over the strip now looks at the 489 by 129 pixels from the client area's top-left, which take the strip drawn 9 pixels in. It compiles under Windows PowerShell 5.1, and `T3WOW_SCREEN_TEST` now puts a 16x16 window over only the strip's far end, but that check hasn't been run with the wider check yet.
- Windows 10, and Windows on ARM.
- Whether a message sent while another window covers the game's corner still arrives.
- How the client opens slot and bell files, and how often a long session has a publish wait for one.
- Whether the logon task starts the bridge when the user signs in. In the checks above the installer started it.
- Whether the game's own voice reads replies aloud.
