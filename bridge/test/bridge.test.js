import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bridge, friendlyError, parseFrame, activityLabel, pendingRequest, runSummary, proposedPlan, commandList } from '../src/bridge.js';
import { holdOpen } from './hold-open.mjs';
import { SlotBank, FileInUse, LONG_SILENT_WAV } from '../src/slots.js';
import { luaValue } from '../src/luaser.js';
import { markdownToWow, markdownToSpeech } from '../src/format.js';
import { RS, US } from '../src/codec.js';
import { seal } from '../src/strip-crypto.js';
import crypto from 'node:crypto';

let currentKeys = null; // the latest fakeBridge's strip keys: frame() seals with them

function hasLua() {
  try {
    execFileSync('lua5.1', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const needsLua = { skip: process.platform === 'win32' && !hasLua() && 'lua5.1 is not installed' };

function tempAddons(slots = 8) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-addons-'));
  fs.mkdirSync(path.join(dir, 'T3Code'));
  new SlotBank(dir, { slots }).install();
  return dir;
}

function fakeBridge(slots = 8, config = {}) {
  const dir = tempAddons(slots);
  const b = new Bridge({ addonsDir: dir, config: { slots, backend: 't3', ...config }, log: () => {}, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-state-')) });
  b.proc = { pid: 1, startTicks: 1 };
  currentKeys = b.stripKeys;
  b.persist = { processKey: '1:1', sigCounter: 1, raised: [], handled: {}, slotGuess: 1, gen: 0 };
  const calls = [];
  b.t3.sendMessage = async (...a) => calls.push(['send', ...a]);
  b.t3.launchThread = async (...a) => (calls.push(['new', ...a]), { threadId: 'new-thread' });
  b.t3.settle = async (...a) => calls.push(['settle', ...a]);
  b.t3.respondAnswers = async (...a) => calls.push(['answer', ...a]);
  b.t3.threadProjection = async () => ({ messages: [], turnItems: [], runtimeRequests: [], runs: [] });
  b.t3.threads.set('t1', { id: 't1', title: 'Fix | the build', projectId: 'p1', status: 'running', activityRunStatus: 'running', updatedAt: new Date().toISOString() });
  b.t3.projects.set('p1', { id: 'p1', title: 'demo' });
  b.voice.speak = () => true;
  return { b, dir, calls };
}

function loadSlot(dir, i) {
  const file = path.join(dir, `T3Code_S${String(i).padStart(3, '0')}`, 'Inbox.lua');
  const out = execFileSync('lua5.1', ['-e', `dofile(${JSON.stringify(file)}) print(T3Code_Inbox and T3Code_Inbox.gen or "nil", T3Code_Inbox and T3Code_Inbox.nextSig or "nil", T3Code_Inbox and T3Code_Inbox.threads and T3Code_Inbox.threads[1] and T3Code_Inbox.threads[1].title or "")`]);
  const [gen, nextSig, title] = out.toString().trim().split('\t');
  return { gen: Number(gen), nextSig: Number(nextSig), title };
}

// One value out of a slot's snapshot, read by the same Lua the game runs.
function slotValue(dir, i, expr) {
  const file = path.join(dir, `T3Code_S${String(i).padStart(3, '0')}`, 'Inbox.lua');
  const out = execFileSync('lua5.1', ['-e', `dofile(${JSON.stringify(file)}) local t = T3Code_Inbox io.write(tostring(${expr}))`]);
  return out.toString();
}

// Size of the bell file that signal k rings (0 if empty or not created yet).
function rung(dir, k) {
  const file = path.join(dir, 'T3Code', 'Signals', String(3991 + ((k - 1) % 8)).padStart(5, '0') + '.wav');
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function plainFrame(seq, records) {
  return { version: 1, seq, payload: Buffer.from(records.map((r) => r.join(US)).join(RS)) };
}

// What the addon draws once it has the keys.
function frame(seq, records) {
  const plain = plainFrame(seq, records).payload;
  return { version: 2, seq, payload: seal(currentKeys, seq, crypto.randomBytes(12), plain) };
}

test('unencrypted frames: the hello is answered, commands are never run', async () => {
  const { b, dir, calls } = fakeBridge();
  b.onFrame(plainFrame(1, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0'], ['C', 1, 'send', 't1', 'forged']]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  assert.ok(b.client && !b.client.encrypted, 'hello accepted');
  b.publishNow('test');
  const lua = fs.readFileSync(path.join(dir, 'T3Code_S001', 'Inbox.lua'), 'latin1');
  assert.match(lua, new RegExp(`key="${b.stripKeys.hex}"`), 'snapshot carries the keys');
  // A forged "encrypted" frame (wrong keys) is dropped entirely.
  const other = { ...frame(2, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0'], ['C', 2, 'send', 't1', 'forged']]) };
  other.payload = Buffer.from(other.payload);
  other.payload[20] ^= 0xff;
  b.onFrame(other);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  assert.equal(b.rejected.forged, 1);
  // The real thing runs.
  b.onFrame(frame(3, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0'], ['C', 3, 'send', 't1', 'real']]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls[0][2], 'real');
  assert.ok(b.client.encrypted);
});

test('parseFrame reads hello and commands', () => {
  const f = parseFrame(Buffer.from(['H', 1, 'sess', 'ui1', 5, 9, 123, 'o', 'tid', '0.1.0'].join(US) + RS + ['C', 3, 'send', 'tid', 'hi there'].join(US)));
  assert.equal(f.hello.slot, 5);
  assert.equal(f.hello.sig, 9);
  assert.equal(f.hello.view, 'tid');
  assert.deepEqual(f.commands[0], { id: 3, verb: 'send', args: ['tid', 'hi there'] });
});

test('parseFrame reads the hashes of the parts the addon holds: projects, transcript, then family', () => {
  const f = parseFrame(Buffer.from(['H', 1, 'sess', 'ui1', 5, 9, 123, 'o', 'tid', '0.1.0', '8', 'mh', 'lh', 'ph', 'vh', 'fh'].join(US)));
  assert.equal(f.hello.models, 'mh');
  assert.equal(f.hello.list, 'lh');
  assert.deepEqual(f.hello.hashes, { projects: 'ph', view: 'vh', fam: 'fh' });
  const older = parseFrame(Buffer.from(['H', 1, 'sess', 'ui1', 5, 9, 123, 'o', 'tid', '0.1.0', '8', 'mh', 'lh', 'ph', 'vh'].join(US)));
  assert.equal(older.hello.hashes.fam, '', 'an addon without the family reports none');
});

test('a publish leaves out what the addon already holds, but slots 1-3 stay complete', needsLua, () => {
  const { b, dir } = fakeBridge();
  b.client = { session: 'sess', ui: 'ui1', ackedSeq: -1, flags: 'o', view: 't1', hashes: {} };
  b.views.set('t1', {
    projection: { messages: [{ role: 'assistant', text: 'a long reply', createdAt: '2026-11-01T00:00:00Z' }], turnItems: [], runtimeRequests: [], runs: [] },
    fetchedAt: Date.now(),
  });
  const first = b.buildSnapshot();
  assert.ok(first.view && first.view.msgs.length === 1, 'the transcript is in the snapshot');
  // Its next hello says it applied exactly this transcript and project list.
  b.client.hashes = { list: first.x.l, projects: first.x.p, view: first.x.v };
  assert.ok(b.publishNow('test'));
  // Slots 1-3 are what a /reload boots from, so they always carry everything.
  for (const i of [1, 2, 3]) {
    assert.equal(slotValue(dir, i, 't.view and t.view.id or "none"'), 't1', `slot ${i} is complete`);
  }
  // The rotating slots leave out what the addon has, and say which parts those are.
  assert.equal(slotValue(dir, 4, 't.view and t.view.id or "none"'), 'none', 'no second copy of the transcript');
  assert.equal(slotValue(dir, 4, 't.projects and #t.projects or "none"'), 'none', 'no second copy of the projects');
  assert.equal(slotValue(dir, 4, 't.same or ""'), 'pv');
  assert.match(slotValue(dir, 4, '#t.threads'), /^\d+$/, 'the thread list always goes');
  // A publish that starts again with an addon that holds nothing sends everything.
  b.client.hashes = {};
  b.publishNow('test');
  assert.equal(slotValue(dir, 4, 't.view and t.view.id or "none"'), 't1', 'an addon that has it not is sent it');
  assert.equal(slotValue(dir, 4, 't.same or ""'), '');
  b.stop();
});

test('a part that changes and changes back is sent again, not assumed', needsLua, () => {
  const { b, dir } = fakeBridge();
  b.client = { session: 'sess', ui: 'ui1', ackedSeq: -1, flags: 'o', view: 't1', hashes: {} };
  const projection = { messages: [{ role: 'assistant', text: 'one', createdAt: '2026-11-01T00:00:00Z' }], turnItems: [], runtimeRequests: [], runs: [] };
  b.views.set('t1', { projection, fetchedAt: Date.now() });
  const first = b.buildSnapshot();
  b.client.hashes = { list: first.x.l, projects: first.x.p, view: first.x.v };
  assert.ok(b.publishNow('test'));
  assert.equal(slotValue(dir, 4, 't.view and #t.view.msgs or "none"'), 'none', 'unchanged: left out');
  // A reply arrives: the transcript the addon holds is now this one.
  projection.messages.push({ role: 'assistant', text: 'two', createdAt: '2026-11-01T00:00:01Z' });
  assert.ok(b.publishNow('test'));
  assert.equal(slotValue(dir, 4, 't.view and #t.view.msgs or "none"'), '2', 'changed: sent');
  // The strip stays on screen and the capture loop decodes it again; that hello was
  // drawn before this publish, so it must not re-arm the hash the publish cleared.
  const hello = (seq, gen) => b.onFrame(frame(seq, [['H', 1, 'sess', 'ui1', 4, 1, gen, 'o', 't1', '0.1.0', '8', '', first.x.l, first.x.p, first.x.v]]));
  hello(50, 0);
  assert.equal(b.client.hashes.view, null, 'an old hello does not re-arm a cleared hash');
  // It goes back to exactly what the addon last reported. The addon holds the
  // two-message one, so this must be sent rather than assumed.
  projection.messages.pop();
  assert.ok(b.publishNow('test'));
  assert.equal(slotValue(dir, 4, 't.view and #t.view.msgs or "none"'), '1', 'back to an older hash: still sent');
  // A hello that has applied our latest publish is trusted again.
  hello(51, b.lastGen);
  assert.equal(b.client.hashes.view, first.x.v, 'a confirming hello is trusted');
  // Hashes in an unencrypted hello aren't trusted: it's only ever a bare hello.
  b.onFrame(plainFrame(52, [['H', 1, 'sess', 'ui1', 4, 1, b.lastGen, 'o', '', '0.1.0', '8', '', first.x.l, first.x.p, first.x.v]]));
  assert.equal(b.client.hashes.view, undefined, 'an unencrypted hello is not trusted');
  b.stop();
});

test('publish writes the next slots and bootstrap slots, then raises one signal', needsLua, () => {
  const { b, dir } = fakeBridge();
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0']]));
  assert.ok(b.publishNow());
  const s2 = loadSlot(dir, 2);
  const s1 = loadSlot(dir, 1);
  assert.equal(s2.nextSig, 2);
  assert.equal(s1.gen, s2.gen);
  assert.equal(s2.title, 'Fix || the build', 'pipes are escaped for WoW');
  assert.ok(rung(dir, 1) > 174762, 'bell 1 rung with a sound too big for the client to cache');
  assert.equal(rung(dir, 2), 0);
  assert.equal(b.client.slotNext, 3, 'predicts the addon loads one slot');
  // Nothing changed: no publish.
  assert.equal(b.publishNow(), false);
  b.stop();
});

test('commands run once, in order, and results are published', async () => {
  const { b, dir, calls } = fakeBridge();
  const f = frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 1, 'send', 't1', 'hello'], ['C', 2, 'new', 'p1', 'start it']]);
  b.onFrame(f);
  b.onFrame(f); // seen again: not re-run
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c[0]), ['send', 'new']);
  assert.equal(calls[0][2], 'hello');
  b.publishNow();
  const lua = fs.readFileSync(path.join(dir, 'T3Code_S001', 'Inbox.lua'), 'latin1');
  assert.match(lua, /results=\{\{id=1,ok=true,msg="Sent"\},\{id=2,ok=true,open="new-thread"\}/);
  assert.match(lua, /ack=\{ui="ui1",seq=2\}/);
  b.stop();
});

test('a picked model rides along with new, and model switches a thread', async () => {
  const { b, calls } = fakeBridge();
  b.t3.setModel = async (...a) => calls.push(['model', ...a]);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 1, 'new', 'p1', 'go', 'codex', 'gpt-x'], ['C', 2, 'new', 'p1', 'auto'], ['C', 3, 'model', 't1', 'codex', 'gpt-y'], ['C', 4, 'new', 'p1', 'hard', '', '', 'high'], ['C', 5, 'model', 't1', 'codex', 'gpt-y', 'low'], ['C', 6, 'new', 'p1', 'branch it', 'codex', 'gpt-x', 'high', '1'], ['C', 7, 'new', 'p1', 'plain']]));
  await new Promise((r) => setTimeout(r, 20));
  const news = calls.filter((c) => c[0] === 'new');
  assert.deepEqual(news.find((c) => c[2] === 'go')[4], { model: { instanceId: 'codex', model: 'gpt-x' } });
  assert.deepEqual(news.find((c) => c[2] === 'auto')[4], {}, 'no pick: T3 picks as before');
  assert.deepEqual(news.find((c) => c[2] === 'hard')[4], { effort: 'high' }, 'only a level picked: on the default model');
  assert.deepEqual(news.find((c) => c[2] === 'branch it')[4], { model: { instanceId: 'codex', model: 'gpt-x' }, effort: 'high', worktree: true }, 'the worktree flag rides along');
  assert.deepEqual(news.find((c) => c[2] === 'plain')[4], {}, 'without the flag, no worktree');
  const models = calls.filter((c) => c[0] === 'model');
  assert.deepEqual(models[0], ['model', 't1', 'codex', 'gpt-y', undefined]);
  assert.deepEqual(models[1], ['model', 't1', 'codex', 'gpt-y', 'low']);
  b.stop();
});

test('the model list is only sent while the addon reports a different one', () => {
  const { b } = fakeBridge();
  const levels = (...ids) => ({ capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: ids.map((id, n) => ({ id, label: id.toUpperCase(), isDefault: n === 1 })) }] } });
  b.t3.local.client.config = {
    providers: [
      { instanceId: 'codex', displayName: 'Codex', enabled: true, models: [{ slug: 'a', name: 'A | B', ...levels('low', 'high') }, { slug: 'b', name: 'B', ...levels('low', 'high') }, { slug: 'n', name: 'N' }] },
      { instanceId: 'claude', displayName: 'Claude  Harness', enabled: true, models: [{ slug: 'o', name: 'O', ...levels('low', 'max') }] },
    ],
  };
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0', '8']]));
  const first = b.buildSnapshot().models;
  assert.equal(first.g[0].e, '');
  assert.deepEqual(first.g[0].p, [
    { i: 'codex', n: 'Codex', m: [{ s: 'a', l: 'A || B', r: 1 }, { s: 'b', l: 'B', r: 1 }, { s: 'n', l: 'N', r: undefined }] },
    { i: 'claude', n: 'Claude Harness', m: [{ s: 'o', l: 'O', r: 2 }] },
  ], 'grouped by provider; models with the same levels share a set');
  assert.deepEqual(first.g[0].x, [
    { k: 'effort', d: 'high', o: [{ i: 'low', l: 'LOW' }, { i: 'high', l: 'HIGH' }] },
    { k: 'effort', d: 'max', o: [{ i: 'low', l: 'LOW' }, { i: 'max', l: 'MAX' }] },
  ]);
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0', '8', first.h]]));
  assert.equal(b.buildSnapshot().models, undefined, 'the addon has this list');
  b.t3.local.client.config.providers[0].models.push({ slug: 'c', name: 'C' });
  assert.ok(b.buildSnapshot().models, 'a changed list goes out again');
  for (const p of b.t3.local.client.config.providers) p.enabled = false;
  assert.deepEqual(b.buildSnapshot().models.g, [], 'switching off the last provider clears the list');
  b.stop();
});

