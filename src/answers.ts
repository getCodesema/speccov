import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EPSILON } from './growth';
import type { Lacuna, Verdict } from './rule';

/**
 * A human answer to a gap, made mechanisable.
 *
 * Accepting is writing a rule: `magnitude` is the accepted threshold. Past it, this is no
 * longer the question someone answered — it is a violation.
 */
export type Answer = {
    readonly rule: string;
    readonly magnitude: number;
    /** What was being measured at the moment of acceptance. */
    readonly detail: string;
    /** Date of the acceptance. */
    readonly at: string;
    /** Why it is intended. Optional, but it is what gets reread in six months. */
    readonly why?: string;
};

export const DEFAULT_ANSWERS_PATH = '.speccov/answers.json';

type AnswerFile = {
    readonly version: 1;
    readonly answers: readonly Answer[];
};

/**
 * Loads the answers. A missing file is normal — it is the first pass.
 *
 * An unreadable file **throws**: taking it for an empty file would make everything noisy,
 * taking it for "everything accepted" would make it blind. Both are worse than a halt.
 */
export async function loadAnswers(path: string): Promise<readonly Answer[]> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw cause;
    }
    return parseAnswers(JSON.parse(raw), path);
}

export async function saveAnswers(path: string, answers: readonly Answer[]): Promise<void> {
    const file: AnswerFile = { version: 1, answers: [...answers].sort((left, right) => left.rule.localeCompare(right.rule)) };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(file, null, 4)}\n`, 'utf8');
}

export function parseAnswers(value: unknown, path: string): readonly Answer[] {
    const file = value as Partial<AnswerFile> | null;
    if (file === null || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.answers)) {
        throw new Error(`speccov: ${path} is not a valid answers file (expected { version: 1, answers: [] }).`);
    }
    return file.answers.map((answer, index) => parseAnswer(answer, path, index));
}

function parseAnswer(value: unknown, path: string, index: number): Answer {
    const answer = value as Partial<Answer> | null;
    const valid =
        answer !== null &&
        typeof answer === 'object' &&
        typeof answer.rule === 'string' &&
        typeof answer.magnitude === 'number' &&
        Number.isFinite(answer.magnitude) &&
        typeof answer.detail === 'string' &&
        typeof answer.at === 'string';
    if (!valid) {
        throw new Error(`speccov: answer ${index} is unreadable in ${path}.`);
    }
    return typeof answer.why === 'string'
        ? { ...(answer as Answer) }
        : { rule: answer.rule, magnitude: answer.magnitude, detail: answer.detail, at: answer.at };
}

export type Applied = {
    readonly verdicts: readonly Verdict[];
    /** Gaps kept quiet because a human already answered. Counted, never invisible. */
    readonly accepted: readonly Lacuna[];
};

/**
 * Applies the known answers.
 *
 * An accepted gap disappears from the report but stays counted. An accepted gap whose
 * magnitude has passed the threshold becomes visible again — as a violation, because a
 * human had ruled on it and the fact changed under them.
 */
export function applyAnswers(verdicts: readonly Verdict[], answers: readonly Answer[]): Applied {
    const byRule = new Map(answers.map((answer) => [answer.rule, answer]));
    const kept: Verdict[] = [];
    const accepted: Lacuna[] = [];

    for (const verdict of verdicts) {
        const answer = verdict.kind === 'lacuna' ? byRule.get(verdict.rule.name) : undefined;
        if (answer === undefined || verdict.kind !== 'lacuna') {
            kept.push(verdict);
        } else if (verdict.magnitude <= answer.magnitude + EPSILON) {
            accepted.push(verdict);
        } else {
            kept.push({
                kind: 'infraction',
                rule: verdict.rule,
                measurements: verdict.measurements,
                magnitude: verdict.magnitude,
                detail: `${verdict.detail}. Accepted on ${answer.at} at a magnitude of ${round(answer.magnitude)}; the threshold is exceeded.`,
            });
        }
    }
    return { verdicts: kept, accepted };
}

/** Turns a gap into a "this is intended" answer, at the threshold measured today. */
export function accept(lacuna: Lacuna, at: string, why?: string): Answer {
    const answer = { rule: lacuna.rule.name, magnitude: lacuna.magnitude, detail: lacuna.detail, at };
    return why === undefined || why.trim() === '' ? answer : { ...answer, why: why.trim() };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
