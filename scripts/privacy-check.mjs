// Fails the public release if any personal information would ship inside it.
// Scans everything of ours that goes into the app (dist/**, package.json, resources) for:
//   - absolute user folders (C:\Users\<name>\..., /home/<name>/...)
//   - your Windows user name / PC name (when they are not generic, like "User")
//   - e-mail addresses, Anthropic API keys
//   - extra words you put in privacy-words.txt (one per line, e.g. your real name), never shipped
// With --release it also checks the built installer's metadata (author / company name).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERIC = new Set(['user', 'users', 'admin', 'administrator', 'owner', 'pc', 'default', 'guest', 'public', 'root', 'claude', 'desktop', 'home', 'runner']);
const words = new Set();
const addWord = (w) => {
  w = String(w ?? '').trim();
  if (!w.startsWith("#") && w.length >= 3 && !GENERIC.has(w.toLowerCase())) words.add(w.toLowerCase());
};
addWord(os.userInfo().username);
addWord(os.hostname());
for (const k of ['user.email', 'user.name']) {
  try {
    addWord(execSync(`git config --global ${k}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch {
    /* no git */
  }
}
try {
  for (const line of fs.readFileSync(path.join(root, 'privacy-words.txt'), 'utf8').split(/\r?\n/)) addWord(line);
} catch {
  /* optional */
}

const patterns = [
  { re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b)[^\\/"'\s]+/g, what: 'a personal Windows folder path' },
  { re: /\/home\/(?!runner\b)[a-z0-9_-]+\//g, what: 'a personal Linux folder path' },
  { re: /\/Users\/(?!Shared\b)[A-Za-z0-9_-]+\//g, what: 'a personal Mac folder path' },
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, what: 'an Anthropic API key' },
  { re: /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook|live|yahoo|icloud|proton(?:mail)?|msn|aol)\.[a-z.]{2,}/gi, what: 'an e-mail address' },
];
// Strings that are fine to ship (examples in UI text, documentation placeholders)
const ALLOW = [/noreply@/i, /example\.com/i];

function* walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const e of fs.readdirSync(p)) yield* walk(path.join(p, e));
}

const targets = [path.join(root, 'dist'), path.join(root, 'package.json'), path.join(root, 'resources', 'licenses')];
const problems = [];
let scanned = 0;
for (const t of targets) {
  for (const file of walk(t)) {
    if (/\.(woff2?|png|ico|jpg)$/i.test(file)) continue;
    let text = fs.readFileSync(file, 'latin1');
    // the GitHub repo (update checks) and counter URL are public on purpose: they are where people download the app
    if (path.basename(file) === 'package.json') text = text.replace(/"(updateRepo|statsUrl)":\s*"[^"]*"/g, '"$1": ""');
    scanned++;
    const rel = path.relative(root, file);
    for (const { re, what } of patterns) {
      for (const m of text.matchAll(re)) {
        if (ALLOW.some((a) => a.test(m[0]))) continue;
        problems.push(`${rel}: ${what} → "${m[0].slice(0, 60)}"`);
      }
    }
    const lower = text.toLowerCase();
    for (const w of words) {
      const i = lower.indexOf(w);
      if (i >= 0) problems.push(`${rel}: contains "${w}" (…${text.slice(Math.max(0, i - 25), i + w.length + 25).replace(/\s+/g, ' ')}…)`);
    }
  }
}

if (process.argv.includes('--release')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const k of ['author', 'copyright']) {
    const v = JSON.stringify(k === 'author' ? pkg.author : pkg.build?.copyright ?? '');
    for (const w of words) if (v.toLowerCase().includes(w)) problems.push(`package.json ${k} contains "${w}" (shown in the installer's file properties)`);
  }
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const rel = path.join(root, outArg ? outArg.slice(6) : 'release');
  const outs = fs.existsSync(rel) ? fs.readdirSync(rel).filter((f) => /\.exe$/i.test(f)) : [];
  if (!outs.length) problems.push('no .exe found in release/');
  else console.log(`release files: ${outs.join(', ')}`);
}

if (problems.length) {
  console.error(`\nPRIVACY CHECK FAILED - ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 50)) console.error('  - ' + p);
  console.error('\nFix these before sharing the build.');
  process.exit(1);
}
console.log(`privacy check passed: ${scanned} files scanned, no personal info found (checked ${words.size} personal word(s) + paths, e-mails, API keys)`);