test('the message box suggests the slash commands, then the skills the player can run, each once', () => {
  const list = commandList({
    slashCommands: [
      { name: 'compact', description: 'Summarize the conversation' },
      { name: 'review', description: 'Review | the diff' },
      { name: 'not a name', description: 'spaces' },
      { name: 'usage-limits', description: 'Opens a panel in T3 Code' },
    ],
    skills: [
      { name: 'review', description: 'Also a slash command' },
      { name: 'deploy', shortDescription: 'Ship it', description: 'A much longer description of shipping it' },
      { name: 'off', description: 'Switched off', enabled: false },
      { name: 'auto', description: 'Only the agent runs it', userInvocable: false },
      { name: 'wordy', description: `First line\n\n  second   line ${'x'.repeat(100)}` },
      { name: 'quiet' },
    ],
  });
  // A skill that is also a slash command is offered as both: only `$review` runs it mid-message.
  assert.deepEqual(list.map((c) => c.t), ['/compact', '/review', '$review', '$deploy', '$wordy', '$quiet']);
  assert.equal(list[1].d, 'Review || the diff', 'escaped for the game');
  assert.equal(list[3].d, 'Ship it', 'the short description when there is one');
  assert.equal(list[4].d.includes('\n'), false);
  assert.ok(list[4].d.startsWith('First line second line x'));
  assert.equal(Array.from(list[4].d).length, 60, 'descriptions are kept short');
  assert.ok(list[4].d.endsWith('…'));
  const many = commandList({ slashCommands: Array.from({ length: 500 }, (_, i) => ({ name: `c${i}` })) });
  assert.equal(many.length, 200, 'the list is capped');
  assert.equal(list[5].d, undefined, 'no description, no field');
  assert.deepEqual(commandList(undefined), []);
});

