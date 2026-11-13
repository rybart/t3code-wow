// The inbound channel (bridge -> game).
//
// WoW addons can't read files at runtime, with two exceptions this relies on, both
// measured on live Forever clients (see docs/ARCHITECTURE.md):
//
//  * C_AddOns.LoadAddOn reads a load-on-demand addon's Lua from disk when it is
//    loaded. Each slot addon (Orca_S001...) can be loaded once per UI session, and
//    /reload unloads them all. We write a snapshot into the next few slots the addon
//    will load.
//  * Sound files bigger than the client's cacheable size (Sound_MaxCacheableSizeInBytes,
//    174,762 bytes here) are streamed from disk and re-opened on every play (measured
//    on this client with inotify). So a large silent .wav is a reusable "bell": the
//    bridge fills it to announce a new snapshot, and the addon plays it and checks
//    C_Sound.IsPlaying a moment later (empty files never play). PlaySoundFile's own
//    "willPlay" answer is useless on Forever: it says true even for empty files.
//    Eight bells rotate so back-to-back updates can't be missed; they live at fixed
//    names inside the Signals folder that already existed when the client started.
//
// Files have to exist when the client starts: the game only indexes them at launch.

import fs from 'node:fs';
import path from 'node:path';
import { luaAssignment } from './luaser.js';

export const ADDON = 'Orca';
export const INTERFACE = '16001';

export function slotName(i) {
  return `${ADDON}_S${String(i).padStart(3, '0')}`;
}

// Bells reuse signal files that were created at install time (the client only knows
// files that existed at launch) and were never raised, so they've never been cached.
export const BELL_BASE = 3991;
export const BELLS = 8;
export const CTL_LONG = 3999; // always a long valid sound: the addon's self-test
export const CTL_EMPTY = 4000; // always empty

export function sigName(k) {
  return String(k).padStart(5, '0') + '.wav';
}

// 10 s of 16-bit mono silence at 22.05 kHz: ~441 KB, comfortably over the cacheable
// size, so the client streams (and re-reads) it on every play.
export const LONG_SILENT_WAV = (() => {
  const data = 22050 * 2 * 10;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24);
  b.writeUInt32LE(22050 * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
})();

// Windows refuses to rename over a file another program has open, whatever sharing
// that program asked for (measured). Linux and macOS never refuse, so they get no
// retries. Windows rounds each wait up to its 15.6 ms timer tick, so a file that stays
// in use blocks the event loop for about 30 ms (measured).
const RETRY_MS = process.platform === 'win32' ? [10, 10] : [];
const IN_USE = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => void Atomics.wait(sleeper, 0, 0, ms);

// Another program kept a file open past the retries. Nothing is half-written when
// this is thrown. Only Windows can throw it.
export class FileInUse extends Error {
  constructor(file) {
    super(`${path.basename(path.dirname(file))}/${path.basename(file)} is in use`);
  }
}

// A reader sees the old content or the new, never part of either. Returns false when
// the target was still in use after the retries, with the target untouched and the
// temp file gone. Any other error throws at once.
export function replaceFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  for (const wait of [0, ...RETRY_MS]) {
    if (wait) sleepSync(wait);
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      if (!RETRY_MS.length || !IN_USE.has(err.code)) throw err;
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}
  return false;
}

function setBell(file, rung) {
  const want = rung ? LONG_SILENT_WAV : '';
  try {
    if (fs.statSync(file).size === want.length) return;
  } catch {}
  if (!replaceFile(file, want)) throw new FileInUse(file);
}

export class SlotBank {
  constructor(addonsDir, { slots = 600 } = {}) {
    this.addonsDir = addonsDir;
    this.slots = slots;
    this.sigDir = path.join(addonsDir, ADDON, 'Signals');
  }

  slotFile(i) {
    const name = slotName(i);
    return path.join(this.addonsDir, name, 'Inbox.lua');
  }

  sigFile(k) {
    return path.join(this.sigDir, sigName(k));
  }

