#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accept, applyAnswers, DEFAULT_ANSWERS_PATH, loadAnswers, saveAnswers, type Answer } from './answers';
import { exitCode, report } from './report';
import { draft, draftForbidden, type DraftResult } from './draft/index';
import { sweep } from './draft/sweep';
import { mutantsToJson, scanToJson, verdictsToJson } from './json';
import { reportMutants } from './mutate/report';
import { mutate } from './mutate/run';
import {
    acceptSite,
    applySiteAnswers,
    DEFAULT_SCAN_ANSWERS_PATH,
    loadSiteAnswers,
    saveSiteAnswers,
    type SiteAnswer,
} from './scan/answers';
import { collectSources, reportScan, scan } from './scan/index';
import type { Site } from './scan/shapes';
import type { Lacuna, Rule } from './rule';
import { run } from './run';

const USAGE = `speccov — finds the behaviours no rule guarantees

  speccov scan <directory> [--tsconfig <path>] [--draft] [--write]
                      --draft passes every site found to the draft bridge and reports how
                      many became a rule file. --write creates them; an existing file is
                      never overwritten.

  speccov scan <directory> [--tsconfig <path>]
                      Static pass: what is proven by construction, the rule candidates,
                      and what was never looked at. Executes nothing.

  speccov scan <directory> --accept <file:line> [--why <text>]
                      Answers "this is not a defect" for a site the scan printed. What is
                      remembered is the shape of the code, not the line, so the answer
                      survives every insertion above it — and expires when that code
                      changes, because it is no longer the same question.

  speccov mutate <directory|file> --run <command> [--limit N] [--all]
                      Alters the code and re-runs <command>. A mutant that survives is a
                      behaviour nobody guarantees. Requires a clean repository.

  speccov draft <file.ts>:<line> [--write]
                      Harvests the wiring from the neighbouring spec and writes the rule
                      draft. Refuses rather than guesses. --write creates the file.

  speccov draft <file.ts> --forbidden <Type> [--write]
                      Reads the type and writes every case of its finite domain into a
                      forbidden() draft. A field the type cannot bound is left as a call
                      that throws, never as a guess.

  speccov <file.rules.ts> [options]

  --accept <rule>     Answers "this is intended": the measured threshold becomes a written
                      rule. Repeatable. A later overrun will be a violation.
  --why <text>        Reason attached to the acceptances of this invocation.
  --answers <path>    Answers file (default: ${DEFAULT_ANSWERS_PATH}, or
                      ${DEFAULT_SCAN_ANSWERS_PATH} for scan).
  --json              Machine-readable output on stdout. Stable schema, no prose to parse.

The rules file default-exports an array of rules, or a function returning one.`;

/** Declared before the dispatch: the subcommands run higher up than the body of the file. */
const DEFAULT_LIMIT = 50;

const commandLine = process.argv.slice(2);
if (commandLine[0] === 'scan') {
    await runScan(commandLine.slice(1));
    process.exit(0);
}
if (commandLine[0] === 'mutate') {
    process.exit(await runMutate(commandLine.slice(1)));
}
if (commandLine[0] === 'draft') {
    process.exit(await runDraft(commandLine.slice(1)));
}

const invocation = parseArguments(commandLine);
if (invocation === 'help') {
    console.log(USAGE);
    process.exit(0);
}

const rules = await loadRules(invocation.target);
const applied = applyAnswers(await run(rules), await loadAnswers(invocation.answersPath));
const code = exitCode(applied.verdicts);
console.log(
    commandLine.includes('--json')
        ? verdictsToJson(applied.verdicts, applied.accepted, code)
        : report(applied.verdicts, applied.accepted),
);

if (invocation.accepts.length > 0) {
    await recordAcceptances(applied.verdicts, invocation);
}
process.exit(code);

async function runDraft(argv: readonly string[]): Promise<number> {
    const target = argv[0];
    const typeName = valueOf(argv, '--forbidden');
    if (typeName !== undefined) {
        if (target === undefined) {
            throw new Error('speccov: name the file that declares the type.');
        }
        return emitDraft(draftForbidden(resolve(target), typeName), argv);
    }

    const match = target === undefined ? null : /^(?<file>.+):(?<line>\d+)$/u.exec(target);
    const file = match?.groups?.['file'];
    const line = Number(match?.groups?.['line']);
    if (file === undefined || !Number.isInteger(line)) {
        throw new Error('speccov: name a site as <file.ts>:<line>.');
    }

    const result = await draft(resolve(file), line);
    return emitDraft(result, argv);
}

