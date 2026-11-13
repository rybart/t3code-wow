import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveKeys, seal, open, loadOrCreateKey, OVERHEAD } from '../src/strip-crypto.js';
import { decodeImage, renderCells, MAX_PAYLOAD } from '../src/codec.js';
import { parseFrame } from '../src/bridge.js';
import { luaAssignment } from '../src/luaser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const has = (bin) => {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
// LuaJIT's bit library returns signed numbers; tools/bitstub.lua (plain Lua 5.1)
// returns unsigned ones like the game's. The addon must agree with Node under both.
const LUAS = ['lua5.1', 'luajit'].filter(has);

// The strip's cells as tools/strip_e2e.lua prints them, drawn where the addon puts them.
function drawn(cells, origin) {
  const [ox, oy] = origin.split(',').map(Number);
  return renderCells([...cells].map(Number), { cell: 3, ox, oy });
}

function luaCrypto(lua, script) {
  const prelude = `dofile("tools/bitstub.lua") local ns = {} assert(loadfile("addon/Orca/Core/Crypto.lua"))("Orca", ns) local C = ns.Crypto
local function hex(s) return C.ToHex(s) end local function raw(h) return C.FromHex(h) end `;
  return execFileSync(lua, ['-e', prelude + script], { cwd: root }).toString().trim();
}

test('strip keys: one per install, kept private', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-key-'));
  const a = loadOrCreateKey(dir);
  assert.equal(a.length, 32);
  assert.deepEqual(loadOrCreateKey(dir), a);
  // Windows has no file modes.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'strip.key')).mode & 0o777, 0o600);
  assert.equal(deriveKeys(a).hex.length, 128);
});

test('seal/open round trip; tampering, wrong keys and wrong seq fail', () => {
  const keys = deriveKeys(crypto.randomBytes(32));
  const nonce = crypto.randomBytes(12);
  const sealed = seal(keys, 77, nonce, 'H\x1f1\x1fsecret');
  assert.equal(sealed.length, 'H\x1f1\x1fsecret'.length + OVERHEAD);
  assert.equal(open(keys, 77, sealed).toString(), 'H\x1f1\x1fsecret');
  assert.equal(open(keys, 78, sealed), null);
  assert.equal(open(deriveKeys(crypto.randomBytes(32)), 77, sealed), null);
  const flipped = Buffer.from(sealed);
  flipped[14] ^= 1;
  assert.equal(open(keys, 77, flipped), null);
});

for (const lua of LUAS) {
  test(`Lua crypto matches Node (${lua})`, () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 200, 2300]) {
      const msg = crypto.randomBytes(len);
      const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]);
      const c = crypto.createCipheriv('chacha20', key, iv);
      const want = Buffer.concat([c.update(msg), c.final()]).toString('hex');
      const sha = crypto.createHash('sha256').update(msg).digest('hex');
      const mac = crypto.createHmac('sha256', key).update(msg).digest('hex');
      const out = luaCrypto(lua, `local m = raw("${msg.toString('hex')}")
        print("x" .. hex(C.ChaCha20(raw("${key.toString('hex')}"), raw("${nonce.toString('hex')}"), 1, m)))
        print(hex(C.SHA256(m)))
        print(hex(C.HMAC(raw("${key.toString('hex')}"))(m)))`).split('\n');
      assert.equal(out[0], "x" + want, `chacha20 len ${len}`);
      assert.equal(out[1], sha, `sha256 len ${len}`);
      assert.equal(out[2], mac, `hmac len ${len}`);
    }
  });

  test(`addon strip: encrypted end to end, readable only with the keys (${lua})`, () => {
    const keys = deriveKeys(crypto.randomBytes(32));
    const slot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-slot-')), 'Inbox.lua');
    fs.writeFileSync(slot, luaAssignment('Orca_Inbox', { v: 1, gen: 5, now: 1, nextSig: 1, key: keys.hex, threads: [], projects: [], usage: [], bridge: {} }));
    const secret = 'please refactor the payment flow';
    const [cells, mode, origin] = execFileSync(lua, ['tools/strip_e2e.lua', 'addon/Orca', slot, 'thread-42', secret], { cwd: root }).toString().trim().split('\n');
    assert.equal(mode, 'encrypted');
    const frame = decodeImage(drawn(cells, origin));
    assert.equal(frame.version, 2);
    assert.ok(!frame.payload.includes(Buffer.from(secret)), 'prompt not visible in the strip');
    assert.ok(!frame.payload.includes(Buffer.from('thread-42')), 'thread id not visible');
    const plain = open(keys, frame.seq, frame.payload);
    assert.ok(plain, 'authenticates with the bridge keys');
    const { hello, commands } = parseFrame(plain);
    assert.equal(hello.view, 'thread-42');
    assert.deepEqual(commands.at(-1).args, ['thread-42', secret, 'auto']);
    assert.equal(open(deriveKeys(crypto.randomBytes(32)), frame.seq, frame.payload), null);
  });

  test(`addon strip without keys: a bare hello, no commands (${lua})`, () => {
    const slot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-slot-')), 'Inbox.lua');
    fs.writeFileSync(slot, 'Orca_Inbox = nil\n');
    const [cells, mode, origin] = execFileSync(lua, ['tools/strip_e2e.lua', 'addon/Orca', slot, 'thread-42', 'secret'], { cwd: root }).toString().trim().split('\n');
    assert.equal(mode, 'plain');
    const frame = decodeImage(drawn(cells, origin));
    assert.equal(frame.version, 1);
    const { hello, commands } = parseFrame(frame.payload);
    assert.equal(hello.view, '');
    assert.equal(commands.length, 0);
  });
}

test('a full-size message still fits once sealed', () => {
  assert.ok(MAX_PAYLOAD - OVERHEAD >= 2000 + 200);
});
