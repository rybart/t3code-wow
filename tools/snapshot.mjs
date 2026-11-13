// Build a real snapshot from the running T3 Code server and write it as a slot file,
// without touching the game. Used by tools/smoke.lua and for eyeballing payloads.
//   node tools/snapshot.mjs [out.lua] [--view <threadId|first>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../bridge/src/bridge.js';
import { luaAssignment } from '../bridge/src/luaser.js';

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/tmp/t3snap.lua';
const viewArg = process.argv.includes('--view') ? process.argv[process.argv.indexOf('--view') + 1] : 'first';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3snap-'));
const bridge = new Bridge({ addonsDir: tmp, config: {}, log: () => {}, stateDir: tmp });
bridge.t3.start();
await new Promise((r) => setTimeout(r, 2500));
// A top-level thread: a subagent isn't in the list unless it's busy, and the smoke test needs the view's row.
const threads = [...bridge.t3.threads.values()].filter((t) => !t.lineage?.parentThreadId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
const viewId = viewArg === 'first' ? threads[0]?.id : viewArg;
bridge.client = { session: 'test', ui: 'test', seq: 1, ackedSeq: -1, flags: 'o', view: viewId, slotNext: 1 };
for (const t of threads.slice(0, 6)) await bridge.refreshView(t.id, true);
await bridge.refreshView(viewId, true);
const snap = { v: 1, gen: Date.now(), now: Math.floor(Date.now() / 1000), nextSig: 2, ack: { ui: 'test', seq: 1 }, key: bridge.stripKeys.hex, ...bridge.buildSnapshot() };
const buf = luaAssignment('Orca_Inbox', snap);
fs.writeFileSync(out, buf);
console.log(`wrote ${out}: ${buf.length} bytes, ${snap.threads.length} threads, view ${viewId} (${snap.view?.msgs?.length ?? 0} messages)`);
fs.writeFileSync(out.replace(/\.lua$/, '.view'), viewId || '');
bridge.t3.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
