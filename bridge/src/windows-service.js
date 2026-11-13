// The bridge reads the screen, so it has to run in the player's own desktop session.
// A Windows service can't (services live in session 0, which has no desktop). What
// fits is a Task Scheduler task that starts when this user logs on. A normal user can
// register one for themselves without administrator rights, through the ScheduledTasks
// cmdlets that ship with Windows (measured; `schtasks /Create /SC ONLOGON` is refused).
//
// Task Scheduler does three things worse than systemd and launchd, so `supervise`
// below does them instead:
//  - Restarting. Node is a console program, and the only way found to start it from a
//    task with no window is `conhost.exe --headless`. conhost exits with code 0
//    whatever Node's exit code was (measured), so the task's "restart on failure"
//    never sees a failure. Its shortest restart delay is a minute anyway.
//  - Logs. A task's output goes nowhere.
//  - Stopping. Stopping the task ends conhost about a second later and nothing under
//    it (measured: the Node processes were still running 2 s on).
//
// Nothing here outlives the supervisor. Windows ends a Node program's children along
// with it, because Node starts them in a job that closes when it exits (measured: a
// child was gone the moment its parent exited). That takes the bridge, and with it the
// helper, however the supervisor ends.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { replaceFile, sleepSync } from './slots.js';
import { POWERSHELL, whatPowerShellSaid } from './windows.js';

const TASK = 'orca-wow';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const LOG_ROTATE_BYTES = 1024 * 1024;
const CONHOST_GONE_MS = 1000; // measured: how long after the task is stopped conhost is gone
const GONE_CHECK_MS = 1000;
const BRIDGE_STOP_MS = 3000;
const STOP_MARGIN_MS = 3000;
const STOP_GRACE_MS = CONHOST_GONE_MS + GONE_CHECK_MS + BRIDGE_STOP_MS + STOP_MARGIN_MS;
const POLL_MS = 100;
const RECORD_WITHIN_MS = 1000;

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process is there, and isn't this user's to signal.
    return err.code === 'EPERM';
  }
}

/**
 * @param {string} script
 * @param {Record<string, string>} env
 * @returns {{ ok: boolean, stdout: string }}
 */
function powershell(script, env) {
  const ran = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (ran.status !== 0) process.stderr.write(`${whatPowerShellSaid(ran.stderr || '') || ran.error?.message || 'PowerShell failed'}\n`);
  return { ok: ran.status === 0, stdout: ran.stdout || '' };
}

const xmlText = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The task definition, in Task Scheduler's own XML. A task's defaults are 72 hours,
 * mains power only and below normal priority, which is why the settings name each one.
 *
 * @param {{ user: string, command: string[] }} task  `user` as DOMAIN\name. `command` is the program and its arguments.
 * @returns {string}
 * @throws {Error} when an argument has a double quote or ends in a backslash, which a
 *   quoted Windows command line can't carry.
 */
