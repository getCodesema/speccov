/**
 * The four defects found in a real-world monorepo, one per rule type.
 *
 * None is caught by the typed lint, the 90% coverage, the mutation tests or the repo's
 * e2e. All of them pass 100% of the existing gates.
 */
import { allOf, complexity, Counter, forbidden, Gauge, metamorphic, resource } from '../src/index';

const counter = new Counter();
const gauge = new Gauge();

// ─── 1. Complexity — the N+1 of list-admin-users.ts:41 ───────────────────────────────

const ORGANIZATION_IDS = ['org-1', 'org-2', 'org-3'];

function page(size: number): readonly string[] {
    return Array.from({ length: size }, (_unused, index) => ORGANIZATION_IDS[index % ORGANIZATION_IDS.length] ?? 'org-1');
}

async function findOrganizationsOneByOne(ids: readonly string[]): Promise<number> {
    const found = await Promise.all(
        ids.map(async (id) => {
            counter.hit();
            return ORGANIZATION_IDS.includes(id);
        }),
    );
    return found.length;
}

// ─── 2. Resource — the unbounded Promise.all ─────────────────────────────────────────

async function syncScreens(size: number): Promise<void> {
    await Promise.all(Array.from({ length: size }, () => gauge.track(() => Promise.resolve())));
}

// ─── 3. Metamorphic — the `total: items.length` of list-admin-users.ts:36 ────────────

type PageQuery = {
    readonly limit: number;
    readonly offset: number;
};

/** Reproduces the defect: once filtered by area, `total` becomes the size of the page. */
function listAdminUsers({ limit, offset }: PageQuery): { total: number } {
    const visibleOnThisPage = Math.max(0, Math.min(limit, 25 - offset));
    return { total: visibleOnThisPage };
}

// ─── 4. Forbidden — the "no adminAreaId = global access" of AreaScopeService ─────────

type Actor = {
    readonly role: 'viewer' | 'org_admin' | 'platform_viewer' | 'platform_admin';
    readonly adminAreaId: string | null;
};

/**
 * The domain, not a list of cases. Four roles and two area states: all eight actors are
 * produced, including the ones nobody would have thought of.
 */
const ACTORS = allOf<Actor>({
    role: ['viewer', 'org_admin', 'platform_viewer', 'platform_admin'],
    adminAreaId: ['area-north', null],
});

/** The current semantics: no area set ⇒ global scope. */
function hasGlobalScope(actor: Actor): boolean {
    return actor.adminAreaId === null;
}

export default [
    complexity({
        name: 'list-admin-users · resolving the organizations',
        unit: 'SQL queries',
        counter,
        subject: (size) => findOrganizationsOneByOne(page(size)),
    }),

    resource({
        name: 'screen sync · outgoing concurrency',
        unit: 'concurrent queries',
        ceiling: 5,
        gauge,
        subject: (size) => syncScreens(size),
    }),

    metamorphic({
        name: 'list-admin-users · total',
        intention: 'The announced total does not depend on the page requested',
        variants: [
            { limit: 10, offset: 0 },
            { limit: 10, offset: 10 },
            { limit: 10, offset: 20 },
        ],
        observe: (query) => listAdminUsers(query).total,
        describe: ({ limit, offset }) => `limit=${limit} offset=${offset}`,
    }),

    forbidden({
        name: 'AreaScopeService · global scope',
        intention: 'Only a platform actor gets a global scope; an org_admin never does',
        cases: ACTORS,
        forbids: (actor) => hasGlobalScope(actor) && !actor.role.startsWith('platform_'),
        describe: (actor) => `${actor.role} ${actor.adminAreaId === null ? 'without an area' : `area ${actor.adminAreaId}`}`,
    }),
];
