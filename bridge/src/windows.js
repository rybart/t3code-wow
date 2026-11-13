// Node can't call the Windows API, and starting PowerShell for each capture costs
// 0.3 to 1.3 s, far too slow for a loop that runs every 150 ms. So one PowerShell
// process stays running for as long as the bridge does. It compiles windows-helper.cs
// when it starts (Add-Type, part of the Windows PowerShell 5.1 that ships with Windows,
// so there's nothing to install or build) and then answers requests on its standard
// input and output.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One running program, as the helper reports it.
 * @typedef {object} WinProcess
 * @property {number} pid
 * @property {string|null} path  Full path of its .exe. Null when Windows won't say.
 * @property {number} startMs    When it started, in ms since 1970 UTC. Windows records this
 *                               once per process, so pid and startMs together name one run
 *                               of a program even after the pid is reused.
 */

/**
 * One top-level window, as the helper reports it. Positions and sizes are in physical
 * pixels of the whole desktop (the helper is per-monitor DPI aware), so a monitor to
 * the left of or above the main one gives negative x or y.
 * @typedef {object} WinWindow
 * @property {number} hwnd
 * @property {number} pid
 * @property {string} title
 * @property {boolean} visible    False for the hidden helper windows a program owns.
 * @property {boolean} minimized  Windows gives a minimized window an empty client area, so its size says nothing.
 * @property {number} x           Left edge of the client area, the part the game draws.
 * @property {number} y           Top edge of the client area.
 * @property {number} width       Client area width.
 * @property {number} height      Client area height.
 */

/** @typedef {{ width: number, height: number, data: Buffer }} RgbImage  Packed 8-bit RGB, row-major, as codec.js reads it. */

/**
 * What StripCapture.grab() returns. `via` says how the pixels were read ('screen' or
 * 'window', see Desktop.grab) and is only there for people debugging the link.
 * @typedef {{ status: 'ok', image: RgbImage, via: 'screen'|'window' } | { status: 'no-window' } | { status: 'hidden' }} GrabResult
 */

/** @typedef {{ head: Record<string, any>, data: Buffer }} Frame  One reply from the helper. */

export const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HELPER_SRC = fileURLToPath(new URL('./windows-helper.cs', import.meta.url));

// A command string, not a script file, so the execution policy doesn't apply. The
// path travels in the environment, so no path needs quoting in PowerShell's syntax.
const BOOT = "$ErrorActionPreference = 'Stop'; Add-Type -LiteralPath $env:T3WOW_HELPER_SRC -ReferencedAssemblies System.Drawing,System.Web.Extensions; [OrcaWow.Helper]::Run()";

const READY_TIMEOUT_MS = 15000; // compiling takes 0.3 to 1.3 s here; a cold disk or a virus scan can take longer
const WINDOW_CACHE_MS = 2000;
const RESTART_AFTER_MS = [1000, 2000, 5000, 15000, 30000];
const TIME_LIMIT_MS = { procs: 3000, windows: 4000, grab: 4000, shot: 8000 };

/**
 * @param {number} [parentPid]  The helper exits when this process is gone.
 * @returns {import('node:child_process').ChildProcess}
 */
export function launchHelper(parentPid = process.pid) {
  return spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', BOOT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, T3WOW_HELPER_SRC: HELPER_SRC, T3WOW_PARENT_PID: String(parentPid) },
  });
}

/**
 * The complete frames at the start of `buffer`, and the bytes left over.
 * @param {Buffer} buffer
 * @returns {{ frames: Frame[], rest: Buffer }}
 * @throws {Error} when a line isn't a frame's JSON.
 */
export function splitFrames(buffer) {
  const frames = [];
  let at = 0;
  for (;;) {
    const lineEnd = buffer.indexOf(0x0a, at);
    if (lineEnd < 0) break;
    const head = JSON.parse(buffer.toString('utf8', at, lineEnd));
    if (!Number.isInteger(head?.bytes) || head.bytes < 0) throw new Error('a reply without its size');
    const end = lineEnd + 1 + head.bytes;
    if (buffer.length < end) break;
    frames.push({ head, data: buffer.subarray(lineEnd + 1, end) });
    at = end;
  }
  return { frames, rest: buffer.subarray(at) };
}

/**
 * The game's window among the helper's list: the largest visible window the client's
 * process owns, else one titled exactly "World of Warcraft". Hidden and tiny windows
 * (tooltips, IME, the launcher's splash) are never the game. A minimized game still
 * counts, so the bridge reports it as hidden instead of missing.
 * @param {WinWindow[]} windows
 * @param {number|undefined} pid
 * @returns {{ found: false } | { found: true, hwnd: number }}
 */
export function pickWinWindow(windows, pid) {
  const real = windows.filter((w) => w.visible && (w.minimized || (w.width > 100 && w.height > 100)));
  const mine = real.filter((w) => pid && w.pid === pid);
  const pool = mine.length ? mine : real.filter((w) => w.title === 'World of Warcraft');
  const area = (w) => w.width * w.height;
  const win = pool.sort((a, b) => Number(a.minimized) - Number(b.minimized) || area(b) - area(a))[0];
  return win ? { found: true, hwnd: win.hwnd } : { found: false };
}

