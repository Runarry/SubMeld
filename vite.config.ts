import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '^/source\\.tar\\.gz(?:$|[?])': 'http://127.0.0.1:3000',
      '^/healthz(?:$|[/?])': 'http://127.0.0.1:3000',
      '^/api(?:$|[/?])': 'http://127.0.0.1:3000',
      '^/s(?:$|[/?])': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
