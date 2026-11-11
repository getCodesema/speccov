import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ShapeKind, Site } from '../src/scan/shapes';

/**
 * The ground truth of the corpus, written next to the code it judges.
 *
 * A comment `// @expect <kind>[, <kind>]` claims those shapes on the line below it;
 * `// @expect none` claims that nothing is to be found there. Everything the scan reports
 * on a line no marker covers is a false positive: silence is not an expectation.
 *
 * The marker lives in the source rather than in a table on the side, because a table drifts
 * the first time a line moves, and a drifted expectation reads as a passing test.
 */
export type Marker = {
    readonly file: string;
    readonly line: number;
    readonly kinds: readonly ShapeKind[];
};

const MARKER = /^\s*\/\/\s*@expect\s+(?<claim>.+?)\s*$/u;
const SOURCE = /\.ts$/u;

export async function readMarkers(root: string): Promise<readonly Marker[]> {
    const markers: Marker[] = [];
    for (const path of await sources(root)) {
        const text = await readFile(path, 'utf8');
        markers.push(...parse(relative(root, path), text.split('\n')));
    }
    return markers;
}

/** A marker claims the first line below it that carries code: blanks and markers do not count. */
function parse(file: string, lines: readonly string[]): readonly Marker[] {
    const markers: Marker[] = [];
    for (const [index, line] of lines.entries()) {
        const claim = MARKER.exec(line ?? '')?.groups?.['claim'];
        if (claim === undefined) {
            continue;
        }
        const target = subject(lines, index + 1);
        if (target === undefined) {
            throw new Error(`speccov corpus: the marker at ${file}:${index + 1} claims a line that does not exist.`);
        }
        markers.push({ file, line: target, kinds: kindsOf(claim) });
    }
    return markers;
}

function subject(lines: readonly string[], from: number): number | undefined {
    for (let index = from; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line.trim() !== '' && !MARKER.test(line)) {
            return index + 1;
        }
    }
    return undefined;
}

function kindsOf(claim: string): readonly ShapeKind[] {
    return claim === 'none' ? [] : (claim.split(',').map((kind) => kind.trim()) as readonly ShapeKind[]);
}

async function sources(directory: string): Promise<readonly string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...(await sources(path)));
        } else if (SOURCE.test(entry.name)) {
            found.push(path);
        }
    }
    return found;
}

export type Verdict = {
    /** Claimed by a marker, absent from the scan. */
    readonly missed: readonly string[];
    /** Reported by the scan, claimed by no marker. */
    readonly unexpected: readonly string[];
    readonly matched: number;
    /** Lines a marker declares empty on purpose. */
    readonly negatives: number;
};

export function compare(markers: readonly Marker[], sites: readonly Site[]): Verdict {
    // Counted rather than set-compared: two parameters of one signature carry the same kind on
    // the same line, and a set would let one of them vanish without a word.
    const claimed = tally(markers.flatMap(({ file, line, kinds }) => kinds.map((kind) => address(file, line, kind))));
    const found = tally(sites.map(({ file, line, kind }) => address(file, line, kind)));
    const addresses = [...new Set([...claimed.keys(), ...found.keys()])].sort();

    const missed: string[] = [];
    const unexpected: string[] = [];
    let matched = 0;
    for (const entry of addresses) {
        const wanted = claimed.get(entry) ?? 0;
        const seen = found.get(entry) ?? 0;
        matched += Math.min(wanted, seen);
        missed.push(...repeat(entry, wanted - seen));
        unexpected.push(...repeat(entry, seen - wanted));
    }

    return { missed, unexpected, matched, negatives: markers.filter(({ kinds }) => kinds.length === 0).length };
}

function tally(entries: readonly string[]): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
    return counts;
}

function repeat(entry: string, times: number): readonly string[] {
    return times > 0 ? Array.from({ length: times }, () => entry) : [];
}

function address(file: string, line: number, kind: ShapeKind): string {
    return `${file}:${line} ${kind}`;
}
