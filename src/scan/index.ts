import { existsSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { readGuarantees } from './guarantees';
import { analyseScope } from './program';
import { dropIgnored } from './ignored';
import type { Scope } from './report';
import type { ScanResult } from './report';
import { type Site } from './shapes';

/** Directories never read: this is not the project's code. */
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.next', '.nuxt']);

const SOURCE = /\.(?:ts|tsx|mts|cts)$/u;
const GENERATED = /\.d\.ts$/u;

/** Specs are not production code: their fixtures are not defects. */
const TEST = /\.(?:spec|test|e2e-spec)\.[cm]?tsx?$/u;

/**
 * Code the pass cannot parse. Counted and declared, never skipped in silence: a
 * `<script setup lang="ts">` holds real TypeScript that we are not looking at.
 */
const UNPARSED = /\.(vue|svelte|astro|jsx?|mjs|cjs)$/u;

export type ScanOptions = {
    readonly root: string;
    readonly tsconfig?: string;
};

/** A purely static pass: reads, parses, runs nothing. */
export async function scan({ root, tsconfig }: ScanOptions): Promise<ScanResult> {
    const configs = tsconfig === undefined ? await findConfigs(root) : [tsconfig];
    const guarantees: readonly Scope[] = configs.map((path) => ({
        path: relative(root, path) || path,
        guarantees: readGuarantees(path),
    }));
    // Type checking happens per scope: one TypeScript program per tsconfig.
    const seen = new Set<string>();
    const sites: Site[] = [];
    const refused: { path: string; reason: string }[] = [];
    for (const path of configs) {
        const analysis = analyseScope(root, path);
        if (analysis.kind === 'refused') {
            refused.push({ path: relative(root, path) || path, reason: analysis.reason });
            continue;
        }
        // A file belonging to two scopes would be counted twice.
        for (const site of analysis.sites) {
            // A tsconfig found by climbing covers more than the directory asked for.
            // Type checking benefits; the report does not: those sites were not asked for.
            if (site.file.startsWith('..')) {
                continue;
            }
            // The excerpt is part of the key: a signature carries one question per parameter, all
            // on the same line. The same site seen through two scopes yields the same excerpt, so
            // the duplicate is still dropped.
            const key = `${site.kind}\u0000${site.file}\u0000${site.line}\u0000${site.excerpt}`;
            if (!seen.has(key)) {
                seen.add(key);
                sites.push(site);
            }
        }
    }

    const skipped = new Map<string, number>();
    let filesScanned = 0;
    let testsExcluded = 0;

    // The walk now only serves honest accounting: what was not looked at.
    const { paths, unreadable } = await walkTracked(root);
    for (const path of paths) {
        const unparsed = UNPARSED.exec(path)?.[1];
        if (unparsed !== undefined) {
            skipped.set(unparsed, (skipped.get(unparsed) ?? 0) + 1);
            continue;
        }
        if (TEST.test(path)) {
            testsExcluded += 1;
            continue;
        }
        filesScanned += 1;
    }
    return { guarantees, sites, filesScanned, unreadable, skipped, testsExcluded, refused };
}

/** Everything the walk finds, minus what the repository sets aside, plus what it could not open. */
async function walkTracked(root: string): Promise<{ readonly paths: readonly string[]; readonly unreadable: readonly string[] }> {
    const found: string[] = [];
    const unreadable: string[] = [];
    for await (const path of walk(root, unreadable)) {
        found.push(path);
    }
    return {
        paths: await dropIgnored(root, found),
        unreadable: unreadable.map((path) => relative(root, path) || path),
    };
}

/** A monorepo has one tsconfig per app: construction guarantees are evaluated scope by scope. */
async function* walkConfigs(directory: string): AsyncGenerator<string> {
    // Unreadable here means one thing only: no scope was found under it. The accounting walk
    // covers the same tree and is the one that reports the path, so it is not named twice.
    const entries = await readEntries(directory);
    if (entries === undefined) {
        return;
    }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !IGNORED.has(entry.name)) {
            yield* walkConfigs(path);
        } else if (entry.isFile() && entry.name === 'tsconfig.json') {
            yield path;
        }
    }
}

async function findConfigs(root: string): Promise<readonly string[]> {
    const found: string[] = [];
    for await (const path of walkConfigs(root)) {
        found.push(path);
    }
    const kept = await dropIgnored(root, found);
    return kept.length > 0 ? kept : climbForConfig(root);
}

/**
 * The first `tsconfig.json` found by climbing, when the descent gave nothing.
 *
 * Aiming at a subdirectory is the common gesture — `scan src/context/identity`. There is
 * no tsconfig in there, but the app's covers it: without this climb, the pass answered
 * "no scope" on a perfectly analysable directory, in silence.
 *
 * We stop at the first one found, and never above the repository root: a tsconfig two
 * levels above the project no longer describes it.
 */
function climbForConfig(root: string): readonly string[] {
    let current = resolve(root);
    for (;;) {
        const candidate = join(current, 'tsconfig.json');
        if (existsSync(candidate)) {
            return [candidate];
        }
        if (existsSync(join(current, '.git'))) {
            return [];
        }
        const parent = dirname(current);
        if (parent === current) {
            return [];
        }
        current = parent;
    }
}

/** The production TypeScript files, tests excluded. Shared with mutation. */
export async function collectSources(root: string): Promise<readonly string[]> {
    // A single file is a legitimate scope: that is how you iterate on one module.
    if ((await stat(root)).isFile()) {
        return SOURCE.test(root) && !GENERATED.test(root) ? [root] : [];
    }
    const { paths } = await walkTracked(root);
    return paths.filter((path) => !UNPARSED.test(path) && !TEST.test(path));
}

/**
 * The entries of a directory, or nothing when it does not open.
 *
 * A directory the process cannot open used to abort the whole scan: one folder with the wrong
 * mode, and a repository came back with no answer at all. Both walks step over it instead,
 * because a scan that stops has nothing to say about the rest of the tree.
 */
async function readEntries(directory: string): Promise<readonly Dirent[] | undefined> {
    try {
        return await readdir(directory, { withFileTypes: true });
    } catch {
        return undefined;
    }
}

async function* walk(directory: string, unreadable: string[]): AsyncGenerator<string> {
    const entries = await readEntries(directory);
    if (entries === undefined) {
        unreadable.push(directory);
        return;
    }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED.has(entry.name)) {
                yield* walk(path, unreadable);
            }
        } else if ((SOURCE.test(entry.name) || UNPARSED.test(entry.name)) && !GENERATED.test(entry.name)) {
            yield path;
        }
    }
}

export { reportScan, type ScanResult } from './report';
export type { Guarantee, Guarantees } from './guarantees';
export { findShapes, type ShapeKind, type Site } from './shapes';