test('each provider in the model list carries its own commands and skills', () => {
  const { b } = fakeBridge();
  b.t3.local.client.config = {
    providers: [
      { instanceId: 'codex', displayName: 'Codex', enabled: true, models: [{ slug: 'a', name: 'A' }], slashCommands: [{ name: 'status', description: 'Show status' }], skills: [{ name: 'lint', description: 'Lint' }] },
      { instanceId: 'claude', displayName: 'Claude', enabled: true, models: [{ slug: 'o', name: 'O' }] },
    ],
  };
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0', '8']]));
  const first = b.buildSnapshot().models;
  const [codex, claude] = first.g[0].p;
  assert.deepEqual(codex.c, [{ t: '/status', d: 'Show status' }, { t: '$lint', d: 'Lint' }]);
  assert.equal('c' in claude, false, 'a provider with none sends none');
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0', '8', first.h]]));
  b.t3.local.client.config.providers[0].skills.push({ name: 'fmt' });
  assert.ok(b.buildSnapshot().models, 'a new skill sends the list again');
  b.stop();
});

test('a reload (new ui token) resets the slot pointer; stale beacons do not', () => {
  const { b } = fakeBridge();
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 6, 4, 0, 'o', '', '0.1.0']]));
  assert.equal(b.client.slotNext, 6);
  assert.equal(b.persist.sigCounter, 4);
  b.publishNow('test');
  assert.equal(b.client.slotNext, 7);
  // An old frame still on screen (gen older than our publish) must not rewind us.
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 6, 4, 0, 'o', '', '0.1.0']]));
  assert.equal(b.client.slotNext, 7);
  // /reload: new ui, addon bootstrapped slot 1, now at 2.
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui2', 2, 5, b.lastGen, 'o', '', '0.1.0']]));
  assert.equal(b.client.slotNext, 2);
  b.stop();
});

test('an addon waiting on a stale signal gets that signal raised too', needsLua, () => {
  const { b, dir } = fakeBridge();
  b.persist.sigCounter = 9;
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 4, 0, 'o', '', '0.1.0']]));
  b.persist.sigCounter = 9; // e.g. restored from a restarted bridge
  b.client.slotNext = 2;
  b.publishNow('test');
  assert.ok(rung(dir, 4) > 0, 'bell the addon listens for is rung');
  assert.ok(rung(dir, 9) > 0);
  assert.equal(loadSlot(dir, 2).nextSig, 10);
  b.stop();
});

test('signals are never skipped, and never rung ahead of our counter', () => {
  const { b, dir } = fakeBridge();
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 5, 0, 'o', '', '0.1.0']]));
  b.persist.sigCounter = 5;
  b.client.pollSig = 8; // an addon that ran ahead (bells it listens to would alias rung ones)
  b.publishNow('test');
  assert.ok(rung(dir, 5) > 0, 'our next bell rung');
  for (const k of [6, 7, 8]) assert.equal(rung(dir, k), 0, `bell ${k} not rung ahead`);
  assert.equal(b.persist.sigCounter, 6);
  b.stop();
});

test('a drifted slot prediction still covers the slot the addon will load', needsLua, () => {
  const { b, dir } = fakeBridge(120);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 40, 5, 0, 'o', '', '0.1.0']]));
  b.client.slotNext = 101; // we kept predicting while the game didn't load anything
  b.publishNow('test');
  const gen = loadSlot(dir, 40).gen;
  assert.ok(gen > 0, 'confirmed slot written');
  assert.equal(loadSlot(dir, 70).gen, gen);
  assert.equal(loadSlot(dir, 105).gen, gen);
  b.stop();
});

test('bells rotate: ringing k empties the bell four behind it', () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  for (let k = 1; k <= 12; k++) bank.raise(k);
  // 9..12 rung (the addon's look-ahead window), 5..8 emptied again.
  for (const k of [9, 10, 11, 12]) assert.ok(rung(dir, k) > 0, `bell ${k}`);
  for (const k of [13, 14, 15, 16]) assert.equal(rung(dir, k), 0, `bell ${k} (same files as 5..8)`);
  bank.prepareBells();
  assert.ok(fs.statSync(path.join(dir, 'T3Code', 'Signals', '03999.wav')).size > 174762, 'self-test control is long');
  assert.equal(fs.statSync(path.join(dir, 'T3Code', 'Signals', '04000.wav')).size, 0);
  bank.resetSignals();
  for (let k = 1; k <= 8; k++) assert.equal(rung(dir, k), 0);
});

function slotInUseOnce(b) {
  const held = {};
  b.bank.write = () => {
    delete b.bank.write;
    held.refusedAt = Date.now();
    throw new FileInUse(b.bank.slotFile(1));
  };
  return held;
}

async function until(done, what) {
  const end = Date.now() + 3000;
  while (!done()) {
    assert.ok(Date.now() < end, `${what} within 3 s`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const windowsOnly = { skip: process.platform !== 'win32' && 'only Windows refuses to replace a file another program has open' };

test('a ring that stops halfway leaves no stale bell rung, and ringing again finishes it', () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  for (let k = 1; k <= 4; k++) bank.raise(k);
  fs.rmSync(bank.bellFile(5));
  fs.mkdirSync(bank.bellFile(5));
  assert.throws(() => bank.raise(5));
  assert.equal(rung(dir, 1), 0, 'bell 1 (the same file as bell 9) was emptied before bell 5 was tried');
  fs.rmdirSync(bank.bellFile(5));
  bank.raise(5);
  for (const k of [2, 3, 4, 5]) assert.ok(rung(dir, k) > 0, `bell ${k}`);
});

test('bells and controls already in the right state are not written again', () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  bank.raise(3);
  const files = [bank.bellFile(3), bank.bellFile(7), bank.sigFile(3999), bank.sigFile(4000)];
  const longAgo = new Date('2001-01-01T00:00:00Z');
  for (const f of files) fs.utimesSync(f, longAgo, longAgo);
  bank.raise(3);
  bank.prepareBells();
  for (const f of files) assert.equal(fs.statSync(f).mtimeMs, longAgo.getTime(), `${path.basename(f)} was left alone`);
});

test('emptying the bells for a new client reports that all are empty, also when there is nothing to empty', () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  bank.raise(1);
  assert.equal(bank.resetSignals(), true);
  assert.equal(rung(dir, 1), 0);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-addons-'));
  assert.equal(new SlotBank(bare).resetSignals(), true, 'a broken install does not keep a new client waiting');
});

