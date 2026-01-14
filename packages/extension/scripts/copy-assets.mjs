import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');

const files = [
  'src/popup.html',
  'src/popup.css',
  'src/options.html',
  'src/options.css',
  'manifest.json'
];

mkdirSync(dist, { recursive: true });

for (const file of files) {
  const src = join(root, file);
  const destName = file.includes('/') ? file.split('/').pop() : file;
  const dest = join(dist, destName);
  copyFileSync(src, dest);
  console.log(`Copied ${file} -> dist/${destName}`);
}

console.log('Done!');
