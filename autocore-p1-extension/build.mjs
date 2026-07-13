// TARGET: autocore-p1-extension/build.mjs
// esbuild bundler for the MV3 extension. Each entry point is bundled to a
// self-contained IIFE in dist/ (shared src/ modules are inlined). Static
// assets (manifest.json, popup.html) are copied. Run: `npm run build`.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

// Supabase publishable/anon key (public; RLS is the boundary). Sourced from
// the SUPABASE_ANON_KEY env var or the gitignored `.anon-key` file written by
// scripts/set-keys.ps1. REPLACE_ME builds still work but cannot log in.
const keyFile = resolve(root, '.anon-key');
const anonKey =
  (process.env.SUPABASE_ANON_KEY || '').trim() ||
  (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '') ||
  'REPLACE_ME';
if (anonKey === 'REPLACE_ME') {
  console.warn('WARNING: no Supabase key found (.anon-key / SUPABASE_ANON_KEY) — extension login will be disabled.');
}

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
  define: { __SUPABASE_ANON_KEY__: JSON.stringify(anonKey) },
});

// Copy static assets into dist.
copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
copyFileSync(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup.html'));

console.log('Built extension → dist/ (load unpacked via chrome://extensions).');