test('a new game client is recorded only once the bells of the last one are empty', () => {
  const { b, dir } = fakeBridge();
  b.persist.sigCounter = 3;
  b.bank.raise(2);
  b.bank.resetSignals = () => {
    delete b.bank.resetSignals;
    return false;
  };
  const client = { pid: 2, startTicks: 2 };
  b.onProcess(client);
  assert.deepEqual([b.persist.processKey, b.persist.sigCounter], ['1:1', 3], 'the last client is still the one on record');
  assert.equal(rung(dir, 1), 0, 'nothing is rung for the new one');
  b.onProcess(client);
  assert.deepEqual([b.persist.processKey, b.persist.sigCounter], ['2:2', 2]);
  assert.equal(rung(dir, 2), 0, 'the old bell is empty');
  assert.ok(rung(dir, 1) > 0, 'the new client gets its first update on bell 1');
  b.stop();
});

test('an ack that meets a file in use goes out again by itself, not at once, and rings one bell', async () => {
  const { b, dir } = fakeBridge();
  const held = slotInUseOnce(b);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0']]));
  const slot = () => fs.readFileSync(b.bank.slotFile(1), 'latin1');
  await until(() => /ack=\{ui="ui1",seq=1\}/.test(slot()), 'the ack goes out again');
  assert.ok(Date.now() - held.refusedAt >= 350, 'at the pace of an ack, not back to back');
  assert.match(slot(), /nextSig=2,/, 'the refused try moved no counter');
  assert.ok(rung(dir, 1) > 0);
  for (let k = 2; k <= 8; k++) assert.equal(rung(dir, k), 0, `bell ${k} not rung`);
  b.stop();
});

test('an update that was refused is still owed when nothing else has changed', () => {
  const { b, dir } = fakeBridge();
  assert.ok(b.publishNow('test'));
  slotInUseOnce(b);
  assert.equal(b.publishNow('test'), false);
  assert.equal(rung(dir, 2), 0, 'the refused try rings nothing');
  assert.notEqual(b.nextPublishDelay(), null, 'the next try is scheduled without waiting for another change');
  assert.ok(b.publishNow(), 'and sends the same snapshot');
  assert.ok(rung(dir, 2) > 0);
  assert.equal(rung(dir, 3), 0, 'one bell for the two tries');
  b.stop();
});

test('a file that stays in use is logged once, and again when it is still in use half a minute on', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { b } = fakeBridge();
  t.after(() => b.stop());
  b.bank.write = () => {
    throw new FileInUse(b.bank.slotFile(1));
  };
  const logged = () => b.logs.filter((line) => line.includes('update waiting')).length;
  for (let tries = 0; tries < 60; tries++) b.publishNow('test');
  assert.equal(logged(), 1);
  t.mock.timers.tick(30000);
  b.publishNow('test');
  assert.equal(logged(), 2);
});

test('a command run just before the bridge stops is not run again by the next bridge', async () => {
  const { b, dir, calls } = fakeBridge();
  const strip = frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0'], ['C', 1, 'send', 't1', 'hello']]);
  b.onFrame(strip);
  b.stop();
  const next = new Bridge({ addonsDir: dir, config: { slots: 8, backend: 't3' }, log: () => {}, stateDir: b.stateDir });
  next.proc = b.proc;
  next.t3.sendMessage = async (...a) => calls.push(['sent again', ...a]);
  next.onFrame(strip);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c[0]), ['send']);
  next.stop();
});

test('a slot the game has open: the update waits, the old snapshot stays whole, no temp file is left', windowsOnly, async () => {
  const { b, dir } = fakeBridge();
  assert.ok(b.publishNow('test'));
  const slot = b.bank.slotFile(1);
  const before = fs.readFileSync(slot);
  const release = await holdOpen(slot);
  try {
    assert.equal(b.publishNow('test'), false);
    assert.deepEqual(fs.readFileSync(slot), before);
    assert.deepEqual(fs.readdirSync(path.dirname(slot)).filter((f) => f.endsWith('.tmp')), []);
    assert.equal(rung(dir, 2), 0, 'no bell for an update the game cannot load');
  } finally {
    await release();
  }
  assert.ok(b.publishNow());
  assert.notDeepEqual(fs.readFileSync(slot), before);
  assert.ok(rung(dir, 2) > 0);
  b.stop();
});

test('a rung bell the game has open: ringing it again works, and the bell that reuses its file waits', windowsOnly, async () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  for (let k = 1; k <= 4; k++) bank.raise(k);
  const release = await holdOpen(bank.bellFile(1));
  try {
    assert.equal(bank.raise(1), true);
    assert.throws(() => bank.raise(5), FileInUse);
    assert.equal(rung(dir, 5), 0, 'bell 5 is not rung while bell 1 (the same file as bell 9) still is');
    assert.equal(rung(dir, 1), LONG_SILENT_WAV.length, 'bell 1 is whole');
  } finally {
    await release();
  }
  bank.raise(5);
  assert.equal(rung(dir, 1), 0);
  assert.ok(rung(dir, 5) > 0);
});

test('a new game client is not ready until a bell the game still has open is empty', windowsOnly, async () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  bank.raise(1);
  bank.raise(2);
  const release = await holdOpen(bank.bellFile(2));
  try {
    assert.equal(bank.resetSignals(), false);
    assert.equal(rung(dir, 2), LONG_SILENT_WAV.length, 'bell 2 is whole');
    assert.equal(rung(dir, 1), 0, 'the others are emptied meanwhile');
  } finally {
    await release();
  }
  assert.equal(bank.resetSignals(), true);
  assert.equal(rung(dir, 2), 0);
});

test('state.json held open by another program: the save waits and the bridge keeps running', windowsOnly, async () => {
  const { b } = fakeBridge();
  const handled = () => JSON.parse(fs.readFileSync(b.stateFile, 'utf8')).handled.sess;
  const strip = (id) => frame(id, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0'], ['C', id, 'send', 't1', 'hello']]);
  b.onFrame(strip(1));
  await until(() => fs.existsSync(b.stateFile), 'the first save lands');
  const release = await holdOpen(b.stateFile);
  try {
    b.onFrame(strip(2));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(handled(), 1, 'the old state is whole');
    assert.deepEqual(fs.readdirSync(b.stateDir).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    await release();
  }
  await until(() => handled() === 2, 'the held-back save lands');
  b.stop();
});

test('activity labels and pending questions', () => {
  const proj = {
    runs: [{ id: 'r1' }],
    turnItems: [
      { runId: 'r1', type: 'command_execution', status: 'completed', input: 'ls' },
      { runId: 'r1', type: 'subagent', status: 'running' },
      { runId: 'r1', type: 'user_input_request', status: 'pending', requestId: 'q', questions: [{ id: 'a', header: 'H', question: 'Pick | one', options: [{ label: 'X', description: 'x' }] }] },
    ],
    runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'pending' }],
  };
  assert.equal(activityLabel(proj), 'Working with a subagent');
  const p = pendingRequest(proj);
  assert.equal(p.kind, 'question');
  assert.equal(p.questions[0].q, 'Pick || one');
  assert.equal(p.questions[0].opts[0].v, 'X');
});

