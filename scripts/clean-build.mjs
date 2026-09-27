import { rmSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const root = resolve('dist');
for (const part of ['server', 'converter']) {
  const target = resolve(root, part);
  if (relative(root, target) !== part) throw new Error('Invalid build path');
  rmSync(target, { recursive: true, force: true });
}
