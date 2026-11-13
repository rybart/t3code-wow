import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StripCapture } from '../src/capture.js';
import { CELLS_PER_ROW, MAX_ROWS, STRIP_INSET } from '../src/codec.js';
import { Desktop, launchHelper, pickWinWindow, splitFrames } from '../src/windows.js';

const windowsOnly = { skip: process.platform !== 'win32' && 'needs Windows PowerShell' };
const FAKE = fileURLToPath(new URL('./fake-windows-helper.mjs', import.meta.url));

const wow = { pid: 4242, path: 'D:\\Games\\World of Warcraft\\_forever_\\Wow.exe', startMs: Date.UTC(2026, 10, 9, 9, 27, 45) };
const explorer = { pid: 77, path: 'C:\\Windows\\explorer.exe', startMs: Date.UTC(2026, 10, 9, 8, 0, 0) };
const win = (hwnd, pid, extra = {}) => ({ hwnd, pid, title: 'World of Warcraft', visible: true, minimized: false, x: 503, y: 260, width: 2992, height: 1683, ...extra });
const corner = { width: 672, height: 192 };

function fakeDesktop(scenario, options = {}) {
  const helpers = [];
  const launch = () => {
    helpers.push(spawn(process.execPath, [FAKE, JSON.stringify(scenario)], { stdio: ['pipe', 'pipe', 'pipe'] }));
    return helpers.at(-1);
  };
  return { desktop: new Desktop({ launch, ...options }), helpers };
}