test('lua serializer escapes strings and keeps utf-8', needsLua, () => {
  const s = luaValue({ a: 'x"y\\z\n\u0001', b: ['é', 1.5, true], 'not ident': 1, end: 2 });
  const file = path.join(os.tmpdir(), `t3wow-ser-${process.pid}.lua`);
  fs.writeFileSync(file, Buffer.from(`local t = ${s}; io.write(t.a, "|", t.b[1], "|", t["not ident"], "|", t["end"])`, 'latin1'));
  const out = execFileSync('lua5.1', [file]);
  fs.rmSync(file);
  assert.equal(out.toString('utf8'), 'x"y\\z\n\u0001|é|1|2');
});

test('markdown formatting', () => {
  const w = markdownToWow('# Title\n- item with `code` and **bold** | pipe\n```\nfn()\n```');
  assert.match(w, /\|cffffd100Title\|r/);
  assert.match(w, /•/);
  assert.match(w, /\|\| pipe/);
  assert.match(w, /fn\(\)/);
  // Characters the game's fonts lack would show as boxes.
  assert.equal(markdownToWow('game → bridge ✓ `a ≥ b` — done…'), 'game -> bridge OK |cffa8c7faa ≥ b|r — done…');
  // Latin Extended letters lose their accents; Latin-1 ones (â î é) stay. Decomposed input too.
  assert.equal(markdownToWow('Când împărțirea, ştiu Țară, Łódź, café'), 'Când împartirea, stiu Tara, Lódz, café');
  assert.equal(markdownToWow('și ă'), 'si a');
  assert.equal(markdownToSpeech('**Done**: see [docs](http://x)'), 'Done : see docs');
});

test('run summary, plan text and approval details', () => {
  const proj = {
    runs: [{ id: 'r1', startedAt: '2026-11-08T00:00:00Z', completedAt: '2026-11-08T00:04:12Z' }],
    turnItems: [
      { runId: 'r1', type: 'command_execution' },
      { runId: 'r1', type: 'command_execution' },
      { runId: 'r1', type: 'file_change', fileName: '/x/a.lua' },
      { runId: 'r1', type: 'file_change', fileName: '/x/a.lua' },
      { runId: 'r1', type: 'file_change', fileName: '/x/b.lua' },
      { runId: 'r1', type: 'subagent' },
      { runId: 'r1', type: 'proposed_plan', markdown: '# Plan\n- step one' },
      { runId: 'r1', nodeId: 'n1', type: 'file_change', fileName: '/x/c.lua', additions: 12, deletions: 3 },
    ],
    runtimeRequests: [{ id: 'q', kind: 'file-change', status: 'pending', nodeId: 'n1' }],
  };
  assert.equal(runSummary(proj), 'Last run: 2 commands · edited 3 files (a.lua, b.lua, c.lua) · 1 subagent · 4m 12s');
  assert.equal(proposedPlan(proj), '# Plan\n- step one');
  const p = pendingRequest(proj);
  assert.deepEqual(p.files, [{ f: 'c.lua', a: 12, d: 3 }]);
  assert.equal(p.always, undefined);
  proj.runtimeRequests[0].kind = 'command';
  proj.turnItems.push({ runId: 'r1', nodeId: 'n1', type: 'command_execution', input: 'rm -rf build' });
  assert.equal(pendingRequest(proj).detail, 'rm -rf build');
  assert.equal(pendingRequest(proj).always, true);
});

test('screenshots ride along with the next message', async () => {
  const { b, calls } = fakeBridge();
  b.capture.screenshot = async () => ({ data: Buffer.from('jpeg'), name: 's.jpg', mime: 'image/jpeg' });
  b.t3.uploadImage = async (key, data, name, mime) => ({ type: 'image', id: 'att-1', name, mimeType: mime, sizeBytes: data.length });
  b.t3.sendMessage = async (...a) => calls.push(['send', ...a]);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 1, 'shot', 't1']]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.shots.get('t1').length, 1);
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 2, 'send', 't1', 'look at this']]));
  await new Promise((r) => setTimeout(r, 20));
  const send = calls.find((c) => c[0] === 'send');
  assert.equal(send[2], 'look at this');
  assert.equal(send[4][0].id, 'att-1');
  assert.equal(b.shots.has('t1'), false);
  b.stop();
});

test('read-aloud waits while the player is in combat', () => {
  const { b } = fakeBridge();
  const spoken = [];
  b.voice.speak = (t) => spoken.push(t);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'orq', '', '0.1.0']]));
  b.announce({ id: 't1', title: 'Fix it' }, 'open');
  assert.equal(spoken.length, 0);
  assert.ok(b.deferredAnnounce);
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'or', '', '0.1.0']]));
  b.stop();
});

test('missing dictation explains itself in platform terms', () => {
  const { b } = fakeBridge();
  b.voice.canOmarchyDictate = () => false;
  b.voice.canTranscribe = () => false;
  assert.match(b.voice.dictationHint('darwin'), /macOS/, 'macOS gets macOS words');
  assert.doesNotMatch(b.voice.dictationHint('darwin'), /Omarchy/, "macOS isn't told to use Omarchy");
  assert.match(b.voice.dictationHint('linux'), /Omarchy/, 'Linux keeps the Omarchy hint');
  assert.throws(() => b.dictate('start'), (err) => err.message === b.voice.dictationHint());
  const noBackend = b.buildSnapshot().bridge;
  assert.equal(noBackend.dictation, undefined);
  assert.equal(noBackend.dictationHint, b.voice.dictationHint(), 'the addon is told what to show');
  b.voice.canOmarchyDictate = () => true;
  b.voice.backendName = () => 'voxtype';
  const withBackend = b.buildSnapshot().bridge;
  assert.equal(withBackend.dictation, 'omarchy-dictation (voxtype)');
  assert.equal(withBackend.dictationHint, undefined, 'no hint when dictation works');
  b.stop();
});

test('pacing: fast while reading, patient otherwise, reserve kept for alerts', () => {
  const { b } = fakeBridge(600);
  const hello = (flags, seq = 1) => frame(seq, [['H', 1, 'sess', 'ui1', 2, 1, 0, flags, 't1', '0.1.0', '600']]);
  b.onFrame(hello('oa'));
  b.publishNow('test'); // ack the hello
  b.lastPublishAt = Date.now();
  b.dirty = { important: false, minor: false, view: true };
  assert.ok(b.nextPublishDelay() <= 1500, 'reading: new reply text within 1.5s');
  b.client.flags = 'o';
  assert.ok(b.nextPublishDelay() >= 4500, 'window open but idle: ~5s');
  b.dirty = { important: false, minor: true, view: false };
  b.client.flags = '';
  assert.ok(b.nextPublishDelay() >= 55000, 'window closed: activity churn waits ~a minute');
  b.dirty = { important: true, minor: false, view: false };
  assert.ok(b.nextPublishDelay() <= 3000, 'window closed: a thread finishing still goes within 3s');
  // Low on slots: intervals stretch; at the reserve only alerts go.
  b.client.slotNext = 560; // 41 left of 600
  b.dirty = { important: false, minor: false, view: true };
  b.client.flags = 'oa';
  assert.ok(b.nextPublishDelay() >= 3500, 'scarce: reading updates stretch');
  b.client.slotNext = 590; // 11 left
  assert.equal(b.nextPublishDelay(), null, 'reserve: no view updates');
  b.dirty = { important: true, minor: false, view: false };
  assert.ok(b.nextPublishDelay() !== null, 'reserve: alerts still go');
  b.client.seq = 99; // an unacknowledged command
  assert.ok(b.nextPublishDelay() <= 400, 'acks always go right away');
  b.stop();
});

