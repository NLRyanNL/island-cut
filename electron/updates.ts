// Update checker: asks GitHub for the latest release of the repo configured at build time
// (package.json "islandcut.updateRepo") and tells the window when a newer version exists.
import { app, net } from 'electron';
import { appConfig } from './appConfig';
import type { UpdateInfo } from '../shared/api';

/** Compare "1.2.10" style versions (a leading "v" is ignored). >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const repo = appConfig().updateRepo;
  const current = app.getVersion();
  if (!repo) return { status: 'not-configured', current };
  try {
    const r = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'IslandCut', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return { status: 'up-to-date', current };
    if (!r.ok) return { status: 'error', current, message: `GitHub answered ${r.status}` };
    const j = (await r.json()) as { tag_name?: string; html_url?: string; body?: string; name?: string };
    const latest = String(j.tag_name ?? '').replace(/^v/i, '');
    if (!latest || compareVersions(latest, current) <= 0) return { status: 'up-to-date', current, latest };
    const url = /^https:\/\/github\.com\//.test(j.html_url ?? '') ? j.html_url! : `https://github.com/${repo}/releases/latest`;
    return { status: 'available', current, latest, url, notes: String(j.body ?? '').slice(0, 1200) };
  } catch (e) {
    return { status: 'error', current, message: (e as Error).message };
  }
}
