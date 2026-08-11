import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'web/index.html'), 'utf8');
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);

if (!inlineScript) throw new Error('web/index.html does not contain an inline script');
new Function(inlineScript[1]);

console.log(JSON.stringify({ ok: true, file: 'web/index.html', inline_scripts_checked: 1 }, null, 2));
