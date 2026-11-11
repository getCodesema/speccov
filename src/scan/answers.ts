import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ShapeKind, Site } from './shapes';

/**
 * A human answer to a candidate site, made mechanisable.
 *
 * `scan` is the cheapest entry point, so it is the one that runs in CI and in an agent loop —
 * and until now it was the only one with nowhere to write an answer down. A site ruled out by
 * a human came back identical at the next pass, carrying the same weight as a real N+1. For an
 * agent that is worse than noise: the README's own worst case, "degrading code that was fine",
 * needs exactly this to happen twice.
 *
 * What is remembered is a **shape**, never a line. A site moves down a file every time
 * something is inserted above it, and an answer keyed on a line number would expire on the
 * next commit, which is a way of remembering nothing.
 */
export type SiteAnswer = {
    /** The file the site sits in, relative to the scanned root. */
    readonly file: string;
    /** Which question was answered: the same code can carry two. */
    readonly kind: ShapeKind;
    /** The code that was ruled on, whitespace normalised. */
    readonly shape: string;
    /** Date of the acceptance. */
    readonly at: string;
    /** Why it is not a defect. Optional, but it is what gets reread in six months. */
    readonly why?: string;
};

export const DEFAULT_SCAN_ANSWERS_PATH = '.speccov/scan-answers.json';

type SiteAnswerFile = {
    readonly version: 1;
    readonly sites: readonly SiteAnswer[];
};

/**
 * Loads the answered sites. A missing file is normal — it is the first pass.
 *
 * An unreadable file **throws**, for the same reason `answers.ts` throws: read as empty it
 * makes every pass noisy, read as "all accepted" it makes the pass blind. Both are worse than
 * a halt.
 */
export async function loadSiteAnswers(path: string): Promise<readonly SiteAnswer[]> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw cause;
    }
    return parseSiteAnswers(JSON.parse(raw), path);
}

export async function saveSiteAnswers(path: string, answers: readonly SiteAnswer[]): Promise<void> {
    const sorted = [...answers].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
    const file: SiteAnswerFile = { version: 1, sites: sorted };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(file, null, 4)}\n`, 'utf8');
}

export function parseSiteAnswers(value: unknown, path: string): readonly SiteAnswer[] {
    const file = value as Partial<SiteAnswerFile> | null;
    if (file === null || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.sites)) {
        throw new Error(`speccov: ${path} is not a valid scan answers file (expected { version: 1, sites: [] }).`);
    }
    return file.sites.map((answer, index) => parseSiteAnswer(answer, path, index));
}

function parseSiteAnswer(value: unknown, path: string, index: number): SiteAnswer {
    const answer = value as Partial<SiteAnswer> | null;
    const valid =
        answer !== null &&
        typeof answer === 'object' &&
        typeof answer.file === 'string' &&
        typeof answer.kind === 'string' &&
        typeof answer.shape === 'string' &&
        typeof answer.at === 'string';
    if (!valid) {
        throw new Error(`speccov: answered site ${index} is unreadable in ${path}.`);
    }
    const kept: SiteAnswer = { file: answer.file, kind: answer.kind as ShapeKind, shape: answer.shape, at: answer.at };
    return typeof answer.why === 'string' ? { ...kept, why: answer.why } : kept;
}

export type AppliedSites = {
    /** What the report still has to ask about. */
    readonly sites: readonly Site[];
    /** Sites kept quiet because a human already ruled. Counted, never invisible. */
    readonly accepted: readonly Site[];
};

/**
 * Applies the known answers to what this pass found.
 *
 * A site whose shape has not moved goes quiet, and stays counted. A site whose code changed
 * comes back: the answer bore on the code as it read that day, and it is not the same question
 * any more. That is the same refusal as an exceeded threshold in `answers.ts` — an acceptance
 * is a rule the build defends, not a permanent silence.
 */
export function applySiteAnswers(sites: readonly Site[], answers: readonly SiteAnswer[]): AppliedSites {
    const known = new Set(answers.map(keyOf));
    const kept: Site[] = [];
    const accepted: Site[] = [];
    for (const site of sites) {
        (known.has(keyOf(asAnswer(site))) ? accepted : kept).push(site);
    }
    return { sites: kept, accepted };
}

/** Turns a site into a "this is not a defect" answer, on the code as it reads today. */
export function acceptSite(site: Site, at: string, why?: string): SiteAnswer {
    const answer = { ...asAnswer(site), at };
    return why === undefined || why.trim() === '' ? answer : { ...answer, why: why.trim() };
}

function asAnswer(site: Site): Omit<SiteAnswer, 'at'> {
    return { file: site.file, kind: site.kind, shape: shapeOf(site.excerpt) };
}

/**
 * What makes two sites the same one.
 *
 * The line is left out on purpose: it moves with every insertion above. What is left is the
 * file, the question asked, and the code itself — which is what a human actually ruled on.
 */
function keyOf(answer: Omit<SiteAnswer, 'at'>): string {
    return `${answer.file} · ${answer.kind} · ${canonical(answer.shape)}`;
}

/**
 * The code with its layout dropped: reformatting is not a new question.
 *
 * Kept readable on purpose, because the answers file is read in review — the harsher form
 * below is for comparing, never for storing. Note the one thing this cannot absorb: the
 * excerpt is truncated, so a reformat long enough to move the cut asks again. The cautious
 * direction, and the same one as everywhere else.
 */
export function shapeOf(excerpt: string): string {
    return excerpt.replace(/\s+/gu, ' ').trim();
}

/**
 * What a formatter is allowed to change without it becoming another site: whitespace, and the
 * trailing comma prettier adds when it breaks a call across lines.
 */
function canonical(shape: string): string {
    return shape.replace(/\s+/gu, '').replace(/,(?=[)\]}])/gu, '');
}