const NO_SHOT = {
  gone: "couldn't find the game window",
  minimized: 'the game window is minimized',
  cloaked: 'the game window is on another desktop',
  hung: "the game window isn't responding",
};

// PowerShell prints an error as its message, hard-wrapped at the width of a console
// nobody sees, then where in the command it happened.
export const whatPowerShellSaid = (stderr) => stderr.split(/\r?\nAt line:/)[0].replace(/\r?\n/g, '').trim().slice(0, 300);

/** For each state of the helper, what can happen to it there and the state that follows. */
const LIFECYCLE = {
  idle: { launch: 'starting', stop: 'idle' },
  starting: { hello: 'ready', fail: 'idle', stop: 'idle' },
  ready: { fail: 'idle', stop: 'idle' },
};

/**
 * The Windows desktop, through one long-lived helper process.
 *
 * A crashed or hung helper costs the captures in flight, and a request after the pause
 * starts a new one. A helper that can't start at all (PowerShell locked down, say) is
 * retried at most every 30 s instead of in a loop.
 *
 * Stopping with the bridge needs no call. The helper exits when its stdin closes,
 * which Windows does for us however the bridge ends, including when Task Scheduler
 * kills it.
 *
 * The child and its pipes never keep this process alive. While the helper is starting
 * or a request is in flight, the time limit on it does. So a command like
 * `orca-wow install` that asked one question exits when it's done instead of
 * hanging on a helper nobody remembered to stop.
 */
export class Desktop {
  /** @type {import('node:child_process').ChildProcess|null} */
  #child = null;
  /** @type {keyof typeof LIFECYCLE} */
  #state = 'idle';
  /** @type {Array<{ id: number, timeoutMs: number, resolve: (f: Frame) => void, reject: (e: Error) => void }>} */
  #queue = [];
  #rest = Buffer.alloc(0);
  #stderr = '';
  #deadline = null;
  #nextId = 1;
  #failuresInARow = 0;
  #retryAt = 0;
  #lastError = '';
  /** @type {{ pid: number|undefined, hwnd: number, at: number }|null} */
  #window = null;
  #launch;
  #timeoutMs;

  /**
   * Called with a plain-language message each time the helper fails to start or stops.
   * @type {(message: string) => void}
   */
  report = () => {};

