// The outbound channel (game -> bridge): screen-capture the top-left corner of the
// game window and decode the addon's pixel strip.
//
// Hyprland (and other wlroots compositors) allow screencopy, so `grim` can read the
// game's pixels on Wayland. KDE Plasma's KWin doesn't, but its ScreenShot2 D-Bus
// interface does the same job. X11 sessions use ImageMagick's `import`. macOS uses its
// own `screencapture`, which needs the Screen Recording permission.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodeImage, parsePPM, parseBMP, parseQImage, encodePNG, CELLS_PER_ROW, MAX_ROWS } from './codec.js';
import { desktop } from './windows.js';

// A service may start before the session exports WAYLAND_DISPLAY; find the socket.
function captureEnv() {
  if (process.env.WAYLAND_DISPLAY) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  try {
    const sock = fs.readdirSync(runtime).find((f) => /^wayland-\d+$/.test(f));
    if (sock) return { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: sock };
  } catch {}
  return process.env;
}

function run(cmd, args, { maxBuffer = 32 * 1024 * 1024, timeout = 4000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'buffer', maxBuffer, timeout, env: captureEnv() }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString();
        reject(err);
      } else resolve(stdout);
    });
    if (input) child.stdin.end(input);
  });
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hyprland IPC (no hyprctl spawn needed)

function hyprSocket() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const base = path.join(runtime, 'hypr');
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (sig && fs.existsSync(path.join(base, sig, '.socket.sock'))) return path.join(base, sig, '.socket.sock');
  // Running as a systemd service the variable may be missing: use the newest instance.
  try {
    const dirs = fs
      .readdirSync(base)
      .map((d) => path.join(base, d, '.socket.sock'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0] || null;
  } catch {
    return null;
  }
}

function hyprRequest(sock, cmd) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const chunks = [];
    c.on('connect', () => c.write(cmd));
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    c.on('error', reject);
    c.setTimeout(2000, () => {
      c.destroy();
      reject(new Error('hyprland ipc timeout'));
    });
  });
}

async function hyprWindow(pid) {
  const sock = hyprSocket();
  if (!sock) return null;
  const [clients, monitors] = await Promise.all([
    hyprRequest(sock, 'j/clients').then(JSON.parse),
    hyprRequest(sock, 'j/monitors').then(JSON.parse),
  ]);
  const win =
    clients.find((c) => pid && c.pid === pid) ||
    clients.find((c) => c.title === 'World of Warcraft') ||
    clients.find((c) => /^World of Warcraft/.test(c.title || ''));
  if (!win) return { found: false };
  const mon = monitors.find((m) => m.id === win.monitor) || monitors[0];
  const visible =
    !win.hidden &&
    mon &&
    (mon.activeWorkspace?.id === win.workspace?.id || mon.specialWorkspace?.id === win.workspace?.id);
  return {
    found: true,
    visible,
    x: win.at[0],
    y: win.at[1],
    width: win.size[0],
    height: win.size[1],
    scale: mon?.scale || 1,
    focused: undefined,
  };
}

// ---------------------------------------------------------------------------
// macOS: CoreGraphics' window list through JXA (osascript ships with the system, so
// there's nothing to compile), then `screencapture` for the pixels.

