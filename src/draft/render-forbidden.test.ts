import { describe, expect, test } from 'bun:test';
import type { DomainField } from './domain';
import { renderForbidden } from './render-forbidden';

const ROLE: DomainField = {
    name: 'role',
    values: ['"viewer"', '"org_admin"', '"platform_admin"'],
    declared: '"viewer" | "org_admin" | "platform_admin"',
    finite: true,
};
const AREA: DomainField = { name: 'adminAreaId', values: ['null'], declared: 'string | null', finite: false };

describe('renderForbidden', () => {
    test('writes the finite values out in plain sight, not a call to the type', () => {
        expect(renderForbidden('/repo/actors.ts', 'Actor', [ROLE]).content).toContain(
            'role: ["viewer", "org_admin", "platform_admin"],',
        );
    });

    test('a field the type does not bound becomes a call that throws', () => {
        const { content, todos } = renderForbidden('/repo/actors.ts', 'Actor', [ROLE, AREA]);
        expect(content).toContain("adminAreaId: [missing('a value for adminAreaId: string | null'), null],");
        expect(todos).toContain('provide a value for "adminAreaId: string | null".');
    });

    test('the infinite part counts as one value in the announced total', () => {
        expect(renderForbidden('/repo/actors.ts', 'Actor', [ROLE, AREA]).content).toContain('3 × 2 = 6 cases');
    });

    test('the sentence and the ban stay human', () => {
        const { todos } = renderForbidden('/repo/actors.ts', 'Actor', [ROLE]);
        expect(todos).toContain('write the business sentence "Actor" must never violate.');
        expect(todos).toContain('say what is forbidden for a "Actor".');
    });

    test('writes next to the type, like the other drafts', () => {
        expect(renderForbidden('/repo/actors.ts', 'Actor', [ROLE]).path).toBe('/repo/actors.rules.ts');
    });
});
