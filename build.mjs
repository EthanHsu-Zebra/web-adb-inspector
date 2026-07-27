import * as esbuild from 'esbuild';
import { statSync } from 'fs';

const commonOpts = {
  entryPoints: ['src/index.js'],
  bundle: true,
  outfile: 'dist/bundle.js',
  format: 'iife',
  globalName: 'WebAdbInspector',
  target: 'es2020',
  minify: true,
  sourcemap: 'external',
  treeShaking: false,
  logLevel: 'error',
};

const report = () => {
  const size = statSync('dist/bundle.js').size;
  console.log(`Build complete -> dist/bundle.js (${(size / 1024).toFixed(1)} KB)`);
};

if (process.argv.includes('--watch')) {
  await esbuild.context({ ...commonOpts }).then(ctx => {
    ctx.watch();
    report();
    ctx.onEnd(result => {
      if (result.errors.length) console.error('Build failed:', result.errors.join('\n'));
      else report();
    });
  });
} else {
  await esbuild.build(commonOpts);
  report();
}
