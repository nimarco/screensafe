import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only sink for tools/make-sample.html, which renders the bundled demo
 * recording with the same WebCodecs encoder the app exports with. Lets the
 * generator write straight into public/ instead of going through downloads.
 */
function sampleWriter(): Plugin {
  return {
    name: 'screensafe-sample-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-sample', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'sample.mp4';
        const out = resolve(process.cwd(), 'public/sample', name.replace(/[^\w.-]/g, '_'));
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, buf);
          console.log(`[screensafe] wrote ${out} (${(buf.length / 1e6).toFixed(2)} MB)`);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: out, bytes: buf.length }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sampleWriter()],
  base: '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
  worker: { format: 'es' },
  server: { port: Number(process.env.PORT) || 5173, host: true },
  // Tesseract ships prebuilt worker/wasm we serve from /public/vendor, so keep
  // Vite from trying to pre-bundle the parts that must load as real workers.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
});
