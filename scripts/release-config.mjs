// Asks (once) which GitHub repository the public release lives in, so the app can check it for
// updates, and which version number this release gets. Questions time out after 40 s and keep
// the current values, so an unattended build never hangs.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const repoFile = path.join(root, 'downloads-repo.txt');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.islandcut ??= {};

function ask(q, timeoutMs = 40000) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const t = setTimeout(() => {
      process.stdout.write('\n(no answer, keeping the current value)\n');
      rl.close();
      resolve('');
    }, timeoutMs);
    rl.question(q, (a) => {
      clearTimeout(t);
      rl.close();
      resolve(a.trim());
    });
  });
}

const valid = (r) => /^[\w.-]+\/[\w.-]+$/.test(r);
let repo = String(pkg.islandcut.updateRepo || '').trim();
if (!valid(repo)) {
  try {
    repo = fs.readFileSync(repoFile, 'utf8').trim();
  } catch {
    repo = '';
  }
}
if (!valid(repo)) {
  console.log('\nWhere will you upload IslandCut on GitHub? (lets the app tell people about new versions)');
  const a = (await ask('Type it as  yourname/islandcut  (or just press Enter to skip): ')).replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (valid(a)) repo = a;
}
if (valid(repo)) {
  pkg.islandcut.updateRepo = repo;
  if (!fs.existsSync(repoFile)) fs.writeFileSync(repoFile, repo + '\n');
  console.log(`Update checks: github.com/${repo}`);
} else console.log('Update checks: off (no GitHub repository set)');

const cur = pkg.version;
const [a, b, c] = cur.split('.').map((x) => parseInt(x, 10) || 0);
const next = `${a}.${b}.${c + 1}`;
const v = await ask(`Version for this release? Current is ${cur}. Enter = keep ${cur}, or type e.g. ${next}: `);
if (/^\d+\.\d+\.\d+$/.test(v)) pkg.version = v;
console.log(`Version: ${pkg.version}`);
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
