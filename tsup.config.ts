import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
  },
  // CLI — только для Node: свой вход, в браузерную сборку не попадает.
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node20',
    platform: 'node',
  },
]);
