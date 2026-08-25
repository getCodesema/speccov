import { describe, expect, test } from 'bun:test';
import { extractSite } from './extract';

/**
 * The trace is exercised through the public door: `extractSite` is what wires it, and a
 * test calling `traceCollection` by hand would build a context that the real path never
 * produces.
 */
function originOf(body: string): string | undefined {
    const source = `export class UseCase {
    constructor(private readonly repo: RepositoryPort) {}

    async run(command: Command): Promise<unknown[]> {
${body}
    }
}`;
    const extraction = extractSite('x.ts', source, 5);
    if (extraction.kind !== 'drafted') {
        return undefined;
    }
    const { origin } = extraction.site;
    if (origin === undefined || origin.kind !== 'dependency') {
        return undefined;
    }
    return `${origin.property}.${origin.method}`;
}

describe('tracing the collection back', () => {
    test('a filter does not change where it comes from', () => {
        expect(
            originOf(`        const page = await this.repo.list(command);
        return Promise.all(page.items.filter(Boolean).map((x) => this.repo.load(x)));`),
        ).toBe('repo.list');
    });

    test('nor does a sort: it reorders a single source', () => {
        expect(
            originOf(`        const page = await this.repo.list(command);
        return Promise.all(page.items.sort().map((x) => this.repo.load(x)));`),
        ).toBe('repo.list');
    });

    test('a concat has two origins: refuse rather than pick one', () => {
        // Feeding `a` and saying nothing of `b` would measure a fan-out over a half-empty
        // collection — a green light obtained on the wrong thing.
        expect(
            originOf(`        const page = await this.repo.list(command);
        return Promise.all(page.items.concat(page.extra).map((x) => this.repo.load(x)));`),
        ).toBeUndefined();
    });

    test('a flat can multiply: same refusal', () => {
        expect(
            originOf(`        const page = await this.repo.list(command);
        return Promise.all(page.groups.flat().map((x) => this.repo.load(x)));`),
        ).toBeUndefined();
    });
});