test('a locked file backs the publish off instead of retrying in a loop', () => {
  const { b } = fakeBridge(600);
  const logs = [];
  b.log = (m) => logs.push(m);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'oa', 't1', '0.1.0', '600']]));
  b.client.seq = 99; // a command the addon is waiting on
  try {
    const raise = b.bank.raise.bind(b.bank);
    b.bank.raise = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    assert.equal(b.publishNow(), false);
    assert.ok(b.nextPublishDelay() >= 200, 'an unacknowledged command still waits for the retry');
    assert.equal(b.publishNow(), false);
    assert.ok(b.nextPublishDelay() >= 450, 'the wait grows');
    assert.ok(b.dirty.important, 'the update stays queued');
    b.bank.raise = raise;
    assert.ok(b.publishNow());
    assert.ok(b.nextPublishDelay() === null || b.nextPublishDelay() > 1000, 'no retry after it went through');
    assert.equal(logs.filter((l) => l.startsWith('publish failed')).length, 1);
    assert.ok(logs.some((l) => l.startsWith('publish recovered after 2 failed tries')));
  } finally {
    b.stop();
  }
});

test('usage comes from the Omarchy records the Agents panel keeps', async () => {
  const { OmarchyUsage, mergeUsage } = await import('../src/usage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-usage-'));
  let changes = 0;
  const u = new OmarchyUsage({ dir, updater: 'definitely-not-a-command', onChange: () => changes++ });
  fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify({ tierLabel: 'Max 20x', limits: [{ label: 'Weekly', percent: 0.18, resetsAt: '2026-11-12T00:00:00Z' }], todayPrompts: 3, todayTotalTokens: 2.5e6 }));
  u.refresh(['claudeAgent', 'codex']);
  assert.equal(changes, 1);
  const e = mergeUsage({ instanceId: 'claudeAgent', displayName: 'Claude' }, u.forInstance('claudeAgent'));
  assert.equal(e.plan, 'Max 20x');
  assert.deepEqual(e.windows.map((w) => [w.label, w.used]), [['Weekly', 18]]);
  assert.equal(e.today, 'Today: 3 prompts · 3M tokens');
  u.refresh(['claudeAgent']); // unchanged file: no re-read, no change event
  assert.equal(changes, 1);
});

