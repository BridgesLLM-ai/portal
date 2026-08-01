import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const eslintBin = fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url));
const accessibilityGate = fileURLToPath(new URL('./validate-accessibility.mjs', import.meta.url));

const eslint = spawnSync(
  process.execPath,
  [eslintBin, 'src', '--ext', '.ts,.tsx', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (eslint.status !== 0) {
  process.exit(eslint.status ?? 1);
}

const accessibility = spawnSync(process.execPath, [accessibilityGate], { stdio: 'inherit' });
process.exit(accessibility.status ?? 1);
