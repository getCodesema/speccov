import { describe, expect, test } from 'bun:test';
import { readSpec } from './harvest';

const SPEC = `import { ListAdminUsers } from './list-admin-users';
import { buildMockAreaScope } from '../../test-support/mock-area-scope';
import { buildMockOrganizations } from '../../test-support/mock-organization-repository';
import type { User } from '../../models/user';

function buildUser(id: string): User { return { id } as User; }
function buildScopedQuery() { return { limit: 50 }; }

describe(ListAdminUsers.name, () => {
    it('works', () => {
        const useCase = new ListAdminUsers(areaScope, organizations, users);
    });
});`;

describe('readSpec', () => {
    test('harvests the double factories and where they come from', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'ListAdminUsers').mockBuilders).toEqual([
            { name: 'buildMockAreaScope', from: '../../test-support/mock-area-scope' },
            { name: 'buildMockOrganizations', from: '../../test-support/mock-organization-repository' },
        ]);
    });

    test('does not carry along the imports that are not doubles', () => {
        const names = readSpec(SPEC, 'x.spec.ts', 'ListAdminUsers').mockBuilders.map(({ name }) => name);
        expect(names).not.toContain('ListAdminUsers');
        expect(names).not.toContain('User');
    });

    test('harvests the local functions, candidates as factories', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'ListAdminUsers').helpers).toEqual(['buildUser', 'buildScopedQuery']);
    });

    test('takes the order of the constructor arguments', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'ListAdminUsers').constructorArguments).toEqual([
            'areaScope',
            'organizations',
            'users',
        ]);
    });

    test('ignores a new of another class', () => {
        expect(readSpec(SPEC, 'x.spec.ts', 'SomethingElse').constructorArguments).toEqual([]);
    });
});
