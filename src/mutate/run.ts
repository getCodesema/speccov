import { readFile, writeFile } from 'node:fs/promises';
import { applyMutant, findMutants, type Mutant } from './mutators';

export type Fate = 'killed' | 'survived';

export type Outcome = {
    readonly mutant: Mutant;
    readonly fate: Fate;
};

export type MutateOptions = {
    readonly files: readonly string[];
    /** Command that judges the mutant. Non-zero exit ⇒ the mutant is killed. */
    readonly command: readonly string[];
    readonly cwd: string;
    /** Budget: maximum number of mutants tried. */
    readonly limit: number;
    readonly onProgress?: (done: number, total: number) => void;
};

export type MutateResult = {
    readonly outcomes: readonly Outcome[];
    /** Mutants generated but not tried, out of budget. Counted, never silenced. */
    readonly skipped: number;
};

/**
 * Tries every mutant: alter the file, run the command, restore.
 *
 * A **surviving** mutant is a gap in the strong sense: the behaviour of the code was changed
 * and nothing — no rule, no test — objected.
 *
 * The restore is in a `finally` and the original file is held in memory: even a command that
 * crashes leaves the source intact. On top of that the caller must require a clean repository,
 * so that a `git checkout` always remains a way out.
 */
export async function mutate(options: MutateOptions): Promise<MutateResult> {
    const all = await generate(options.files);
    const budgeted = all.slice(0, options.limit);
    const outcomes: Outcome[] = [];

    for (const [index, mutant] of budgeted.entries()) {
        options.onProgress?.(index + 1, budgeted.length);
        outcomes.push({ mutant, fate: await tryMutant(mutant, options) });
    }
    return { outcomes, skipped: all.length - budgeted.length };
}

export async function generate(files: readonly string[]): Promise<readonly Mutant[]> {
    const mutants: Mutant[] = [];
    for (const file of files) {
        mutants.push(...findMutants(file, await readFile(file, 'utf8')));
    }
    return mutants;
}

async function tryMutant(mutant: Mutant, options: MutateOptions): Promise<Fate> {
    const original = await readFile(mutant.file, 'utf8');
    try {
        await writeFile(mutant.file, applyMutant(original, mutant), 'utf8');
        return (await run(options)) === 0 ? 'survived' : 'killed';
    } finally {
        await writeFile(mutant.file, original, 'utf8');
    }
}

async function run({ command, cwd }: MutateOptions): Promise<number> {
    const child = Bun.spawn([...command], { cwd, stdout: 'ignore', stderr: 'ignore' });
    return child.exited;
}
