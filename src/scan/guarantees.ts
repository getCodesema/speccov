import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export type Guarantee = {
    readonly flag: string;
    /** What the flag proves, in one sentence. */
    readonly proves: string;
    readonly enabled: boolean;
};

/**
 * `impliedByStrict` matters: `parseJsonConfigFileContent` keeps `strict: true` as-is and
 * leaves the flags it implies at `undefined`. Read naively, they would be called off.
 */
const FLAGS: readonly { flag: string; proves: string; impliedByStrict: boolean }[] = [
    { flag: 'strictNullChecks', proves: 'no value is implicitly nullable', impliedByStrict: true },
    { flag: 'noImplicitAny', proves: 'no parameter falls back to the any type', impliedByStrict: true },
    { flag: 'useUnknownInCatchVariables', proves: 'a caught error is never typed any', impliedByStrict: true },
    { flag: 'strictFunctionTypes', proves: 'function types are checked contravariantly', impliedByStrict: true },
    { flag: 'strictPropertyInitialization', proves: 'no class property stays uninitialised', impliedByStrict: true },
    { flag: 'noUncheckedIndexedAccess', proves: 'every indexed access is treated as possibly absent', impliedByStrict: false },
    { flag: 'exactOptionalPropertyTypes', proves: 'an optional property cannot receive undefined', impliedByStrict: false },
    { flag: 'noFallthroughCasesInSwitch', proves: 'no switch case falls through in silence', impliedByStrict: false },
    { flag: 'noImplicitOverride', proves: 'no method overrides a parent by accident', impliedByStrict: false },
    { flag: 'noPropertyAccessFromIndexSignature', proves: 'no dot access on an index signature', impliedByStrict: false },
];

/**
 * The result of a read. The `unresolved` case exists because an unresolved `extends` makes
 * TypeScript fall back to its defaults **in silence**: concluding "nothing is proven" then
 * fires a broadside of false alarms on a project that is in fact full strict.
 *
 * A tool you trust does not guess. It says it could not.
 */
/**
 * TS18003, "No inputs were found in config file".
 *
 * The only diagnostic ignored, and by name: it bears on the files to compile, never on
 * the `compilerOptions` we came to read. Every other code stays blocking — an unknown
 * diagnostic must not become a green light.
 */
const NO_INPUTS_FOUND = 18_003;

/**
 * TS6046, "Argument for '--x' option must be: …".
 *
 * A **value** error, not a resolution one: the file was found, the `extends` was followed,
 * the other options are read right. Only the value of one option is unrecognised —
 * typically a `lib` newer than the TypeScript shipped here.
 *
 * The distinction is fundamental. An `extends` that cannot be found makes EVERY option
 * fall back to its default in silence: blocking. An unknown value on an option we do not
 * read touches none of the flags: not blocking — but declared, never swallowed.
 */
const OPTION_VALUE = 6046;

const OPTION_NAMED = /Argument for '--(?<option>[a-zA-Z]+)' option/u;

export type Guarantees =
    | {
          readonly kind: 'read';
          readonly flags: readonly Guarantee[];
          /** Options whose value speccov's compiler did not recognise. Declared, never silenced. */
          readonly unrecognised: readonly string[];
      }
    | { readonly kind: 'unresolved'; readonly path: string; readonly reason: string };

/**
 * Reads what the compiler already proves, `extends` resolved.
 *
 * These guarantees cost nothing: no rule, no test, no question. Naming them is what
 * makes the rest of the report short.
 */
export function readGuarantees(tsconfigPath: string): Guarantees {
    return readScope(tsconfigPath, new Set());
}

function readScope(tsconfigPath: string, seen: Set<string>): Guarantees {
    if (seen.has(tsconfigPath)) {
        return { kind: 'unresolved', path: tsconfigPath, reason: 'circular reference between projects' };
    }
    seen.add(tsconfigPath);

    const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (error !== undefined) {
        return { kind: 'unresolved', path: tsconfigPath, reason: flatten(error) };
    }
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(tsconfigPath));
    const unrecognised: string[] = [];
    for (const diagnostic of parsed.errors) {
        if (diagnostic.code === NO_INPUTS_FOUND) {
            continue;
        }
        const option = harmless(diagnostic);
        if (option === undefined) {
            return { kind: 'unresolved', path: tsconfigPath, reason: flatten(diagnostic) };
        }
        unrecognised.push(option);
    }

    const references = parsed.projectReferences ?? [];
    if (references.length > 0 && parsed.fileNames.length === 0) {
        return delegated(tsconfigPath, references, seen, unrecognised);
    }
    return {
        kind: 'read',
        flags: flagsOf(parsed.options, strictByDefault(dirname(tsconfigPath))),
        unrecognised: [...new Set(unrecognised)],
    };
}

