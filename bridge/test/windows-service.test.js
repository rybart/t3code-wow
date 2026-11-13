import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logonTask, supervise, taskXml } from '../src/windows-service.js';
import { POWERSHELL } from '../src/windows.js';

const windowsOnly = { skip: process.platform !== 'win32' && 'needs Task Scheduler' };
const FAKE_BRIDGE = fileURLToPath(new URL('./fake-bridge.mjs', import.meta.url));
const RUN_SUPERVISOR = fileURLToPath(new URL('./run-supervisor.mjs', import.meta.url));

function sandbox(name = 't3wow-service-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const journal = path.join(dir, 'journal');
  return {
    dir,
    logFile: path.join(dir, 'state', 'bridge.log'),
    runningFile: path.join(dir, 'state', 'running.json'),
    bridge: (...options) => [process.execPath, FAKE_BRIDGE, journal, ...options],
    events: (event) => {
      try {
        return fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event === event);
      } catch {
        return [];
      }
    },
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!done()) {
    assert.ok(Date.now() < end, `${what} within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakeTask() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  return {
    pid: child.pid,
    stop: async () => {
      child.kill();
      await once(child, 'exit');
    },
  };
}

function supervisor(box, bridgeOptions, options = {}) {
  const task = fakeTask();
  const returned = supervise({ command: box.bridge(...bridgeOptions), logFile: box.logFile, runningFile: box.runningFile, stopWithPid: task.pid, restartMs: 20, checkMs: 20, ...options });
  return {
    returned,
    stopped: async () => {
      await task.stop();
      await returned;
    },
  };
}

const startedMs = () => Math.round(Date.now() - process.uptime() * 1000);
const createdMs = () => startedMs() - 15;

function fakeProcesses({ created = new Map(), gone = new Map() } = {}) {
  const ended = [];
  return {
    ended,
    exists: (pid) => (gone.has(pid) ? Date.now() < gone.get(pid) : alive(pid)),
    createdMs: (pids) => new Map(pids.filter((pid) => created.has(pid)).map((pid) => [pid, created.get(pid)])),
    endTree: (pid) => {
      ended.push({ pid, at: Date.now() });
      gone.set(pid, 0);
    },
  };
}

function record(box, running) {
  fs.mkdirSync(path.dirname(box.runningFile), { recursive: true });
  fs.writeFileSync(box.runningFile, JSON.stringify(running));
}

test('the task runs its command behind conhost with every part quoted, and a folder called "Tom & Jerry" stays whole', () => {
  const command = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Tom & Jerry\\.local\\share\\orca-wow\\bridge\\bin\\orca-wow.js', 'supervise'];
  const xml = taskXml({ user: 'PC\\Tom & <Jerry>', command });
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;)/, 'every & in the definition is escaped');
  const text = (tag) => new RegExp(`<${tag}>(.*?)</${tag}>`).exec(xml)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.match(text('Command'), /\\conhost\.exe$/);
  assert.equal(text('Arguments'), `--headless "${command[0]}" "${command[1]}" "supervise"`);
  assert.equal(text('UserId'), 'PC\\Tom & <Jerry>');
});

test("an argument a quoted Windows command line can't carry is refused", () => {
  for (const part of ['say "hi"', 'C:\\Games\\']) {
    assert.throws(() => taskXml({ user: 'PC\\me', command: ['node.exe', part] }), /command line/, part);
  }
});

test('the supervisor starts the bridge again after every exit and keeps its output', async () => {
  const box = sandbox();
  const { stopped } = supervisor(box, ['exit=7']);
  await until(() => box.events('stop').length >= 3, 'three bridges have run');
  await stopped();
  const starts = box.events('start');
  assert.ok(starts.every((e) => e.stillRunning.length === 0), 'each bridge started after the one before it was gone');
  const log = fs.readFileSync(box.logFile, 'utf8');
  assert.match(log, new RegExp(`fake bridge ${starts[0].pid} started`));
  assert.match(log, /the bridge stopped \(exit code 7\); starting it again/);
});

test('when its task is gone, the supervisor lets the bridge finish stopping and does not start another', async () => {
  const box = sandbox();
  const { stopped } = supervisor(box, ['slow=300']);
  await until(() => box.events('start').length === 1, 'the bridge is running');
  await stopped();
  assert.deepEqual(box.events('stop').map((e) => e.pid), [box.events('start')[0].pid], 'the bridge stopped by itself before the supervisor returned');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(box.events('start').length, 1);
});

test('a log past 1 MB is set aside when the bridge next starts', async () => {
  const box = sandbox();
  fs.mkdirSync(path.dirname(box.logFile), { recursive: true });
  fs.writeFileSync(box.logFile, 'x'.repeat(1024 * 1024 + 1));
  const { stopped } = supervisor(box, ['exit=0']);
  await until(() => box.events('stop').length >= 1, 'a bridge has run');
  await stopped();
  assert.equal(fs.statSync(`${box.logFile}.1`).size, 1024 * 1024 + 1);
  assert.match(fs.readFileSync(box.logFile, 'utf8'), /^fake bridge \d+ started/);
});

test('a second supervisor does not start while the first is running its bridge', async () => {
  const box = sandbox();
  const first = supervisor(box, []);
  await until(() => box.events('start').length === 1, 'the first bridge is running');
  try {
    const system = fakeProcesses({ created: new Map([[process.pid, createdMs()]]) });
    const second = supervisor(box, [], { graceMs: 300, system });
    await assert.rejects(second.returned, /another supervisor/);
    await second.stopped().catch(() => {});
    assert.equal(box.events('start').length, 1);
    assert.deepEqual(system.ended, []);
  } finally {
    await first.stopped();
  }
});

test("a record that can't be written is in the log, and the bridge runs all the same", async () => {
  const box = sandbox();
  fs.mkdirSync(box.runningFile, { recursive: true });
  const { stopped } = supervisor(box, []);
  await until(() => box.events('start').length === 1, 'the bridge is running');
  await stopped();
  assert.match(fs.readFileSync(box.logFile, 'utf8'), /couldn't record who is running/);
});

test('a record left by a supervisor that is gone does not stop the next one, even when another program has its pid now', async () => {
  const box = sandbox();
  record(box, { supervisor: { pid: process.pid, startMs: startedMs() - 3600000 }, bridge: null });
  const system = fakeProcesses({ created: new Map([[process.pid, createdMs()]]) });
  const { stopped } = supervisor(box, ['exit=0'], { graceMs: 300, system });
  await until(() => box.events('start').length >= 1, 'the bridge started');
  await stopped();
  assert.deepEqual(system.ended, []);
});

test('a bridge that outlived its supervisor: the next supervisor waits for it to stop, and ends it when it does not', async () => {
  const [gone, orphan] = [4000000, 4000001];
  for (const stopsByItself of [true, false]) {
    const box = sandbox();
    const recordedAt = Date.now();
    record(box, { supervisor: { pid: gone, startMs: recordedAt - 5000 }, bridge: { pid: orphan, startMs: recordedAt } });
    const orphanGoneAt = stopsByItself ? recordedAt + 300 : Infinity;
    const system = fakeProcesses({ created: new Map([[orphan, recordedAt - 3]]), gone: new Map([[gone, 0], [orphan, orphanGoneAt]]) });
    const { stopped } = supervisor(box, ['exit=0'], { graceMs: stopsByItself ? 5000 : 300, system });
    await until(() => box.events('start').length >= 1, 'the bridge started');
    await stopped();
    const started = box.events('start')[0].at;
    if (stopsByItself) {
      assert.deepEqual(system.ended, []);
      assert.ok(started >= orphanGoneAt, `the new bridge started ${orphanGoneAt - started} ms before the old one was gone`);
    } else {
      assert.deepEqual(system.ended.map((e) => e.pid), [orphan]);
      assert.ok(started >= system.ended[0].at);
    }
  }
});

const throwaway = () => `orca-wow-test-${process.pid}-${Date.now()}`;

function ask(script, env) {
  return spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } }).stdout.trim();
}

function registered(name) {
  const script = "$t = Get-ScheduledTask -TaskName $env:T3WOW_TASK -ErrorAction SilentlyContinue; if ($t) { @{ limit = $t.Settings.ExecutionTimeLimit; mainsOnly = $t.Settings.DisallowStartIfOnBatteries; stopOnBattery = $t.Settings.StopIfGoingOnBatteries; priority = $t.Settings.Priority; second = \"$($t.Settings.MultipleInstances)\"; logon = \"$($t.Principal.LogonType)\"; level = \"$($t.Principal.RunLevel)\" } | ConvertTo-Json }";
  const found = ask(script, { T3WOW_TASK: name });
  return found ? JSON.parse(found) : null;
}

function processesUnder(dir) {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:T3WOW_DIR) } | ForEach-Object { $_.ProcessId }";
  return ask(script, { T3WOW_DIR: dir }).split(/\r?\n/).filter(Boolean).map(Number);
}

function endProcessesUnder(dir) {
  for (const pid of processesUnder(dir)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

test('Task Scheduler takes the task from a normal user, keeps its settings, and runs it with its arguments whole', windowsOnly, async () => {
  const box = sandbox('t3wow é & task-');
  const marker = path.join(box.dir, 'ran.json');
  const script = path.join(box.dir, 'mark.cjs');
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(2)))");
  const task = logonTask({ name: throwaway(), file: path.join(box.dir, 'task.xml'), command: [process.execPath, script, marker, 'two words'], runningFile: box.runningFile });
  const ran = () => {
    try {
      return JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      return null;
    }
  };
  try {
    assert.equal(task.install(), true);
    assert.deepEqual(registered(task.name), { limit: 'PT0S', mainsOnly: false, stopOnBattery: false, priority: 5, second: 'IgnoreNew', logon: 'Interactive', level: 'Limited' });
    await until(ran, 'the task ran');
    assert.deepEqual(ran(), [marker, 'two words']);
  } finally {
    task.remove();
    endProcessesUnder(box.dir);
  }
  assert.equal(registered(task.name), null);
  assert.equal(fs.existsSync(task.file), false);
});

test('stopping the task ends everything under it, and a restart or an update never has two bridges running', windowsOnly, async (t) => {
  const box = sandbox('t3wow é & tree-');
  const name = throwaway();
  const file = path.join(box.dir, 'task.xml');
  const command = (...bridgeOptions) => [process.execPath, RUN_SUPERVISOR, box.logFile, box.runningFile, '200', ...box.bridge(...bridgeOptions)];
  const polite = logonTask({ name, file, runningFile: box.runningFile, command: command('slow=700') });
  const stuck = logonTask({ name, file, runningFile: box.runningFile, command: command('deaf'), graceMs: 1500 });
  const starts = () => box.events('start');
  try {
    assert.equal(polite.install(), true);
    await until(() => starts().length === 1, 'the first bridge started', 20000);

    let from = Date.now();
    polite.restart();
    assert.equal(box.events('stop').length, 1, 'restart returns once the old bridge has stopped');
    t.diagnostic(`restart returned after ${Date.now() - from} ms; the old bridge had stopped ${box.events('stop')[0].at - from} ms after the task was stopped`);
    await until(() => starts().length === 2, 'the second bridge started', 20000);

    assert.equal(stuck.install(), true);
    assert.equal(box.events('stop').length, 2, 'an update starts the task once the old bridge has stopped');
    await until(() => starts().length === 3, 'the third bridge started', 20000);
    const [first, second, third] = starts();
    const stops = box.events('stop');
    assert.deepEqual([second.stillRunning, third.stillRunning], [[], []], 'no bridge started while an earlier one was running');
    assert.deepEqual(stops.map((e) => e.pid), [first.pid, second.pid], 'the first two stopped by themselves');
    t.diagnostic(`from one bridge stopping to the next starting: ${second.at - stops[0].at} ms, then ${third.at - stops[1].at} ms`);

    from = Date.now();
    stuck.remove();
    t.diagnostic(`remove, with a bridge that would not stop: ${Date.now() - from} ms`);
    assert.equal(alive(third.pid), false);
    assert.deepEqual(processesUnder(box.dir), []);
    assert.equal(registered(name), null);
    assert.equal(fs.existsSync(file), false);
    stuck.remove();
  } finally {
    stuck.remove();
    endProcessesUnder(box.dir);
  }
});
