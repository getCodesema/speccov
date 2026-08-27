import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { firstBlocking } from './guarantees';
import { findShapes, type Site } from './shapes';

/**
 * What a scope gave: its sites, or the reason for its silence.
 *
 * The second case is not a detail. A program that does not build — dependencies missing,
 * an `extends` that cannot be found, a generated file absent — must not make the tool fall
 * back on a guess: it would then produce exactly the false positives that type checking
 * removes, under a look of rigour.
 */
export type Analysis =
    | { readonly kind: 'analysed'; readonly sites: readonly Site[]; readonly filesTyped: number }
    | { readonly kind: 'refused'; readonly reason: string };

/** A file that carries no project code: neither test, nor installed dependency. */
const TEST = /\.(?:spec|test|e2e-spec)\.[cm]?tsx?$/u;
const DECLARATION = /\.d\.ts$/u;

/**
 * The files speccov writes itself: they carry **the answer**, not the question.
 *
 * A `.rules.ts` holds the doubles that measure the site — among them a
 * `mockResolvedValue({ items, total })` that looks like a paginated return. Without this
 * exclusion, `scan` re-reads its own drafts and reports its own fixture: measured on a
 * real-world monorepo, `list-admin-users.rules.ts:84` came out a `metamorphic()` candidate.
 */
const RULES = /\.rules\.[cm]?ts$/u;

export function analyseScope(root: string, tsconfigPath: string): Analysis {
    const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (error !== undefined) {
        return { kind: 'refused', reason: flatten(error) };
    }
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirOf(tsconfigPath));

    // Same discipline as the flag read. Without it, speccov built a program on a broken
    // `extends`: TypeScript falls back to its defaults, the types degrade, and the sites
    // came out presented as sound.
    const blocking = firstBlocking(parsed.errors);
    if (blocking !== undefined) {
        return { kind: 'refused', reason: flatten(blocking) };
    }

    // A "solution" tsconfig — `files: []` plus `references` — compiles nothing itself.
    // Stopping there silenced four scopes out of nineteen in a real-world monorepo.
    const references = parsed.projectReferences ?? [];
    if (parsed.fileNames.length === 0 && references.length > 0) {
        return delegate(root, references);
    }
    if (parsed.fileNames.length === 0) {
        return { kind: 'refused', reason: 'no input file in this scope' };
    }

    // Asked before the program is built, not after. A generated scope declares two files, both
    // of them declarations, and building its program still costs a second and a half: measured
    // on codesema, six `.nuxt/tsconfig.*` spent 15s of a 35s scan to type four files between
    // them. The loop below would have skipped every one of them anyway.
    // Analysed and empty, never refused: there is nothing here to read, which is not the same
    // as being unable to read it. Refusing would propagate through `delegate` and silence the
    // whole app the generated scope belongs to — 14s saved against two scopes lost.
    if (!parsed.fileNames.some(isWorthTyping)) {
        return { kind: 'analysed', sites: [], filesTyped: 0 };
    }

    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    const sites: Site[] = [];
    let filesTyped = 0;

    for (const source of program.getSourceFiles()) {
        const path = source.fileName;
        if (source.isDeclarationFile || !isWorthTyping(path)) {
            continue;
        }
        filesTyped += 1;
        sites.push(...findShapes(source, checker, relative(root, path) || path));
    }
    return { kind: 'analysed', sites, filesTyped };
}

/**
 * Is this file one the pass would read?
 *
 * The same question decides twice: whether a scope is worth a program, and whether a source is
 * worth walking. Two lists would drift, and the first one would then pay for scopes the second
 * throws away.
 */
function isWorthTyping(path: string): boolean {
    return !DECLARATION.test(path) && !TEST.test(path) && !RULES.test(path) && !path.includes('/node_modules/');
}

/** Analyses each referenced project and joins their sites. One unreadable refuses them all. */
function delegate(root: string, references: readonly ts.ProjectReference[]): Analysis {
    const sites: Site[] = [];
    let filesTyped = 0;
    for (const reference of references) {
        const resolved = resolveReference(reference.path);
        if (resolved === undefined) {
            return { kind: 'refused', reason: `referenced project ${reference.path} was not found` };
        }
        const part = analyseScope(root, resolved);
        if (part.kind === 'refused') {
            return { kind: 'refused', reason: `${reference.path}: ${part.reason}` };
        }
        sites.push(...part.sites);
        filesTyped += part.filesTyped;
    }
    return { kind: 'analysed', sites, filesTyped };
}

function resolveReference(path: string): string | undefined {
    if (ts.sys.directoryExists(path)) {
        const inside = `${path}/tsconfig.json`;
        return ts.sys.fileExists(inside) ? inside : undefined;
    }
    return ts.sys.fileExists(path) ? path : undefined;
}

/**
 * The tsconfig's directory, **absolute**.
 *
 * `ts.sys.readDirectory` does not resolve a relative `basePath` against the current
 * directory: it yields zero files, with no diagnostic other than TS18003. A
 * `speccov scan ../other-repo` then refused all nineteen scopes of a real-world monorepo —
 * a green report on zero lines read.
 */
function dirOf(path: string): string {
    const cut = path.lastIndexOf('/');
    return resolve(cut === -1 ? '.' : path.slice(0, cut));
}

function flatten(diagnostic: ts.Diagnostic): string {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}
