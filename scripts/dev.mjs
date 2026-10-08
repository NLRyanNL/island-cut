// Dev runner: Vite dev server for the UI + esbuild watch for the Electron main process.
// Restarts Electron whenever main/preload code changes. The UI hot-reloads by itself.
import { createServer } from 'vite';
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { electronBuildOptions } from './electron-options.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';
console.log(`\n  UI dev server: ${url}\n`);

let child = null;
let restarting = false;
function startElectron() {
  if (child) {
    restarting = true;
    child.kill();
  }
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  child.on('exit', (code) => {
    if (restarting) {
      restarting = false;
      return;
    }
    server.close();
    process.exit(code ?? 0);
  });
}

const ctx = await context({
  ...electronBuildOptions,
  plugins: [
    {
      name: 'restart-electron',
      setup(b) {
        b.onEnd((r) => {
          if (r.errors.length === 0) startElectron();
        });
      },
    },
  ],
});
await ctx.watch();
