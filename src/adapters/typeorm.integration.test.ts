import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DataSource, EntitySchema, In } from 'typeorm';
import { complexity } from '../complexity';
import { Counter } from '../counter';
import { countingLogger } from './typeorm';

/**
 * Proof against a real TypeORM and a real Postgres: the N+1 in `list-admin-users` is
 * detected through the real stack, transaction noise included.
 *
 *   docker run -d --rm -e POSTGRES_PASSWORD=speccov -e POSTGRES_DB=speccov \
 *     -p 55432:5432 docker.io/library/postgres:17-alpine
 *   SPECCOV_PG_URL=postgres://postgres:speccov@localhost:55432/speccov bun test
 *
 * Without `SPECCOV_PG_URL`, the suite is skipped: nobody should need Docker to run the
 * unit tests.
 */
const url = process.env['SPECCOV_PG_URL'] ?? '';
const suite = url === '' ? describe.skip : describe;

type OrganizationRow = {
    id: string;
    areaId: string;
};

const Organization = new EntitySchema<OrganizationRow>({
    name: 'SpeccovOrganization',
    tableName: 'speccov_organization',
    columns: { id: { type: 'text', primary: true }, areaId: { type: 'text' } },
});

const ORGANIZATION_IDS = ['org-1', 'org-2', 'org-3'];

suite('complexity against a real TypeORM', () => {
    const counter = new Counter();
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            url,
            entities: [Organization],
            synchronize: true,
            dropSchema: true,
            logger: countingLogger(counter),
        });
        await dataSource.initialize();
        await dataSource.getRepository(Organization).save(ORGANIZATION_IDS.map((id, index) => ({ id, areaId: `area-${index}` })));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    /** A page of `size` users spread over three organizations only. */
    function page(size: number): readonly string[] {
        return Array.from({ length: size }, (_unused, index) => `org-${(index % ORGANIZATION_IDS.length) + 1}`);
    }

    test('the transaction noise of the seed does not count', () => {
        // `save` emitted START TRANSACTION / INSERT / COMMIT: only the INSERT counts,
        // plus the SELECT TypeORM runs first to know whether to insert or to update.
        expect(counter.hits).toBeLessThanOrEqual(2);
    });

    test('one findOneBy per item is seen as an N+1', async () => {
        const repository = dataSource.getRepository(Organization);
        const rule = complexity({
            name: 'findOneBy per candidate',
            unit: 'SQL queries',
            counter,
            subject: async (size) => {
                await Promise.all(page(size).map((id) => repository.findOneBy({ id })));
            },
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(false);
        expect(judgement.magnitude).toBeCloseTo(1, 6);
    });

    test('a batched read holds the rule whatever the page size', async () => {
        const repository = dataSource.getRepository(Organization);
        const rule = complexity({
            name: 'findBy(In) deduplicated',
            unit: 'SQL queries',
            counter,
            subject: async (size) => {
                await repository.findBy({ id: In([...new Set(page(size))]) });
            },
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(true);
        expect(judgement.magnitude).toBe(0);
    });
});
