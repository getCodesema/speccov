import { describe, expect, test } from 'bun:test';
import { extractSite, type DraftSite, type Subject } from './extract';

const USE_CASE = `export class ListAdminUsers {
    constructor(
        private readonly areaScope: AreaScopeService,
        private readonly organizations: OrganizationRepositoryPort,
        private readonly users: UserRepositoryPort,
    ) {}

    async run(command: Command): Promise<User[]> {
        return this.filterVisibleUsers(await this.users.list(command));
    }

    private async filterVisibleUsers(candidates: User[]): Promise<User[]> {
        const organizations = await Promise.all(
            candidates.map((candidate) => this.organizations.findById(candidate.organizationId)),
        );
        return candidates;
    }
}`;

/** Line of the `.map()` in the fixture above. Named so it is never recounted by hand. */
const MAP_LINE = 14;

function drafted(source: string, line: number): DraftSite {
    const extraction = extractSite('x.ts', source, line);
    if (extraction.kind !== 'drafted') {
        throw new Error(`expected a draft, refused: ${extraction.reason}`);
    }
    return extraction.site;
}

function asClass(subject: Subject): Extract<Subject, { kind: 'class' }> {
    if (subject.kind !== 'class') {
        throw new Error('expected a class subject');
    }
    return subject;
}

function refusal(source: string, line: number): string {
    const extraction = extractSite('x.ts', source, line);
    if (extraction.kind !== 'refused') {
        throw new Error('expected a refusal');
    }
    return extraction.reason;
}

describe('extractSite · the class with injected dependencies', () => {
    test('picks up the class and the collection being iterated', () => {
        const site = drafted(USE_CASE, MAP_LINE);
        expect(asClass(site.subject).className).toBe('ListAdminUsers');
        expect(site.collection).toBe('candidates');
    });

    test('picks up the call counted in the .map()', () => {
        expect(drafted(USE_CASE, MAP_LINE).probe).toEqual({ kind: 'injected', property: 'organizations', method: 'findById' });
    });

    test('picks up the constructor parameters, in order', () => {
        expect(asClass(drafted(USE_CASE, MAP_LINE).subject).constructorParameters).toEqual([
            { name: 'areaScope', type: 'AreaScopeService' },
            { name: 'organizations', type: 'OrganizationRepositoryPort' },
            { name: 'users', type: 'UserRepositoryPort' },
        ]);
    });

    test('walks up from the private method to the public entry point', () => {
        expect(asClass(drafted(USE_CASE, MAP_LINE).subject).methodName).toBe('run');
    });

    test('accepts the Promise.all line as that of the folded .map()', () => {
        expect(asClass(drafted(USE_CASE, MAP_LINE - 1).subject).methodName).toBe('run');
    });

    test('refuses when several reads share the .map()', () => {
        const source = USE_CASE.replace(
            'this.organizations.findById(candidate.organizationId)',
            'this.organizations.findById(candidate.organizationId) ?? this.users.findById(candidate.id)',
        );
        expect(refusal(source, MAP_LINE)).toContain('several reads');
    });

    test('refuses a private method that no public one calls', () => {
        const source = USE_CASE.replace('return this.filterVisibleUsers(await this.users.list(command));', 'return [];');
        expect(refusal(source, MAP_LINE)).toContain('no public method calls it');
    });

    test('refuses a private method called by several public ones', () => {
        const source = USE_CASE.replace(
            '    private async filterVisibleUsers',
            '    async other(c: Command) { return this.filterVisibleUsers([]); }\n\n    private async filterVisibleUsers',
        );
        expect(refusal(source, MAP_LINE + 2)).toContain('2 public methods');
    });

    test('refuses when the line carries no .map()', () => {
        expect(refusal(USE_CASE, 1)).toContain('no ".map(…)" call');
    });
});

