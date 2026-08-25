import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropIgnored } from './ignored';

let root = '';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'speccov-ignored-'));
});

afterEach(() => {
    // The temporary directory stays: nothing recursive deletes it here.
    root = '';
});

async function repository(): Promise<void> {
    Bun.spawnSync(['git', 'init', '-q', root]);
    await writeFile(join(root, '.gitignore'), 'copy/\n', 'utf8');
}

test('a path the repository sets aside leaves the scan', async () => {
    await repository();

    const kept = await dropIgnored(root, [join(root, 'src/a.ts'), join(root, 'copy/a.ts')]);

    expect(kept).toEqual([join(root, 'src/a.ts')]);
});

test('outside a git repository, no path is lost', async () => {
    const paths = [join(root, 'src/a.ts'), join(root, 'copy/a.ts')];

    expect(await dropIgnored(root, paths)).toEqual(paths);
});

test('with no path to filter, git is not disturbed', async () => {
    expect(await dropIgnored(root, [])).toEqual([]);
});
