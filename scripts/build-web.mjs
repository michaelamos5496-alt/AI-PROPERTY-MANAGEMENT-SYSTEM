// Bundles ./web into ./public (minified, no source maps, no environment values inlined).
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'public');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'assets'), { recursive: true });

const js = (await readdir(join(root, 'web', 'js'))).filter((f) => f.endsWith('.js') && !['api.js', 'ui.js'].includes(f));
await build({
  entryPoints: [
    ...js.map((f) => join(root, 'web', 'js', f)),
    join(root, 'web', 'css', 'main.css'),
  ],
  outdir: join(out, 'assets'),
  bundle: true, minify: true, format: 'esm', target: 'es2022', sourcemap: false, legalComments: 'none',
  splitting: true, // shared api/ui code is emitted once as a chunk
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  logLevel: 'warning',
});
for (const f of (await readdir(join(root, 'web'))).filter((f) => f.endsWith('.html'))) {
  await cp(join(root, 'web', f), join(out, f));
}
console.log(`web build complete -> ${out}`);
