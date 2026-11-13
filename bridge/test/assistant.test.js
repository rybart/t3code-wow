import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant, renderInstructions, ASSISTANT_NAME } from '../src/assistant.js';

test("the instructions name this install's game folder and screenshot command", () => {
  const text = renderInstructions({ wowDir: '/Games/WoW/_forever_', screenshotCmd: 'shoot' });
  assert.ok(text.includes('/Games/WoW/_forever_/WTF/Config.wtf'));
  assert.ok(text.includes('run `shoot`'));
  assert.ok(!text.includes('{{'));
});

function fakeOrca() {
  const calls = [];
  const orca = {
    calls,
    threads: new Map(),
    repos: [],
    call: async (args) => {
      calls.push(args);
      if (args[0] === 'repo' && args[1] === 'list') return orca.repos;
      return {};
    },
    launchChat: async (dir, text) => {
      calls.push(['launchChat', dir, text]);
      orca.threads.set('o1', { id: 'o1', _orca: { sessionId: 'claude_aaaaaaaa' } });
      return { sessionId: 'claude_aaaaaaaa', threadId: 'o1' };
    },
    sendMessage: async (id, text, mode, attachments) => calls.push(['send', id, text, attachments.length]),
  };
  return orca;
}

test('the first Ask prepares the workspace and starts a named chat; later ones message it', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asst-')), ASSISTANT_NAME);
  const orca = fakeOrca();
  const persist = {};
  let saved = 0;
  const a = new Assistant({ orca, dir, wowDir: '/Games/WoW', screenshotCmd: 'shoot', persist, save: () => saved++ });
  assert.equal(a.threadId(), null);

  const id = await a.open('Why so dark?', [{ path: '/tmp/shot.png' }]);
  assert.equal(id, 'o1');
  assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('/Games/WoW/WTF/Config.wtf'));
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.ok(orca.calls.some((c) => c[0] === 'repo' && c[1] === 'add' && c.includes(dir)));
  const launch = orca.calls.find((c) => c[0] === 'launchChat');
  assert.equal(launch[2], 'Why so dark?\n\nScreenshot of the game: /tmp/shot.png');
  assert.ok(orca.calls.some((c) => c[0] === 'chat' && c.includes(ASSISTANT_NAME)));
  assert.equal(persist.assistant.sessionId, 'claude_aaaaaaaa');
  assert.equal(saved, 1);

  assert.equal(await a.open('And gamma?'), 'o1');
  assert.deepEqual(orca.calls.at(-1), ['send', 'o1', 'And gamma?', 0]);
  assert.equal(orca.calls.filter((c) => c[0] === 'launchChat').length, 1);
});

test("a chat closed in Orca is started again; a workspace Orca knows isn't added twice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-'));
  const orca = fakeOrca();
  orca.repos = [{ path: dir }];
  const a = new Assistant({ orca, dir, wowDir: '/Games/WoW', screenshotCmd: 'shoot', persist: { assistant: { sessionId: 'claude_gone0000' } } });
  a.persist.assistant.version = a.version;
  assert.equal(a.threadId(), null);
  await a.open();
  assert.ok(!orca.calls.some((c) => c[0] === 'repo' && c[1] === 'add'));
  assert.equal(orca.calls.find((c) => c[0] === 'launchChat')[2], '');
});

test('a chat started on older instructions is replaced by a fresh one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-'));
  const orca = fakeOrca();
  orca.threads.set('old', { id: 'old', _orca: { sessionId: 'claude_old00000' } });
  const persist = { assistant: { sessionId: 'claude_old00000', version: 'older' } };
  const a = new Assistant({ orca, dir, wowDir: '/Games/WoW', screenshotCmd: 'shoot', persist });
  assert.equal(a.threadId(), null);
  assert.equal(await a.open('hi'), 'o1');
  assert.equal(persist.assistant.version, a.version);
});
