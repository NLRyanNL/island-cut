// Shared esbuild options for the Electron main + preload bundles.
export const electronBuildOptions = {
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
    worker: 'electron/worker.ts',
  },
  outdir: 'dist/electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', 'ffmpeg-static', 'ffprobe-static'],
  logLevel: 'info',
};
