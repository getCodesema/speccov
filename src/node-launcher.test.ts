import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LAUNCHER = resolve(import.meta.dir, '../bin/speccov.mjs');

/**
 * A rules file as a real project writes it: everything in it is something Node refuses to
 * load by itself. It throws unless each piece came out right, so exit 0 is the proof.
 */
const PROJECT: Readonly<Record<string, string>> = {
    'tsconfig.json': JSON.stringify({
        compilerOptions: { experimentalDecorators: true, paths: { '@lib/*': ['./lib/*'] } },
    }),
    'lib/level.ts': `export enum Level { Low, High }\n`,
    'helper.ts': `export const label = (level: number): string => \`level:\${level}\`;\n`,
    'project.rules.ts': `
import { label } from './helper';
import { Level } from '@lib/level';

function tagged(target: { tag?: string }): void {
    target.tag = 'tagged';
}

@tagged
class Subject {
    static tag?: string;
    constructor(private readonly level: Level) {}
    describe(): string {
        return label(this.level);
    }
}

if (new Subject(Level.High).describe() !== 'level:1' || Subject.tag !== 'tagged') {
    throw new Error('the project was not compiled the way its tsconfig asks');
}

export default [];
`,
};

test('Node runs a rules file written in the TypeScript Node cannot load by itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speccov-node-'));
    await mkdir(join(root, 'lib'));
    for (const [name, content] of Object.entries(PROJECT)) {
        await writeFile(join(root, name), content, 'utf8');
    }

    const child = Bun.spawnSync(['node', LAUNCHER, join(root, 'project.rules.ts')], { stderr: 'pipe' });

    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
});

test('the bin path is written the way npm keeps it', async () => {
    // At publish time npm drops a bin whose path starts with "./", behind a warning: the
    // package then installs without its command.
    const manifest = (await Bun.file(resolve(import.meta.dir, '../package.json')).json()) as { bin: Record<string, string> };

    expect(Object.values(manifest.bin).filter((path) => path.startsWith('./'))).toEqual([]);
});