function requestLog() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-helper-')), 'requests');
  return { file, read: () => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

async function eventually(ask) {
  const end = Date.now() + 5000;
  for (;;) {
    try {
      return await ask();
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done, what) {
  const end = Date.now() + 5000;
  while (!done()) {
    assert.ok(Date.now() < end, `${what} within 5 s`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test('replies cut anywhere by the pipe come out whole and in order', () => {
  const frame = (head, data = Buffer.alloc(0)) => Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, bytes: data.length })}\n`), data]);
  const pixels = Buffer.from(Array.from({ length: 600 }, (_, i) => i % 256));
  const stream = Buffer.concat([frame({ id: 1 }, pixels), frame({ id: 2 }), frame({ id: 3 }, pixels.subarray(0, 5))]);
  for (let cut = 0; cut <= stream.length; cut++) {
    const first = splitFrames(stream.subarray(0, cut));
    const second = splitFrames(Buffer.concat([first.rest, stream.subarray(cut)]));
    const frames = [...first.frames, ...second.frames];
    assert.deepEqual(frames.map((f) => [f.head.id, f.data.length]), [[1, 600], [2, 0], [3, 5]], `cut at ${cut}`);
    assert.ok(frames[0].data.equals(pixels), `cut at ${cut}`);
    assert.equal(second.rest.length, 0);
  }
  assert.throws(() => splitFrames(Buffer.from('WARNING: something PowerShell printed\n')));
});

test('requests written back to back each get their own answer', async () => {
  const { desktop } = fakeDesktop({ procs: { Wow: [wow], explorer: [explorer] } });
  const answers = await Promise.all([desktop.processes('Wow'), desktop.processes('explorer'), desktop.processes('Retail'), desktop.processes('Wow')]);
  assert.deepEqual(answers, [[wow], [explorer], [], [wow]]);
  desktop.stop();
});

test('a helper that dies fails the request in flight, and a later request gets a new helper', async () => {
  const { desktop, helpers } = fakeDesktop({ procs: { Wow: [wow] }, exitAfter: 2 });
  assert.deepEqual(await desktop.processes('Wow'), [wow]);
  await assert.rejects(desktop.processes('Wow'));
  assert.deepEqual(await eventually(() => desktop.processes('Wow')), [wow]);
  assert.equal(helpers.length, 2);
  desktop.stop();
});

test('a helper that stops answering is killed and replaced', async () => {
  const { desktop, helpers } = fakeDesktop({ procs: { Wow: [wow] }, silentAfter: 2 }, { timeoutMs: 100 });
  assert.deepEqual(await desktop.processes('Wow'), [wow]);
  await assert.rejects(desktop.processes('Wow'));
  await until(() => !alive(helpers[0].pid), 'the silent helper is gone');
  assert.deepEqual(await eventually(() => desktop.processes('Wow')), [wow]);
  assert.equal(helpers.length, 2);
  desktop.stop();
});

test("a helper that can't start is reported with what PowerShell said, and not started again at once", async () => {
  const { desktop, helpers } = fakeDesktop({ neverReady: true });
  const reports = [];
  desktop.report = (message) => reports.push(message);
  await assert.rejects(desktop.processes('Wow'), /Cannot add type/);
  await assert.rejects(desktop.processes('Wow'), /Cannot add type/);
  assert.equal(helpers.length, 1);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Cannot add type/);
});

test('a command that asked the desktop one question exits, and its helper goes with it', async () => {
  const script = `
    import { spawn } from 'node:child_process';
    import { Desktop } from ${JSON.stringify(new URL('../src/windows.js', import.meta.url).href)};
    const launch = () => {
      const helper = spawn(process.execPath, [${JSON.stringify(FAKE)}, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(helper.pid);
      return helper;
    };
    await new Desktop({ launch }).processes('Wow');
  `;
  const command = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 10000 });
  let printed = '';
  command.stdout.on('data', (d) => (printed += d));
  const [code] = await once(command, 'close');
  assert.equal(code, 0);
  const helper = Number(printed);
  assert.ok(helper > 0, 'the command started a helper');
  await until(() => !alive(helper), 'the helper is gone');
});

test("the game window: the client's own over a same-named one, the largest of its windows, never a hidden or tiny one", () => {
  assert.deepEqual(pickWinWindow([win(1, 9), win(2, 5, { width: 300, height: 200 }), win(3, 5)], 5), { found: true, hwnd: 3 });
  assert.deepEqual(pickWinWindow([win(1, 5, { visible: false }), win(2, 5, { width: 40, height: 40 })], 5), { found: false });
  assert.deepEqual(pickWinWindow([win(1, 9)], undefined), { found: true, hwnd: 1 }, 'by title when the pid is unknown');
  assert.deepEqual(pickWinWindow([win(1, 9, { title: 'Battle.net' })], 5), { found: false });
});

test('a minimized game is still found, so the bridge can say hidden and not missing', () => {
  const minimized = win(1, 5, { minimized: true, width: 0, height: 0 });
  assert.deepEqual(pickWinWindow([minimized], 5), { found: true, hwnd: 1 });
  assert.deepEqual(pickWinWindow([minimized, win(2, 5, { width: 640, height: 480 })], 5), { found: true, hwnd: 2 }, 'a window that is showing wins');
});

test('grab: the pixels of the game window, which is looked up once for many grabs', async () => {
  const log = requestLog();
  const { desktop } = fakeDesktop({ windows: [win(1, 9), win(7, 5)], pixel: [10, 200, 30], log: log.file });
  for (let i = 0; i < 3; i++) {
    const res = await desktop.grab(5, corner);
    assert.deepEqual([res.status, res.via, res.image.width, res.image.height, res.image.data.length], ['ok', 'screen', 672, 192, 672 * 192 * 3]);
    assert.deepEqual([...res.image.data.subarray(0, 3), ...res.image.data.subarray(-3)], [10, 200, 30, 10, 200, 30]);
  }
  const grab = { op: 'grab', hwnd: 7, w: 672, h: 192 };
  assert.deepEqual(log.read(), [{ op: 'windows', pid: 5, title: 'World of Warcraft' }, grab, grab, grab]);
  desktop.stop();
});

test('grab: a window that closed reads as no-window, and the next grab looks again', async () => {
  const log = requestLog();
  const { desktop } = fakeDesktop({ windows: [win(7, 5)], states: { 7: 'gone' }, log: log.file });
  assert.deepEqual(await desktop.grab(5, corner), { status: 'no-window' });
  assert.deepEqual(await desktop.grab(5, corner), { status: 'no-window' });
  assert.deepEqual(log.read().map((r) => r.op), ['windows', 'grab', 'windows', 'grab']);
  desktop.stop();

  const none = fakeDesktop({ windows: [] });
  assert.deepEqual(await none.desktop.grab(5, corner), { status: 'no-window' });
  none.desktop.stop();
});

test('grab: minimized, on another virtual desktop, or covered and not responding, reads as hidden', async () => {
  for (const state of ['minimized', 'cloaked', 'hung']) {
    const { desktop } = fakeDesktop({ windows: [win(7, 5)], states: { 7: state } });
    assert.deepEqual(await desktop.grab(5, corner), { status: 'hidden' }, state);
    desktop.stop();
  }
});

test('grab: with a configured region, the screen is copied there and no window is looked up', async () => {
  const log = requestLog();
  const { desktop } = fakeDesktop({ via: 'screen', log: log.file });
  const res = await desktop.grab(5, { ...corner, region: { x: -1080, y: -300 } });
  assert.deepEqual([res.status, res.image.data.length], ['ok', 672 * 192 * 3]);
  assert.deepEqual(log.read(), [{ op: 'grab', x: -1080, y: -300, w: 672, h: 192 }]);
  desktop.stop();
});

test('screenshot: the JPEG the helper made, or the reason there is none', async () => {
  const jpeg = [0xff, 0xd8, 0xff, 0xd9];
  const showing = fakeDesktop({ windows: [win(7, 5)], jpeg });
  assert.deepEqual(await showing.desktop.screenshot(5), { data: Buffer.from(jpeg), mime: 'image/jpeg' });
  showing.desktop.stop();

  const minimized = fakeDesktop({ windows: [win(7, 5)], states: { 7: 'minimized' } });
  await assert.rejects(minimized.desktop.screenshot(5), /minimized/);
  minimized.desktop.stop();

  const hung = fakeDesktop({ windows: [win(7, 5)], states: { 7: 'hung' } });
  await assert.rejects(hung.desktop.screenshot(5), /isn't responding/);
  hung.desktop.stop();

  const missing = fakeDesktop({ windows: [] });
  await assert.rejects(missing.desktop.screenshot(5), /find the game window/);
  missing.desktop.stop();
});

test('the helper places the strip where the addon draws it and the decoder looks, inside the corner the bridge grabs', () => {
  const helper = fs.readFileSync(fileURLToPath(new URL('../src/windows-helper.cs', import.meta.url)), 'utf8');
  const addon = fs.readFileSync(fileURLToPath(new URL('../../addon/Orca/Core/Transport.lua', import.meta.url)), 'utf8');
  const [cell, perRow, rows, inset] = helper.match(/const int CELL = (\d+), CELLS_PER_ROW = (\d+), MAX_ROWS = (\d+), INSET = (\d+);/).slice(1).map(Number);
  assert.deepEqual([cell, perRow, rows, inset], [Number(addon.match(/^local CELL = (\d+)/m)[1]), CELLS_PER_ROW, MAX_ROWS, Number(addon.match(/^local INSET = (\d+)/m)[1])]);
  assert.equal(inset, STRIP_INSET, 'where the decoder looks');
  const grabbed = StripCapture.stripPixels(4);
  assert.ok(inset + perRow * cell <= grabbed.width && inset + rows * cell <= grabbed.height, 'the whole strip is in what the bridge grabs');
});

test("the real helper compiles under Windows PowerShell 5.1 and finds this test's own process", windowsOnly, async () => {
  let helper;
  const desktop = new Desktop({ launch: () => (helper = launchHelper()) });
  const me = (await desktop.processes(path.basename(process.execPath, '.exe'))).find((p) => p.pid === process.pid);
  assert.equal(me.path.toLowerCase(), process.execPath.toLowerCase());
  const started = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(me.startMs - started) < 2000, `started ${me.startMs}, expected about ${Math.round(started)} (ms since 1970 UTC)`);
  desktop.stop();
  const [code] = await within(5000, once(helper, 'exit'), 'the helper exits when its input closes');
  assert.equal(code, 0);
});

test('the real helper leaves when the bridge is gone, even with its input still open', windowsOnly, async () => {
  const bridge = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const helper = launchHelper(bridge.pid);
  try {
    await within(15000, once(helper.stdout, 'data'), 'the helper says it is ready');
    bridge.kill();
    const [code] = await within(5000, once(helper, 'exit'), 'the helper exits');
    assert.equal(code, 0);
  } finally {
    bridge.kill();
    helper.kill();
  }
});
