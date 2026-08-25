import { resolve } from 'node:path';
import { draft } from './index';
import type { Site } from '../scan/shapes';

export type Drafted = {
    readonly file: string;
    readonly line: number;
    readonly path: string;
    readonly todos: readonly string[];
    readonly content: string;
};

export type SweepResult = {
    readonly drafted: readonly Drafted[];
    /** The refusals, by reason: the map of what `draft` cannot read yet. */
    readonly refusedBy: ReadonlyMap<string, number>;
    readonly tried: number;
};

/** Only these shapes go through a `.map()`: the others have no site to wire. */
const DRAFTABLE = new Set(['unbounded-fanout', 'async-per-item']);

/**
 * Runs `draft` on every site `scan` found.
 *
 * The missing link: `scan` points, `draft` writes, and until now it was a human copying a
 * `file:line` from one to the other. An agent will not do it any more than a tired human
 * will.
 *
 * Refusals are **counted by reason**, not thrown away. It is the only honest measure of
 * what the bridge covers: across five third-party repos, it was 0 out of 350.
 */
export async function sweep(root: string, sites: readonly Site[]): Promise<SweepResult> {
    const drafted: Drafted[] = [];
    const refusedBy = new Map<string, number>();
    let tried = 0;

    for (const site of sites) {
        if (!DRAFTABLE.has(site.kind)) {
            continue;
        }
        tried += 1;
        const result = await draft(resolve(root, site.file), site.line);
        if (result.kind === 'refused') {
            const reason = family(result.reason);
            refusedBy.set(reason, (refusedBy.get(reason) ?? 0) + 1);
            continue;
        }
        drafted.push({
            file: site.file,
            line: site.line,
            path: result.draft.path,
            todos: result.draft.todos,
            content: result.draft.content,
        });
    }
    // Two shapes can land on the same `.map()` — the `Promise.all` and the per-item call —
    // and then produce the same file. We keep the most complete draft, never two concurrent
    // writes to the same path.
    const best = new Map<string, Drafted>();
    for (const entry of drafted) {
        const kept = best.get(entry.path);
        if (kept === undefined || entry.todos.length < kept.todos.length) {
            best.set(entry.path, entry);
        }
    }
    return { drafted: [...best.values()], refusedBy, tried };
}

/**
 * The reason, without the file name nor the class name.
 *
 * Three hundred all-distinct refusals do not get read; grouped by family, they say where to
 * put the effort. It is the same gesture as the "Not measured" section of the report.
 */
function family(reason: string): string {
    return reason
        .replace(/"[^"]*"/gu, '…')
        .replace(/at line \d+ of \S+/u, 'at this line')
        .replace(/^\S+ could not be/u, 'the file could not be');
}
