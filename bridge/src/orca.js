// Client for Orca (the agent development environment), behind the same interface as
// T3Client, so the bridge and fleet treat it as one more T3 Code machine.
//
// Orca has no public live API, so this polls `orca worktree ps --json` and turns each
// agent Orca lists into a T3-shaped thread, and each worktree into a T3-shaped
// project. Thread and project ids are short hashes of Orca's pane keys and worktree
// ids, which run to 100+ characters and would crowd the addon's hello frame.
//
// Chat agents are read and written through Orca's runtime chat API (orca-rpc.js): the
// transcript, replies, Stop, approvals and questions. Terminal agents are watch only.
// Settling, snoozing, archiving and model changes have no Orca equivalent and throw a
// plain "not available" error the game shows.

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrcaRpc, sessionIdOf, paneKeyOf } from './orca-rpc.js';

// Where screenshots from the game are kept for Orca to read, and how many.
const SHOT_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 't3code-wow', 'shots');
const KEEP_SHOTS = 30;

export const POLL_MS = 2000;
// The Orca build the chat API calls were checked against, and the runtime capabilities
// they rely on. A newer Orca is fine as long as it still has these and a read works.
export const CHECKED_ORCA = '1.4.256';
export const NEEDED_CAPABILITIES = ['agent-session.structured.v1', 'agent-session.queued-messages.v2', 'agent-session.question-answers.v1'];
const RUNTIME_CHECK_MS = 10 * 60 * 1000;
const MAC_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca';

// The agents the game's model picker offers. Each is one "provider" with one model,
// "default", meaning whatever model Orca's settings start that agent with.
export const AGENTS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
];
export const DEFAULT_MODEL = 'default';

const shortId = (prefix, raw) => prefix + createHash('sha1').update(String(raw)).digest('hex').slice(0, 12);
const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);

// The `orca` command: ORCA_CLI, else the one on PATH, else the macOS app's own copy.
// A launchd service doesn't get the login shell's PATH, so the fallback matters.
export function findOrcaCli(env = process.env) {
  if (env.ORCA_CLI) return env.ORCA_CLI;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, process.platform === 'win32' ? 'orca.cmd' : 'orca');
    if (fs.existsSync(p)) return p;
  }
  return fs.existsSync(MAC_CLI) ? MAC_CLI : null;
}

function firstLine(text, max = 60) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || '';
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

// What an agent is doing right now, as a T3 turn item, so the bridge's activity label
// reads "Running npm test" or "Using Read" as it does for T3 threads.
function toolItem(agent) {
  if (!agent.toolName) return null;
  const input = agent.toolInput;
  const command = typeof input === 'string' ? input : input?.command;
  if (/^(bash|shell|exec|command)/i.test(agent.toolName) && command) {
    return { runId: 'run', type: 'command_execution', status: 'running', input: String(command) };
  }
  const file = typeof input === 'object' && input ? input.file_path || input.path : null;
  if (/^(edit|write|multiedit|apply_patch)/i.test(agent.toolName) && file) {
    return { runId: 'run', type: 'file_change', status: 'running', fileName: String(file) };
  }
  return { runId: 'run', type: 'dynamic_tool', status: 'running', toolName: agent.toolName };
}

