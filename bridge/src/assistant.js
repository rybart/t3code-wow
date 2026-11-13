// The WoW Assistant: one Orca chat, in a workspace of its own, that answers questions
// about the game from inside it. Its instructions (assistant/CLAUDE.md, written into the
// workspace on start) tell it where the game's settings live and how to take a
// screenshot. The game opens it like any other agent; this only makes sure it exists.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '..', 'assistant', 'CLAUDE.md');
export const ASSISTANT_NAME = 'WoW Assistant';

// The instructions with this install's paths filled in.
export function renderInstructions({ wowDir, screenshotCmd }, template = fs.readFileSync(TEMPLATE, 'utf8')) {
  return template.replaceAll('{{WOW_DIR}}', wowDir || '(not found: ask the player where the game is installed)').replaceAll('{{SCREENSHOT_CMD}}', screenshotCmd);
}

export class Assistant {
  // orca: the OrcaClient. persist: the bridge's saved state, where the chat's session id
  // is kept. save: persists it.
  constructor({ orca, dir, wowDir, screenshotCmd, persist, save = () => {}, log = () => {} }) {
    this.orca = orca;
    this.dir = dir;
    this.wowDir = wowDir;
    this.screenshotCmd = screenshotCmd;
    this.persist = persist;
    this.save = save;
    this.log = log;
    this.ready = null;
    this.text = renderInstructions({ wowDir, screenshotCmd });
    // An agent reads its instructions when its chat starts, so a chat started on older
    // ones is replaced by a fresh chat on the next Ask.
    this.version = createHash('sha256').update(this.text).digest('hex').slice(0, 12);
    // Orca lists a chat only once it has a message: keep showing ours until then.
    if (this.sessionId) this.orca.pin?.(this.sessionId, { title: ASSISTANT_NAME, path: this.dir });
    this.orca.on?.('pin-lost', (sid) => {
      if (sid !== this.persist.assistant?.sessionId) return;
      delete this.persist.assistant;
      this.save();
      this.log(`the ${ASSISTANT_NAME} chat is gone from Orca; the next Ask starts a new one`);
    });
  }

  get sessionId() {
    const a = this.persist.assistant;
    return a?.sessionId && a.version === this.version ? a.sessionId : null;
  }

  // The assistant's thread id, while Orca still lists its chat.
  threadId() {
    const sid = this.sessionId;
    if (!sid) return null;
    for (const t of this.orca.threads.values()) if (t._orca?.sessionId === sid) return t.id;
    return null;
  }

  // The folder, its instructions, and Orca knowing it as a workspace. Once per run.
  prepare() {
    this.ready ||= this.prepareNow().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async prepareNow() {
    fs.mkdirSync(this.dir, { recursive: true });
    const text = this.text;
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(this.dir, name);
      let old = null;
      try {
        old = fs.readFileSync(file, 'utf8');
      } catch {}
      if (old !== text) fs.writeFileSync(file, text);
    }
    const repos = await this.orca.call(['repo', 'list']);
    const list = Array.isArray(repos) ? repos : repos?.repos || [];
    const real = fs.realpathSync(this.dir);
    if (!list.some((r) => r.path === this.dir || r.path === real)) {
      await this.orca.call(['repo', 'add', '--path', this.dir, '--kind', 'folder']);
      this.log(`added the ${ASSISTANT_NAME} workspace to Orca: ${this.dir}`);
    }
  }

  // The assistant's thread, starting its chat when there isn't one. With `text`, a new
  // chat starts on it (an existing one gets it as a message from the game instead).
  async open(text = '', attachments = []) {
    const existing = this.threadId();
    if (existing) {
      if (text) await this.orca.sendMessage(existing, text, 'auto', attachments);
      return existing;
    }
    await this.prepare();
    // Screenshots can't ride on a launch, so a new chat gets their paths to read.
    const paths = attachments.map((a) => a.path).filter(Boolean);
    const prompt = [text, ...paths.map((p) => `Screenshot of the game: ${p}`)].filter(Boolean).join('\n\n');
    const { sessionId, threadId } = await this.orca.launchChat(this.dir, prompt);
    this.persist.assistant = { sessionId, version: this.version, startedAt: Date.now() };
    this.save();
    this.orca.pin?.(sessionId, { title: ASSISTANT_NAME, path: this.dir });
    try {
      await this.orca.call(['chat', 'rename', '--session', sessionId, '--name', ASSISTANT_NAME]);
    } catch (err) {
      this.log(`couldn't name the assistant chat: ${err.message}`);
    }
    this.log(`started the ${ASSISTANT_NAME} chat (${sessionId})`);
    return threadId;
  }
}
