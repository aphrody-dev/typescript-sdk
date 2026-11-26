/**
 * Builds the workspace package in the current directory from its `tsdown.config.ts`:
 * JavaScript with `Bun.build` (ESM `.mjs` with shared chunks + CJS `.cjs`), then bundled
 * declarations (`.d.mts`/`.d.cts`) with tsdown's dts-only pass, which inlines the private
 * `@modelcontextprotocol/core-internal` types the way the JavaScript bundle inlines its code.
 *
 * Usage (from a package directory): bun ../../scripts/build.ts [--out-dir <dir>]
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { BuildConfig } from 'bun';
import type { UserConfig } from 'tsdown';
import { build as buildDeclarations } from 'tsdown';

const cwd = process.cwd();
const config = (await import(path.join(cwd, 'tsdown.config.ts'))).default as UserConfig;
const pkg = await Bun.file(path.join(cwd, 'package.json')).json();

const entrypoints = (Array.isArray(config.entry) ? config.entry : [config.entry]).map(entry => path.join(cwd, String(entry)));
const noExternal = new Set((config.noExternal as string[] | undefined) ?? []);
const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
const external = [
    ...dependencies.filter(dep => !noExternal.has(dep)).flatMap(dep => [dep, `${dep}/*`]),
    ...((config.external as string[] | undefined) ?? [])
];

const { values: args } = parseArgs({ options: { 'out-dir': { type: 'string' } } });
const outdir = path.resolve(cwd, args['out-dir'] ?? String(config.outDir ?? 'dist'));
await rm(outdir, { recursive: true, force: true });

const shared = {
    entrypoints,
    outdir,
    root: path.join(cwd, 'src'),
    target: config.platform === 'neutral' ? 'browser' : 'node',
    external,
    sourcemap: config.sourcemap ? 'linked' : 'none',
    packages: 'bundle'
} satisfies Partial<BuildConfig>;

const started = performance.now();
for (const options of [
    { ...shared, format: 'esm', splitting: true, naming: { entry: '[dir]/[name].mjs', chunk: '_chunks/[name]-[hash].mjs' } },
    { ...shared, format: 'cjs', naming: { entry: '[dir]/[name].cjs' } }
] satisfies BuildConfig[]) {
    const result = await Bun.build(options);
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        process.exit(1);
    }
}
const jsMs = performance.now() - started;

if (config.dts) {
    // tsdown still writes CJS JavaScript next to the declarations, so build into a scratch dir and keep only *.d.[mc]ts(.map).
    const scratch = await mkdtemp(path.join(tmpdir(), 'mcp-dts-'));
    try {
        await buildDeclarations({
            ...config,
            config: false,
            clean: false,
            outDir: scratch,
            logLevel: 'warn',
            dts: { ...(typeof config.dts === 'object' ? config.dts : {}), emitDtsOnly: true }
        });
        for (const file of new Bun.Glob('**/*.d.{mts,cts}{,.map}').scanSync({ cwd: scratch })) {
            await cp(path.join(scratch, file), path.join(outdir, file));
        }
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

console.log(`${pkg.name}: js ${jsMs.toFixed(0)} ms, total ${(performance.now() - started).toFixed(0)} ms`);
