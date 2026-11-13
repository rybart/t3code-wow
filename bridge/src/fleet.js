// Several T3 Code machines behind the single-client interface the bridge uses.
//
// Thread and project ids are made unique across machines: the local machine keeps
// raw ids (so existing views and saved state stay valid), other machines' ids get
// a short prefix ("e1~<id>"). Every thread/project object handed out is a shallow
// copy with `id`/`projectId` and the lineage ids rewritten, `_env` pointing at its
// machine and `_from` saying which thread it came from (see `from`).

import { EventEmitter } from 'node:events';
import { T3Client, modelChoices } from './t3.js';
import { remoteTokenProvider, remoteOriginProvider } from './envs.js';

const SEP = '~';

export class Fleet extends EventEmitter {
  // `localClient` replaces this machine's T3 Code client (the Orca fork passes an
  // OrcaClient); it needs the same events and methods as T3Client.
  constructor({ localTokens, localClient = null, environments = [], log = () => {} }) {
    super();
    this.log = log;
    this.envs = [];
    this.threads = new Map();
    this.projects = new Map();
    // This machine's T3 environment id, known once its config arrives.
    this.localEnvironmentId = null;
    const local = { code: '', id: 'local', label: 'local', local: true };
    local.client = localClient || new T3Client({ tokenProvider: localTokens, log, label: 'local' });
    local.tokens = localTokens;
    this.envs.push(local);
    for (const e of environments) {
      if (e.disabled) continue;
      const env = { code: e.code, id: e.id, label: e.label, local: false, config: e };
      env.tokens = remoteTokenProvider(e, { log, label: 'WoW bridge' });
      env.client = new T3Client({ tokenProvider: env.tokens, originProvider: remoteOriginProvider(e), log, label: e.label });
      this.envs.push(env);
    }
    for (const env of this.envs) this.wire(env);
  }

  get local() {
    return this.envs[0];
  }

  key(env, id) {
    return env.code ? `${env.code}${SEP}${id}` : id;
  }

  split(key) {
    const k = String(key || '');
    const i = k.indexOf(SEP);
    if (i > 0) {
      const env = this.envs.find((e) => e.code === k.slice(0, i));
      if (env) return { env, id: k.slice(i + 1) };
    }
    return { env: this.local, id: k };
  }

  wrapThread(env, t) {
    const lineage = t.lineage && {
      ...t.lineage,
      parentThreadId: t.lineage.parentThreadId ? this.key(env, t.lineage.parentThreadId) : t.lineage.parentThreadId,
      rootThreadId: t.lineage.rootThreadId ? this.key(env, t.lineage.rootThreadId) : t.lineage.rootThreadId,
    };
    return { ...t, id: this.key(env, t.id), projectId: this.key(env, t.projectId), lineage, _env: env, _from: this.from(env, t) };
  }

  // The thread `t` came from, as { key, kind, env, title }: the thread it forked off
  // or was started by on its own machine, else the one another machine sent it from.
  // `key` is null for a sender on a machine this bridge doesn't know. `forkedFrom`
  // isn't used: for subagents it names a node in the parent's turn, not a thread.
  from(env, t) {
    const parent = t.lineage?.parentThreadId;
    if (parent) {
      const kind = t.lineage.sideChat ? 'side' : t.lineage.relationshipToParent === 'fork' ? 'fork' : 'sub';
      return { key: this.key(env, parent), kind, env };
    }
    const sent = t.delegatedFrom;
    if (!sent) return null;
    const sender = sent.environmentId ? this.envs.find((e) => (e.local ? this.localEnvironmentId : e.id) === sent.environmentId) : undefined;
    return { key: sender ? this.key(sender, sent.threadId) : null, kind: 'sent', env: sender, title: sent.title };
  }

  label(env) {
    return env.local ? env.client.config?.environment?.label || 'this computer' : env.label;
  }

  wrapProject(env, p) {
    return { ...p, id: this.key(env, p.id), _env: env };
  }

  rebuild(env) {
    for (const [k, t] of this.threads) if (t._env === env) this.threads.delete(k);
    for (const [k, p] of this.projects) if (p._env === env) this.projects.delete(k);
    for (const t of env.client.threads.values()) {
      const w = this.wrapThread(env, t);
      this.threads.set(w.id, w);
    }
    for (const p of env.client.projects.values()) {
      const w = this.wrapProject(env, p);
      this.projects.set(w.id, w);
    }
  }

