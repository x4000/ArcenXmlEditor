const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const mainConfig = {
  entryPoints: [path.join(__dirname, 'src', 'renderer', 'index.jsx')],
  bundle: true,
  outfile: path.join(__dirname, 'src', 'renderer', 'bundle.js'),
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.js': 'js' },
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

const workerConfig = {
  entryPoints: [path.join(__dirname, 'src', 'renderer', 'editor', 'validationWorker.js')],
  bundle: true,
  outfile: path.join(__dirname, 'src', 'renderer', 'validationWorker.bundle.js'),
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  loader: { '.js': 'js' },
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

if (isWatch) {
  Promise.all([
    esbuild.context(mainConfig),
    esbuild.context(workerConfig),
  ])
    .then(([mainCtx, workerCtx]) => {
      mainCtx.watch();
      workerCtx.watch();
      console.log('Watching for changes...');
    })
    .catch(() => process.exit(1));
} else {
  Promise.all([
    esbuild.build(mainConfig),
    esbuild.build(workerConfig),
  ])
    .then(() => console.log('Build complete.'))
    .catch(() => process.exit(1));
}
