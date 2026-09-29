import { fileURLToPath } from 'node:url';
import { alphaTab } from '@coderline/alphatab-vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const backend = process.env.JULIANIFY_DEV_BACKEND ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root,
  // Lo spartito non suona (c'è la traccia audio): il worklet del sintetizzatore non serve.
  plugins: [react(), alphaTab({ audioWorklets: false })],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
    },
  },
});
