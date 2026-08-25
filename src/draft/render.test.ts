import { describe, expect, test } from 'bun:test';
import type { DraftSite } from './extract';
import type { Harvest } from './harvest';
import { renderDraft } from './render';

const SITE: DraftSite = {
    file: '/repo/list-admin-users.ts',
    line: 41,
    subject: {
        kind: 'class',
        className: 'ListAdminUsers',
        methodName: 'run',
        constructorParameters: [
            { name: 'areaScope', type: 'AreaScopeService' },
            { name: 'organizations', type: 'OrganizationRepositoryPort' },
        ],
        entryParameters: [{ name: 'command', type: "Parameters<ListAdminUsers['run']>[0]" }],
    },
    probe: { kind: 'injected', property: 'organizations', method: 'findById' },
    collection: 'candidates',
    shape: 'async-per-item',
    origin: undefined,
};

const HARVEST: Harvest = {
    specFile: '/repo/list-admin-users.spec.ts',
    mockBuilders: [
        { name: 'buildMockAreaScope', from: '../../test-support/mock-area-scope' },
        { name: 'buildMockOrganizations', from: '../../test-support/mock-organization-repository' },
    ],
    helpers: ['buildUser'],
    localBuilders: [],
    mocks: [],
    constructorArguments: ['areaScope', 'organizations'],
};

describe('renderDraft', () => {
    test('writes next to the use case, like its spec', () => {
        expect(renderDraft(SITE, HARVEST).path).toBe('/repo/list-admin-users.rules.ts');
    });

    test('matches each dependency to its double factory', () => {
        const { content } = renderDraft(SITE, HARVEST);
        expect(content).toContain('const areaScope = buildMockAreaScope();');
        expect(content).toContain('const organizations = buildMockOrganizations();');
    });

    test('places the probe on the call found in the .map()', () => {
        expect(renderDraft(SITE, HARVEST).content).toContain('organizations.findById.mockImplementation');
    });

    test('calls the public entry point with the constructor order', () => {
        const { content } = renderDraft(SITE, HARVEST);
        expect(content).toContain('const subject = new ListAdminUsers(areaScope, organizations);');
        expect(content).toContain('await subject.run(command());');
    });

    test('names the spec factories to help fill the holes', () => {
        expect(renderDraft(SITE, HARVEST).todos.join(' ')).toContain('buildUser');
    });

    test('an unfilled hole throws: never a misleading green light', () => {
        const { content } = renderDraft(SITE, HARVEST);
        expect(content).toContain("throw new Error('TODO speccov: provide a valid command for ListAdminUsers.run().')");
        expect(content).toContain('function missing(what: string): never');
    });

    test('a dependency without a double becomes an explicit hole', () => {
        const { content, todos } = renderDraft(SITE, { ...HARVEST, mockBuilders: [] });
        // `missing()` returns `never`: it threw at wiring, and the subject could not even be
        // instantiated. The double now exists and throws only on the member actually asked for.
        expect(content).toContain("const areaScope = only<ConstructorParameters<typeof ListAdminUsers>[0]>('areaScope');");
        expect(todos.join(' ')).toContain('provide a double for "areaScope: AreaScopeService"');
    });

    test('without a harvested factory, the probe no longer demands a runner mock', () => {
        // `.mockImplementation` only exists on a double that came from a `buildMock*`.
        // Without one, writing it imposed a convention the draft never checked.
        const { content } = renderDraft(SITE, { ...HARVEST, mockBuilders: [] });
        expect(content).not.toContain('mockImplementation');
        expect(content).toContain(
            "const organizations = only<ConstructorParameters<typeof ListAdminUsers>[1]>('organizations', 'findById', () =>",
        );
    });

    test('without a neighbouring spec, all the wiring becomes a hole', () => {
        const { todos } = renderDraft(SITE, undefined);
        expect(todos).toContain('wire this collection onto the dependency that produces it.');
        expect(todos).toContain('provide a valid command for ListAdminUsers.run().');
        // Placing the probe removes the "provide a double" decision, never the one about the
        // value it returns: the measured code consumes it.
        expect(todos).toContain('provide the value organizations.findById() must return.');
        expect(todos.length).toBe(5);
    });

    test('the size reaches the subject, or the draft throws', () => {
        const { content } = renderDraft(SITE, HARVEST);
        expect(content).toContain('const items = collectionOf(size);');
        expect(content).not.toContain('void collectionOf(size);');
    });

    test('the command factory is copied when its return type is the right one', () => {
        const withBuilder = {
            ...HARVEST,
            localBuilders: [
                {
                    name: 'buildScopedQuery',
                    returns: "Parameters<ListAdminUsers['run']>[0]",
                    source: "function buildScopedQuery(): Parameters<ListAdminUsers['run']>[0] {\n    return { limit: 10 };\n}",
                    exampleCall: undefined,
                },
            ],
        };
        const { content, todos } = renderDraft(SITE, withBuilder);
        expect(content).toContain("function command(): Parameters<ListAdminUsers['run']>[0] {");
        expect(content).toContain('return { limit: 10 };');
        expect(todos.join(' ')).not.toContain('provide a valid command');
    });

    test('a return type that does not match is not copied', () => {
        const wrong = {
            ...HARVEST,
            localBuilders: [
                {
                    name: 'buildUser',
                    returns: 'User',
                    source: 'function buildUser(): User { return {} as User; }',
                    exampleCall: undefined,
                },
            ],
        };
        expect(renderDraft(SITE, wrong).todos.join(' ')).toContain('provide a valid command');
    });
});

