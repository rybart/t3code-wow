// The bridge's T3 session token. Minted with the user's own `t3` CLI, stored 0600
// under ~/.config/orca-wow, renewed a week before it expires.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca-wow');
export const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

export function tokenClaims(token) {
  try {
    const [body] = token.split('.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function findT3Cli() {
  if (process.platform === 'win32') {
    // T3 Code writes a batch file here.
    const home = os.homedir();
    const known = [process.env.T3_CLI, path.join(home, '.t3/bin/t3.cmd'), path.join(home, '.local/bin/t3.cmd'), path.join(home, '.local/bin/t3.exe')];
    const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap((dir) => [path.join(dir, 't3.cmd'), path.join(dir, 't3.exe')]);
    return [...known, ...onPath].find((c) => c && fs.existsSync(c)) || null;
  }
  const candidates = [
    process.env.T3_CLI,
    path.join(os.homedir(), '.local/bin/t3'),
    path.join(os.homedir(), '.t3/bin/t3'),
    '/usr/bin/t3',
    '/usr/local/bin/t3',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, 't3');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Anything else is refused, because inside a cmd.exe command line & | < > ^ % ! and "
// all mean something, and no quoting covers them all.
const CMD_SAFE_ARG = /^[A-Za-z0-9 _.,:=@+\/()-]*$/;
// A batch file's own path sits inside quotes, where cmd.exe still reads these three.
// Measured: accents, spaces, & and ' in a profile folder's name all arrive intact.
const CMD_UNSAFE_PATH = /["%!]/;

/**
 * What to hand execFile or spawnSync to run the t3 CLI: [file, args, options].
 *
 * Node refuses to start a .cmd or .bat directly (EINVAL), and T3 Code's command on
 * Windows is `t3.cmd`. A batch file runs as
 *
 *   cmd.exe /d /s /c ""C:\Users\me\.t3\bin\t3.cmd" "auth" "session" "issue" ..."
 *
 * with windowsVerbatimArguments, so Node adds no quoting of its own. Everything else,
 * on every platform, runs as it is.
 *
 * @param {string} cli  From findT3Cli().
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @returns {[file: string, args: string[], options: { windowsVerbatimArguments?: boolean, windowsHide?: boolean }]}
 * @throws {Error} when cmd.exe would read part of the path or of an argument as a command.
 */
export function t3Command(cli, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(cli)) return [cli, args, {}];
  if (CMD_UNSAFE_PATH.test(cli)) throw new Error(`can't run ${cli}: cmd.exe reads % and ! in a batch file's path as variables. Set T3_CLI to a copy of it in a folder without them.`);
  const refused = args.find((arg) => !CMD_SAFE_ARG.test(arg));
  if (refused !== undefined) throw new Error(`can't pass ${JSON.stringify(refused)} to ${path.basename(cli)}: cmd.exe would read part of it as a command`);
  const line = [cli, ...args].map((part) => `"${part}"`).join(' ');
  return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true }];
}

export function mintToken({ label = 'WoW bridge' } = {}) {
  const cli = findT3Cli();
  if (!cli) return Promise.reject(new Error('could not find the `t3` command; open T3 Code once so it installs it'));
  const args = [
    'auth', 'session', 'issue',
    '--scope', 'orchestration:read',
    '--scope', 'orchestration:operate',
    '--ttl', '30d',
    '--label', label,
    '--token-only',
  ];
  return new Promise((resolve, reject) => {
    const [file, argv, options] = t3Command(cli, args);
    execFile(file, argv, { timeout: 120000, ...options }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`t3 auth session issue failed: ${(stderr || err.message).trim()}`));
      const token = stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      if (!token || !tokenClaims(token)) return reject(new Error('t3 auth session issue printed no token'));
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
      resolve(token);
    });
  });
}

export function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Returns a function the T3 client calls before connecting.
export function tokenProvider({ log = () => {} } = {}) {
  let minting = null;
  let forceRenew = false;
  const provider = async () => {
    if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
    let token = readToken();
    const claims = token && tokenClaims(token);
    const expiring = !claims || (claims.exp && claims.exp - Date.now() < RENEW_BEFORE_MS);
    if (!token || expiring || forceRenew) {
      if (!minting) {
        log(token ? 'renewing the T3 session token' : 'minting a T3 session token');
        minting = mintToken().finally(() => {
          minting = null;
          forceRenew = false;
        });
      }
      try {
        token = await minting;
      } catch (err) {
        if (!token) throw err;
        log(`token renewal failed, using the old one: ${err.message}`);
      }
    }
    return token;
  };
  provider.invalidate = () => {
    forceRenew = true;
  };
  return provider;
}
