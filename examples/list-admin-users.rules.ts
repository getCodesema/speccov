/**
 * A faithful reproduction of a real-world monorepo — apps/api/src/context/identity/application/use-cases/
 * list-admin-users/list-admin-users.ts:41, and of its fix.
 *
 * The in-memory database holds only THREE organizations, whatever the page size: that is
 * the point of ticket #4. Several users share the same organization, so the current
 * version reads the same rows over and over.
 */
import { complexity, Counter } from '../src/index';

type User = {
    readonly id: string;
    readonly organizationId: string;
};

type Organization = {
    readonly id: string;
    readonly areaId: string;
};

const ORGANIZATIONS: readonly Organization[] = [
    { id: 'org-1', areaId: 'area-north' },
    { id: 'org-2', areaId: 'area-south' },
    { id: 'org-3', areaId: 'area-east' },
];

const counter = new Counter();

const repository = {
    /** One query per call. It is the only read the port exposes today. */
    async findById(id: string): Promise<Organization | null> {
        counter.hit();
        return ORGANIZATIONS.find((organization) => organization.id === id) ?? null;
    },

    /** Batch read, de-duplicated: one query whatever the size of the batch. */
    async findByIds(ids: readonly string[]): Promise<Map<string, Organization>> {
        counter.hit();
        const wanted = new Set(ids);
        return new Map(
            ORGANIZATIONS.filter((organization) => wanted.has(organization.id)).map((organization) => [
                organization.id,
                organization,
            ]),
        );
    },
};

/** A page of `size` users, spread across the three organizations. */
function page(size: number): readonly User[] {
    return Array.from({ length: size }, (_unused, index) => ({
        id: `user-${index}`,
        organizationId: `org-${(index % ORGANIZATIONS.length) + 1}`,
    }));
}

/** As it stands in that monorepo: one findById per candidate, inside a Promise.all. */
async function filterVisibleUsersCurrent(candidates: readonly User[]): Promise<readonly User[]> {
    const organizations = await Promise.all(candidates.map((candidate) => repository.findById(candidate.organizationId)));
    return candidates.filter((_candidate, index) => organizations[index] !== null);
}

/** The proposed fix: a batch read, indexed by identifier and not by position. */
async function filterVisibleUsersFixed(candidates: readonly User[]): Promise<readonly User[]> {
    const organizations = await repository.findByIds(candidates.map((candidate) => candidate.organizationId));
    return candidates.filter((candidate) => organizations.has(candidate.organizationId));
}

export default [
    complexity({
        name: 'list-admin-users · current',
        unit: 'SQL queries',
        counter,
        subject: (size) => filterVisibleUsersCurrent(page(size)),
    }),
    complexity({
        name: 'list-admin-users · fixed',
        unit: 'SQL queries',
        counter,
        subject: (size) => filterVisibleUsersFixed(page(size)),
    }),
];