  /**
   * @param {{ launch?: () => import('node:child_process').ChildProcess, timeoutMs?: number }} [options]
   *   Both are for tests: `launch` starts a stand-in helper, and `timeoutMs` replaces
   *   every request's time limit so a test of a hung helper takes milliseconds.
   */
  constructor({ launch = launchHelper, timeoutMs } = {}) {
    this.#launch = launch;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Running programs with this image name (no ".exe").
   * @param {string} name
   * @returns {Promise<WinProcess[]>}
   */
  async processes(name) {
    return (await this.#request('procs', { name })).head.procs;
  }

  /**
   * The top-left corner of the game's client area, as StripCapture.grab() must return it.
   *
   * The client area starts exactly at the game's UI origin, so there's no title bar to
   * search past and no `searchY`. How the pixels are read is the helper's decision,
   * made per call:
   *  - 'screen': a copy of that rectangle of the screen. This is the normal path.
   *  - 'window': PrintWindow, which makes Windows render the whole client area. Used
   *    only while another window covers the corner or the corner is off screen, where
   *    a screen copy would read the wrong pixels. That keeps a command readable when
   *    the player sends it and switches straight to a browser.
   *
   * @param {number|undefined} pid  The client's pid from findWowProcess().
   * @param {{ width: number, height: number, region?: { x: number, y: number }|null }} options
   *   `region` is the config's capture.region: skip the window lookup and copy the
   *   screen at that point (physical pixels of the whole desktop).
   * @returns {Promise<GrabResult>}
   */
  async grab(pid, { width, height, region = null }) {
    const from = region ? { x: region.x, y: region.y } : { hwnd: await this.#gameWindow(pid) };
    if (from.hwnd === null) return { status: 'no-window' };
    const { head, data } = await this.#request('grab', { ...from, w: width, h: height });
    if (head.state === 'ok') return { status: 'ok', image: { width: head.width, height: head.height, data }, via: head.via };
    if (head.state === 'gone') this.#window = null;
    return { status: head.state === 'gone' ? 'no-window' : 'hidden' };
  }

  /**
   * A JPEG of the game's whole client area for attaching to a message, at the size
   * the window has before display scaling, like the other platforms' screenshots.
   * Always PrintWindow: the whole window is wanted, once, and a window on top of the
   * game must not end up in the picture.
   * @param {number|undefined} pid
   * @returns {Promise<{ data: Buffer, mime: 'image/jpeg' }>}
   * @throws {Error} with the reason in plain words, which is shown in game.
   */
  async screenshot(pid) {
    const hwnd = await this.#gameWindow(pid);
    if (hwnd === null) throw new Error(NO_SHOT.gone);
    const { head, data } = await this.#request('shot', { hwnd, quality: 85 });
    if (head.state !== 'ok') throw new Error(NO_SHOT[head.state]);
    return { data, mime: 'image/jpeg' };
  }

  /** Ask the helper to exit now. Only tests need this; see the class comment. */
  stop() {
    this.#child?.stdin.end();
    for (const waiting of this.#drain('stop')) waiting.reject(new Error('the Windows helper was stopped'));
  }

  /**
   * @param {number|undefined} pid
   * @returns {Promise<number|null>}
   */
  async #gameWindow(pid) {
    const known = this.#window;
    if (known && known.pid === pid && Date.now() - known.at < WINDOW_CACHE_MS) return known.hwnd;
    const { head } = await this.#request('windows', { pid: pid || 0, title: 'World of Warcraft' });
    const win = pickWinWindow(head.windows, pid);
    this.#window = win.found ? { pid, hwnd: win.hwnd, at: Date.now() } : null;
    return win.found ? win.hwnd : null;
  }

  /**
   * @param {keyof typeof TIME_LIMIT_MS} op
   * @param {Record<string, string|number>} args
   * @returns {Promise<Frame>}
   */
  #request(op, args) {
    return new Promise((resolve, reject) => {
      if (this.#state === 'idle' && Date.now() < this.#retryAt) return reject(new Error(this.#lastError));
      const id = this.#nextId++;
      this.#queue.push({ id, timeoutMs: this.#timeoutMs ?? TIME_LIMIT_MS[op], resolve, reject });
      if (this.#state === 'idle' && !this.#start()) return;
      this.#child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      if (this.#state === 'ready' && this.#queue.length === 1) this.#limitHead();
    });
  }

  /** @returns {boolean} False when no helper could be launched. The queue has been failed by then. */
  #start() {
    this.#transition('launch');
    this.#rest = Buffer.alloc(0);
    this.#stderr = '';
    let child;
    try {
      child = this.#launch();
    } catch (err) {
      this.#fail(`the bridge's Windows helper couldn't start: ${err.message}`);
      return false;
    }
    this.#child = child;
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) handle.unref();
    child.stdout.on('data', (chunk) => this.#read(child, chunk));
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(0, 2000);
    });
    // Writing to a helper that just died fails here. Its exit is what gets reported.
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.#ended(child, err.message));
    child.on('close', (code) => this.#ended(child, `it exited with code ${code}`));
    this.#limit(READY_TIMEOUT_MS, `the bridge's Windows helper didn't start within ${READY_TIMEOUT_MS / 1000} s`);
    return true;
  }

  #read(child, chunk) {
    if (child !== this.#child) return;
    let frames;
    try {
      ({ frames, rest: this.#rest } = splitFrames(Buffer.concat([this.#rest, chunk])));
    } catch {
      return this.#fail("the bridge's Windows helper sent something the bridge can't read");
    }
    for (const frame of frames) {
      if (this.#state === 'starting' && frame.head.ready) {
        this.#transition('hello');
        this.#limitHead();
        continue;
      }
      const asked = this.#queue[0];
      if (this.#state !== 'ready' || frame.head.id !== asked?.id) {
        return this.#fail("the bridge's Windows helper sent a reply the bridge wasn't waiting for");
      }
      this.#queue.shift();
      this.#failuresInARow = 0;
      this.#limitHead();
      if (frame.head.ok) asked.resolve(frame);
      else asked.reject(new Error(frame.head.error));
    }
  }

  #ended(child, how) {
    if (child !== this.#child) return;
    const said = whatPowerShellSaid(this.#stderr) || how;
    this.#fail(this.#state === 'starting' ? `the bridge's Windows helper couldn't start: ${said}` : `the bridge's Windows helper stopped: ${said}`);
  }

  #limit(ms, reason) {
    clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => this.#fail(reason), ms);
  }

  #limitHead() {
    const head = this.#queue[0];
    if (head) this.#limit(head.timeoutMs, `the bridge's Windows helper didn't answer within ${head.timeoutMs / 1000} s`);
    else clearTimeout(this.#deadline);
  }

  #fail(reason) {
    this.#child?.kill();
    const waiting = this.#drain('fail');
    this.#retryAt = Date.now() + RESTART_AFTER_MS[Math.min(this.#failuresInARow, RESTART_AFTER_MS.length - 1)];
    this.#failuresInARow++;
    this.#lastError = reason;
    for (const request of waiting) request.reject(new Error(reason));
    this.report(reason);
  }

  /** @param {'fail'|'stop'} event */
  #drain(event) {
    this.#transition(event);
    clearTimeout(this.#deadline);
    const waiting = this.#queue;
    this.#queue = [];
    this.#child = null;
    return waiting;
  }

  /**
   * @param {'launch'|'hello'|'fail'|'stop'} event
   * @throws {Error} when LIFECYCLE has no such event for the state the helper is in.
   */
  #transition(event) {
    const next = LIFECYCLE[this.#state][event];
    if (!next) throw new Error(`the bridge's Windows helper can't ${event} while it is ${this.#state}`);
    this.#state = next;
  }
}

export const desktop = new Desktop();
