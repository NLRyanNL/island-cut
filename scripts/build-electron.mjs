import { build } from 'esbuild';
import { electronBuildOptions } from './electron-options.mjs';

await build({ ...electronBuildOptions, minify: false });
