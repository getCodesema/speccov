import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { climbFor } from './climb';

export const IGNORE_FILE = '.speccovignore';

/** Says whether a path was set aside by the project. */
export type Ignore = (path: string) => boolean;

/**
 * The perimeter the project declares, read from the nearest `.speccovignore`.
 *
 * A test harness or a browser-side client is real code, but not where a value enters the
 * system: its sites drown the ones that matter. Nothing can tell that from the code alone
 * without guessing by name, so the project says it, in a versioned file, and the report
 * counts what was left out instead of keeping quiet about it.
 *
 * Patterns are relative to the directory of the file, as in a `.gitignore`: the same line
 * holds whether the scan aims at the repository or at one of its directories.
 */
export async function loadIgnore(root: string): Promise<Ignore> {
    const file = climbFor(IGNORE_FILE, root);
    if (file === undefined) {
        return () => false;
    }
    const matches = parseIgnore(await readFile(file, 'utf8'));
    const base = dirname(file);
    return (path) => matches(relative(base, resolve(path)).split(sep).join('/'));
}

/**
 * The subset of the `.gitignore` syntax a perimeter needs: `*`, `?`, `**`, comments, a
 * leading `/` to anchor, and a line without a slash matching at any depth. A directory
 * takes everything under it.
 */
export function parseIgnore(content: string): Ignore {
    const patterns = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .flatMap(toPatterns);
    return (path) => patterns.some((pattern) => pattern.test(path));
}

function toPatterns(line: string): readonly RegExp[] {
    // Read as a plain pattern, a negation would set aside the very files it means to keep.
    if (line.startsWith('!')) {
        throw new Error(`speccov: ${IGNORE_FILE} does not support negation ("${line}"). Narrow the pattern above it instead.`);
    }
    const path = line.replace(/\/$/u, '');
    const glob = path.includes('/') ? path.replace(/^\//u, '') : `**/${path}`;
    return [toRegExp(glob), toRegExp(`${glob}/**`)];
}

const GLOB = new Map([
    ['**/', '(?:.*/)?'],
    ['**', '.*'],
    ['*', '[^/]*'],
    ['?', '[^/]'],
]);

function toRegExp(glob: string): RegExp {
    const source = glob.replaceAll(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/gu, (token) => GLOB.get(token) ?? `\\${token}`);
    return new RegExp(`^${source}$`, 'u');
}
