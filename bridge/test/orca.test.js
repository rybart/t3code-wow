import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrcaClient, agentToThread, projectionOf, historyToProjection, answersFor, approvalOption, withoutGameContext } from '../src/orca.js';
import { sessionIdOf, paneKeyOf, canonicalize, fingerprint } from '../src/orca-rpc.js';
import { threadStatus, isUnread } from '../src/t3.js';
import { activityLabel, pendingRequest } from '../src/bridge.js';

const ids = { thread: (k) => `o-${k}`, project: (k) => `w-${k}` };
const wt = { worktreeId: 'repo::/p', repo: 'app', displayName: 'feature', branch: 'refs/heads/feature' };
const agent = (over = {}) => ({ paneKey: 'pane', agentType: 'claude', prompt: 'Fix the bug', stateStartedAt: 1000, updatedAt: 2000, activity: { unread: false }, ...over });

test("Orca's agent states map onto the game's statuses", () => {
  assert.equal(threadStatus(agentToThread(agent({ state: 'working' }), wt, ids)), 'working');
  assert.equal(threadStatus(agentToThread(agent({ state: 'blocked' }), wt, ids)), 'input');
  assert.equal(threadStatus(agentToThread(agent({ state: 'waiting' }), wt, ids)), 'input');
  assert.equal(threadStatus(agentToThread(agent({ state: 'done', mainAgent: { outcome: 'success' } }), wt, ids)), 'open');
  assert.equal(threadStatus(agentToThread(agent({ state: 'done', mainAgent: { outcome: 'failure' } }), wt, ids)), 'failed');
});

test('a finished turn is finished even while a background command runs, and waits on live subagents', () => {
  const child = (kind) => ({ kind, state: 'working', description: 'Run the bridge' });
  const done = { state: 'done', outcome: 'success', stateStartedAt: 1500 };
  assert.equal(threadStatus(agentToThread(agent({ state: 'working', mainAgent: done, children: [child('command')] }), wt, ids)), 'open');
  assert.equal(threadStatus(agentToThread(agent({ state: 'working', mainAgent: done, children: [child('subagent')] }), wt, ids)), 'waiting');
});

test("a finished agent is unread until Orca says it's been seen", () => {
  assert.equal(isUnread(agentToThread(agent({ state: 'done', activity: { unread: true } }), wt, ids)), true);
  assert.equal(isUnread(agentToThread(agent({ state: 'done' }), wt, ids)), false);
});

test('a running tool becomes the activity label', () => {
  const t = agentToThread(agent({ state: 'working', toolName: 'Bash', toolInput: { command: 'npm test' } }), wt, ids);
  assert.equal(activityLabel(projectionOf(t)), 'Running npm test');
});

test('polls report a snapshot, then only real changes', async () => {
  let worktrees = [{ ...wt, agents: [agent({ state: 'working' })] }];
  const c = new OrcaClient({ run: async () => JSON.stringify({ ok: true, result: { worktrees } }), pollMs: 60000 });
  const events = [];
  c.lastRuntimeCheck = Date.now(); // the Orca update check has a test of its own
  c.on('change', (e) => events.push(e.kind));
  c.stopped = false;
  await c.poll();
  await c.poll();
  worktrees = [{ ...wt, agents: [agent({ state: 'done' })] }];
  await c.poll();
  worktrees = [{ ...wt, agents: [] }];
  await c.poll();
  c.stop();
  assert.deepEqual(events, ['snapshot', 'thread', 'removed']);
  assert.equal(c.state, 'connected');
});

test('launching starts a chat agent in the chosen worktree', async () => {
  const calls = [];
  const c = new OrcaClient({ run: async (args) => (calls.push(args), JSON.stringify({ ok: true, result: { worktrees: [wt] } })), pollMs: 60000 });
  c.stopped = false;
  await c.poll();
  const projectId = [...c.projects.keys()][0];
  await c.launchThread(projectId, 'Write tests', [], { model: { instanceId: 'codex', model: 'default' } });
  c.stop();
  const launch = calls.find((a) => a[0] === 'agent');
  assert.deepEqual(launch.slice(0, 8), ['agent', 'launch', '--agent', 'codex', '--worktree', 'id:repo::/p', '--surface', 'chat']);
  assert.ok(!launch.includes('--model'));
});

// ---- chat agents, through Orca's runtime ----------------------------------------

const SID = 'claude_088c3ba5_d124_4863_9e9d_3e048a7d9a85';
const PANE = `structured-agent-session-${SID}:54374154-62e7-46be-a458-a62a03b680d1`;
const item = (seq, body, extra = {}) => ({ itemId: `i${seq}`, revision: 1, sequence: seq, observedAt: seq * 1000, body, turnScope: { kind: 'turn', turnItemId: 'turn1' }, ...extra });
const text = (role, t) => ({ kind: 'message', role, blocks: [{ type: 'text', text: t }] });