// One Orca agent as a T3 thread. Orca's four states map onto what threadStatus()
// in t3.js reads: working runs, blocked and waiting need the player, done is open
// (or failed or stopped, by its outcome).
export function agentToThread(agent, worktree, ids) {
  const id = ids.thread(agent.paneKey);
  // Orca's top-level state stays "working" while anything the agent started still
  // runs, a background shell command included. The main agent's own state says
  // whether its turn is over, which is what the game shows, as T3 Code does.
  const state = agent.mainAgent?.state || agent.state;
  const outcome = agent.mainAgent?.outcome;
  const startedAt = iso(agent.mainAgent?.stateStartedAt || agent.stateStartedAt);
  // Subagents still running after the turn ends: the thread waits on them. Background
  // commands don't count, as in T3 Code's sidebar.
  const subagents = (agent.children || []).filter((c) => c?.kind === 'subagent' && c.state === 'working');
  const updatedAt = iso(agent.updatedAt) || startedAt;
  const title = agent.conversationName || agent.activity?.title || agent.taskTitle || agent.displayName || firstLine(agent.prompt) || agent.agentType || 'Agent';
  const t = {
    id,
    title,
    projectId: ids.project(worktree.worktreeId),
    branch: String(worktree.branch || '').replace(/^refs\/heads\//, '') || undefined,
    modelSelection: { instanceId: agent.agentType || 'agent', model: DEFAULT_MODEL },
    createdAt: startedAt,
    updatedAt,
    status: 'ready',
    latestVisibleMessage: agent.lastAssistantMessage ? { role: 'assistant', text: agent.lastAssistantMessage } : undefined,
    // Orca's own copy of the agent, for the view and the commands.
    _orca: { paneKey: agent.paneKey, sessionId: sessionIdOf(agent.paneKey), worktreeId: worktree.worktreeId, agent, pr: prOf(worktree), issue: issueOf(worktree) },
  };
  if (agent.parentPaneKey) t.lineage = { parentThreadId: ids.thread(agent.parentPaneKey), relationshipToParent: 'subagent' };
  if (state === 'working') {
    t.status = 'running';
    t.activityRunStatus = 'running';
    t.activityRunStartedAt = startedAt;
  } else if (state === 'blocked') {
    t.pendingRuntimeRequest = { kind: 'approval' };
  } else if (state === 'waiting') {
    t.pendingRuntimeRequest = { kind: 'user_input' };
  } else {
    t.latestRunCompletedAt = startedAt;
    // Read in Orca: visited at least as late as the run ended.
    if (agent.activity?.unread !== true) t.lastVisitedAt = startedAt;
    if (outcome === 'failure') t.status = 'failed';
    else if (agent.interrupted || outcome === 'cancellation' || outcome === 'interruption') t.status = 'interrupted';
    if (subagents.length) {
      t.pendingBackgroundTasks = subagents.map((c) => ({ kind: 'subagent', awaited: true, description: c.description ? `Waiting on ${firstLine(c.description, 50)}` : 'Waiting on a subagent' }));
    }
  }
  return t;
}

// The workspace's linked pull request, as the game shows it: number, state and checks.
export function prOf(worktree) {
  const pr = worktree?.linkedPR;
  if (!pr?.number) return null;
  const sum = pr.checksSummary || {};
  return {
    n: pr.number,
    s: pr.isDraft ? 'draft' : pr.state || 'open',
    c: pr.checksStatus || sum.state || 'none',
    f: sum.failed || undefined,
    t: sum.total || undefined,
  };
}

// The workspace's linked issue (Linear, else GitHub), by its identifier.
export function issueOf(worktree) {
  if (worktree?.linkedLinearIssue) return String(worktree.linkedLinearIssue);
  const gh = worktree?.linkedIssue;
  return gh?.number ? `#${gh.number}` : null;
}

// One Orca worktree as a T3 project.
export function worktreeToProject(w, ids) {
  const repo = w.repo || '';
  const name = w.displayName && w.displayName !== repo ? `${repo} · ${w.displayName}` : repo || w.displayName || w.path;
  return { id: ids.project(w.worktreeId), title: name, _orca: { worktreeId: w.worktreeId, path: w.path } };
}

// What the game's thread view shows: the prompt that started the agent and its latest
// reply. Orca doesn't expose a full transcript yet.
export function projectionOf(t) {
  const a = t?._orca?.agent;
  if (!a) return { messages: [], runs: [], turnItems: [] };
  const messages = [];
  if (a.prompt) messages.push({ role: 'user', text: a.prompt, createdAt: t.createdAt });
  if (a.lastAssistantMessage) messages.push({ role: 'assistant', text: a.lastAssistantMessage, createdAt: t.updatedAt });
  const running = t.status === 'running';
  const item = running ? toolItem(a) : null;
  return {
    messages,
    runs: [{ id: 'run', startedAt: t.activityRunStartedAt || t.createdAt, completedAt: running ? undefined : t.latestRunCompletedAt }],
    turnItems: item ? [item] : [],
    runtimeRequests: [],
  };
}

const textOf = (body) => (body?.blocks || []).filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');

// The block the addon adds to a question for the WoW Assistant (Core/GameContext.lua):
// the agent reads it, but the game's transcript shows only the question.
export const GAME_CONTEXT_MARKER = '[Game context]';
export function withoutGameContext(text) {
  const i = text.indexOf(`\n\n${GAME_CONTEXT_MARKER}\n`);
  return i >= 0 ? text.slice(0, i) : text;
}

// The questions a question row asks: its list, or the row itself as one question, under
// the id Orca expects back (as agentSessionPromptQuestions in Orca's source).
export function promptQuestions(body) {
  if (Array.isArray(body?.questions)) return body.questions;
  return [{ id: body?.freeTextQuestionId ?? 'q1', question: body?.question, options: body?.options || [], multiSelect: false, freeTextQuestionId: body?.freeTextQuestionId }];
}

// The answer Orca takes for what the game picked: { questionId: value | [values] }, where a
// value is an option id or text the player typed.
export function answersFor(body, picked) {
  const out = [];
  for (const q of promptQuestions(body)) {
    const values = [].concat(picked[q.id] ?? []);
    if (!values.length) continue;
    const ids = new Set((q.options || []).map((o) => o.id));
    const optionIds = values.filter((v) => ids.has(v));
    const other = values.find((v) => !ids.has(v));
    out.push(other !== undefined && q.freeTextQuestionId ? { questionId: q.id, optionIds, other } : { questionId: q.id, optionIds });
  }
  return out;
}

// The approval option for the game's decision, by what each option means.
const INTENTS = { accept: ['allow_once', 'allow_always'], acceptForSession: ['allow_always', 'allow_once'], acceptAlways: ['allow_always', 'allow_once'], decline: ['reject_once', 'reject_always'] };
export function approvalOption(body, decision) {
  const options = body?.options || [];
  for (const intent of INTENTS[decision] || INTENTS.accept) {
    const o = options.find((x) => x.intent === intent);
    if (o) return o.id;
  }
  // No intents: the first option allows, the last declines.
  return (decision === 'decline' ? options.at(-1) : options[0])?.id;
}

function journalTool(item, status) {
  const body = item.body;
  const input = body.input && typeof body.input === 'object' ? body.input : {};
  const base = { runId: 'run', status, nodeId: item.itemId };
  if (/^(bash|shell|exec|command)/i.test(body.name) && input.command) return { ...base, type: 'command_execution', input: String(input.command) };
  if (/^(edit|write|multiedit|apply_patch|notebookedit)/i.test(body.name) && (input.file_path || input.path)) return { ...base, type: 'file_change', fileName: String(input.file_path || input.path) };
  return { ...base, type: 'dynamic_tool', toolName: body.name };
}

// A chat's history page as a T3 thread projection: its messages, the latest turn's tool
// calls (for the activity label and run summary), and a pending approval or question in
// the shape the bridge's pendingRequest() reads.
export function historyToProjection(page) {
  const items = [...(page?.items || [])].sort((a, b) => a.sequence - b.sequence || (a.sequenceIndex || 0) - (b.sequenceIndex || 0));
  const messages = [];
  for (const it of items) {
    const b = it.body;
    if (b?.kind !== 'message' || (b.role !== 'user' && b.role !== 'assistant')) continue;
    const text = b.role === 'user' ? withoutGameContext(textOf(b)) : textOf(b);
    if (text.trim()) messages.push({ role: b.role, text, createdAt: iso(it.observedAt), streaming: b.state === 'streaming' || undefined });
  }
  const turn = page?.latestTurn;
  const turnId = turn?.itemId;
  const turnItems = [];
  for (const it of items) {
    if (it.body?.kind !== 'tool-call') continue;
    if (turnId && it.turnScope?.turnItemId !== turnId) continue;
    turnItems.push(journalTool(it, it.body.state === 'running' ? 'running' : 'completed'));
  }
  const runtimeRequests = [];
  const prompt = items.find((it) => (it.body?.kind === 'approval' || it.body?.kind === 'question') && it.body.resolution?.state === 'pending');
  if (prompt?.body.kind === 'question') {
    runtimeRequests.push({ id: prompt.itemId, status: 'pending', kind: 'user_input' });
    turnItems.push({
      type: 'user_input_request',
      requestId: prompt.itemId,
      questions: promptQuestions(prompt.body).map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        multiSelect: q.multiSelect,
        allowCustomAnswer: Boolean(q.freeTextQuestionId),
        options: (q.options || []).map((o) => ({ label: o.label, description: o.description, value: o.id })),
      })),
    });
  } else if (prompt) {
    const b = prompt.body;
    runtimeRequests.push({ id: prompt.itemId, status: 'pending', kind: b.displayName || b.title || 'permission', nodeId: prompt.itemId });
    turnItems.push({ nodeId: prompt.itemId, type: 'dynamic_tool', toolName: b.title, input: b.detail || b.description || b.decisionReason || '' });
  }
  const t = turn?.turn;
  return {
    messages,
    runs: t ? [{ id: 'run', startedAt: iso(t.startedAt || t.requestedAt), completedAt: t.state === 'running' ? undefined : iso(t.completedAt) }] : [],
    turnItems,
    runtimeRequests,
  };
}