test('slot manifests are identical and keep the live data out of addon-manager fingerprints', () => {
  const dir = tempAddons(3);
  const read = (i, f) => fs.readFileSync(path.join(dir, `T3Code_S00${i}`, f), 'utf8');
  assert.equal(read(1, 'T3Code_S001.toc'), read(3, 'T3Code_S003.toc'));
  assert.doesNotMatch(read(1, 'T3Code_S001.toc'), /Dependencies|Inbox\.lua/);
  // WowUp/CurseForge follow only self-closing <Script file="..."/> includes.
  const xml = read(1, 'Slot.xml');
  assert.match(xml, /<Script file="Inbox\.lua"><\/Script>/);
  assert.doesNotMatch(xml, /<(?:Include|Script)\s+file=["']((?:(?<!\.\.).)+)["']\s*\/>/is);
});

test('reopening a settled thread sends the reason T3 Code requires', async () => {
  const { T3Client } = await import('../src/t3.js');
  const c = new T3Client({ tokenProvider: async () => 'x' });
  const sent = [];
  c.request = async (tag, payload) => sent.push([tag, payload]);
  await c.unsettle('t1');
  assert.equal(sent[0][0], 'orchestration.dispatchCommand');
  assert.equal(sent[0][1].type, 'thread.unsettle');
  assert.equal(sent[0][1].reason, 'user');
});

test('schema errors from T3 Code read as a version mismatch', () => {
  assert.match(friendlyError('Missing key\n  at ["reason"]'), /didn't accept that request \(it wants "reason"\)/);
  assert.equal(friendlyError('nothing is running in that thread'), 'nothing is running in that thread');
});

test('a settled thread shows as settled even with an unreviewed plan', async () => {
  const { threadStatus } = await import('../src/t3.js');
  const t = { status: 'completed', hasActionableProposedPlan: true, settledOverride: 'settled' };
  assert.equal(threadStatus(t), 'settled');
  assert.equal(threadStatus({ ...t, settledOverride: null }), 'plan');
  assert.equal(threadStatus({ ...t, pendingRuntimeRequest: { kind: 'user_input' } }), 'input');
});

test('a thread waiting on a watched PR or another thread is waiting, not open', async () => {
  const { threadStatus, waitingOn } = await import('../src/t3.js');
  const watch = { taskId: 'pull-request-watch:x#1', description: 'Watching pull request #1', awaited: true, kind: 'monitor' };
  const t = { status: 'completed', pendingBackgroundTasks: [watch] };
  assert.equal(threadStatus(t), 'waiting');
  assert.equal(waitingOn(t), 'Watching pull request #1');
  assert.equal(threadStatus({ ...t, pendingBackgroundTasks: [{ ...watch, awaited: false }] }), 'open');
  assert.equal(threadStatus({ ...t, status: 'running', activityRunStatus: 'running' }), 'working', 'while its run goes on a thread is Working, as in T3 Code');
  assert.equal(threadStatus({ ...t, pendingRuntimeRequest: { kind: 'approval' } }), 'input', 'needing the player wins');
});

test('a running thread blocked on another thread is waiting, as in T3 Code', async () => {
  const { threadStatus, waitingOn } = await import('../src/t3.js');
  const t = { status: 'running', activityRunStatus: 'running', blockedOnThreadWait: true };
  assert.equal(threadStatus(t), 'waiting');
  assert.equal(waitingOn(t), 'Waiting on another thread');
  assert.equal(threadStatus({ ...t, blockedOnThreadWait: false }), 'working');
  assert.equal(threadStatus({ status: 'completed', blockedOnThreadWait: true }), 'open', 'the flag counts only during a run');
});

test('a thread waiting on its subagent or a background task is waiting, as in T3 Code', async () => {
  const { threadStatus, waitingOn } = await import('../src/t3.js');
  // The shape T3 Code sends: subagent and background tasks carry no awaited flag.
  const subagent = { taskId: 'a1', description: 'Build bridge half', kind: 'subagent', providerInstanceId: 'claudeAgent' };
  const t = { status: 'completed', pendingBackgroundTasks: [subagent] };
  assert.equal(threadStatus(t), 'waiting');
  assert.equal(waitingOn(t), 'Build bridge half');
  assert.equal(threadStatus({ ...t, pendingBackgroundTasks: [{ taskId: 'b', kind: 'background_task' }] }), 'waiting');
  assert.equal(threadStatus({ ...t, pendingBackgroundTasks: [{ taskId: 'c', kind: 'command' }] }), 'open', 'a background command is not waited on');
  assert.equal(threadStatus({ ...t, pendingBackgroundTasks: [{ taskId: 'm', kind: 'monitor' }] }), 'open', 'nor is a monitor nobody awaits');
  assert.equal(threadStatus({ ...t, status: 'failed' }), 'failed', 'a failed run shows as failed, not waiting');
});

test('a waiting thread is listed with what it waits for, timed from the end of its last run', () => {
  const { b } = fakeBridge();
  b.t3.threads.set('pr-watch', { id: 'pr-watch', title: 'Watch', projectId: 'p1', status: 'completed', updatedAt: new Date().toISOString(),
    latestRunStartedAt: '2026-01-01T00:00:00Z', latestRunCompletedAt: '2026-01-01T00:05:00Z',
    pendingBackgroundTasks: [{ taskId: 'w', description: 'Watching pull request #7', awaited: true, kind: 'monitor' }] });
  const t = b.buildSnapshot().threads.find((x) => x.id === 'pr-watch');
  assert.equal(t?.s, 'waiting');
  assert.equal(t?.l, 'Watching pull request #7');
  assert.equal(t?.st, Date.parse('2026-01-01T00:05:00Z') / 1000, 'waiting counts from the end of the last run');
  assert.equal(t?.run, undefined, 'nothing is running to stop');
});

test('a thread whose run is blocked on another thread can still be stopped, and churns no slots', () => {
  const { b } = fakeBridge();
  const base = { id: 'parent', title: 'Parent', projectId: 'p1', status: 'running', activityRunStatus: 'running', activityRunStartedAt: '2026-01-01T00:00:00Z', blockedOnThreadWait: true,
    latestVisibleMessage: { role: 'assistant', text: 'Starting the subagent' }, pendingBackgroundTasks: [{ taskId: 'a1', description: 'Build bridge half', kind: 'subagent' }] };
  b.t3.threads.set('parent', { ...base, updatedAt: '2026-01-01T00:01:00Z' });
  const first = b.buildSnapshot().threads.find((x) => x.id === 'parent');
  assert.equal(first?.s, 'waiting');
  assert.equal(first?.run, true, 'the addon is told the run is still going');
  assert.equal(first?.st, Date.parse('2026-01-01T00:00:00Z') / 1000, 'timed from the start of the run');
  b.t3.threads.set('parent', { ...base, updatedAt: '2026-01-01T00:02:00Z', latestVisibleMessage: { role: 'assistant', text: 'Still going' } });
  const second = b.buildSnapshot().threads.find((x) => x.id === 'parent');
  assert.deepEqual(second, first, 'tool calls during the run change nothing the game is sent');
});

test('a subagent thread waiting on its own subagent stays listed', () => {
  const { b } = fakeBridge();
  b.t3.threads.set('kid', { id: 'kid', title: 'Kid', projectId: 'p1', status: 'completed', lineage: { parentThreadId: 't1' },
    updatedAt: new Date().toISOString(), pendingBackgroundTasks: [{ taskId: 'g', kind: 'subagent' }] });
  assert.equal(b.buildSnapshot().threads.find((x) => x.id === 'kid')?.s, 'waiting');
});

test('a thread whose child threads still run is waiting on them, as in T3 Code', () => {
  const { b } = fakeBridge();
  const said = [];
  b.announce = (t, status) => said.push(status);
  const now = new Date().toISOString();
  // T3 Code lists no pending task on the parent for a delegated child thread.
  const lead = { id: 'lead', title: 'Lead', projectId: 'p1', status: 'completed', latestRunCompletedAt: '2026-01-01T00:05:00Z', updatedAt: now };
  const kid = { id: 'kid', title: 'Kid', projectId: 'p1', status: 'running', activityRunStatus: 'running', lineage: { parentThreadId: 'lead' }, updatedAt: now };
  b.t3.threads.set('lead', lead);
  b.t3.threads.set('kid', kid);
  b.onT3Change({ kind: 'thread', prev: { ...lead, status: 'running', activityRunStatus: 'running' }, thread: lead });
  assert.deepEqual(said, [], 'the parent’s run ending while a child runs is not announced');
  const row = () => b.buildSnapshot().threads.find((x) => x.id === 'lead');
  assert.deepEqual([row().s, row().l, row().st], ['waiting', 'Waiting on 1 subagent', Date.parse('2026-01-01T00:05:00Z') / 1000]);
  b.t3.threads.set('kid', { ...kid, status: 'completed', activityRunStatus: null });
  assert.equal(row().s, 'open', 'done once its children are');
});

test('ending a turn into waiting is not announced; the wait ending is', async () => {
  const { b } = fakeBridge();
  const said = [];
  b.announce = (t, status) => said.push(status);
  const base = { id: 'w', title: 'W', projectId: 'p1', updatedAt: new Date().toISOString() };
  const running = { ...base, status: 'running', activityRunStatus: 'running' };
  const waiting = { ...base, status: 'completed', pendingBackgroundTasks: [{ taskId: 'x', description: 'Watching pull request #7', awaited: true }] };
  const done = { ...base, status: 'completed' };
  b.onT3Change({ kind: 'thread', prev: running, thread: waiting });
  assert.deepEqual(said, []);
  b.onT3Change({ kind: 'thread', prev: waiting, thread: done });
  assert.deepEqual(said, ['open']);
  b.onT3Change({ kind: 'thread', prev: running, thread: { ...running, id: 'kid', lineage: { parentThreadId: 'w' }, status: 'completed', activityRunStatus: null } });
  assert.deepEqual(said, ['open'], 'subagent threads are never announced');
});

test('running subagent threads are listed, idle ones are not', async () => {
  const { T3Client } = await import('../src/t3.js');
  const c = new T3Client({ tokenProvider: async () => 'x' });
  c.onShell({ kind: 'snapshot', snapshot: { threads: [{ id: 'kid', lineage: { parentThreadId: 'p' }, status: 'running', activityRunStatus: 'running' }] } });
  assert.ok(c.threads.has('kid'), 'the client keeps subagent threads');
  c.onShell({ kind: 'thread.updated', thread: { id: 'kid2', lineage: { parentThreadId: 'p' }, status: 'running', activityRunStatus: 'running' } });
  assert.ok(c.threads.has('kid2'), 'and their updates');

  const { b } = fakeBridge();
  const now = new Date().toISOString();
  b.t3.threads.set('busy-kid', { id: 'busy-kid', title: 'Busy', projectId: 'p1', status: 'running', activityRunStatus: 'running', lineage: { parentThreadId: 't1' }, updatedAt: now });
  b.t3.threads.set('idle-kid', { id: 'idle-kid', title: 'Idle', projectId: 'p1', status: 'completed', lineage: { parentThreadId: 't1' }, updatedAt: now });
  const ids = b.buildSnapshot().threads.map((t) => t.id);
  assert.ok(ids.includes('busy-kid'), 'a running subagent thread is listed');
  assert.ok(!ids.includes('idle-kid'), 'an idle one is not');
});

const at = (min) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString();

function lineage(parent, relationship = 'subagent') {
  return { parentThreadId: parent, relationshipToParent: parent ? relationship : null, rootThreadId: parent || 'lead' };
}

// A lead thread with an idle and a busy subagent, delivered as T3 Code's shell.
function family(b) {
  const now = new Date().toISOString();
  const shell = (threads) => b.t3.local.client.onShell({ kind: 'snapshot', snapshot: { threads } });
  shell([
    { id: 'lead', title: 'Lead | the work', projectId: 'p1', status: 'completed', createdAt: at(0), updatedAt: now, lineage: lineage(null) },
    { id: 'idle', title: 'A | b' + 'c'.repeat(100), projectId: 'p1', status: 'completed', createdAt: at(1), updatedAt: now, latestRunCompletedAt: at(9), lineage: lineage('lead') },
    { id: 'busy', title: 'Busy', projectId: 'p1', status: 'running', activityRunStatus: 'running', activityRunStartedAt: at(3), createdAt: at(2), updatedAt: now, lineage: lineage('lead') },
  ]);
  const update = (id, change) => b.t3.local.client.onShell({ kind: 'thread.updated', thread: { ...b.t3.local.client.threads.get(id), ...change } });
  return { update };
}

function view(b, id) {
  b.client = { session: 'sess', ui: 'ui1', ackedSeq: -1, flags: 'o', view: id, hashes: {} };
  return b.buildSnapshot();
}

test('the open thread’s family: its children, its parent, and its own header when the list leaves it out', () => {
  const { b } = fakeBridge();
  family(b);
  const long = 'A || b' + 'c'.repeat(75);

  const lead = view(b, 'lead');
  assert.deepEqual(lead.fam, {
    id: 'lead',
    me: undefined,
    up: undefined,
    kids: [
      { id: 'idle', t: long, s: 'open', k: 'sub', env: undefined },
      { id: 'busy', t: 'Busy', s: 'working', k: 'sub', env: undefined },
    ],
  }, 'children in start order; a title is cut to 80 characters, then escaped');

  const idle = view(b, 'idle');
  assert.ok(!idle.threads.some((t) => t.id === 'idle'), 'an idle subagent is not listed');
  assert.deepEqual(idle.fam.up, { id: 'lead', t: 'Lead || the work', s: 'open', k: 'sub', env: undefined });
  assert.equal(idle.fam.kids, undefined);
  const me = idle.fam.me;
  assert.deepEqual([me.id, me.title, me.p, me.s, me.l], ['idle', 'A || b' + 'c'.repeat(100), 'p1', 'open', 'Finished'], 'the header a list row would give');
  assert.equal(me.u, Date.parse(at(9)) / 1000, 'aged from the end of its last run');
  assert.equal(me.last, undefined);

  const busy = view(b, 'busy');
  assert.ok(busy.threads.some((t) => t.id === 'busy'), 'a working subagent is listed');
  assert.equal(busy.fam.me, undefined, 'so it needs no header of its own');
  assert.equal(busy.fam.up.id, 'lead');

  const lone = view(b, 't1');
  assert.equal(lone.fam, undefined, 'a listed thread with no relatives has no family part');
  assert.equal(lone.x.f, '');
  b.stop();
});

test('a subagent the provider started takes its status from its parent, where T3 Code keeps it', async () => {
  const { b } = fakeBridge();
  const now = new Date().toISOString();
  // The shape T3 Code sends for Claude's own subagents: the subagent's thread stays idle
  // while it runs, and the parent's projection lists it with its real status.
  b.t3.local.client.onShell({ kind: 'snapshot', snapshot: { threads: [
    { id: 'lead', title: 'Lead', projectId: 'p1', status: 'running', activityRunStatus: 'running', createdAt: at(0), updatedAt: now, lineage: lineage(null) },
    { id: 'kid', title: 'Hold', projectId: 'p1', status: 'idle', creationSource: 'provider', createdAt: at(1), updatedAt: now, lineage: lineage('lead') },
  ] } });
  let status = 'running';
  b.t3.threadProjection = async (id) => ({ messages: [], turnItems: [], runtimeRequests: [], runs: [], subagents: id === 'lead' ? [{ childThreadId: 'kid', status }] : [] });

  b.client = { session: 'sess', ui: 'ui1', ackedSeq: -1, flags: 'o', view: 'lead', hashes: {} };
  await b.refreshView('lead', true);
  assert.equal(view(b, 'lead').fam.kids[0].s, 'working', 'a running subagent is working, not finished');
  status = 'failed';
  await b.refreshView('lead', true);
  assert.equal(view(b, 'lead').fam.kids[0].s, 'failed');
  status = 'completed';
  await b.refreshView('lead', true);
  assert.equal(view(b, 'lead').fam.kids[0].s, 'open');

  status = 'running';
  b.views.clear();
  b.client.view = 'kid';
  await b.refreshView('kid', true);
  await b.views.get('lead')?.inflight;
  assert.equal(view(b, 'kid').threads.find((r) => r.id === 'kid')?.s, 'working', 'opening the subagent loads its parent, so its own row is right too');
  assert.equal(view(b, 'kid').fam.ro, true, 'a subagent its provider started takes no messages, so the game is told');
  assert.equal(view(b, 'lead').fam?.ro, undefined, 'its parent does');
  status = 'waiting';
  b.client.view = 'lead';
  await b.refreshView('lead', true);
  assert.equal(view(b, 'lead').fam.kids[0].s, 'waiting', 'a subagent waiting on its own work shows as waiting');
  b.stop();
});

test('a relative on another machine is named with it, and a sender on an unknown machine can’t be opened', () => {
  const { b } = fakeBridge(8, { environments: [{ code: 'e1', id: 'env-laptop', label: 'Laptop | 2', urls: [] }] });
  family(b);
  b.t3.local.client.onConfig({ type: 'snapshot', config: { environment: { environmentId: 'env-desk', label: 'Desk' } } });
  const [, laptop] = b.t3.envs;
  laptop.client.onShell({ kind: 'snapshot', snapshot: { threads: [
    { id: 'helper', title: 'Helper', projectId: 'lp', status: 'completed', createdAt: at(5), updatedAt: at(6), delegatedFrom: { environmentId: 'env-desk', threadId: 'lead', title: 'Lead' } },
    { id: 'stray', title: 'Stray', projectId: 'lp', status: 'completed', createdAt: at(5), updatedAt: at(6), delegatedFrom: { environmentId: 'env-gone', threadId: 'x', title: 'From | afar' } },
  ] } });

  assert.deepEqual(view(b, 'lead').fam.kids.at(-1), { id: 'e1~helper', t: 'Helper', s: 'open', k: 'sent', env: 'Laptop || 2' });
  assert.deepEqual(view(b, 'e1~helper').fam.up, { id: 'lead', t: 'Lead || the work', s: 'open', k: 'sent', env: 'Desk' });
  assert.deepEqual(view(b, 'e1~stray').fam.up, { id: undefined, t: 'From || afar', s: undefined, k: 'sent', env: undefined });
  b.stop();
});

test('the family part keeps its hash through replies and a child’s tool calls, and a hidden child’s update costs no publish', () => {
  const { b } = fakeBridge();
  const { update } = family(b);
  const leadDetail = { messages: [{ role: 'assistant', text: 'one', createdAt: at(4) }], turnItems: [], runtimeRequests: [], runs: [] };
  b.views.set('lead', { projection: leadDetail, fetchedAt: Date.now() });
  const first = view(b, 'lead');

  leadDetail.messages.push({ role: 'assistant', text: 'two', createdAt: at(5) });
  b.views.set('busy', { projection: { runs: [{ id: 'r' }], turnItems: [{ runId: 'r', type: 'command_execution', status: 'running', input: 'ls' }] }, fetchedAt: Date.now() });
  update('busy', { updatedAt: new Date(Date.now() + 1000).toISOString() });
  const later = b.buildSnapshot();
  assert.notEqual(later.x.v, first.x.v, 'the transcript changed');
  assert.equal(later.threads.find((t) => t.id === 'busy').l, 'Running ls', 'the child’s activity changed');
  assert.equal(later.x.f, first.x.f);

  b.t3.on('change', (ev) => b.onT3Change(ev));
  assert.ok(b.publishNow());
  update('idle', { updatedAt: new Date(Date.now() + 2000).toISOString(), lastVisitedAt: new Date().toISOString() });
  assert.equal(b.publishNow(), false, 'a hidden child’s update with nothing shown changed');
  update('idle', { title: 'Renamed', updatedAt: new Date(Date.now() + 3000).toISOString() });
  assert.ok(b.publishNow(), 'its new title is shown, so it goes');

  update('idle', { status: 'running', activityRunStatus: 'running', updatedAt: new Date(Date.now() + 4000).toISOString() });
  assert.notEqual(b.buildSnapshot().x.f, first.x.f, 'a child starting work changes the family');
  b.stop();
});

test('the family part is left out of later slots while the addon holds it, never out of slots 1-3', () => {
  const { b, dir } = fakeBridge();
  const { update } = family(b);
  const slot = (i) => fs.readFileSync(path.join(dir, `T3Code_S${String(i).padStart(3, '0')}`, 'Inbox.lua'), 'latin1');
  const hello = (seq, x = {}) => b.onFrame(frame(seq, [['H', 1, 'sess', 'ui1', 4, 1, b.lastGen, 'o', 'idle', '0.1.0', '8', '', x.l || '', x.p || '', x.v || '', x.f || '']]));
  hello(1);
  const first = b.buildSnapshot();
  assert.ok(b.publishNow('test'));
  // Its next hello says it applied that snapshot.
  hello(2, first.x);
  assert.equal(b.client.hashes.fam, first.x.f);
  assert.ok(b.publishNow('test'));
  for (const i of [1, 2, 3]) assert.match(slot(i), /fam=\{id="idle"/, `slot ${i} is complete`);
  assert.doesNotMatch(slot(4), /fam=/, 'no second copy of the family');
  assert.match(slot(4), /same="pvf"/);

  // The parent starts a run: the family changed, so the addon's copy is stale.
  update('lead', { status: 'running', activityRunStatus: 'running', updatedAt: new Date(Date.now() + 1000).toISOString() });
  assert.ok(b.publishNow('test'));
  assert.match(slot(4), /fam=\{id="idle"/, 'a changed family is sent');
  assert.equal(b.client.hashes.fam, null, 'and the old hash is no longer trusted');
  b.stop();
});