  wire(env) {
    const c = env.client;
    c.on('state', (s, e) => {
      if (!env.local) this.log(`${env.label}: ${s}${e ? ` (${e})` : ''}`);
      this.emit('state', this.state, this.error, env);
    });
    c.on('unauthorized', () => env.tokens.invalidate?.());
    c.on('config', () => {
      const id = env.local && c.config?.environment?.environmentId;
      if (id && id !== this.localEnvironmentId) {
        // Threads sent from this machine name it by this id, which can arrive after them.
        this.localEnvironmentId = id;
        for (const [k, t] of this.threads) {
          const raw = t.delegatedFrom && t._env.client.threads.get(this.split(k).id);
          if (raw) this.threads.set(k, this.wrapThread(t._env, raw));
        }
      }
      this.emit('config', env);
    });
    c.on('change', (ev) => {
      if (ev.kind === 'thread') {
        const thread = this.wrapThread(env, ev.thread);
        this.threads.set(thread.id, thread);
        this.emit('change', { kind: 'thread', id: thread.id, thread, prev: ev.prev ? this.wrapThread(env, ev.prev) : undefined, env });
      } else if (ev.kind === 'removed') {
        this.threads.delete(this.key(env, ev.id));
        this.emit('change', { kind: 'removed', id: this.key(env, ev.id), env });
      } else {
        this.rebuild(env);
        this.emit('change', { kind: ev.kind, env });
      }
    });
    // A machine that drops off takes its threads with it.
    c.on('state', (s) => {
      if (s === 'offline' && !env.local) {
        for (const [k, t] of this.threads) if (t._env === env) this.threads.delete(k);
        for (const [k, p] of this.projects) if (p._env === env) this.projects.delete(k);
        this.emit('change', { kind: 'snapshot', env });
      }
    });
  }

  start() {
    for (const env of this.envs) env.client.start();
  }

  stop() {
    for (const env of this.envs) env.client.stop();
  }

  // The local machine decides "connected" for the link indicator; others report
  // separately in `environments()`.
  get state() {
    return this.local.client.state;
  }

  get error() {
    return this.local.client.error;
  }

  get origin() {
    return this.local.client.origin;
  }

  get config() {
    return this.local.client.config;
  }

  get olderSettled() {
    return this.envs.reduce((n, e) => n + (e.client.olderSettled || 0), 0);
  }

  environments() {
    return this.envs.map((e) => ({
      code: e.code,
      label: this.label(e),
      local: e.local || undefined,
      state: e.client.state,
      error: e.client.error || undefined,
      threads: [...e.client.threads.values()].filter((t) => !t.lineage?.parentThreadId).length,
    }));
  }

  // ---- reads and writes, routed by id ------------------------------------------

  threadProjection(key) {
    const { env, id } = this.split(key);
    return env.client.threadProjection(id);
  }

  sendMessage(key, text, mode, attachments) {
    const { env, id } = this.split(key);
    return env.client.sendMessage(id, text, mode, attachments);
  }

  uploadImage(key, data, name, mime) {
    const { env } = this.split(key);
    return env.client.uploadImage(data, name, mime);
  }

  async launchThread(projectKey, text, attachments, opts) {
    const { env, id } = this.split(projectKey);
    const res = await env.client.launchThread(id, text, attachments, opts);
    if (res?.threadId) res.threadId = this.key(env, res.threadId);
    return res;
  }

  interrupt(key) {
    const { env, id } = this.split(key);
    return env.client.interrupt(id);
  }

  respondApproval(key, requestId, decision) {
    const { env, id } = this.split(key);
    return env.client.respondApproval(id, requestId, decision);
  }

  respondAnswers(key, requestId, answers) {
    const { env, id } = this.split(key);
    return env.client.respondAnswers(id, requestId, answers);
  }

  settle(key) {
    const { env, id } = this.split(key);
    return env.client.settle(id);
  }

  unsettle(key) {
    const { env, id } = this.split(key);
    return env.client.unsettle(id);
  }

  snooze(key, until) {
    const { env, id } = this.split(key);
    return env.client.snooze(id, until);
  }

  unsnooze(key) {
    const { env, id } = this.split(key);
    return env.client.unsnooze(id);
  }

  archive(key) {
    const { env, id } = this.split(key);
    return env.client.archive(id);
  }

  visit(key) {
    const { env, id } = this.split(key);
    return env.client.visit(id);
  }

  setModel(key, instanceId, model, effort) {
    const { env, id } = this.split(key);
    return env.client.setModel(id, instanceId, model, effort);
  }

  defaultModelFor(projectKey) {
    const { env, id } = this.split(projectKey);
    return env.client.defaultModelFor(id);
  }

  // Each machine's models, keyed by its id prefix ('' for this one), and the
  // providers they came from (for their slash commands and skills).
  modelGroups() {
    return this.envs.map((env) => ({ code: env.code, choices: modelChoices(env.client.config?.providers), providers: env.client.config?.providers || [] }));
  }
}
