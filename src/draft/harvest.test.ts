import { describe, expect, test } from 'bun:test';
import { readSpec } from './harvest';

const SPEC = `import { ListMembers } from './list-members';
import { buildMockRegionScope } from '../../test-support/mock-region-scope';
import { buildMockOrganizations } from '../../test-support/mock-organization-repository';
import type { User } from '../../models/user';

function buildUser(id: string): User { return { id } as User; }
function buildScopedQuery() { return { limit: 50 }; }

describe(ListMembers.name, () => {
    it('works', () => {
        const useCase = new ListMembers(regionScope, organizations, users);
    });
});`;

describe('readSpec', () => {
    test('harvests the double factories and where they come from', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'ListMembers').mockBuilders).toEqual([
            { name: 'buildMockRegionScope', from: '../../test-support/mock-region-scope' },
            { name: 'buildMockOrganizations', from: '../../test-support/mock-organization-repository' },
        ]);
    });

    test('does not carry along the imports that are not doubles', () => {
        const names = readSpec(SPEC, 'x.spec.ts', 'ListMembers').mockBuilders.map(({ name }) => name);
        expect(names).not.toContain('ListMembers');
        expect(names).not.toContain('User');
    });

    test('harvests the local functions, candidates as factories', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'ListMembers').helpers).toEqual(['buildUser', 'buildScopedQuery']);
    });

    test('takes the order of the constructor arguments', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'ListMembers').constructorArguments).toEqual([
            'regionScope',
            'organizations',
            'users',
        ]);
    });

    test('ignores a new of another class', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'SomethingElse').constructorArguments).toEqual([]);
    });
});