test("a chat's pane key names its session; a terminal's names none", () => {
  assert.equal(sessionIdOf(PANE), SID);
  assert.equal(sessionIdOf('terminal:abc'), null);
  assert.equal(paneKeyOf(SID), PANE);
});

test("fingerprints use Orca's canonical form: keys sorted, undefined left out", () => {
  assert.equal(canonicalize({ b: 1, a: { d: undefined, c: [1, 'x'] } }), '{"a":{"c":[1,"x"]},"b":1}');
  assert.equal(fingerprint('agentSession.cancel', SID, {}), fingerprint('agentSession.cancel', SID, { turnId: undefined }));
});

test('a history page becomes messages, the running tool and a pending question', () => {
  const page = {
    latestTurn: { itemId: 'turn1', turn: { state: 'running', startedAt: 1000 } },
    items: [
      item(1, text('user', 'Fix the bug')),
      item(2, { kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text: 'hmm' }] }),
      item(3, text('assistant', 'Looking now.')),
      item(4, { kind: 'tool-call', name: 'Bash', input: { command: 'npm test' }, state: 'running' }),
      item(5, { kind: 'question', question: 'Which file?', options: [{ id: 'a', label: 'a.js' }, { id: 'b', label: 'b.js' }], freeTextQuestionId: 'free', resolution: { state: 'pending' } }),
    ],
  };
  const p = historyToProjection(page);
  assert.deepEqual(p.messages.map((m) => [m.role, m.text]), [['user', 'Fix the bug'], ['assistant', 'Looking now.']]);
  assert.equal(activityLabel(p), 'Running npm test');
  const pending = pendingRequest(p);
  assert.equal(pending.kind, 'question');
  assert.equal(pending.id, 'i5');
  assert.equal(pending.questions[0].id, 'free');
  assert.equal(pending.questions[0].custom, true);
  assert.deepEqual(pending.questions[0].opts.map((o) => o.v), ['a', 'b']);
});

test('answers carry option ids, and typed text as the free-text answer', () => {
  const single = { question: 'Which?', options: [{ id: 'a' }, { id: 'b' }], freeTextQuestionId: 'free' };
  assert.deepEqual(answersFor(single, { free: 'a' }), [{ questionId: 'free', optionIds: ['a'] }]);
  assert.deepEqual(answersFor(single, { free: 'neither' }), [{ questionId: 'free', optionIds: [], other: 'neither' }]);
  const plain = { question: 'Which?', options: [{ id: 'a' }] };
  assert.deepEqual(answersFor(plain, { q1: 'a' }), [{ questionId: 'q1', optionIds: ['a'] }]);
  const group = { questions: [{ id: 'x', options: [{ id: '1' }, { id: '2' }], multiSelect: true }, { id: 'y', options: [{ id: '3' }] }] };
  assert.deepEqual(answersFor(group, { x: ['1', '2'] }), [{ questionId: 'x', optionIds: ['1', '2'] }]);
});

test("the game's approval buttons pick Orca's options by what they mean", () => {
  const body = { options: [{ id: 'yes', intent: 'allow_once' }, { id: 'always', intent: 'allow_always' }, { id: 'no', intent: 'reject_once' }] };
  assert.equal(approvalOption(body, 'accept'), 'yes');
  assert.equal(approvalOption(body, 'acceptForSession'), 'always');
  assert.equal(approvalOption(body, 'decline'), 'no');
  assert.equal(approvalOption({ options: [{ id: 'ok' }, { id: 'stop' }] }, 'decline'), 'stop');
});

test('replies, Stop and approvals go to the chat with a fresh revision; terminals refuse', async () => {
  const sent = [];
  const pending = item(7, { kind: 'approval', title: 'Bash', detail: 'rm -rf build', options: [{ id: 'yes', intent: 'allow_once' }, { id: 'no', intent: 'reject_once' }], resolution: { state: 'pending' } }, { revision: 3 });
  const rpc = {
    history: async () => ({ ok: true, page: { fence: 4, items: [pending] } }),
    send: async (...a) => sent.push(['send', ...a]),
    cancel: async (...a) => sent.push(['cancel', ...a]),
    respondToApproval: async (...a) => sent.push(['approve', ...a]),
  };
  const worktrees = [{ ...wt, agents: [agent({ paneKey: PANE, state: 'blocked' }), agent({ paneKey: 'terminal:1', state: 'working' })] }];
  const c = new OrcaClient({ run: async () => JSON.stringify({ ok: true, result: { worktrees } }), rpc, pollMs: 60000 });
  c.stopped = false;
  await c.poll();
  c.pollSoon = () => {};
  const chat = [...c.threads.values()].find((t) => t._orca.sessionId);
  const term = [...c.threads.values()].find((t) => !t._orca.sessionId);
  await c.sendMessage(chat.id, 'hi', 'auto');
  await c.interrupt(chat.id);
  await c.respondApproval(chat.id, 'i7', 'decline');
  c.stop();
  assert.deepEqual(sent[0].slice(0, 3), ['send', SID, 'hi']);
  assert.equal(sent[0][3].queue, true);
  assert.equal(sent[1][1], SID);
  assert.deepEqual(sent[2].slice(1, 5), [SID, 'i7', 3, 'no']);
  await assert.rejects(c.sendMessage(term.id, 'hi'), /terminal/);
});

