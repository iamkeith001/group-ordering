import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'server'), { recursive: true });
await mkdir(join(dist, 'client', 'menu'), { recursive: true });
await mkdir(join(dist, '.openai'), { recursive: true });

await cp(join(root, 'order.html'), join(dist, 'client', 'order.html'));
await cp(join(root, 'style.css'), join(dist, 'client', 'style.css'));
await cp(join(root, 'app.js'), join(dist, 'client', 'app.js'));
await cp(join(root, 'menu', 'burgerking.js'), join(dist, 'client', 'menu', 'burgerking.js'));
await cp(join(root, '.openai', 'hosting.json'), join(dist, '.openai', 'hosting.json'));

const staticAssets = {
  '/order.html': await readFile(join(root, 'order.html'), 'utf8'),
  '/style.css': await readFile(join(root, 'style.css'), 'utf8'),
  '/app.js': await readFile(join(root, 'app.js'), 'utf8'),
  '/menu/burgerking.js': await readFile(join(root, 'menu', 'burgerking.js'), 'utf8')
};

const workerSource = await readFile(join(root, 'src', 'worker.js'), 'utf8');
await writeFile(
  join(dist, 'server', 'index.js'),
  workerSource.replace('const ASSET_CONTENTS = {};', `const ASSET_CONTENTS = ${JSON.stringify(staticAssets)};`)
);
