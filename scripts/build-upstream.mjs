import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    target: 'es2022',
    outDir: 'dist/upstream',
    minify: false,
    lib: {
      entry: 'server/native-runtime.ts',
      name: 'SubMeldRuntime',
      formats: ['iife'],
      fileName: () => 'runtime.js',
    },
    rollupOptions: {
      external: ['node:net', 'node:url'],
      output: { globals: { 'node:net': 'SubMeldNet', 'node:url': 'SubMeldUrl' } },
    },
  },
});
const path = 'dist/upstream/runtime.js';
await writeFile(
  path,
  'const SubMeldNet = require("node:net"), SubMeldUrl = require("node:url");\n' +
    (await readFile(path, 'utf8')),
);