test("the game's transcript shows a question without the game context the addon added", () => {
  const q = 'Which is better?\n\n[Game context]\nCharacter: Tester, level 60 Night Elf Druid\nLinked: [Helm] (item level 200)';
  const p = historyToProjection({ items: [item(1, text('user', q)), item(2, text('assistant', 'The Helm.'))] });
  assert.deepEqual(p.messages.map((m) => m.text), ['Which is better?', 'The Helm.']);
  assert.equal(withoutGameContext('No block here'), 'No block here');
});

test("a workspace's pull request and issue ride on its agents' rows", () => {
  const w = { ...wt, linkedPR: { number: 1721, state: 'open', checksStatus: 'failure', checksSummary: { total: 18, failed: 2 } }, linkedLinearIssue: 'J-326' };
  const t = agentToThread(agent({ state: 'done' }), w, ids);
  assert.deepEqual(t._orca.pr, { n: 1721, s: 'open', c: 'failure', f: 2, t: 18, ok: undefined });
  assert.equal(t._orca.issue, 'J-326');
  assert.equal(agentToThread(agent({ state: 'done' }), wt, ids)._orca.pr, null);
});

test('an Orca update that drops a needed capability, or breaks reading a chat, sets a warning', async () => {
  let caps = ['agent-session.structured.v1', 'agent-session.queued-messages.v2', 'agent-session.question-answers.v1'];
  let historyFails = false;
  const run = async (args) => {
    if (args[0] === 'status') return JSON.stringify({ ok: true, result: { runtime: { appVersion: '1.5.0', capabilities: caps } } });
    return JSON.stringify({ ok: true, result: { worktrees: [{ ...wt, agents: [agent({ paneKey: PANE, state: 'done' })] }] } });
  };
  const rpc = { history: async () => { if (historyFails) throw new Error('Invalid params'); return { ok: true, page: { items: [] } }; } };
  const c = new OrcaClient({ run, rpc, pollMs: 60000 });
  c.stopped = false;
  c.lastRuntimeCheck = Date.now(); // the poll shouldn't start its own check here
  await c.poll();
  c.stop();
  await c.checkRuntime();
  assert.equal(c.apiWarning, null);
  historyFails = true;
  await c.checkRuntime();
  assert.match(c.apiWarning, /Orca 1\.5\.0 .*reading a chat failed \(Invalid params\)/);
  historyFails = false;
  caps = caps.slice(1);
  await c.checkRuntime();
  assert.match(c.apiWarning, /no longer offers agent-session\.structured\.v1/);
});

test("a chat the bridge started shows while it's still empty, and a gone one is dropped", async () => {
  const dir = '/tmp/WoW Assistant';
  const worktrees = [{ worktreeId: 'folder::asst', repo: 'WoW Assistant', path: dir, agents: [] }];
  const rpc = { send: async () => { throw new Error('Session not found'); } };
  const c = new OrcaClient({ run: async () => JSON.stringify({ ok: true, result: { worktrees } }), rpc, pollMs: 60000 });
  c.stopped = false;
  c.lastRuntimeCheck = Date.now();
  await c.poll();
  c.pollSoon = () => {};
  const id = c.pin(SID, { title: 'WoW Assistant', path: dir });
  const t = c.threads.get(id);
  assert.equal(t.title, 'WoW Assistant');
  assert.equal(t._orca.sessionId, SID);
  assert.equal(threadStatus(t), 'open');
  await c.poll();
  assert.ok(c.threads.has(id), 'still shown after the next poll');
  let lost = null;
  c.on('pin-lost', (sid) => (lost = sid));
  await assert.rejects(c.sendMessage(id, 'hi'), /gone from Orca.*Press Ask again/);
  assert.equal(lost, SID);
  await c.poll();
  c.stop();
  assert.ok(!c.threads.has(id), 'not shown once it turned out to be gone');
});