async function emitDraft(result: DraftResult, argv: readonly string[]): Promise<number> {
    if (result.kind === 'refused') {
        console.log(`\n  Refused — ${result.reason}\n`);
        return 1;
    }
    const { path, content, todos } = result.draft;
    if (argv.includes('--write')) {
        await writeFile(path, content, 'utf8');
        console.log(`\n  Draft written: ${path}`);
    } else {
        console.log(content);
    }
    console.log(`\n  ${todos.length} decision(s) left to a human:`);
    todos.forEach((todo, index) => console.log(`     ${index + 1}. ${todo}`));
    console.log('\n  While one is left, the subject throws at runtime: never a misleading green light.\n');
    return 0;
}

async function runMutate(argv: readonly string[]): Promise<number> {
    const root = argv[0];
    if (root === undefined || root.startsWith('--')) {
        throw new Error('speccov: name a directory or file to mutate.');
    }
    const command = valueOf(argv, '--run');
    if (command === undefined) {
        throw new Error('speccov: --run <command> is required — something has to judge a mutant.');
    }
    const limit = Number(valueOf(argv, '--limit') ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('speccov: --limit expects an integer of 1 or more.');
    }
    assertCleanTree(root);

    const files = await collectSources(resolve(root));
    const result = await mutate({
        files,
        command: command.split(' '),
        cwd: process.cwd(),
        limit,
        // A carriage return erases nothing in a file or a pipe: outside a terminal, stay quiet.
        onProgress: (done, total) => {
            if (process.stderr.isTTY === true) {
                process.stderr.write(`\r  mutant ${done}/${total}   `);
            }
        },
    });
    process.stderr.write('\r');
    // A survivor is a question, not a refusal: the same semantics as a gap.
    console.log(argv.includes('--json') ? mutantsToJson(result, 0) : reportMutants(result, argv.includes('--all')));
    return 0;
}

/**
 * Mutation writes into the project's own files. Restoration is guaranteed in `finally`,
 * but a clean repository is the last-resort net: `git checkout` must always be able to
 * catch everything.
 */
function assertCleanTree(root: string): void {
    const { status, stdout } = spawnSync('git', ['status', '--porcelain', '--', root], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: Infinity,
    });
    // Checked first: without git there is no status, and no output to read either.
    if (status !== 0) {
        throw new Error(
            `speccov: ${root} is not inside a git repository. Mutation writes into your files: it refuses without a net.`,
        );
    }
    if (stdout.trim() !== '') {
        throw new Error(`speccov: ${root} has uncommitted changes. Commit or stash them before mutating.`);
    }
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index === -1) {
        return undefined;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`speccov: ${flag} expects a value.`);
    }
    return value;
}

async function runScan(argv: readonly string[]): Promise<void> {
    const root = argv[0];
    if (root === undefined || root.startsWith('--')) {
        throw new Error('speccov: name a directory to scan.');
    }
    const flagIndex = argv.indexOf('--tsconfig');
    const tsconfig = flagIndex === -1 ? undefined : argv[flagIndex + 1];
    if (flagIndex !== -1 && (tsconfig === undefined || tsconfig.startsWith('--'))) {
        throw new Error('speccov: --tsconfig expects a path.');
    }
    const result = await scan(tsconfig === undefined ? { root } : { root, tsconfig });
    if (argv.includes('--draft')) {
        await reportSweep(root, result.sites, argv.includes('--write'));
        return;
    }

    const answersPath = valueOf(argv, '--answers') ?? DEFAULT_SCAN_ANSWERS_PATH;
    const known = await loadSiteAnswers(answersPath);
    const accepts = allValuesOf(argv, '--accept');
    const answered = applySiteAnswers(result.sites, known);
    // Recorded from what this pass just found, so the answer bears on the code as it reads
    // today — never on a line number a later commit would move.
    if (accepts.length > 0) {
        await recordSites(answersPath, known, answered.sites, accepts, valueOf(argv, '--why'));
        return;
    }

    const kept = { ...result, sites: answered.sites };
    console.log(argv.includes('--json') ? scanToJson(kept, answered.accepted) : reportScan(kept, answered.accepted));
}

/**
 * Writes down "this is not a defect" for the named sites.
 *
 * A site is named the way the report prints it, `file:line`, because that is what a human has
 * in front of them. What gets stored is the shape at that line, not the line: the address is
 * for the person, the memory is for the code.
 */
async function recordSites(
    path: string,
    known: readonly SiteAnswer[],
    sites: readonly Site[],
    accepts: readonly string[],
    why: string | undefined,
): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const found = accepts.map((address) => ({ address, site: sites.find((site) => `${site.file}:${site.line}` === address) }));
    const unknown = found.filter(({ site }) => site === undefined).map(({ address }) => address);
    if (unknown.length > 0) {
        throw new Error(`speccov: no site to answer at ${unknown.join(', ')}. Run the scan first and copy an address from it.`);
    }

    const merged = [...known];
    for (const { site } of found) {
        if (site !== undefined) {
            merged.push(acceptSite(site, today, why));
        }
    }
    await saveSiteAnswers(path, merged);
    console.log(`  ${accepts.length} site(s) answered in ${path}\n`);
}

