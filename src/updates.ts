// Update checker (renderer side): asks the main process whether GitHub has a newer release.
import { setRT, toast } from './store/store';

const LS_SKIP = 'islandcut.skipVersion';

export async function checkUpdates(manual: boolean): Promise<void> {
  let info;
  try {
    info = await window.api.checkForUpdate();
  } catch (e) {
    if (manual) toast(`Could not check for updates: ${(e as Error).message}`, 'error');
    return;
  }
  if (info.status === 'available') {
    let skipped = '';
    try {
      skipped = localStorage.getItem(LS_SKIP) ?? '';
    } catch {
      /* ignore */
    }
    if (manual || skipped !== info.latest) setRT({ update: info });
    return;
  }
  if (!manual) return;
  if (info.status === 'up-to-date') toast(`You have the newest version (${info.current}).`, 'success');
  else if (info.status === 'not-configured') toast('This copy of IslandCut was built without an update source.', 'info');
  else toast(`Could not check for updates: ${info.message ?? 'unknown error'}`, 'error');
}

export function skipUpdate(version: string): void {
  try {
    localStorage.setItem(LS_SKIP, version);
  } catch {
    /* ignore */
  }
  setRT({ update: null });
}
