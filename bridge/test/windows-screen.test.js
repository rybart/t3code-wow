import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { StripCapture } from '../src/capture.js';
import { STRIP_INSET, decodeImage, encodeFrame } from '../src/codec.js';

const at = process.platform === 'win32' && process.env.T3WOW_SCREEN_TEST;
const asked = { skip: !at && 'it draws a window: on Windows, set T3WOW_SCREEN_TEST=x,y to say where' };

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SHOW = "$ErrorActionPreference = 'Stop'; Add-Type -LiteralPath $env:T3WOW_STRIP_SRC -ReferencedAssemblies System.Windows.Forms,System.Drawing; [OrcaWow.StripWindow]::Run()";
const CLIENT = { width: 700, height: 220 };
const OVER_THE_CORNER = { x: -20, y: -20, width: 320, height: 140 };
const TOOLTIP_SIZED = { x: 201, y: 22, width: 16, height: 16 };
// Over only the strip's last cells, which the inset puts past the 480 pixels from the
// corner the strip took when it was drawn in the corner itself.
const OVER_THE_FAR_END = { x: 482, y: 12, width: 16, height: 16 };
const HANG_MS = 8000;

function showStrip(cells) {
  return spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', SHOW], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      T3WOW_STRIP_SRC: fileURLToPath(new URL('./strip-window.cs', import.meta.url)),
      T3WOW_STRIP_CELLS: cells.join(''),
      T3WOW_STRIP_AT: at,
      T3WOW_STRIP_TITLE: 'T3 Code strip test',
    },
  });
}

function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function jpegSize(data) {
  for (let i = 2; i < data.length; i += 2 + data.readUInt16BE(i + 2)) {
    if (data[i + 1] >= 0xc0 && data[i + 1] <= 0xc2) return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
  }
  return null;
}

test('a strip in a real window is read off the screen, and through the window while another covers it, even a 16x16 one at its far end', asked, async (t) => {
  const payload = Buffer.from('a real frame from encodeFrame, long enough to fill several rows of cells. '.repeat(8));
  const stage = showStrip(encodeFrame(4242, payload));
  try {
    const [shown] = await within(15000, once(readline.createInterface({ input: stage.stdout }), 'line'), 'the test window shows');
    const dpi = Number(shown.split(' ')[1]);
    const capture = new StripCapture({});

    const read = async (via) => {
      const end = Date.now() + 3000;
      for (;;) {
        const res = await capture.grab(stage.pid);
        const out = res.status === 'ok' && res.via === via && decodeImage(res.image, null, { searchY: res.searchY });
        if (out && !out.error) {
          assert.equal(out.seq, 4242);
          assert.ok(out.payload.equals(payload), 'the payload comes back whole');
          assert.deepEqual(out.geo, { ox: STRIP_INSET, oy: STRIP_INSET, cell: 3 }, 'the image starts at the top-left of the client area');
          return;
        }
        assert.ok(Date.now() < end, `the strip is read via the ${via} within 3 s (last grab: ${res.status} via the ${res.via})`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const cover = ({ x, y, width, height }) => stage.stdin.write(`cover ${x} ${y} ${width} ${height}\n`);
    const timed = async (via) => {
      const started = performance.now();
      for (let i = 0; i < 20; i++) assert.equal((await capture.grab(stage.pid)).via, via);
      t.diagnostic(`a grab via the ${via}: ${((performance.now() - started) / 20).toFixed(1)} ms, mean of 20`);
    };

    const started = performance.now();
    await capture.grab(stage.pid);
    t.diagnostic(`the first grab, which starts the helper: ${Math.round(performance.now() - started)} ms`);
    await read('screen');
    await timed('screen');

    cover(OVER_THE_CORNER);
    await read('window');
    await timed('window');

    const shot = await capture.screenshot(stage.pid);
    assert.equal(shot.mime, 'image/jpeg');
    assert.match(shot.name, /^wow-.*\.jpg$/);
    assert.deepEqual([...shot.data.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual(jpegSize(shot.data), { width: Math.round((CLIENT.width * 96) / dpi), height: Math.round((CLIENT.height * 96) / dpi) }, `the client area at the size it has before ${dpi} DPI scaling`);

    stage.stdin.write('uncover\n');
    await read('screen');

    cover(TOOLTIP_SIZED);
    await read('window');

    cover(OVER_THE_FAR_END);
    await read('window');
  } finally {
    stage.stdin.end();
    await within(5000, once(stage, 'exit'), 'the test window closes').catch(() => stage.kill());
  }
});

test('a window that stops responding reads as hidden and gives no screenshot, and is read again once it answers', asked, async () => {
  const stage = showStrip(encodeFrame(1, Buffer.from('hello')));
  try {
    await within(15000, once(readline.createInterface({ input: stage.stdout }), 'line'), 'the test window shows');
    const capture = new StripCapture({});
    const grabs = async (status, ms) => {
      const end = Date.now() + ms;
      for (;;) {
        const res = await capture.grab(stage.pid);
        if (res.status === status) return;
        assert.ok(Date.now() < end, `a grab says ${status} within ${ms / 1000} s (last grab: ${res.status})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    await grabs('ok', 3000);
    stage.stdin.write(`hang ${HANG_MS}\n`);
    await grabs('hidden', HANG_MS);
    await assert.rejects(capture.screenshot(stage.pid), /isn't responding/);
    await grabs('ok', HANG_MS);
  } finally {
    stage.stdin.end();
    await within(HANG_MS + 5000, once(stage, 'exit'), 'the test window closes').catch(() => stage.kill());
  }
});
