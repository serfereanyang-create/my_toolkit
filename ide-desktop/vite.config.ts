import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Content-Security-Policy for the packaged renderer.
 *
 * The main window previously had NO CSP at all, so any script that reached the
 * DOM — a compromised dependency, a pasted payload, injected HTML from a
 * preview — could run with the app's full privileges and reach every IPC
 * handler in preload.cjs. The policy below locks the renderer to its own
 * bundle.
 *
 * `style-src 'unsafe-inline'` is required: the UI sets inline `style` props
 * throughout. `img-src` needs `data:`/`blob:` for screenshots and the
 * `yoycode-preview:` custom scheme for workspace images. `worker-src` needs
 * `blob:` because monaco's workers are created from blob URLs.
 *
 * Injected at BUILD time only: the Vite dev server injects inline HMR
 * preamble scripts, which this policy would block.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: yoycode-preview:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function injectCsp() {
  return {
    name: 'inject-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), injectCsp()],
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
