import { describe, expect, test } from 'bun:test';
import { findShapes, type ShapeKind, type Site } from './shapes';
import { virtualProgram } from './virtual-program';

/**
 * The preamble gives a type to what the fixtures call. Without it the checker would return
 * `any` everywhere and the detectors would see nothing — that would test the absence of
 * types, not the detection.
 */
const PREAMBLE = `
declare const repo: { findById(x: unknown): Promise<unknown>; update(x: unknown): Promise<void> };
declare const helpers: { getCompactDisplayName(x: unknown): string; countRows(x: unknown): number };
declare function sync(x: unknown): Promise<void>;
declare function go(x: unknown): Promise<void>;
declare function wrap<T>(x: T): T;
declare function a(): Promise<void>;
declare function b(): Promise<void>;
declare function c(): Promise<void>;
declare function lane(): Promise<void>;
declare function work(x: unknown): Promise<void>;
declare const users: unknown[];
declare const ids: unknown[];
declare const xs: unknown[];
declare const items: unknown[];
declare const extensions: unknown[];
declare const limit: number;
declare const fraction: number;
declare const flag: boolean;
declare function fetchAll(): Promise<{ id: string }[]>;
`;
const OFFSET = PREAMBLE.split('\n').length;

function sitesOf(source: string): readonly Site[] {
    const name = 'x.ts';
    const { program, checker } = virtualProgram({ [name]: `${PREAMBLE}async function main() {\n${source}\n}\n` });
    const parsed = program.getSourceFile(name);
    if (parsed === undefined) {
        throw new Error('fixture not found');
    }
    return findShapes(parsed, checker, name).map((site) => ({ ...site, line: site.line - OFFSET }));
}

function kinds(source: string): readonly ShapeKind[] {
    return sitesOf(source).map(({ kind }) => kind);
}

