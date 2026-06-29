import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_HTML = join(root, 'performance-monitor.html');

async function run() {
  const result = await build({
    entryPoints: [join(root, 'src/editor/index.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    loader: { '.css': 'text' },
    write: false,
    logLevel: 'info',
  });
  const js = result.outputFiles[0].text;
  // Node-RED loads the plugin .html into the editor; wrap the bundle in a script tag.
  const html = `<!-- Performance Monitor — built from src/editor/ by build/build.mjs. DO NOT EDIT BY HAND. -->\n<script type="text/javascript">\n${js}\n</script>\n`;
  await writeFile(OUT_HTML, html, 'utf8');
  console.log('wrote', OUT_HTML, js.length, 'bytes JS');
}
run().catch((e) => { console.error(e); process.exit(1); });