describe('renderDraft · unbounded fan-out', () => {
    const FANOUT: DraftSite = { ...SITE, shape: 'unbounded-fanout' };

    test('places a Gauge and a resource() rule, not a Counter', () => {
        const { content } = renderDraft(FANOUT, HARVEST);
        expect(content).toContain("import { resource, Gauge } from '@codesema/speccov';");
        expect(content).toContain('const gauge = new Gauge();');
        expect(content).toContain('resource({');
        expect(content).not.toContain('new Counter()');
    });

    test('wraps the read instead of counting it', () => {
        expect(renderDraft(FANOUT, HARVEST).content).toContain('gauge.track(');
    });

    test('the ceiling throws: it is decided, it is not derived', () => {
        const { content, todos } = renderDraft(FANOUT, HARVEST);
        expect(content).toContain('function ceiling(): number {');
        expect(content).toContain('ceiling: ceiling(),');
        expect(todos).toContain('choose the tolerated concurrency peak.');
    });

    test('the reason behind the ceiling throws too: a bare number cannot be fixed', () => {
        const { content, todos } = renderDraft(FANOUT, HARVEST);
        expect(content).toContain('function intention(): string {');
        expect(content).toContain('intention: intention(),');
        expect(todos).toContain('say where this ceiling comes from.');
    });

    test('a bare .map() asks for no reason: nothing was chosen', () => {
        const { content, todos } = renderDraft(SITE, HARVEST);
        expect(content).not.toContain('function intention(): string {');
        expect(todos).not.toContain('say where this ceiling comes from.');
    });

    test('a bare .map() stays a question of total', () => {
        const { content } = renderDraft(SITE, HARVEST);
        expect(content).toContain('complexity({');
        expect(content).not.toContain('resource({');
    });
});

/**
 * The holes actually written in the text: a stub that throws, or a call to `missing()`.
 *
 * We count the text, not the cases. One test per form would let the next rendering path
 * slip through; the invariant holds whatever the shape of the site.
 */
function holes(content: string): number {
    // A "TODO speccov:" written in a comment annotates a hole; the embedded probes write the
    // same marker inside their own messages, right after a quote, and those do not count.
    const annotated = content.match(/(?<!['`])TODO speccov:/gu) ?? [];
    const calls = content.match(/missing\(['`]/gu) ?? [];
    return annotated.length + calls.length;
}

describe('the decision list is exhaustive', () => {
    const OWN: DraftSite = {
        ...SITE,
        probe: { kind: 'own', method: 'compute' },
        origin: { kind: 'argument', index: 0, name: 'command' },
    };
    const ITEM: DraftSite = { ...SITE, probe: { kind: 'item', method: 'close' } };
    const FREE: DraftSite = {
        ...SITE,
        subject: {
            kind: 'function',
            functionName: 'syncScreens',
            entryParameters: [
                { name: 'screens', type: 'ScreenPort' },
                { name: 'ids', type: 'readonly string[]' },
            ],
        },
        probe: { kind: 'parameter', parameter: 'screens', method: 'fetchState' },
        origin: { kind: 'argument', index: 1, name: 'ids' },
    };

    const forms: readonly (readonly [string, DraftSite, Harvest | undefined])[] = [
        ['class · harvested factory', SITE, HARVEST],
        ['class · no factory', SITE, { ...HARVEST, mockBuilders: [] }],
        ['class · no neighbouring spec', SITE, undefined],
        ['class · unbounded fan-out', { ...SITE, shape: 'unbounded-fanout' }, HARVEST],
        ['probe on a method of the subject', OWN, HARVEST],
        ['probe carried by the item', ITEM, HARVEST],
        ['free function · probe on a parameter', FREE, undefined],
    ];

    for (const [name, site, harvest] of forms) {
        test(`${name}: as many lines as holes`, () => {
            const { content, todos } = renderDraft(site, harvest);
            // The contract with whoever fills it — often an agent: a hole the list keeps quiet
            // about becomes an unannounced `throw`, so a loop or a deleted `missing()`.
            expect(todos.length).toBe(holes(content));
        });
    }
});