export function taskXml({ user, command }) {
  const bad = command.find((part) => /"|\\$/.test(part));
  if (bad !== undefined) throw new Error(`can't put ${JSON.stringify(bad)} on a Windows command line: a double quote, or a backslash at the end, would change where the argument stops`);
  const args = ['--headless', ...command.map((part) => `"${part}"`)].join(' ');
  return [
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>T3 Code bridge for World of Warcraft</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlText(user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlText(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlText(path.win32.join(SYSTEM32, 'conhost.exe'))}</Command>`,
    `      <Arguments>${xmlText(args)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

const REGISTER = "$ErrorActionPreference = 'Stop'; Register-ScheduledTask -TaskName $env:T3WOW_TASK -Xml (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:T3WOW_TASK_XML) -Force | Out-Null";
const START = "$ErrorActionPreference = 'Stop'; Start-ScheduledTask -TaskName $env:T3WOW_TASK";
const STOP = 'Stop-ScheduledTask -TaskName $env:T3WOW_TASK -ErrorAction SilentlyContinue; exit 0';
const UNREGISTER = 'Stop-ScheduledTask -TaskName $env:T3WOW_TASK -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $env:T3WOW_TASK -Confirm:$false -ErrorAction SilentlyContinue; exit 0';

/**
 * The bridge's logon task, in the shape the CLI already uses for the systemd unit and
 * the launchd agent: a definition file whose existence means "installed", and three
 * verbs. Every verb can be run again after a failure or a crash and ends in the same
 * place, and none of them starts a bridge while an earlier one is still running.
 *
 * @param {object} options
 * @param {string} options.file  Where the definition is kept (CONFIG_DIR/orca-wow.task.xml).
 *   The folder Task Scheduler keeps its own copy in can't be listed without
 *   administrator rights (measured), so it can't serve as the "installed" marker.
 * @param {string[]} options.command  What the task runs: [node, orca-wow.js, 'supervise'].
 * @param {string} options.runningFile  The supervisor's record of who is running (see below).
 * @param {string} [options.name]  The task's name. Tests register theirs under another one.
 * @param {string} [options.user]
 * @param {number} [options.graceMs]  How long a stopped supervisor and bridge get to leave before they're ended.
 * @returns {{ name: string, file: string, kind: string, install(): boolean, restart(): void, remove(): void }}
 */
export function logonTask({ file, command, runningFile, name = TASK, user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`, graceMs = STOP_GRACE_MS }) {
  const env = { T3WOW_TASK: name, T3WOW_TASK_XML: file };
  const makeSureStopped = () => {
    const { supervisor, bridge } = waitForStop(runningFile, graceMs);
    for (const run of [supervisor, bridge]) if (run) windows.endTree(run.pid);
  };
  return {
    name,
    file,
    kind: 'logon task',
    install() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, taskXml({ user, command }));
      if (!powershell(REGISTER, env).ok) return false;
      powershell(STOP, env);
      makeSureStopped();
      return powershell(START, env).ok;
    },
    restart() {
      powershell(STOP, env);
      makeSureStopped();
      powershell(START, env);
    },
    remove() {
      powershell(UNREGISTER, env);
      makeSureStopped();
      fs.rmSync(file, { force: true });
    },
  };
}

/**
 * One run of a program. Windows hands a pid to another program once its process is
 * gone, so the pid alone could name a stranger. With the start time it can't.
 * @typedef {object} Run
 * @property {number} pid
 * @property {number} startMs  A moment just after the process was created, in ms since
 *   1970 UTC: what Node can tell without asking Windows.
 */

/** @typedef {{ supervisor: Run|null, bridge: Run|null }} Running  What running.json holds. */

/**
 * What the rules below ask and do about other processes. Tests pass their own, so the
 * rules run under `node --test` on any system.
 * @typedef {object} Processes
 * @property {(pid: number) => boolean} exists
 * @property {(pids: number[]) => Map<number, number>} createdMs  When Windows created each
 *   pid's process, in ms since 1970 UTC. A pid it won't tell this user about is left out.
 * @property {(pid: number) => void} endTree  End the process and everything it started.
 */

const CREATED = "foreach ($id in $env:T3WOW_PIDS -split ',') { try { $p = Get-Process -Id $id -ErrorAction Stop; \"$id $(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds())\" } catch {} }; exit 0";

/** @type {Processes} */
const windows = {
  exists,
  createdMs(pids) {
    const lines = powershell(CREATED, { T3WOW_PIDS: pids.join(',') }).stdout.split(/\r?\n/).filter(Boolean);
    return new Map(lines.map((line) => line.split(' ').map(Number)));
  },
  endTree(pid) {
    spawnSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  },
};

// Measured: Node counts its own start 14 to 17 ms after Windows creates the process,
// and a child is created 3 ms before spawn() returns. The minute allows for a computer
// busy logging on, and the slack for a clock set back meanwhile.
const STARTUP_MS = 60000;
const CLOCK_SLACK_MS = 2000;

/** Whether the process Windows created at `createdMs` is the recorded run, and not a later program that got its pid. */
const isSameRun = (run, createdMs) => createdMs >= run.startMs - STARTUP_MS && createdMs <= run.startMs + CLOCK_SLACK_MS;

const asRun = (value) => (Number.isInteger(value?.pid) && Number.isFinite(value?.startMs) ? { pid: value.pid, startMs: value.startMs } : null);

/**
 * @param {string} file
 * @param {Processes} system
 * @returns {Running}
 */
function stillRunning(file, system) {
  let recorded = {};
  try {
    recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const runs = [asRun(recorded.supervisor), asRun(recorded.bridge)];
  const there = runs.filter((run) => run && system.exists(run.pid));
  const created = there.length ? system.createdMs(there.map((run) => run.pid)) : new Map();
  const [supervisor, bridge] = runs.map((run) => {
    const at = run ? created.get(run.pid) : undefined;
    return at !== undefined && isSameRun(run, at) ? run : null;
  });
  return { supervisor, bridge };
}

/**
 * @param {string} file
 * @param {number} graceMs
 * @param {Processes} [system]
 * @returns {Running}
 */
function waitForStop(file, graceMs, system = windows) {
  const end = Date.now() + graceMs;
  for (;;) {
    const left = stillRunning(file, system);
    const pids = Object.values(left).filter(Boolean).map((run) => run.pid);
    if (!pids.length || Date.now() >= end) return left;
    while (pids.some((pid) => system.exists(pid)) && Date.now() < end) sleepSync(POLL_MS);
  }
}

/**
 * Call `onGone` once the process `pid` no longer exists. The timer doesn't keep the
 * caller alive.
 * @param {number} pid
 * @param {() => void} onGone
 * @param {number} [everyMs]
 */
export function stopWhenGone(pid, onGone, everyMs = GONE_CHECK_MS) {
  const timer = setInterval(() => {
    if (exists(pid)) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref();
}

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/**
 * Keep the bridge running: start `command`, send what it prints to `logFile`, and
 * start it again `restartMs` after it exits, for any reason and with any exit code.
 * That is systemd's Restart=always with RestartSec=3 and launchd's KeepAlive, which
 * Windows doesn't offer here.
 *
 * Before the first bridge starts, whatever is on record gets `graceMs` to stop. A
 * supervisor still running then keeps the job, and this one doesn't start. A bridge
 * still running then has outlived its supervisor, which Windows should not have
 * allowed, and is ended.
 *
 * It runs until the process `stopWithPid` is gone. The bridge is told to watch the same
 * process, so it is stopping too, and gets a moment to finish. Whoever called this then
 * exits, which ends anything the bridge left running.
 *
 * The log is opened for appending each time the bridge starts. If it has grown past
 * 1 MB by then, it's first renamed to `<logFile>.1`, replacing the previous one. The
 * bridge writes to the file itself (it inherits the handle), so a crash's stack trace
 * lands there too. The supervisor's own lines carry the date, which the bridge's don't.
 *
 * @param {object} options
 * @param {string[]} options.command  [node, orca-wow.js, 'run']. The child also gets
 *   `--stop-with <stopWithPid>`.
 * @param {string} options.logFile
 * @param {string} options.runningFile  Where this supervisor records who is running.
 * @param {number} options.stopWithPid  The pid whose end means "stop": the logon task's conhost.
 * @param {number} [options.restartMs]
 * @param {number} [options.graceMs]
 * @param {number} [options.checkMs]  How often to look whether that process is still there.
 * @param {Processes} [options.system]
 * @returns {Promise<void>}
 * @throws {Error} when another supervisor is running.
 */
export async function supervise({ command, logFile, runningFile, stopWithPid, restartMs = 3000, graceMs = STOP_GRACE_MS, checkMs = GONE_CHECK_MS, system = windows }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(runningFile), { recursive: true });
  const note = (text) => {
    try {
      fs.appendFileSync(logFile, `[${stamp()}] ${text}\n`);
    } catch {}
  };

  const before = waitForStop(runningFile, graceMs, system);
  if (before.supervisor) {
    note(`not starting: another supervisor (pid ${before.supervisor.pid}) is already running the bridge`);
    throw new Error(`the bridge is already running under another supervisor (pid ${before.supervisor.pid})`);
  }
  if (before.bridge) {
    note(`ending a bridge that outlived its supervisor (pid ${before.bridge.pid})`);
    system.endTree(before.bridge.pid);
  }

  const me = { pid: process.pid, startMs: Math.round(Date.now() - process.uptime() * 1000) };
  const record = (bridge) => {
    let why = 'another program has it open';
    try {
      if (replaceWithin(RECORD_WITHIN_MS, runningFile, JSON.stringify({ supervisor: me, bridge }))) return;
    } catch (err) {
      why = err.message;
    }
    note(`couldn't record who is running in ${path.basename(runningFile)}: ${why}. A restart or an update reads that file, and may not wait for this bridge to stop.`);
  };
  const stop = new AbortController();
  const stopping = new Promise((resolve) => stop.signal.addEventListener('abort', resolve, { once: true }));
  stopWhenGone(stopWithPid, () => stop.abort(), checkMs);

  record(null);
  while (!stop.signal.aborted) {
    const bridge = startBridge([...command, '--stop-with', String(stopWithPid)], logFile);
    record(bridge.pid ? { pid: bridge.pid, startMs: Date.now() } : null);
    const how = await Promise.race([bridge.ended, stopping]);
    if (stop.signal.aborted) {
      await Promise.race([bridge.ended, delay(BRIDGE_STOP_MS, undefined, { ref: false })]);
      return;
    }
    record(null);
    note(`the bridge ${how}; starting it again in ${restartMs / 1000} s`);
    await delay(restartMs, undefined, { signal: stop.signal }).catch(() => {});
  }
}

/**
 * replaceFile() gives up on a file in use after about 30 ms, which a virus scanner
 * reading the file can outlast. This asks again until `ms` have passed.
 * @param {number} ms
 * @param {string} file
 * @param {string} content
 * @returns {boolean} False when the file was in use to the end.
 */
function replaceWithin(ms, file, content) {
  const end = Date.now() + ms;
  while (!replaceFile(file, content)) {
    if (Date.now() >= end) return false;
  }
  return true;
}

/**
 * @param {string[]} command
 * @param {string} logFile
 * @returns {{ pid: number|undefined, ended: Promise<string> }}
 */
function startBridge(command, logFile) {
  const out = openLog(logFile);
  try {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', out, out], windowsHide: true });
    const ended = new Promise((resolve) => {
      child.once('error', (err) => resolve(`couldn't start: ${err.message}`));
      child.once('exit', (code, signal) => resolve(`stopped (exit code ${code ?? signal})`));
    });
    return { pid: child.pid, ended };
  } catch (err) {
    return { pid: undefined, ended: Promise.resolve(`couldn't start: ${err.message}`) };
  } finally {
    if (out !== 'ignore') fs.closeSync(out);
  }
}

function openLog(logFile) {
  try {
    if (fs.statSync(logFile).size > LOG_ROTATE_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {}
  try {
    return fs.openSync(logFile, 'a');
  } catch {
    return 'ignore';
  }
}
