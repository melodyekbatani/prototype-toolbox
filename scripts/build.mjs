// Builds the deployable site into dist/:
//   toolbox.js      the bookmarklet's payload (Preact + tools, one IIFE)
//   index.html      the landing page, with the bookmarklet baked in
//   sample.html     a mock page to try the toolbox on
//   bookmarklet.txt the bookmarklet's code, for pasting by hand
//
// TOOLBOX_BASE_URL  where toolbox.js will be served (default: production)
// TOOLBOX_ROBOTS_URL optional endpoint "Send to Claude" posts to
// --watch           rebuild on changes;  --serve  serve dist/ on :4173
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { serve } from './serve.mjs';

const PRODUCTION_URL = 'https://prototype-toolbox.quick.shopify.io';
const baseUrl = (process.env.TOOLBOX_BASE_URL || PRODUCTION_URL).replace(/\/$/, '');
const robotsUrl = process.env.TOOLBOX_ROBOTS_URL || '';
const watch = process.argv.includes('--watch');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function bookmarklet() {
  const source = fs.readFileSync(path.join(root, 'scripts/bookmarklet.js'), 'utf8');
  const { code } = await esbuild.transform(source, {
    minify: true,
    target: 'es2020',
    define: { __BASE_URL__: JSON.stringify(baseUrl) },
    legalComments: 'none',
  });
  const body = code.trim().replace(/;$/, '');
  if (body.includes('%')) throw new Error('Bookmarklet must not contain %');
  return `javascript:${body}`;
}

// CSS imported as a minified string, for the shadow root's stylesheet.
const minifiedCss = {
  name: 'minified-css',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      const { code } = await esbuild.transform(source, { loader: 'css', minify: true });
      return { contents: `export default ${JSON.stringify(code)};`, loader: 'js' };
    });
  },
};

async function build() {
  const started = Date.now();
  fs.mkdirSync(dist, { recursive: true });
  const version = `${pkg.version}+${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main.tsx')],
    outfile: path.join(dist, 'toolbox.js'),
    bundle: true,
    format: 'iife',
    minify: true,
    sourcemap: false,
    target: ['chrome111', 'safari16.4', 'firefox115'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
    plugins: [minifiedCss],
    define: {
      __VERSION__: JSON.stringify(version),
      __ROBOTS_URL__: JSON.stringify(robotsUrl),
      'process.env.NODE_ENV': '"production"',
    },
    banner: { js: `/* Prototype toolbox ${version} */` },
    legalComments: 'none',
    logLevel: 'warning',
  });
  const js = fs.readFileSync(path.join(dist, 'toolbox.js'));
  const size = `${(js.length / 1024).toFixed(1)} KB (${(zlib.gzipSync(js).length / 1024).toFixed(1)} KB gzipped)`;
  const href = await bookmarklet();
  fs.writeFileSync(path.join(dist, 'bookmarklet.txt'), `${href}\n`);

  const site = path.join(root, 'site');
  for (const name of fs.readdirSync(site)) {
    const from = path.join(site, name);
    const to = path.join(dist, name);
    if (fs.statSync(from).isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else if (name.endsWith('.html')) {
      const html = fs
        .readFileSync(from, 'utf8')
        .replaceAll('{{BOOKMARKLET_HREF}}', escapeHtml(href))
        .replaceAll('{{BOOKMARKLET_CODE}}', escapeHtml(href))
        .replaceAll('{{BASE_URL}}', escapeHtml(baseUrl))
        .replaceAll('{{VERSION}}', escapeHtml(version))
        .replaceAll('{{BUNDLE_SIZE}}', escapeHtml(size));
      fs.writeFileSync(to, html);
    } else {
      fs.copyFileSync(from, to);
    }
  }
  console.log(`Built dist/ in ${Date.now() - started}ms · toolbox.js ${size} · base ${baseUrl}`);
}

await build();

if (watch) {
  let timer;
  for (const dir of ['src', 'site', 'scripts']) {
    fs.watch(path.join(root, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((e) => console.error(e.message)), 100);
    });
  }
  console.log('Watching src/, site/ and scripts/ for changes');
}
if (process.argv.includes('--serve')) serve(dist, 4173);
