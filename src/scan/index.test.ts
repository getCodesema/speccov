import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from './index';

/**
 * A directory the process cannot open.
 *
 * The walk used to let the `readdir` failure through, so a single folder with the wrong mode
 * aborted the scan of the whole repository: no site, no accounting, no message. The answer is
 * not to fall silent either, which is what an ignored failure would amount to. It is recorded,
 * stepped over, and reported.
 */
let directory = '';

/** Running as root defeats the mode: `readdir` succeeds and there is nothing to observe. */
const asRoot = process.getuid?.() === 0;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'speccov-walk-'));
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', noEmit: true }, include: ['src'] }),
        'utf8',
    );
    await mkdir(join(directory, 'src'));
    await writeFile(
        join(directory, 'src', 'service.ts'),
        'declare function load(x: string): Promise<void>;\nexport async function go(xs: string[]): Promise<void> {\n    await Promise.all(xs.map((x) => load(x)));\n}\n',
        'utf8',
    );
    await mkdir(join(directory, 'locked'));
    await writeFile(join(directory, 'locked', 'hidden.ts'), 'export const hidden = 1;\n', 'utf8');
    await chmod(join(directory, 'locked'), 0o000);
});

afterEach(async () => {
    // Given back before the removal: a directory at mode 000 cannot be emptied either.
    await chmod(join(directory, 'locked'), 0o755).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
});

test.skipIf(asRoot)('a directory the walk cannot open is recorded, not fatal', async () => {
    const result = await scan({ root: directory });

    expect(result.unreadable).toEqual(['locked']);
});

test.skipIf(asRoot)('the rest of the tree is still read', async () => {
    const result = await scan({ root: directory });

    expect(result.sites.map(({ kind }) => kind)).toContain('unbounded-fanout');
    expect(result.filesScanned).toBe(1);
});

test('a tree that opens everywhere reports nothing unreadable', async () => {
    await chmod(join(directory, 'locked'), 0o755);
    const result = await scan({ root: directory });

    expect(result.unreadable).toEqual([]);
    // The file behind the mode is counted once the directory opens: same walk, different answer.
    expect(result.filesScanned).toBe(2);
});