describe('extractSite · the probe is not necessarily injected', () => {
    const OWN = `export class Batch {
    async computeAll(queries: Query[]): Promise<Result[]> {
        return Promise.all(queries.map((q) => this.compute(q)));
    }

    private async compute(q: Query): Promise<Result> {
        return run(q);
    }
}`;

    test('a class with no constructor is still instantiable', () => {
        expect(asClass(drafted(OWN, 3).subject).constructorParameters).toEqual([]);
    });

    test('counts a method of the subject itself', () => {
        expect(drafted(OWN, 3).probe).toEqual({ kind: 'own', method: 'compute' });
    });

    test('counts a call carried by the item being iterated', () => {
        const source = `export class Pool {
    async closeAll(connections: Connection[]): Promise<void> {
        await Promise.all(connections.map((connection) => connection.close()));
    }
}`;
        expect(drafted(source, 3).probe).toEqual({ kind: 'item', method: 'close' });
    });

    test('recognizes the collection when it is an argument of the entry point', () => {
        expect(drafted(OWN, 3).origin).toEqual({ kind: 'argument', index: 0, name: 'queries' });
    });

    test('refuses internal state the draft does not drive', () => {
        const source = 'export class A {\n  async run(xs: string[]) { return xs.map((x) => this.repo.findById(x)); }\n}';
        expect(refusal(source, 2)).toContain('is not injected');
    });

    test('refuses a module function: it cannot be observed without a module double', () => {
        const source = 'export function all(xs: string[]) {\n  return Promise.all(xs.map((x) => fetchOne(x)));\n}';
        expect(refusal(source, 2)).toContain('module function');
    });

    test('refuses a callback whose body points to no single call', () => {
        const source = `export class A {
    async run(xs: string[]) {
        return Promise.all(xs.map((x) => { const a = load(x); const b = load(x); return [a, b]; }));
    }
}`;
        expect(refusal(source, 3)).toContain('single call per item');
    });

    test('counts the sole awaited call when the callback guards on entry', () => {
        const source = `export class Notifier {
    async notifyAll(ids: string[], tokens: Map<string, string>) {
        await Promise.allSettled(
            ids.map(async (id) => {
                const token = tokens.get(id);
                if (!token) {
                    return false;
                }
                await this.publish(id, token);
                return true;
            }),
        );
    }
}`;
        expect(drafted(source, 4).probe).toEqual({ kind: 'own', method: 'publish' });
    });

    test('refuses two awaited calls in the same callback', () => {
        const source = `export class A {
    async run(xs: string[]) {
        await Promise.all(
            xs.map(async (x) => {
                await this.first(x);
                await this.second(x);
            }),
        );
    }
}`;
        expect(refusal(source, 4)).toContain('single call per item');
    });

    test('ignores the awaits of a nested callback: they spread something else', () => {
        const source = `export class A {
    async run(xs: string[][]) {
        await Promise.all(
            xs.map(async (group) => {
                await this.handle(group);
                group.forEach(async (x) => {
                    await this.inner(x);
                });
            }),
        );
    }
}`;
        expect(drafted(source, 4).probe).toEqual({ kind: 'own', method: 'handle' });
    });
});

describe('extractSite · the exported function', () => {
    const FREE = `export async function syncScreens(screens: ScreenPort, ids: readonly string[]) {
    return Promise.all(ids.map((id) => screens.fetchState(id)));
}`;

    test('the subject is the function, there is nothing to instantiate', () => {
        expect(drafted(FREE, 2).subject).toEqual({
            kind: 'function',
            functionName: 'syncScreens',
            entryParameters: [
                { name: 'screens', type: 'ScreenPort' },
                { name: 'ids', type: 'readonly string[]' },
            ],
        });
    });

    test('the dependency arriving as a parameter carries the probe', () => {
        expect(drafted(FREE, 2).probe).toEqual({ kind: 'parameter', parameter: 'screens', method: 'fetchState' });
    });

    test('the collection is the argument the draft passes itself', () => {
        expect(drafted(FREE, 2).origin).toEqual({ kind: 'argument', index: 1, name: 'ids' });
    });

    test('an exported arrow const is a subject like any other', () => {
        const source =
            'export const sync = async (screens: ScreenPort, ids: string[]) => Promise.all(ids.map((id) => screens.fetchState(id)));';
        const subject = drafted(source, 1).subject;
        expect(subject.kind === 'function' && subject.functionName).toBe('sync');
    });

    test('refuses a function the module does not export', () => {
        const source =
            'async function sync(screens: ScreenPort, ids: string[]) {\n  return Promise.all(ids.map((id) => screens.fetchState(id)));\n}';
        expect(refusal(source, 2)).toContain('not inside an exported function');
    });

    test('refuses outside any function', () => {
        expect(refusal('const xs = ys.map((y) => repo.findById(y));', 1)).toContain('nothing to call from the outside');
    });
});
