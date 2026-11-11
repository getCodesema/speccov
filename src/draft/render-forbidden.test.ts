import { describe, expect, test } from 'bun:test';
import type { DomainField } from './domain';
import { renderForbidden } from './render-forbidden';

const ROLE: DomainField = {
    name: 'role',
    values: ['"viewer"', '"org_admin"', '"platform_admin"'],
    declared: '"viewer" | "org_admin" | "platform_admin"',
    finite: true,
    edges: [],
};
const AREA: DomainField = { name: 'adminAreaId', values: ['null'], declared: 'string | null', finite: false, edges: [] };
/** A field whose infinite part carries boundary values, as `readDomain()` produces them. */
const PRICE: DomainField = {
    name: 'prix',
    values: [],
    declared: 'number',
    finite: false,
    edges: ['0', '-1', 'Number.NaN'],
};

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

    test('the boundary values are written out, after the one still to be provided', () => {
        expect(renderForbidden('/repo/actors.ts', 'Actor', [PRICE]).content).toContain(
            "prix: [missing('a value for prix: number'), 0, -1, Number.NaN],",
        );
    });

    test('the boundary values count in the announced total', () => {
        // Three edges plus the value still to be provided.
        expect(renderForbidden('/repo/actors.ts', 'Actor', [ROLE, PRICE]).content).toContain('3 × 4 = 12 cases');
    });

    test('a boundary value never replaces the human decision', () => {
        const { todos } = renderForbidden('/repo/actors.ts', 'Actor', [PRICE]);
        expect(todos).toContain('provide a value for "prix: number".');
    });

    test('writes next to the type, like the other drafts', () => {
        expect(renderForbidden('/repo/actors.ts', 'Actor', [ROLE]).path).toBe('/repo/actors.rules.ts');
    });
});
