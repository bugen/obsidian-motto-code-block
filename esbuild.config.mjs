import { builtinModules } from 'node:module';
import { context } from 'esbuild';

const production = process.argv.includes('production');
const build = await context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2021',
  loader: { '.svg': 'dataurl' },
  banner: { js: '/* Third-party code and assets: see THIRD_PARTY_NOTICES and LICENSES/. */' },
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/common', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
});

if (production) {
  try {
    await build.rebuild();
  } finally {
    await build.dispose();
  }
} else {
  await build.watch();
}
