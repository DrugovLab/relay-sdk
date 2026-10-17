import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Фронтенд без своих схем: только send и fetchSchema. Сборка — как у
// сборщиков сайтов: ESM, с разделением на файлы по динамическим import().
async function bundle(code: string) {
  const result = await build({
    stdin: { contents: code, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    write: false,
    outdir: 'out',
    metafile: true,
    logLevel: 'silent',
  });
  const outputs = Object.entries(result.metafile.outputs);
  const [, main] = outputs.find(([, output]) => output.entryPoint)!;
  const packages = (inputs: Record<string, unknown>) =>
    Object.keys(inputs)
      .filter((path) => path.includes('node_modules'))
      .map((path) =>
        path.replace(/.*node_modules\/((@[^/]+\/)?[^/]+).*/, '$1'),
      );
  return {
    mainBytes: main.bytes,
    mainPackages: packages(main.inputs),
    lazyPackages: outputs
      .filter(([, output]) => !output.entryPoint)
      .flatMap(([, output]) => packages(output.inputs)),
  };
}

describe('бандл фронтенда', () => {
  it('без схем zod не попадает в основной файл, грузится только для fetchSchema', async () => {
    const { mainBytes, mainPackages, lazyPackages } = await bundle(`
      import { createRelay } from './index';
      const relay = createRelay<{ lead: { name: string } }>({ publicKey: 'pk_1' });
      relay.events.lead.send({ name: 'Иван' });
      relay.events.lead.fetchSchema();
    `);
    expect(mainPackages).toEqual([]);
    expect(lazyPackages).toContain('zod');
    expect(mainBytes).toBeLessThan(8 * 1024);
  });
});
