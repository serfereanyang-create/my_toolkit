import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: 'resources',
  // Relative asset paths so Electron can load the bundle over file:// in
  // production. With the default '/' base, /assets/* resolves to the OS
  // filesystem root under file:// and the window renders blank.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  worker: {
    format: 'es',
  },
});
