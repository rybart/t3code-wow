// Orca's runtime RPC, over the same local socket the `orca` CLI uses: the chat API
// (`agentSession.*`) that Orca's own desktop, mobile and remote clients call.
//
// This is Orca's private API, read from its MIT source (github.com/stablyai/orca), not a
// published contract. Requests are strict: an unknown key is refused. Checked against
// Orca 1.4.256.
//
//   discovery  ~/Library/Application Support/orca/orca-runtime.json (mode 0600): the
//              owner token and the socket. Re-read on every call: both change when Orca
//              restarts.
//   wire       one JSON line per request, {id, authToken, method, params}; the reply is
//              one line {id, ok, result | error}. Long calls may send {_keepalive:true}.
//   writes     carry a mutation envelope whose payloadFingerprint is the sha256 of a
//              canonical JSON {method, sessionId, fields} (keys sorted, undefined dropped),
//              which Orca recomputes and refuses on mismatch.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function orcaUserDataDir(env = process.env) {
  if (env.ORCA_USER_DATA_PATH) return env.ORCA_USER_DATA_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'orca');
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'orca');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca');
}

export function readRuntime(dir = orcaUserDataDir()) {
  const file = path.join(dir, 'orca-runtime.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sock = (meta.transports || []).find((t) => t.kind === 'unix' || t.kind === 'named-pipe')?.endpoint;
  if (!meta.authToken || !sock) throw new Error(`no socket or token in ${file}; is Orca running?`);
  return { token: meta.authToken, socket: sock, runtimeId: meta.runtimeId };
}

// Orca's canonical form: keys sorted, undefined left out, everything else as JSON.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function fingerprint(method, sessionId, fields) {
  return createHash('sha256').update(canonicalize({ method, sessionId, fields })).digest('hex');
}

// A fresh operation id: Orca refuses one over 24 hours old or reused with other content.
export function operationId(now = Date.now()) {
  return `${now}-${randomUUID().replaceAll('-', '')}`;
}

export function envelope(method, sessionId, fields, fence) {
  return { sessionId, clientOperationId: operationId(), expectedRuntimeFence: fence || 1, payloadFingerprint: fingerprint(method, sessionId, fields) };
}

// The chat session behind a pane key from `orca worktree ps`, or null for a terminal agent.
export function sessionIdOf(paneKey) {
  const m = /^structured-agent-session-([A-Za-z0-9_-]{8,128}):/.exec(String(paneKey || ''));
  return m ? m[1] : null;
}

// The pane key `orca worktree ps` lists a chat under: its session id and a UUID made from
// the first 16 bytes of the id's sha256, version nibble 4 and variant a.
export function paneKeyOf(sessionId) {
  const h = createHash('sha256').update(sessionId).digest('hex').slice(0, 32).split('');
  h[12] = '4';
  h[16] = 'a';
  const x = h.join('');
  return `structured-agent-session-${sessionId}:${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export class OrcaRpc {
  constructor({ dir = orcaUserDataDir(), timeout = 20000, connect = net.createConnection } = {}) {
    this.dir = dir;
    this.timeout = timeout;
    this.connect = connect;
  }

  // One request per connection: connect, write one line, read until our reply.
  call(method, params) {
    const { token, socket } = readRuntime(this.dir);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const c = this.connect(socket);
      let buf = '';
      const done = (fn, v) => {
        clearTimeout(timer);
        c.destroy();
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error(`Orca didn't answer ${method} in time`)), this.timeout);
      c.on('connect', () => c.write(JSON.stringify({ id, authToken: token, method, params }) + '\n'));
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== id) continue;
          if (msg.ok === false) return done(reject, new Error(msg.error?.message || msg.error?.code || `${method} failed`));
          // A write Orca turned down comes back as a result with a refusal.
          const r = msg.result;
          if (r && r.ok === false && r.refusal) return done(reject, new Error(r.refusal.message || r.refusal.code || `${method} was refused`));
          return done(resolve, r);
        }
      });
      c.on('error', (err) => done(reject, new Error(`couldn't reach Orca (${err.code || err.message}); is it running?`)));
      c.on('close', () => done(reject, new Error(`Orca closed the connection during ${method}`)));
    });
  }

  history(sessionId, limit = 200) {
    return this.call('agentSession.history', { sessionId, direction: 'tail', limit });
  }

  item(sessionId, itemId) {
    return this.call('agentSession.item', { sessionId, itemId });
  }

  // `queue`: when the agent is mid-turn, hold the message until the turn ends instead of
  // steering it into the running turn.
  // `images`: local file paths, sent as image blocks ahead of the text.
  send(sessionId, text, { queue = false, fence, images = [] } = {}) {
    const blocks = [...images.map((p) => ({ type: 'image-ref', path: p })), ...(text ? [{ type: 'text', text }] : [])];
    const body = { kind: 'message', role: 'user', blocks };
    const fields = { body, delivery: queue ? 'queue-if-active' : undefined };
    return this.call('agentSession.send', { ...fields, envelope: envelope('agentSession.send', sessionId, fields, fence) });
  }

  cancel(sessionId, { fence } = {}) {
    return this.call('agentSession.cancel', { envelope: envelope('agentSession.cancel', sessionId, {}, fence) });
  }

  respondToApproval(sessionId, itemId, expectedRevision, optionId, { fence } = {}) {
    const fields = { itemId, expectedRevision, optionId, answers: undefined };
    return this.call('agentSession.respondToApproval', { itemId, expectedRevision, optionId, envelope: envelope('agentSession.respondTo:approval', sessionId, fields, fence) });
  }

  // Exactly one of `optionId` (a single question, one option) or `answers`.
  respondToQuestion(sessionId, itemId, expectedRevision, { optionId, answers }, { fence } = {}) {
    const fields = { itemId, expectedRevision, optionId, answers };
    const params = { itemId, expectedRevision, envelope: envelope('agentSession.respondTo:question', sessionId, fields, fence) };
    if (optionId !== undefined) params.optionId = optionId;
    else params.answers = answers;
    return this.call('agentSession.respondToQuestion', params);
  }
}