  // Every slot's TOC is identical, and it loads Inbox.lua through a static Slot.xml.
  //
  // Addon managers (WowUp, the CurseForge app) identify folders by a 32-bit hash of the
  // .toc plus the files it lists, looked up against all of CurseForge. Inbox.lua changes
  // with every update, so listing it directly meant hundreds of fresh hashes per scan,
  // and one did collide (WowUp took a slot for a Minecraft modpack, and an "update"
  // would have replaced it). Their scanners follow only self-closing <Script file/>
  // tags, so with `<Script file="Inbox.lua"></Script>` every slot hashes the same two
  // unchanging files: one fixed fingerprint, checked against CurseForge once.
  //
  // No `## Dependencies` either: WowUp hides an unrecognised load-on-demand folder only
  // when all its dependencies are recognised, and Orca isn't on its sites, so a
  // dependency on it listed every slot as an unknown addon. The game doesn't need it.
  slotToc() {
    return [
      `## Interface: ${INTERFACE}`,
      '## Title: T3 Code live update slot',
      '## Notes: Carries live updates from the T3 Code bridge. Leave it enabled.',
      '## Author: Ryan Hughes',
      '## LoadOnDemand: 1',
      `## Group: ${ADDON}`,
      '',
      'Slot.xml',
      '',
    ].join('\n');
  }

  slotXml() {
    return [
      '<Ui xmlns="http://www.blizzard.com/wow/ui/">',
      '\t<Script file="Inbox.lua"></Script>',
      '</Ui>',
      '',
    ].join('\n');
  }

  // Create every slot and bell that doesn't exist yet, refresh slot TOCs that differ,
  // and remove signal files older versions created but nothing uses. Returns counts.
  install() {
    let made = 0;
    let kept = 0;
    const ensure = (file, content, { refresh = false } = {}) => {
      if (fs.existsSync(file)) {
        if (refresh && fs.readFileSync(file, 'utf8') !== content) {
          fs.writeFileSync(file, content);
          made++;
        } else kept++;
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      made++;
    };
    for (let i = 1; i <= this.slots; i++) {
      const name = slotName(i);
      ensure(path.join(this.addonsDir, name, `${name}.toc`), this.slotToc(), { refresh: true });
      ensure(path.join(this.addonsDir, name, 'Slot.xml'), this.slotXml(), { refresh: true });
      ensure(this.slotFile(i), 'Orca_Inbox = nil\n');
    }
    // Only the bells and the two self-test controls are ever played.
    for (let k = BELL_BASE; k < BELL_BASE + BELLS; k++) ensure(this.sigFile(k), '');
    ensure(this.sigFile(CTL_LONG), LONG_SILENT_WAV);
    ensure(this.sigFile(CTL_EMPTY), '');
    const keep = new Set([...Array(BELLS).keys()].map((i) => sigName(BELL_BASE + i)).concat(sigName(CTL_LONG), sigName(CTL_EMPTY)));
    let pruned = 0;
    try {
      for (const f of fs.readdirSync(this.sigDir)) {
        if (!keep.has(f)) {
          fs.rmSync(path.join(this.sigDir, f), { force: true });
          pruned++;
        }
      }
    } catch {}
    return { made, kept, pruned };
  }

  // Remove slot addons beyond `keep` (used by uninstall and when shrinking the bank).
  removeSlots(keep = 0) {
    let removed = 0;
    for (const d of fs.readdirSync(this.addonsDir)) {
      const m = /^Orca_S(\d+)$/.exec(d);
      if (m && Number(m[1]) > keep) {
        fs.rmSync(path.join(this.addonsDir, d), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  installedSlotCount() {
    let n = 0;
    while (n < 10000 && fs.existsSync(this.slotFile(n + 1))) n++;
    return n;
  }

  write(slotIndexes, value) {
    const content = luaAssignment('Orca_Inbox', value);
    for (const i of slotIndexes) {
      if (i < 1 || i > this.slots) continue;
      if (!replaceFile(this.slotFile(i), content)) throw new FileInUse(this.slotFile(i));
    }
    return content.length;
  }

  bellFile(k) {
    return this.sigFile(BELL_BASE + ((((k - 1) % BELLS) + BELLS) % BELLS));
  }

  // Empty the bell four behind k, then fill bell k, so the addon's look-ahead window
  // (k .. k+3) only ever sees bells raised after it last loaded.
  raise(k) {
    setBell(this.bellFile(k - 4), false);
    setBell(this.bellFile(k), true);
    return true;
  }

  // The self-test controls and empty bells; safe to call at every start.
  prepareBells() {
    setBell(this.sigFile(CTL_LONG), true);
    setBell(this.sigFile(CTL_EMPTY), false);
  }

  // Bells are re-read on every play, so at a client restart we only need them empty.
  // Returns false while a bell is still in use, which leaves it rung.
  resetSignals() {
    let empty = true;
    for (let i = 0; i < BELLS; i++) {
      try {
        setBell(this.sigFile(BELL_BASE + i), false);
      } catch (err) {
        if (err instanceof FileInUse) empty = false;
      }
    }
    return empty;
  }
}