test("while the Ask panel is open, updates carry the assistant's latest messages", async () => {
  const { Bridge } = await import('../src/bridge.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askv-'));
  const b = new Bridge({ addonsDir: dir, config: { slots: 8 }, log: () => {}, stateDir: dir });
  b.assistant.threadId = () => 'o1';
  b.t3.threads.set('o1', { id: 'o1', status: 'ready', _orca: {} });
  const messages = [];
  for (let i = 0; i < 8; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, createdAt: new Date(1000 * i).toISOString() });
  b.views.set('o1', { projection: { messages, runs: [], turnItems: [] } });
  b.client = { flags: 'o' };
  assert.equal(b.askSection(), undefined, 'not while the panel is closed');
  b.client = { flags: 'k' };
  const v = b.askSection();
  assert.equal(v.id, 'o1');
  assert.deepEqual(v.msgs.map((m) => m.r + m.t), ['um2', 'am3', 'um4', 'am5', 'um6', 'am7']);
  assert.equal(v.act, undefined);
  b.stop();
});

// A fake `gh`: what GitHub says about a PR and the repository, and every command run.
function fakeGh({ status = 'CLEAN', state = 'OPEN', draft = false, method = 'MERGE', allowed = { mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false } } = {}) {
  const calls = [];
  const gh = {
    calls,
    status,
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state, isDraft: draft, mergeStateStatus: gh.status });
      if (args[0] === 'repo') return JSON.stringify({ viewerDefaultMergeMethod: method, ...allowed });
      if (args[0] === 'pr' && args[1] === 'merge') return 'merged';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
  };
  return gh;
}

const PR_URL = 'https://github.com/acme/app/pull/31';
async function clientWithPR(gh) {
  const worktrees = [{ ...wt, linkedPR: { number: 31, state: 'open', url: PR_URL, checksStatus: 'success' }, agents: [agent({ state: 'done' })] }];
  const c = new OrcaClient({ run: async () => JSON.stringify({ ok: true, result: { worktrees } }), gh: 'gh', ghRun: gh.run, pollMs: 60000 });
  c.stopped = false;
  c.lastRuntimeCheck = Date.now();
  c.pollSoon = () => {};
  await c.poll();
  await c.prBusy;
  return c;
}

test('a PR GitHub calls CLEAN shows as ready to merge; anything else does not', async () => {
  const c = await clientWithPR(fakeGh());
  assert.equal([...c.threads.values()][0]._orca.pr.ok, true);
  for (const status of ['BLOCKED', 'UNSTABLE', 'BEHIND', 'DIRTY']) {
    const d = await clientWithPR(fakeGh({ status }));
    assert.equal([...d.threads.values()][0]._orca.pr.ok, undefined, status);
  }
  c.stop();
});

test('merging checks again first, uses the repository default, and never overrides', async () => {
  const gh = fakeGh({ method: 'SQUASH', allowed: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false } });
  const c = await clientWithPR(gh);
  const id = [...c.threads.keys()][0];
  const res = await c.mergePR(id);
  assert.equal(res.number, 31);
  const merge = gh.calls.find((a) => a[1] === 'merge');
  assert.deepEqual(merge, ['pr', 'merge', PR_URL, '--squash']);
  assert.ok(!gh.calls.flat().includes('--admin'));
  // GitHub changed its mind since the last check: no merge.
  const gh2 = fakeGh();
  const d = await clientWithPR(gh2);
  gh2.status = 'BLOCKED';
  await assert.rejects(d.mergePR([...d.threads.keys()][0]), /won't merge it without an override yet \(blocked\)/);
  assert.ok(!gh2.calls.some((a) => a[1] === 'merge'));
  c.stop();
  d.stop();
});

test("pinned agents' tabs: watch sends their conversations until the tabs hide", async () => {
  const { Bridge } = await import('../src/bridge.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const b = new Bridge({ addonsDir: dir, config: { slots: 8 }, log: () => {}, stateDir: dir });
  b.refreshView = () => {};
  b.t3.threads.set('o2', { id: 'o2', status: 'ready', _orca: {} });
  b.views.set('o2', { projection: { messages: [{ role: 'user', text: 'Fix it' }, { role: 'assistant', text: 'Fixed.' }], runs: [], turnItems: [] } });
  b.client = { flags: '' };
  assert.equal(b.chatsSection(), undefined);
  await b.runCommand({ id: 1, verb: 'watch', args: ['o2,gone'] });
  const chats = b.chatsSection();
  assert.deepEqual(Object.keys(chats), ['o2'], 'only threads that exist');
  assert.deepEqual(chats.o2.msgs.map((m) => m.r + m.t), ['uFix it', 'aFixed.']);
  await b.runCommand({ id: 2, verb: 'watch', args: [] });
  assert.equal(b.chatsSection(), undefined);
  b.stop();
});