// Prints { windows, screens } for windows owned by the pid, or by an app called Wow
// (the client's process name) or World of Warcraft. Window bounds are in points with
// the origin at the top-left of the main display; screens come from NSScreen, whose
// origin is bottom-left.
const MAC_WINDOWS_JXA = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function run(argv) {
  const pid = Number(argv[0]) || 0;
  const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0));
  const windows = [];
  for (let i = 0; i < arr.count; i++) {
    const w = arr.objectAtIndex(i);
    const v = (k) => { const x = w.objectForKey(k); return x.isNil() ? null : x.js; };
    const owner = v('kCGWindowOwnerName');
    const wpid = v('kCGWindowOwnerPID');
    if (wpid !== pid && owner !== 'Wow' && owner !== 'World of Warcraft') continue;
    windows.push({ id: v('kCGWindowNumber'), pid: wpid, layer: v('kCGWindowLayer'), onscreen: !!v('kCGWindowIsOnscreen'), bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
  }
  const screens = $.NSScreen.screens.js.map((s) => ({ x: s.frame.origin.x, y: s.frame.origin.y, width: s.frame.size.width, height: s.frame.size.height, scale: s.backingScaleFactor }));
  return JSON.stringify({ windows, screens });
}`;

// The game window from MAC_WINDOWS_JXA's output: its bounds and the scale of the screen
// it's on.
export function pickMacWindow(info, pid) {
  const normal = info.windows.filter((w) => w.layer === 0 && w.bounds.Width > 100 && w.bounds.Height > 100);
  const mine = normal.filter((w) => w.pid === pid);
  const pool = mine.length ? mine : normal;
  const area = (w) => w.bounds.Width * w.bounds.Height;
  const win = pool.sort((a, b) => Number(b.onscreen) - Number(a.onscreen) || area(b) - area(a))[0];
  if (!win) return { found: false };
  const b = win.bounds;
  const primary = info.screens[0];
  // NSScreen frames are bottom-left based; flip them into window-list coordinates.
  const screens = info.screens.map((s) => ({ ...s, y: primary.height - (s.y + s.height) }));
  const cx = b.X + b.Width / 2;
  const cy = b.Y + b.Height / 2;
  const screen = screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) || screens[0];
  return { found: true, id: win.id, visible: win.onscreen, x: b.X, y: b.Y, width: b.Width, height: b.Height, scale: screen?.scale || 1 };
}

// ---------------------------------------------------------------------------
// KDE Plasma: KWin doesn't offer wlroots' screencopy, so grim can't read it. Its D-Bus
// API can: the windows runner (KRunner's window search) finds windows by caption,
// getWindowInfo gives their geometry, pid, desktops and minimized state, and
// ScreenShot2 writes raw pixels into a pipe we pass it. busctl ships with systemd and
// can pass that pipe, so there's nothing to install.

const KWIN_WINDOW_ID = /\{[0-9a-f-]{36}\}$/i;

// Runs busctl and parses its JSON reply. With `pipe`, busctl gets a pipe as fd 3 for an
// `h` argument, and the result also carries what was written to it.
function busctl(args, { pipe = false, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('busctl', ['--user', '--json=short', 'call', ...args], {
      stdio: ['ignore', 'pipe', 'pipe', ...(pipe ? ['pipe'] : [])],
      env: captureEnv(),
    });
    const out = [];
    const err = [];
    const data = [];
    let pending = pipe ? 2 : 1;
    let code = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`busctl ${args[3]} timed out`));
    }, timeout);
    const done = () => {
      if (--pending) return;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString('utf8').trim() || `busctl ${args[3]} failed`));
      try {
        resolve({ reply: JSON.parse(Buffer.concat(out).toString('utf8')).data, data: Buffer.concat(data) });
      } catch (e) {
        reject(e);
      }
    };
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    if (pipe) {
      child.stdio[3].on('data', (d) => data.push(d));
      child.stdio[3].on('close', done);
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (c) => {
      code = c;
      done();
    });
  });
}

// a{sv} as busctl prints it ({ key: { type, data } }) -> { key: data }.
const plainDict = (dict) => Object.fromEntries(Object.entries(dict).map(([k, v]) => [k, v.data]));

// The game window from getWindowInfo replies: found by pid, else by caption. It's
// visible unless minimized or on another virtual desktop (no desktops means all).
export function pickKwinWindow(infos, pid, desktop) {
  const win =
    infos.find((w) => pid && w.pid === pid) ||
    infos.find((w) => w.caption === 'World of Warcraft') ||
    infos.find((w) => /^World of Warcraft/.test(w.caption || ''));
  if (!win) return { found: false };
  const visible = !win.minimized && (!win.desktops?.length || win.desktops.includes(desktop));
  return { found: true, visible, uuid: win.uuid, x: win.x, y: win.y, width: win.width, height: win.height };
}

async function kwinWindow(pid) {
  const [{ reply: matches }, { reply: current }] = await Promise.all([
    busctl(['org.kde.KWin', '/WindowsRunner', 'org.kde.krunner1', 'Match', 's', 'World of Warcraft']),
    busctl(['org.kde.KWin', '/VirtualDesktopManager', 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.kde.KWin.VirtualDesktopManager', 'current']),
  ]);
  // Match ids are "<action>_{uuid}"; a window can appear once per action.
  const ids = [...new Set(matches[0].map((m) => KWIN_WINDOW_ID.exec(m[0])?.[0]).filter(Boolean))];
  const infos = await Promise.all(ids.map((id) => busctl(['org.kde.KWin', '/KWin', 'org.kde.KWin', 'getWindowInfo', 's', id]).then((r) => plainDict(r.reply[0]))));
  return pickKwinWindow(infos, pid, current[0].data);
}

// One ScreenShot2 call; `args` are the method's arguments before the options and pipe.
async function kwinCapture(method, signature, args, options, timeout = 4000) {
  const opts = Object.entries(options).flatMap(([k, v]) => [k, 'b', String(v)]);
  const { reply, data } = await busctl(
    ['org.kde.KWin', '/org/kde/KWin/ScreenShot2', 'org.kde.KWin.ScreenShot2', method, `${signature}a{sv}h`, ...args.map(String), String(opts.length / 3), ...opts, '3'],
    { pipe: true, timeout },
  );
  const meta = plainDict(reply[0]);
  if (meta.type !== 'raw') throw new Error(`unexpected KWin image type ${meta.type}`);
  return parseQImage(data, meta);
}

export const SCREEN_PERMISSION_HELP =
  `macOS hasn't let the bridge record the screen. Open System Settings > Privacy & Security > Screen & System Audio Recording, turn on ${path.basename(process.execPath)} (${process.execPath}), then restart the bridge with: launchctl kickstart -k gui/${process.getuid?.()}/t3code-wow`;

// ---------------------------------------------------------------------------

export class StripCapture {
  constructor({ log = () => {}, backend = 'auto', region = null } = {}) {
    this.log = log;
    this.backend = backend;
    this.manualRegion = region; // { x, y, width, height } in compositor (logical) coordinates
    this.hint = null;
    this.lastError = null;
    this.lastSeenAt = 0;
    this.stats = { captures: 0, decoded: 0, rejected: 0, notVisible: 0 };
    this.lastImage = null;
    this.winCache = null; // { pid, at, win }: window lookups cost an osascript run or several D-Bus calls
    this.macAsked = false;
    this.tmpDir = null;
    if (process.platform === 'win32') {
      desktop.report = (message) => {
        if (message !== this.lastError) this.log(message);
        this.lastError = message;
      };
    }
  }

  resolveBackend() {
    if (this.backend !== 'auto') return this.backend;
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'win32') return 'windows';
    if (/(^|:)KDE(:|$)/.test(process.env.XDG_CURRENT_DESKTOP || '') && which('busctl')) return 'kwin';
    if (process.env.WAYLAND_DISPLAY || hyprSocket()) {
      if (hyprSocket() && which('grim')) return 'hyprland';
      if (which('grim')) return 'grim';
    }
    if (process.env.DISPLAY && which('import')) return 'x11';
    if (which('grim')) return 'grim';
    return 'none';
  }

  // Size of the region to grab, in physical pixels: the largest strip plus slack for
  // window borders and offset search.
  static stripPixels(cell = 4) {
    return { width: CELLS_PER_ROW * cell + 32, height: MAX_ROWS * cell + 32 };
  }

  // The game window, looked up every 2 seconds, or less often while it stays put: each
  // lookup that finds it visible and unchanged doubles the wait, up to 8 seconds. A
  // change, or a hidden window, goes back to 2 seconds so a return to the game is quick.
  async cachedWindow(pid, lookup) {
    const c = this.winCache;
    if (c && c.pid === pid && Date.now() - c.at < c.ttl) return c.win;
    const win = await lookup(pid);
    const same = c && c.pid === pid && win.found && win.visible && JSON.stringify(win) === JSON.stringify(c.win);
    this.winCache = { pid, at: Date.now(), win, ttl: same ? Math.min(c.ttl * 2, 8000) : 2000 };
    return win;
  }

  macWindow(pid) {
    return this.cachedWindow(pid, async () => {
      const out = await run('osascript', ['-l', 'JavaScript', '-e', MAC_WINDOWS_JXA, String(pid)]);
      return pickMacWindow(JSON.parse(out.toString('utf8')), pid);
    });
  }

  kwinWindow(pid) {
    return this.cachedWindow(pid, kwinWindow);
  }

  // Ask macOS once for Screen Recording permission. The system shows its prompt (or
  // lists the bridge, switched off, in Settings) for the process that asked.
  requestScreenAccess() {
    if (this.macAsked) return;
    this.macAsked = true;
    const js = "ObjC.import('CoreGraphics'); ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]); $.CGRequestScreenCaptureAccess()";
    run('osascript', ['-l', 'JavaScript', '-e', js], { timeout: 60000 }).catch(() => {});
  }

  // On macOS, ask for Screen Recording up front (at bridge start) so the prompt shows
  // before the game does. macOS only prompts when the permission is missing. Elsewhere
  // there's nothing to ask.
  prepare() {
    if (this.resolveBackend() === 'macos') this.requestScreenAccess();
  }

  tmpFile(name) {
    if (!this.tmpDir || !fs.existsSync(this.tmpDir)) this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3code-wow-'));
    return path.join(this.tmpDir, name);
  }

  // One window's own pixels, even while other windows cover it, without its shadow.
  async macCaptureWindow(id, type) {
    const file = this.tmpFile(`window.${type}`);
    try {
      await run('screencapture', ['-x', '-o', '-l', String(id), '-t', type, file], { timeout: 8000 });
      return fs.readFileSync(file);
    } catch (err) {
      if (/could not create image/i.test(`${err.stderr || ''}${err.message}`)) {
        this.requestScreenAccess();
        throw new Error(SCREEN_PERMISSION_HELP);
      }
      throw err;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // `screencapture` writes a file; read it back and remove it. Rect is in points.
  async macCapture(rect, type) {
    const file = this.tmpFile(`capture.${type}`);
    try {
      await run('screencapture', ['-x', '-R', rect.map(Math.round).join(','), '-t', type, file], { timeout: 8000 });
      return fs.readFileSync(file);
    } catch (err) {
      if (/could not create image/i.test(`${err.stderr || ''}${err.message}`)) {
        this.requestScreenAccess();
        throw new Error(SCREEN_PERMISSION_HELP);
      }
      throw err;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async grab(wowPid) {
    const backend = this.resolveBackend();
    this.stats.captures++;
    if (backend === 'none') throw new Error('no capture backend: install grim (Wayland/wlroots) or ImageMagick (X11); on KDE Plasma the bridge uses busctl from systemd');
    const px = StripCapture.stripPixels(4);
    if (backend === 'windows') {
      const res = await desktop.grab(wowPid, { ...px, region: this.manualRegion });
      if (res.status === 'hidden') this.stats.notVisible++;
      return res;
    }
    if (backend === 'macos') {
      let region = this.manualRegion;
      let scale = 1;
      let searchY = 0;
      if (!region) {
        const win = await this.macWindow(wowPid);
        if (!win.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        scale = win.scale;
        region = { x: win.x, y: win.y };
        // The strip can start below the window's top: under the title bar of a windowed
        // game, or in fullscreen on a MacBook display, where the game moves its UI below
        // the notch. Search 40 points down rather than guessing either height.
        searchY = 40;
      }
      const w = Math.ceil(px.width / scale);
      const h = Math.ceil(px.height / scale) + searchY;
      const buf = await this.macCapture([region.x, region.y, w, h], 'bmp');
      const image = parseBMP(buf);
      // screencapture works in physical pixels: scale the slack to match the image.
      return { status: 'ok', image, searchY: Math.ceil(searchY * (image.width / w)) };
    }
    if (backend === 'kwin') {
      let region = this.manualRegion;
      let searchY = 0;
      if (!region) {
        const win = await this.kwinWindow(wowPid);
        if (!win.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        region = { x: win.x, y: win.y };
        // KWin reports the frame, so a windowed game's UI starts below the title bar.
        searchY = 40;
      }
      // The region is in logical pixels; at a scale above 1 this grabs more than the
      // strip needs, which is harmless. Native resolution keeps the cells unresampled.
      const w = px.width;
      const h = px.height + searchY;
      const image = await kwinCapture('CaptureArea', 'iiuu', [Math.round(region.x), Math.round(region.y), w, h], { 'native-resolution': true });
      return { status: 'ok', image, searchY: Math.ceil(searchY * (image.width / w)) };
    }
    if (backend === 'hyprland' || backend === 'grim') {
      let region = this.manualRegion;
      let scale = 1;
      if (!region && backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (!win?.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        scale = win.scale;
        region = { x: win.x, y: win.y };
      }
      region = region || { x: 0, y: 0 };
      const w = Math.ceil(px.width / scale);
      const h = Math.ceil(px.height / scale);
      const buf = await run('grim', ['-g', `${region.x},${region.y} ${w}x${h}`, '-t', 'ppm', '-']);
      return { status: 'ok', image: parsePPM(buf) };
    }
    if (backend === 'x11') {
      const r = this.manualRegion || { x: 0, y: 0 };
      const buf = await run('import', [
        '-silent', '-window', 'root',
        '-crop', `${px.width}x${px.height}+${r.x}+${r.y}`,
        '-depth', '8', 'ppm:-',
      ]);
      return { status: 'ok', image: parsePPM(buf) };
    }
    throw new Error(`unknown capture backend ${backend}`);
  }

  // A screenshot of the game window for attaching to a message: JPEG at the
  // compositor's logical resolution (keeps it well under T3's 10 MB image limit).
  async screenshot(wowPid) {
    const backend = this.resolveBackend();
    const name = `wow-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
    if (backend === 'windows') return { ...(await desktop.screenshot(wowPid)), name };
    if (backend === 'kwin') {
      // KWin renders the window itself, so this works even while it's covered.
      const win = await this.kwinWindow(wowPid);
      if (!win.found) throw new Error("couldn't find the game window");
      const image = await kwinCapture('CaptureWindow', 's', [win.uuid], { 'include-decoration': false, 'include-shadow': false }, 8000);
      if (which('magick')) {
        const data = await run('magick', ['-size', `${image.width}x${image.height}`, '-depth', '8', 'rgb:-', '-quality', '85', 'jpeg:-'], { timeout: 8000, input: image.data });
        return { data, name, mime: 'image/jpeg' };
      }
      return { data: encodePNG(image), name: name.replace(/\.jpg$/, '.png'), mime: 'image/png' };
    }
    if (backend === 'macos') {
      const win = await this.macWindow(wowPid);
      // Capture the game window itself (-l): a rectangle of the screen would take whatever
      // covers the game, such as another app's window, and send it with the screenshot.
      if (!win.visible) throw new Error("the game window isn't on screen");
      if (!win.id) throw new Error("couldn't identify the game window to capture it");
      let data = await this.macCaptureWindow(win.id, 'jpg');
      // Retina captures come back at twice the size; keep them at the logical size.
      if (win.scale > 1) {
        const file = this.tmpFile(name);
        fs.writeFileSync(file, data);
        try {
          await run('sips', ['-Z', String(Math.round(Math.max(win.width, win.height))), file], { timeout: 8000 });
          data = fs.readFileSync(file);
        } catch {}
        fs.rmSync(file, { force: true });
      }
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'hyprland' || backend === 'grim') {
      const args = ['-t', 'jpeg', '-q', '85', '-s', '1'];
      if (backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (win?.found) args.push('-g', `${win.x},${win.y} ${win.width}x${win.height}`);
      }
      const data = await run('grim', [...args, '-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'x11') {
      const data = await run('import', ['-silent', '-window', 'root', '-quality', '85', 'jpeg:-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    throw new Error('no screenshot backend (install grim)');
  }

  // One capture + decode. Returns { status, frame? }.
  async poll(wowPid) {
    let res;
    try {
      res = await this.grab(wowPid);
    } catch (err) {
      this.lastError = err.message;
      return { status: 'error', error: err.message };
    }
    if (res.status !== 'ok') return res;
    this.lastImage = res.image;
    const out = decodeImage(res.image, this.hint, { searchY: res.searchY });
    if (!out) return { status: 'empty' };
    this.hint = out.geo;
    if (out.error) {
      this.stats.rejected++;
      return { status: 'rejected', error: out.error };
    }
    this.stats.decoded++;
    this.lastSeenAt = Date.now();
    return { status: 'frame', frame: out };
  }
}
