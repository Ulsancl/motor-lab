import fs from 'node:fs';
import path from 'node:path';
import { checkedPath, checkTree, copyInput, publishDirectory, secureDirectory, stagingDirectory } from './safe-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'dist');
secureDirectory(root, root);
if (fs.lstatSync(target, { throwIfNoEntry: false })) {
  checkedPath(root, target);
  if (!fs.statSync(target).isDirectory()) throw new Error('dist must be a real project directory');
  checkTree(root, target);
}
for (const dependency of ['vite', 'three', 'rollup', 'esbuild']) checkTree(root, path.join(root, 'node_modules', dependency));

const stage = stagingDirectory(root);
const input = path.join(stage, 'web');
const bundle = path.join(stage, 'bundle');
try {
  for (const name of ['index.html', 'vite.config.js', 'src', 'public']) {
    copyInput(root, path.join(root, name), path.join(input, name));
  }
  const { build } = await import('vite');
  await build({
    root: input,
    configFile: path.join(input, 'vite.config.js'),
    configLoader: 'runner',
    build: { outDir: bundle, emptyOutDir: false },
  });
  publishDirectory(root, bundle, target);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