const notYet = (what) => Promise.reject(new Error(`${what} from the game isn't available with Orca yet. Use Orca for this.`));

export class OrcaClient extends EventEmitter {
  constructor({ log = () => {}, label = 'Orca', cli = findOrcaCli(), run = null, pollMs = POLL_MS, rpc = null, shotDir = SHOT_DIR } = {}) {
    super();
    this.shotDir = shotDir;
    // Orca's runtime chat API, for chat agents.
    this.rpc = rpc || new OrcaRpc();
    this.apiWarning = null; // set when an Orca update may have broken the chat API
    this.orcaVersion = null;
    this.lastRuntimeCheck = 0;
    this.fences = new Map(); // session id -> the runtime fence its last history page gave
    this.log = log;
    this.label = label;
    this.cli = cli;
    this.pollMs = pollMs;
    // Runs the CLI: (args) => Promise<stdout>. Tests pass their own.
    this.run = run || ((args) => this.exec(args));
    this.threads = new Map();
    this.projects = new Map();
    this.olderSettled = 0;
    this.state = 'disconnected';
    this.error = null;
    this.origin = null;
    this.stopped = true;
    this.timer = null;
    this.lastDigest = null;
    this.paneKeys = new Map(); // short id -> pane key
    this.worktrees = new Map(); // short id -> worktree id
    this.ids = {
      thread: (pane) => {
        const id = shortId('o', pane);
        this.paneKeys.set(id, pane);
        return id;
      },
      project: (wt) => {
        const id = shortId('w', wt);
        this.worktrees.set(id, wt);
        return id;
      },
    };
    this.config = {
      environment: { label },
      settings: {},
      providers: AGENTS.map((a) => ({ instanceId: a.id, displayName: a.name, enabled: true, models: [{ slug: DEFAULT_MODEL, name: `${a.name} (Orca default)` }] })),
    };
  }