/**
 * TypeScript 6 turned `strict` on by default. The default that counts is the one of the
 * compiler the project runs, not the one shipped here: read with ours, a TS 6 project that
 * never writes `strict` was called lukewarm in every scope.
 */
function strictByDefault(directory: string): boolean {
    return Number(projectTypeScriptVersion(directory).split('.')[0]) >= 6;
}

/** The version of the TypeScript the project resolves, or ours when it resolves none. */
function projectTypeScriptVersion(directory: string): string {
    try {
        const manifest: unknown = createRequire(join(resolve(directory), 'tsconfig.json'))('typescript/package.json');
        const version = (manifest as { version?: unknown }).version;
        return typeof version === 'string' ? version : ts.version;
    } catch {
        // TODO(ceiling): no TypeScript resolvable from the project, ours stands in and can call a TS 6 project lukewarm: declare it in "Not measured".
        return ts.version;
    }
}

/**
 * The first diagnostic that forbids concluding, or `undefined` if all of them are harmless.
 *
 * Shared with building the typed program: two parallel disciplines would have drifted, and
 * that is exactly what happened — type checking accepted a broken `extends` that the flag
 * read refused, then announced its types as sound.
 */
export function firstBlocking(errors: readonly ts.Diagnostic[]): ts.Diagnostic | undefined {
    return errors.find((diagnostic) => diagnostic.code !== NO_INPUTS_FOUND && harmless(diagnostic) === undefined);
}

/**
 * The option name, if the diagnostic cannot skew what we read. `undefined` otherwise —
 * and `undefined` stays blocking: a diagnostic we cannot classify is not a green light.
 */
function harmless(diagnostic: ts.Diagnostic): string | undefined {
    if (diagnostic.code !== OPTION_VALUE) {
        return undefined;
    }
    const option = OPTION_NAMED.exec(flatten(diagnostic))?.groups?.['option'];
    // The second term cannot fire today — TS6046 only bears on options with enumerated
    // values, and the ten flags are booleans. It stays on principle: the day the table
    // takes something else, it would be a green light granted on a flag.
    if (option === undefined || FLAGS.some(({ flag }) => flag === option)) {
        return undefined;
    }
    return option;
}

/**
 * A "solution" tsconfig compiles nothing itself: `files: []` plus `references`. It declares
 * no option, so reading it naively would call everything off — while the referenced
 * projects can be full strict. That is the case of every Nuxt project.
 *
 * So we descend into the references. A guarantee holds for the scope only if it holds in
 * **each** delegated project: a single lukewarm link takes it away.
 *
 * An unreadable reference makes the whole scope unreadable. The opposite — ignoring it and
 * concluding on the others — would recreate the silent hole this type exists to close.
 */
function delegated(
    tsconfigPath: string,
    references: readonly ts.ProjectReference[],
    seen: Set<string>,
    inherited: readonly string[],
): Guarantees {
    const parts: Extract<Guarantees, { kind: 'read' }>[] = [];
    for (const reference of references) {
        const resolved = resolveReference(reference.path);
        if (resolved === undefined) {
            return {
                kind: 'unresolved',
                path: tsconfigPath,
                reason: `referenced project ${reference.path} was not found`,
            };
        }
        const part = readScope(resolved, seen);
        if (part.kind === 'unresolved') {
            return { kind: 'unresolved', path: tsconfigPath, reason: `${part.path}: ${part.reason}` };
        }
        parts.push(part);
    }

    // `parts` holds successful reads only: every other outcome has returned above.
    const [first, ...rest] = parts;
    if (first === undefined) {
        return { kind: 'unresolved', path: tsconfigPath, reason: 'no referenced project could be read' };
    }
    return {
        kind: 'read',
        unrecognised: [...new Set([...inherited, ...parts.flatMap((part) => part.unrecognised)])],
        flags: first.flags.map((guarantee, index) => ({
            ...guarantee,
            enabled: guarantee.enabled && rest.every((part) => part.flags[index]?.enabled === true),
        })),
    };
}

/** A reference points either at the tsconfig, or at the directory holding it. */
function resolveReference(path: string): string | undefined {
    if (ts.sys.directoryExists(path)) {
        const inside = join(path, 'tsconfig.json');
        return ts.sys.fileExists(inside) ? inside : undefined;
    }
    return ts.sys.fileExists(path) ? path : undefined;
}

function flagsOf(options: ts.CompilerOptions, strictDefault: boolean): readonly Guarantee[] {
    const strict = options.strict ?? strictDefault;
    const read = (flag: string): unknown => (options as Record<string, unknown>)[flag];

    return FLAGS.map(({ flag, proves, impliedByStrict }) => ({
        flag,
        proves,
        enabled: read(flag) === true || (impliedByStrict && strict && read(flag) !== false),
    }));
}

function flatten(diagnostic: ts.Diagnostic): string {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}
