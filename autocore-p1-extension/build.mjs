// TARGET: autocore-p1-extension/build.mjs
// esbuild bundler for the MV3 extension. Each entry point is bundled to a
// self-contained IIFE in dist/ (shared src/ modules are inlined). Static
// assets (manifest.json, popup.html) are copied. Run: `npm run build`.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

// Clean dist.
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entries = {
  background: 'src/background.ts',
  'content-inbox': 'src/content/inbox.ts',
  'content-reply': 'src/content/reply.ts',
  'content-publisher': 'src/content/publisher.ts',
  popup: 'src/popup/popup.ts',
};

await build({
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([name, file]) => [name, resolve(root, file)])
  ),
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  platform: 'browser',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

// Copy static assets into dist.
copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
copyFileSync(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup.html'));

console.log('Built extension → dist/ (load unpacked via chrome://extensions).');