  exec(args) {
    if (!this.cli) return Promise.reject(new Error("Couldn't find the orca command. Open Orca, or set ORCA_CLI to its path."));
    return new Promise((resolve, reject) => {
      execFile(this.cli, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(firstLine(stderr, 200) || err.message));
        else resolve(stdout);
      });
    });
  }

  async call(args) {
    const out = await this.run([...args, '--json']);
    const data = JSON.parse(out);
    if (data && data.ok === false) throw new Error(data.error?.message || 'orca reported an error');
    return data?.result ?? data;
  }

  // After an Orca update: does it still have what replies from the game need, and can
  // a chat still be read? Sets `apiWarning` (shown in game) when it can't, else clears it.
  async checkRuntime() {
    this.lastRuntimeCheck = Date.now();
    let status;
    try {
      status = await this.call(['status']);
    } catch (err) {
      return; // Orca isn't answering at all; the connection state already says so
    }
    const version = status?.runtime?.appVersion || null;
    const caps = new Set(status?.runtime?.capabilities || []);
    const missing = NEEDED_CAPABILITIES.filter((c) => !caps.has(c));
    let problem = missing.length ? `it no longer offers ${missing.join(', ')}` : null;
    if (!problem) {
      const chat = [...this.threads.values()].find((t) => t._orca?.sessionId);
      if (chat) {
        try {
          const res = await this.rpc.history(chat._orca.sessionId, 1);
          if (!Array.isArray(res?.page?.items)) problem = 'reading a chat returns something new';
        } catch (err) {
          problem = `reading a chat failed (${err.message})`;
        }
      }
    }
    const was = this.apiWarning;
    this.apiWarning = problem ? `Orca ${version || 'was updated'} changed how chats work: ${problem}. Replies from the game may fail until the bridge is updated.` : null;
    if (version !== this.orcaVersion) {
      this.log(`Orca ${version}${version === CHECKED_ORCA ? '' : ` (the bridge was checked against ${CHECKED_ORCA})`}: ${problem ? `problem: ${problem}` : 'chat API looks fine'}`);
      this.orcaVersion = version;
    }
    if (was !== this.apiWarning) this.emit('change', { kind: 'snapshot' });
  }

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }

  start() {
    this.stopped = false;
    this.setState('connecting');
    this.emit('config');
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async poll() {
    if (this.stopped) return;
    try {
      const res = await this.call(['worktree', 'ps', '--limit', '500']);
      this.apply(res?.worktrees || []);
      this.setState('connected');
      if (!this.lastRuntimeCheck || Date.now() - this.lastRuntimeCheck > RUNTIME_CHECK_MS) this.checkRuntime();
    } catch (err) {
      this.setState('offline', err.message);
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => this.poll(), this.state === 'connected' ? this.pollMs : Math.max(this.pollMs, 5000));
      this.timer.unref?.();
    }
  }

  // Replace the lists with what Orca reports now, and say what changed: a snapshot the
  // first time, then one event per thread that changed or went away.
  apply(worktrees) {
    const threads = new Map();
    const projects = new Map();
    for (const w of worktrees) {
      if (w.isArchived) continue;
      const p = worktreeToProject(w, this.ids);
      projects.set(p.id, p);
      for (const a of w.agents || []) {
        if (!a?.paneKey || a.activity?.listed === false) continue;
        const t = agentToThread(a, w, this.ids);
        threads.set(t.id, t);
      }
    }
    const first = this.lastDigest === null;
    const prevThreads = this.threads;
    const prevProjects = JSON.stringify([...this.projects.values()].map((p) => [p.id, p.title]));
    this.threads = threads;
    this.projects = projects;
    this.lastDigest = Date.now();
    if (first) {
      this.emit('change', { kind: 'snapshot' });
      return;
    }
    for (const [id, t] of threads) {
      const prev = prevThreads.get(id);
      if (!prev || threadKey(prev) !== threadKey(t)) this.emit('change', { kind: 'thread', id, prev, thread: t });
    }
    for (const id of prevThreads.keys()) if (!threads.has(id)) this.emit('change', { kind: 'removed', id });
    if (JSON.stringify([...projects.values()].map((p) => [p.id, p.title])) !== prevProjects) this.emit('change', { kind: 'project' });
  }

  // ---- reads ---------------------------------------------------------------

  // A chat agent's whole transcript from Orca's runtime; a terminal agent's prompt and
  // latest reply from the last poll.
  async threadProjection(threadId) {
    const t = this.threads.get(threadId);
    const sid = t?._orca?.sessionId;
    if (!sid) return projectionOf(t);
    const page = await this.historyPage(sid);
    return historyToProjection(page);
  }

  async historyPage(sid) {
    const res = await this.rpc.history(sid);
    const page = res?.page;
    if (!page) throw new Error('Orca sent no history for that chat');
    if (page.fence) this.fences.set(sid, page.fence);
    return page;
  }

  // The chat behind a thread, or a plain error for a terminal agent.
  chat(threadId, what) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error('That agent is gone from Orca.');
    const sid = t._orca?.sessionId;
    if (!sid) throw new Error(`${what} a terminal agent from the game isn't available yet. Use Orca for this one.`);
    return { t, sid, fence: this.fences.get(sid) };
  }

  // A pending approval or question row, read fresh: its revision guards the answer.
  async pendingPrompt(sid, itemId, kind) {
    const page = await this.historyPage(sid);
    const item = (page.items || []).find((it) => it.itemId === itemId);
    if (!item || item.body?.kind !== kind) throw new Error('That request is gone. It may have been answered in Orca.');
    if (item.body.resolution?.state !== 'pending') throw new Error('That was already answered in Orca.');
    return { item, fence: page.fence };
  }

  pollSoon() {
    clearTimeout(this.timer);
    if (!this.stopped) this.poll();
  }

  defaultModelFor() {
    return { instanceId: AGENTS[0].id, model: DEFAULT_MODEL };
  }

  // ---- writes --------------------------------------------------------------

  // Starts an agent in the worktree as a chat.
  async launchThread(projectId, text, attachments = [], opts = {}) {
    if (opts.worktree) throw new Error('Starting in a new worktree from the game isn\'t available with Orca yet. Pick an existing worktree.');
    const worktreeId = this.worktrees.get(projectId);
    if (!worktreeId) throw new Error('That worktree is gone from Orca. Pick another.');
    const agent = AGENTS.find((a) => a.id === opts.model?.instanceId)?.id || AGENTS[0].id;
    // As a chat: chats can be read and replied to from the game through Orca's runtime.
    // Screenshots can't ride on a launch, so the new chat gets their paths to read.
    const paths = attachments.map((a) => a.path).filter(Boolean);
    const prompt = [text, ...paths.map((p) => `Screenshot of the game: ${p}`)].join('\n\n');
    const args = ['agent', 'launch', '--agent', agent, '--worktree', `id:${worktreeId}`, '--surface', 'chat', '--prompt', prompt];
    if (opts.model?.model && opts.model.model !== DEFAULT_MODEL) {
      args.push('--model', opts.model.model);
      if (opts.effort) args.push('--effort', opts.effort);
    }
    const res = await this.call(args);
    // The new agent shows up on the next poll; ask for it now rather than in 2 s.
    this.pollSoon();
    // A chat's id is known now, so the game can open it straight away.
    const sid = res?.outcome?.sessionId;
    return sid ? { threadId: this.ids.thread(paneKeyOf(sid)) } : {};
  }

  visit() {
    return Promise.resolve();
  }

  // `mode` 'steer' sends into a running turn, as the player's setting asks; otherwise a
  // message to a busy agent waits for its turn to end.
  // attachments: what uploadImage returned, { path }.
  async sendMessage(threadId, text, mode = 'auto', attachments = []) {
    const { sid, fence } = this.chat(threadId, 'Replying to');
    const images = attachments.map((a) => a.path).filter(Boolean);
    await this.rpc.send(sid, text, { queue: mode !== 'steer', fence, images });
    this.pollSoon();
    return {};
  }

  async interrupt(threadId) {
    const { sid, fence } = this.chat(threadId, 'Stopping');
    await this.rpc.cancel(sid, { fence });
    this.pollSoon();
    return {};
  }

  // decision: accept | acceptForSession | acceptAlways | decline, as the game's buttons send.
  async respondApproval(threadId, requestId, decision) {
    const { sid } = this.chat(threadId, 'Approving for');
    const { item, fence } = await this.pendingPrompt(sid, requestId, 'approval');
    const optionId = approvalOption(item.body, decision);
    if (!optionId) throw new Error('Orca offered no option to pick for that request.');
    await this.rpc.respondToApproval(sid, item.itemId, item.revision, optionId, { fence });
    this.pollSoon();
    return {};
  }

  // answers: { questionId: value | [values] }, a value an option id or typed text.
  async respondAnswers(threadId, requestId, picked) {
    const { sid } = this.chat(threadId, 'Answering');
    const { item, fence } = await this.pendingPrompt(sid, requestId, 'question');
    const answers = answersFor(item.body, picked);
    if (!answers.length) throw new Error('Pick an answer first.');
    await this.rpc.respondToQuestion(sid, item.itemId, item.revision, { answers }, { fence });
    this.pollSoon();
    return {};
  }

  setModel() {
    return notYet('Changing the model');
  }

  settle() {
    return notYet('Settling');
  }

  unsettle() {
    return notYet('Reopening');
  }

  snooze() {
    return notYet('Snoozing');
  }

  unsnooze() {
    return notYet('Waking');
  }

  archive() {
    return notYet('Archiving');
  }

  // A screenshot from the game, saved where Orca (and the agent) can read it.
  async uploadImage(data, name, mime) {
    fs.mkdirSync(this.shotDir, { recursive: true });
    const ext = mime === 'image/jpeg' ? '.jpg' : '.png';
    const file = path.join(this.shotDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}${ext}`);
    fs.writeFileSync(file, data);
    // Keep the newest few: old screenshots only take room.
    const old = fs.readdirSync(this.shotDir).sort().slice(0, -KEEP_SHOTS);
    for (const f of old) fs.rmSync(path.join(this.shotDir, f), { force: true });
    return { path: file, name, mime };
  }

  // Starts a chat agent in a folder (registered with Orca), optionally with a first
  // message. Returns its session and thread ids.
  async launchChat(dir, text = '', agent = AGENTS[0].id) {
    const args = ['agent', 'launch', '--agent', agent, '--worktree', `path:${dir}`, '--surface', 'chat'];
    if (text) args.push('--prompt', text);
    const res = await this.call(args);
    const sessionId = res?.outcome?.sessionId;
    if (!sessionId) throw new Error(`Orca didn't start a chat there (${res?.receipt?.detail || res?.outcome?.kind || 'no session'})`);
    this.pollSoon();
    return { sessionId, threadId: this.ids.thread(paneKeyOf(sessionId)) };
  }
}

// What the game shows of a thread, to tell a real change from a poll that found the
// same thing.
function threadKey(t) {
  const a = t._orca.agent;
  return JSON.stringify([t.title, t.status, t.pendingRuntimeRequest?.kind, t.pendingBackgroundTasks?.length, t.updatedAt, t.lastVisitedAt, a.toolName, a.lastAssistantMessage?.length, t._orca.pr, t._orca.issue]);
}
