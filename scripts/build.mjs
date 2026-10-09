import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = `${root}node_modules/vite/bin/vite.js`;

for (const args of [['build', '--config', 'vite.config.ts'], ['build', '--config', 'vite.content.config.ts']]) {
  const result = spawnSync(process.execPath, [vite, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await copyFile(new URL('../manifest.json', import.meta.url), new URL('../dist/manifest.json', import.meta.url));
