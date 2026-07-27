import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

await esbuild.build({
  entryPoints: ['src/index.js'],
  bundle: true,
  outfile: 'dist/bundle.js',
  format: 'iife',
  globalName: 'WebAdbInspector',
  target: 'es2020',
  minify: !isWatch,
  sourcemap: !isWatch,
  treeShaking: true,
  external: [], // no external deps - full bundle
});

if (!isWatch) {
  console.log('Build complete -> dist/bundle.js');
  // Print bundle size
  import('fs').then(fs => {
    const stats = fs.statSync('dist/bundle.js');
    console.log(`Bundle size: ${(stats.size / 1024).toFixed(1)} KB`);
  });
} else {
  console.log('Watching... (not yet implemented)');
}