function allValuesOf(argv: readonly string[], flag: string): readonly string[] {
    const values: string[] = [];
    for (const [index, argument] of argv.entries()) {
        if (argument !== flag) {
            continue;
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`speccov: ${flag} expects a value.`);
        }
        values.push(value);
    }
    return values;
}

async function reportSweep(root: string, sites: readonly Site[], write: boolean): Promise<void> {
    const { drafted, refusedBy, tried } = await sweep(root, sites);
    console.log(`\n  ${tried} site(s) with a .map(), ${drafted.length} turned into a rule draft.\n`);

    for (const { file, line, path, todos, content } of drafted) {
        const decisions = todos.length === 0 ? 'nothing left to decide' : `${todos.length} decision(s) left`;
        if (!write) {
            console.log(`     ${file}:${line} → ${path}  (${decisions})`);
            continue;
        }
        if (existsSync(path)) {
            console.log(`     ${file}:${line} → ${path}  already exists, left untouched`);
            continue;
        }
        await writeFile(path, content, 'utf8');
        console.log(`     ${file}:${line} → ${path}  written (${decisions})`);
    }

    if (refusedBy.size > 0) {
        console.log(`\n  ── Not drafted ───────────────────────────────────────────`);
        for (const [reason, count] of [...refusedBy].sort((left, right) => right[1] - left[1])) {
            console.log(`     ${String(count).padStart(4)}  ${reason}`);
        }
    }
    console.log('\n  A refusal is not a failure: it names what the bridge cannot read yet.\n');
}

type Options = {
    readonly target: string;
    readonly answersPath: string;
    readonly accepts: readonly string[];
    readonly why: string | undefined;
};

function parseArguments(argv: readonly string[]): Options | 'help' {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        return 'help';
    }
    let target: string | undefined;
    let answersPath = DEFAULT_ANSWERS_PATH;
    let why: string | undefined;
    const accepts: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--accept' || argument === '--why' || argument === '--answers') {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new Error(`speccov: ${argument} expects a value.`);
            }
            if (argument === '--accept') {
                accepts.push(value);
            } else if (argument === '--why') {
                why = value;
            } else {
                answersPath = value;
            }
            index += 1;
        } else if (argument === '--json') {
            // Valueless flag, read straight from argv at the moment of writing.
        } else if (argument !== undefined && argument.startsWith('--')) {
            throw new Error(`speccov: unknown option ${argument}.`);
        } else if (target === undefined) {
            target = argument;
        } else {
            throw new Error(`speccov: one rules file at a time (also received ${argument}).`);
        }
    }
    if (target === undefined) {
        throw new Error('speccov: name a rules file.');
    }
    return { target, answersPath, accepts, why };
}

async function recordAcceptances(verdicts: readonly Verdictish[], options: Options): Promise<void> {
    const lacunae = new Map(verdicts.filter(isLacuna).map((lacuna) => [lacuna.rule.name, lacuna]));
    const unknown = options.accepts.filter((name) => !lacunae.has(name));
    if (unknown.length > 0) {
        throw new Error(`speccov: no open gap named ${unknown.map((name) => `"${name}"`).join(', ')}.`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const existing = await loadAnswers(options.answersPath);
    const merged = new Map(existing.map((answer): [string, Answer] => [answer.rule, answer]));
    for (const name of options.accepts) {
        const lacuna = lacunae.get(name);
        if (lacuna !== undefined) {
            merged.set(name, accept(lacuna, today, options.why));
        }
    }
    await saveAnswers(options.answersPath, [...merged.values()]);
    console.log(`  ${options.accepts.length} answer(s) recorded in ${options.answersPath}\n`);
}

type Verdictish = Awaited<ReturnType<typeof run>>[number];

function isLacuna(verdict: Verdictish): verdict is Lacuna {
    return verdict.kind === 'lacuna';
}

async function loadRules(path: string): Promise<readonly Rule[]> {
    const module: unknown = await import(pathToFileURL(resolve(path)).href);
    const exported = (module as { default?: unknown }).default;
    const value = typeof exported === 'function' ? await (exported as () => unknown)() : exported;

    if (!Array.isArray(value)) {
        throw new Error(`speccov: ${path} must default-export an array of rules (received ${describe(value)}).`);
    }
    value.forEach(assertRule);
    return value;
}

function assertRule(candidate: unknown, index: number): asserts candidate is Rule {
    const rule = candidate as Partial<Rule> | null;
    const valid =
        rule !== null &&
        typeof rule === 'object' &&
        typeof rule.name === 'string' &&
        typeof rule.intention === 'string' &&
        typeof rule.measure === 'function' &&
        typeof rule.judge === 'function';
    if (!valid) {
        throw new Error(`speccov: item ${index} is not a usable rule.`);
    }
}

function describe(value: unknown): string {
    return value === null ? 'null' : typeof value;
}