describe('fan-out', () => {
    test('a Promise.all over a .map() is an unbounded fan-out', () => {
        expect(kinds('await Promise.all(users.map((u) => sync(u)));')).toContain('unbounded-fanout');
    });

    test('Promise.allSettled counts the same', () => {
        expect(kinds('await Promise.allSettled(ids.map((id) => go(id)));')).toContain('unbounded-fanout');
    });

    test('an array literal is bounded in writing, not a defect', () => {
        const found = kinds('await Promise.all([a(), b(), c()]);');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('walking a constant of the file is bounded in writing', () => {
        expect(kinds('const TABLES = ["a", "b"];\nawait Promise.all(TABLES.map((t) => sync(t)));')).toContain('bounded-fanout');
    });

    test('recognises the "as const" form too', () => {
        expect(kinds('const TABLES = ["a", "b"] as const;\nawait Promise.all(TABLES.map((t) => sync(t)));')).toContain(
            'bounded-fanout',
        );
    });

    test('a let is not a constant: the collection can grow', () => {
        expect(kinds('let TABLES = ["a"];\nawait Promise.all(TABLES.map((t) => sync(t)));')).toContain('unbounded-fanout');
    });

    test('a pool with a written ceiling is bounded', () => {
        expect(kinds('await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, () => lane()));')).toContain(
            'bounded-fanout',
        );
    });

    test('a length literal is bounded', () => {
        expect(kinds('await Promise.all(Array.from({ length: 4 }, () => lane()));')).toContain('bounded-fanout');
    });

    test('reading the collection size back does not make a ceiling', () => {
        expect(kinds('await Promise.all(Array.from({ length: items.length }, (_u, i) => work(items[i])));')).toContain(
            'unbounded-fanout',
        );
    });

    test('a sliced batch is bounded by its size, not by the collection size', () => {
        const found = kinds('const i = 0;\nconst batch = xs.slice(i, i + limit);\nawait Promise.all(batch.map((x) => go(x)));');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('a list head with a written ceiling is bounded too', () => {
        expect(kinds('const head = xs.slice(0, 100);\nawait Promise.all(head.map((x) => go(x)));')).toContain('bounded-fanout');
    });

    test('slicing on the collection size bounds nothing', () => {
        expect(kinds('const all = xs.slice(0, xs.length);\nawait Promise.all(all.map((x) => go(x)));')).toContain(
            'unbounded-fanout',
        );
    });

    /**
     * The empty literal states the shape, never the width. The loop that fills it is what
     * sets that — and it follows the input. Classed bounded, this site came out filed under
     * "proven by construction": the exact opposite verdict, on the N+1 of `resolve-app-items.ts:67`.
     */
    test('an accumulator filled by push grows with the input', () => {
        const found = kinds(
            'const acc: unknown[] = [];\nfor (const x of xs) acc.push(x);\nawait Promise.all(acc.map((x) => go(x)));',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('unshift and splice grow it just as much', () => {
        expect(
            kinds('const acc: unknown[] = [];\nfor (const x of xs) acc.unshift(x);\nawait Promise.all(acc.map((x) => go(x)));'),
        ).toContain('unbounded-fanout');
        expect(
            kinds(
                'const acc: unknown[] = [];\nfor (const x of xs) acc.splice(0, 0, x);\nawait Promise.all(acc.map((x) => go(x)));',
            ),
        ).toContain('unbounded-fanout');
    });

    /**
     * The removal applies to the name, across the whole file — as the addition does. A
     * parameter carrying the name of an accumulator declared elsewhere no longer inherits
     * its boundedness: that is exactly the collision that masked the site in a real-world monorepo.
     */
    test('a parameter sharing the name of a file accumulator is not bounded', () => {
        const found = kinds(
            'const acc: unknown[] = [];\nfor (const x of xs) acc.push(x);\nasync function inner(acc: unknown[]) { await Promise.all(acc.map((y) => go(y))); }\nawait inner(acc);',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    /**
     * The `push` says nothing on its own: what runs it decides. Three `if (…) tasks.push(…)`
     * in a row add at most three items — `package-manager.ts:1130` in pi, flagged wrongly
     * until now. Four sites across the five repos hung on this shape.
     */
    test('straight-line pushes add a written number', () => {
        const found = kinds(
            'const tasks: Promise<void>[] = [];\nif (limit > 0) tasks.push(lane());\nif (limit > 1) tasks.push(lane());\nawait Promise.all(tasks);',
        );
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    /**
     * `for (let i = 0; i < this.config.minConnections; i++) promises.push(…)` — the connection
     * pool of `connection-pool.ts:136` in ruflo. Five sites across the five repos.
     */
    test('a loop with a capped condition adds a written number', () => {
        const found = kinds(
            'const acc: Promise<void>[] = [];\nfor (let i = 0; i < limit; i += 1) acc.push(lane());\nawait Promise.all(acc);',
        );
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('the same loop counted on the collection bounds nothing', () => {
        const found = kinds(
            'const acc: Promise<void>[] = [];\nfor (let i = 0; i < items.length; i += 1) acc.push(lane());\nawait Promise.all(acc);',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('a loop with no written bound is not one, even with no condition on the size', () => {
        // `while (true)`: the bound is `true`, which is not a ceiling but the absence of one.
        const found = kinds(
            'const acc: Promise<void>[] = [];\nwhile (true) { acc.push(lane()); if (limit > 0) break; }\nawait Promise.all(acc);',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    /**
     * `target - alreadyDone` never exceeds `target`, even when what is subtracted is a size:
     * `container-worker-pool.ts:283` in ruflo, two sites.
     */
    test('subtracting a size from a ceiling leaves a ceiling', () => {
        const found = kinds(
            'const toCreate = limit - items.length;\nconst acc: Promise<void>[] = [];\nfor (let i = 0; i < toCreate; i += 1) acc.push(lane());\nawait Promise.all(acc);',
        );
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('subtracting a ceiling from a size leaves a size', () => {
        // `pooledAgents.size - target` grows with the pool — `agent-pool.ts:222` in ruflo.
        const found = kinds(
            'const toDrop = items.length - limit;\nconst acc: Promise<void>[] = [];\nfor (let i = 0; i < toDrop; i += 1) acc.push(lane());\nawait Promise.all(acc);',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('a push lodged in a callback cannot be counted', () => {
        const found = kinds('const acc: Promise<void>[] = [];\nitems.forEach(() => acc.push(lane()));\nawait Promise.all(acc);');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('a constant never mutated stays bounded', () => {
        const found = kinds('const TABLES = ["a", "b"];\nawait Promise.all(TABLES.map((t) => sync(t)));');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    /**
     * The worker pool rewritten without `Array.from`: `new Array(limit)` fixes the same
     * arity, `.fill(null).map(…)` only traverses it. Real site: `subagent/index.ts:228` in pi
     * and in prime-agent, the same file on both sides.
     */
    test('a pool written with new Array is bounded like one written with Array.from', () => {
        const found = kinds('await Promise.all(new Array(limit).fill(null).map(async () => { await lane(); }));');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('Array(limit) without new counts the same', () => {
        expect(kinds('await Promise.all(Array(limit).fill(null).map(async () => { await lane(); }));')).toContain(
            'bounded-fanout',
        );
    });

    test('a new Array sized on the collection bounds nothing', () => {
        const found = kinds('await Promise.all(new Array(items.length).fill(null).map(async () => { await lane(); }));');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('Array.from over a collection bounds nothing: the length comes from what is iterated', () => {
        expect(kinds('await Promise.all(Array.from(items, (x) => work(x)));')).toContain('unbounded-fanout');
    });

    /**
     * The literal receiver. `[a(), b(), c()].map(…)` is written out in full at the site, like
     * `Promise.all([a(), b(), c()])` from which it differs only by a projection.
     * Real site: `conformance.ts:838` in pi, four writes named one by one.
     */
    test('an array literal in receiver position is bounded', () => {
        const found = kinds('await Promise.all([a(), b(), c()].map((p) => wrap(p)));');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    /**
     * The negative test that keeps the widening honest: `[...xs]` carries the syntax of a
     * written array and the width of the spread collection. 20 of the 22 literal receivers
     * found across the five repos were of that shape.
     */
    test('a spread inside the literal hands it the collection width', () => {
        const found = kinds('await Promise.all([...items].map((x) => go(x)));');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('a named spread copy is not bounded either', () => {
        expect(kinds('const copy = [...items];\nawait Promise.all(copy.map((x) => go(x)));')).toContain('unbounded-fanout');
    });

    /**
     * The pool almost always goes through a name: `const workers = …` then
     * `await Promise.all(workers)`. Without following the identifier, the bound already
     * written is useless — the shape of 66 of the 211 sites found across the five repos.
     */
    test('a name holding a pool with a written ceiling is bounded', () => {
        const found = kinds('const tasks = Array.from({ length: limit }, () => lane());\nawait Promise.all(tasks);');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('a name holding a projection of the collection is not', () => {
        const found = kinds('const tasks = items.map((x) => work(x));\nawait Promise.all(tasks);');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('the bound follows from one name to the next, in source order', () => {
        const found = kinds(
            'const i = 0;\nconst batch = xs.slice(i, i + limit);\nconst promises = batch.map((x) => go(x));\nawait Promise.all(promises);',
        );
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('filtering does not grow: the bound carries through', () => {
        expect(
            kinds('const TABLES = ["a", "b"];\nawait Promise.all(TABLES.filter((t) => t !== "a").map((t) => sync(t)));'),
        ).toContain('bounded-fanout');
    });

    /**
     * The concurrency pool written by hand: wait for a slot when the batch is full, and the
     * final `Promise.all` drains only what is still in flight. That is the answer
     * `resource()` demands. Real sites: `test-utils.ts:256` in ruflo,
     * `runtime-local-skill-import-panel.tsx:785` in multica.
     */
    test('a set throttled by Promise.race is bounded by its threshold', () => {
        const found = kinds(
            'const running = new Set<Promise<void>>();\nfor (const x of xs) {\n  const p = go(x).then(() => { running.delete(p); });\n  running.add(p);\n  if (running.size >= limit) await Promise.race(running);\n}\nawait Promise.all(running);',
        );
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    /**
     * The third signal: with no guard on the size, the wait happens once and nothing is
     * capped. Real counter-example — `rpc-mode.ts:535` in prime-agent adds and removes as
     * the lines are read, without ever waiting for a slot.
     */
    test('waiting for a slot without looking at the size caps nothing', () => {
        const found = kinds(
            'const running = new Set<Promise<void>>();\nfor (const x of xs) {\n  const p = go(x).then(() => { running.delete(p); });\n  running.add(p);\n  await Promise.race(running);\n}\nawait Promise.all(running);',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('removing without ever waiting for a slot slows nothing', () => {
        const found = kinds(
            'const running = new Set<Promise<void>>();\nfor (const x of xs) {\n  const p = go(x).then(() => { running.delete(p); });\n  running.add(p);\n}\nawait Promise.all(running);',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    /**
     * `splice(start, count)` removes; it only inserts from the third argument on. An array
     * that shrinks stays bounded by its declaration.
     */
    test('a splice that removes does not grow', () => {
        const found = kinds('const acc = [a(), b()];\nacc.splice(0, 1);\nawait Promise.all(acc);');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('a batch sliced on a ceiling is bounded even in receiver position', () => {
        const found = kinds('await Promise.all(xs.slice(0, limit).map((x) => go(x)));');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    /**
     * The negative test for the sliced batch. `sw.ts:367` in that monorepo purges a
     * **fraction** of the cache: the slice end carries the name of a ceiling and is worth
     * `keys.length * f`. Without the descent into `Math.floor`, the earlier widening silenced it.
     */
    test('a slice end computed from the size is not a ceiling', () => {
        const found = kinds(
            'const toDrop = Math.floor(xs.length * fraction);\nawait Promise.all(xs.slice(0, toDrop).map((x) => go(x)));',
        );
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    test('a ceiling clamped by Math.max around a Math.min stays one', () => {
        // `Math.max(1, Math.min(concurrency, items.length))` — the ceiling of pi's pool.
        const found = kinds(
            'await Promise.all(new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => { await lane(); }));',
        );
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('a name that merely relays a size does not become a ceiling', () => {
        const found = kinds('const n = items.length;\nawait Promise.all(Array.from({ length: n }, () => lane()));');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });

    /**
     * The optional argument: `...(op ? [op] : [])` makes zero or one item, both branches are
     * written. Real site — `agent-session.ts:8000` in prime-agent, three named promises.
     */
    test('a spread of written branches stays written', () => {
        const found = kinds('await Promise.all([a(), ...(flag ? [b()] : [])]);');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('a spread of a projection of the collection is not', () => {
        const found = kinds('await Promise.all([a(), ...items.map((x) => work(x))]);');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('bounded-fanout');
    });
});

/**
 * The method name no longer decides anything: only its return type counts. Measured on the
 * `apps/api` package of that monorepo, the name missed `update`, `addItem`, `republish` — one
 * of them a write N+1 — and flagged `getCompactDisplayName()`, which only reads memory.
 */
describe('an async call per item', () => {
    test('a call that returns a promise counts, whatever its name', () => {
        expect(kinds('users.map((u) => repo.update(u));')).toContain('async-per-item');
    });

    test('a read counts too, obviously', () => {
        expect(kinds('users.map((u) => repo.findById(u));')).toContain('async-per-item');
    });

    test('a synchronous accessor does not count, even when it carries a read verb', () => {
        expect(kinds('extensions.map((e) => helpers.countRows(e));')).not.toContain('async-per-item');
    });

    test('a pure transformation triggers nothing', () => {
        expect(kinds('extensions.map((e) => helpers.getCompactDisplayName(e));')).toEqual([]);
    });

    test('a .map() over a bounded constant does not raise the question', () => {
        expect(kinds('const IDS = ["a", "b"];\nIDS.map((i) => repo.findById(i));')).not.toContain('async-per-item');
    });

    test('a .map() wrapped in another call counts all the same', () => {
        // The return type does not depend on what surrounds it: the Promise.all is no longer needed.
        expect(kinds('wrap(xs.map((x) => repo.findById(x)));')).toContain('async-per-item');
    });

    test('a call lodged in a handler does not count: the .map() does not fire it', () => {
        // The list-render pattern. `go(i)` fires on click, not once per item.
        expect(kinds('items.map((i) => wrap({ onClick: () => go(i) }));')).not.toContain('async-per-item');
    });

    test('a direct call still counts when a nested callback follows it', () => {
        // The bound must not swallow what is, for its part, fired on every item.
        expect(kinds('items.map((i) => go(i).then(() => work(i)));')).toContain('async-per-item');
    });

    test('a promise in the receiver does not count: it is the batched read', () => {
        // One call, once, then a synchronous .map(). That is the fix, not the defect.
        expect(kinds('(await fetchAll()).map((r) => r.id);')).not.toContain('async-per-item');
    });

    test('an async receiver does not mask a callback that does call', () => {
        expect(kinds('(await fetchAll()).map((r) => repo.update(r));')).toContain('async-per-item');
    });
});

describe('paginated return', () => {
    test('a paginated return is a metamorphic candidate', () => {
        expect(kinds('const page = { items: xs, total: xs.length };')).toContain('paginated-return');
    });

    test('an object with no total triggers nothing', () => {
        expect(kinds('const page = { items: xs };')).toEqual([]);
    });
});

describe('location', () => {
    test('gives the file and the line', () => {
        const [site] = sitesOf('\nawait Promise.all(users.map((u) => sync(u)));');

        expect(site?.file).toBe('x.ts');
        expect(site?.line).toBe(2);
    });

    test('truncates the excerpt so the report stays readable', () => {
        const [site] = sitesOf(`await Promise.all(users.map((u) => sync(${'"x"'.repeat(60)})));`);

        expect(site?.excerpt.length).toBeLessThanOrEqual(73);
        expect(site?.excerpt.endsWith('…')).toBe(true);
    });

    test('normalises the line breaks in the excerpt', () => {
        const [site] = sitesOf('await Promise.all(\n  users.map(\n    (u) => sync(u),\n  ),\n);');

        expect(site?.excerpt).not.toContain('\n');
    });
});

describe('one place, not two', () => {
    test('both questions of the same Promise.all carry the same line', () => {
        const found = sitesOf('await Promise.all(users.map((u) => sync(u)));');

        expect(found.map(({ kind }) => kind).sort()).toEqual(['async-per-item', 'unbounded-fanout']);
        expect(new Set(found.map(({ line }) => line)).size).toBe(1);
    });

    test('two .map() calls fanned out by the same Promise.all hold one address', () => {
        const found = sitesOf('await Promise.all([...users.map((u) => sync(u)), ...ids.map((i) => go(i))]);');

        expect(new Set(found.map(({ line }) => line)).size).toBe(1);
        expect(found.filter(({ kind }) => kind === 'async-per-item')).toHaveLength(1);
    });

    test('two neighbouring Promise.all calls stay two addresses', () => {
        const found = sitesOf(
            'await Promise.all(users.map((u) => sync(u)));\nconst seen = 0;\nawait Promise.all(ids.map((i) => go(i)));',
        );

        expect([...new Set(found.map(({ line }) => line))].sort((l, r) => l - r)).toEqual([1, 3]);
    });

    test('a .map() written in the callback fans out something else and keeps its address', () => {
        const found = sitesOf('await Promise.all(users.map(async (u) => {\n  ids.map((i) => repo.findById(i));\n}));');

        expect(found.filter(({ kind }) => kind === 'async-per-item').map(({ line }) => line)).toEqual([1, 2]);
    });

    test('a .map() without Promise.all keeps its own', () => {
        expect(kinds('users.map((u) => repo.update(u));')).toEqual(['async-per-item']);
    });
});

/**
 * A drain waits for work that another line started. It holds as many promises as a fan-out
 * and reads the same by width, so every fixture here pairs the drain with the fan-out it must
 * not be confused with.
 */
describe('waiting is not launching', () => {
    test('a set of promises is drained, not fanned out', () => {
        const found = kinds('const poses = new Set<Promise<void>>();\nawait Promise.allSettled(poses);');
        expect(found).toContain('in-flight-drain');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('the values of a map of promises are drained', () => {
        const found = kinds('const inflight = new Map<string, Promise<void>>();\nawait Promise.all([...inflight.values()]);');
        expect(found).toContain('in-flight-drain');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('two spreads of promises stay a drain', () => {
        const source =
            'const inflight = new Map<string, Promise<void>>();\n' +
            'const abandons = new Set<Promise<void>>();\n' +
            'await Promise.allSettled([...inflight.values(), ...abandons]);';
        expect(kinds(source)).toContain('in-flight-drain');
    });

    test('decorating promises in flight does not launch them', () => {
        const source =
            'const proxies = new Map<string, Promise<void>>();\n' +
            'const settled = [...proxies.values()].map((p) => p.catch(() => null));\n' +
            'await Promise.all(settled);';
        const found = kinds(source);
        expect(found).toContain('in-flight-drain');
        expect(found).not.toContain('unbounded-fanout');
        // The `.map()` decorates, so it is not one outgoing call per item either.
        expect(found).not.toContain('async-per-item');
    });

    test('a name holding a real fan-out stays a fan-out', () => {
        const found = kinds('const tasks = users.map((u) => sync(u));\nawait Promise.all(tasks);');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('in-flight-drain');
    });

    test('an array literal of calls launches them here', () => {
        const found = kinds('await Promise.all([a(), b(), c()]);');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('in-flight-drain');
    });

    test('a decoration on a launch keeps the launch', () => {
        expect(kinds('users.map((u) => sync(u).finally(() => undefined));')).toContain('async-per-item');
    });

    test('a let is not followed to its initialiser', () => {
        const found = kinds(
            'const inflight = new Map<string, Promise<void>>();\nlet settled = [...inflight.values()];\nawait Promise.all(settled);',
        );
        expect(found).not.toContain('in-flight-drain');
    });
});

describe('a constant declared next door', () => {
    function crossFileKinds(source: string): readonly ShapeKind[] {
        const files = {
            '/keys.ts':
                'export const KEYS = ["a", "b", "c"] as const;\n' +
                // An accumulator over there is an accumulator here: filled in its own file,
                // under its own name, and the import must not launder it.
                'export const rows: string[] = [];\n' +
                'export function collect(xs: string[]): void {\n  for (const x of xs) {\n    rows.push(x);\n  }\n}\n',
            '/x.ts': `${PREAMBLE}import { KEYS, rows } from './keys';\nasync function main() {\n${source}\n}\n`,
        };
        const { program, checker } = virtualProgram(files);
        const parsed = program.getSourceFile('/x.ts');
        if (parsed === undefined) {
            throw new Error('fixture not found');
        }
        return findShapes(parsed, checker, '/x.ts').map(({ kind }) => kind);
    }

    test('an imported array literal is bounded in writing', () => {
        const found = crossFileKinds('await Promise.all(KEYS.map((k) => sync(k)));');
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('an imported accumulator stays a fan-out', () => {
        expect(crossFileKinds('await Promise.all(rows.map((r) => sync(r)));')).toContain('unbounded-fanout');
    });

    test('pushing onto an imported name in this file takes it back out', () => {
        expect(
            crossFileKinds('for (const x of xs) {\n  KEYS.push(x as never);\n}\nawait Promise.all(KEYS.map((k) => sync(k)));'),
        ).toContain('unbounded-fanout');
    });
});

/**
 * The shape the pass never looked at: concurrency of one, cost that grows all the same. The
 * fixtures pair each site with the loop right next to it that must stay silent, because a
 * serial loop is very often exactly what someone meant.
 */
describe('awaiting in series', () => {
    test('one awaited call per item is a site', () => {
        expect(kinds('for (const x of xs) {\n  await sync(x);\n}')).toContain('awaited-in-loop');
    });

    test('a written collection asks nothing', () => {
        const found = kinds('const TABLES = ["a", "b"];\nfor (const t of TABLES) {\n  await sync(t);\n}');
        expect(found).not.toContain('awaited-in-loop');
    });

    test('a loop that waits for nothing asks nothing', () => {
        expect(kinds('for (const x of xs) {\n  helpers.countRows(x);\n}')).not.toContain('awaited-in-loop');
    });

    test('a handler on the call does not hide the call', () => {
        expect(kinds('for (const x of xs) {\n  await sync(x).catch(() => null);\n}')).toContain('awaited-in-loop');
    });

    test('awaiting a name launches nothing', () => {
        const source =
            'const inflight = new Map<string, Promise<void>>();\nfor (const p of inflight.values()) {\n  await p.catch(() => null);\n}';
        expect(kinds(source)).not.toContain('awaited-in-loop');
    });

    test('a Promise.all in a loop keeps its own question, at its own address', () => {
        const found = kinds('for (const x of xs) {\n  await Promise.all(ids.map((i) => go(i)));\n}');
        expect(found).toContain('unbounded-fanout');
        expect(found).not.toContain('awaited-in-loop');
    });

    test('an await inside a nested loop counts: it is the same cost, worse', () => {
        expect(kinds('for (const x of xs) {\n  for (const i of ids) {\n    await go(i);\n  }\n}')).toContain('awaited-in-loop');
    });

    test('an await inside a callback runs on its own schedule', () => {
        expect(kinds('for (const x of xs) {\n  void (async () => {\n    await sync(x);\n  })();\n}')).not.toContain(
            'awaited-in-loop',
        );
    });
});

/** The fixture at module level: an exported signature cannot live inside `main()`. */
function moduleSitesOf(source: string): readonly Site[] {
    const name = 'x.ts';
    const { program, checker } = virtualProgram({ [name]: `${PREAMBLE}${source}\n` });
    const parsed = program.getSourceFile(name);
    if (parsed === undefined) {
        throw new Error('fixture not found');
    }
    return findShapes(parsed, checker, name);
}

/** The questions asked about parameters, the only kind these cases are about. */
function primitivesOf(source: string): readonly Site[] {
    return moduleSitesOf(source).filter(({ kind }) => kind === 'unbounded-primitive');
}

describe('the four combinators', () => {
    /**
     * `race` and `any` were read by nothing: only `all` and `allSettled` were classified, so a
     * fan-out awaited by the first answer kept its growth question and lost its ceiling one.
     * They open the same calls, so they now carry the same three verdicts.
     */
    test('a fan-out awaited by `race` is a fan-out', () => {
        const found = sitesOf('await Promise.race(users.map((u) => sync(u)));').map(({ kind }) => kind);
        expect(found).toContain('unbounded-fanout');
    });

    test('a fan-out awaited by `any` is a fan-out', () => {
        const found = sitesOf('await Promise.any(users.map((u) => sync(u)));').map(({ kind }) => kind);
        expect(found).toContain('unbounded-fanout');
    });

    test('`race` over promises already in flight is a drain, not a fan-out', () => {
        const source = 'const inflight = new Map<string, Promise<void>>();\nawait Promise.race([...inflight.values()]);';
        const found = kinds(source);
        expect(found).toContain('in-flight-drain');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('a width the code writes closes the question under `race` as under `all`', () => {
        const found = sitesOf('await Promise.race(users.slice(0, 5).map((u) => sync(u)));').map(({ kind }) => kind);
        expect(found).toContain('bounded-fanout');
        expect(found).not.toContain('unbounded-fanout');
    });

    test('the four verdicts land at one address, that of the combinator', () => {
        const all = sitesOf('await Promise.all(users.map((u) => sync(u)));');
        const race = sitesOf('await Promise.race(users.map((u) => sync(u)));');
        // Same shape, same two questions, same single line: `race` is not read a line apart.
        expect(race.map(({ kind, line }) => `${kind}:${line}`).sort()).toEqual(
            all.map(({ kind, line }) => `${kind}:${line}`).sort(),
        );
    });
});

describe('unbounded primitive', () => {
    test('an exported parameter typed `number` has no bound the type states', () => {
        const found = moduleSitesOf('export function tarif(prix: number): void {}').map(({ kind }) => kind);
        expect(found).toContain('unbounded-primitive');
    });

    test('a bare `string` counts the same', () => {
        const found = moduleSitesOf('export function tarif(description: string): void {}').map(({ kind }) => kind);
        expect(found).toContain('unbounded-primitive');
    });

    test('a literal union is closed by the compiler: no question', () => {
        const found = moduleSitesOf("export function tarif(mode: 'TOTO' | 'TATA'): void {}").map(({ kind }) => kind);
        expect(found).not.toContain('unbounded-primitive');
    });

    test('a boolean is finite: no question', () => {
        const found = moduleSitesOf('export function tarif(flagged: boolean): void {}').map(({ kind }) => kind);
        expect(found).not.toContain('unbounded-primitive');
    });

    test('a function that is not exported is not a frontier', () => {
        const found = moduleSitesOf('function tarif(prix: number): void {}').map(({ kind }) => kind);
        expect(found).not.toContain('unbounded-primitive');
    });

    test('an exported arrow counts as a frontier too', () => {
        const found = moduleSitesOf('export const tarif = (prix: number): void => {};').map(({ kind }) => kind);
        expect(found).toContain('unbounded-primitive');
    });

    test('two parameters on one line make two questions, not one', () => {
        const found = moduleSitesOf('export function tarif(description: string, prix: number): void {}').filter(
            ({ kind }) => kind === 'unbounded-primitive',
        );
        expect(found).toHaveLength(2);
    });

    test('the excerpt names the parameter, so the question reads on its own', () => {
        const site = moduleSitesOf('export function tarif(prix: number): void {}').find(
            ({ kind }) => kind === 'unbounded-primitive',
        );
        expect(site?.excerpt).toBe('prix: number');
    });

    test('an optional parameter is left alone: the widened question is for a later pass', () => {
        expect(primitivesOf('export function tarif(prix?: number): void {}')).toHaveLength(0);
    });

    test('a union of two primitives is left alone for the same reason', () => {
        expect(primitivesOf('export function tarif(prix: number | string): void {}')).toHaveLength(0);
    });

    test('a numeric literal type is closed by the compiler, like a literal union of strings', () => {
        expect(primitivesOf('export function tarif(prix: 42): void {}')).toHaveLength(0);
    });

    test('a template literal type narrows the string: nothing left to ask', () => {
        expect(primitivesOf('export function tarif(id: `u_${string}`): void {}')).toHaveLength(0);
    });

    test('a bigint is not a number: the detector says what it checks, not what it resembles', () => {
        expect(primitivesOf('export function tarif(prix: bigint): void {}')).toHaveLength(0);
    });

    test('an alias closes nothing: `type Prix = number` still takes the whole domain', () => {
        const found = primitivesOf('type Prix = number;\nexport function tarif(prix: Prix): void {}');
        expect(found.map(({ excerpt }) => excerpt)).toEqual(['prix: Prix']);
    });

    test('a branded number is narrowed by its brand: no question', () => {
        const source = 'type Prix = number & { readonly brand: unique symbol };\nexport function tarif(prix: Prix): void {}';
        expect(primitivesOf(source)).toHaveLength(0);
    });

    test('a parameter with no annotation is not read, however obvious its default', () => {
        expect(primitivesOf('export function tarif(prix = 3): void {}')).toHaveLength(0);
    });

    test('a rest parameter carries an array, not a bare primitive', () => {
        expect(primitivesOf('export function tarif(...prix: number[]): void {}')).toHaveLength(0);
    });

    test('a destructured parameter carries an object, not a bare primitive', () => {
        expect(primitivesOf('export function tarif({ prix }: { prix: number }): void {}')).toHaveLength(0);
    });

    test('`export default` is a frontier too', () => {
        expect(primitivesOf('export default function tarif(prix: number): void {}')).toHaveLength(1);
    });

    test('an exported function expression is a frontier, like the arrow', () => {
        expect(primitivesOf('export const tarif = function (prix: number): void {};')).toHaveLength(1);
    });

    /**
     * The two limits below are deliberate, and stated here so that lifting one is a decision.
     * A method and a deferred `export` are frontiers just as much; reaching them means reading
     * the class and the export list, which this pass does not do yet.
     */
    test('a method of an exported class is not seen: the pass reads functions, not members', () => {
        expect(primitivesOf('export class Tarifs { apply(prix: number): void {} }')).toHaveLength(0);
    });

    test('a function exported by a separate `export { }` is not seen either', () => {
        expect(primitivesOf('function tarif(prix: number): void {}\nexport { tarif };')).toHaveLength(0);
    });

    test('only the exported function is a frontier: an arrow it returns is not', () => {
        const found = primitivesOf('export const tarif = (prix: number) => (remise: number): void => {};');
        expect(found.map(({ excerpt }) => excerpt)).toEqual(['prix: number']);
    });

    test('two parameters on two lines make two questions, each at its own line', () => {
        const found = primitivesOf('export function tarif(\n    description: string,\n    prix: number,\n): void {}');
        const lines = found.map(({ line }) => line);
        expect(found).toHaveLength(2);
        // The question is addressed to the parameter, so it points at the parameter's line.
        expect(lines[1]).toBe((lines[0] ?? 0) + 1);
    });
});
