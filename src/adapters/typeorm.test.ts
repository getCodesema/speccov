import { describe, expect, test } from 'bun:test';
import { Counter } from '../counter';
import { countingLogger, isDataQuery } from './typeorm';

describe('isDataQuery', () => {
    test.each([
        'SELECT "o"."id" FROM "organization" "o" WHERE "o"."id" = $1',
        'INSERT INTO "organization"("id") VALUES ($1)',
        'UPDATE "organization" SET "areaId" = $1',
        'DELETE FROM "organization" WHERE "id" = $1',
    ])('counts data queries: %s', (query) => {
        expect(isDataQuery(query)).toBe(true);
    });

    test.each(['START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT sp1', 'RELEASE SAVEPOINT sp1'])(
        'ignores transaction boundaries: %s',
        (query) => {
            expect(isDataQuery(query)).toBe(false);
        },
    );

    // Queries taken down as-is from a real TypeORM 1.1 / Postgres 17.
    test.each([
        'SELECT version()',
        'SELECT * FROM current_schema()',
        'SELECT * FROM current_database()',
        'SELECT current_schema() AS "currentSchema"',
    ])('ignores the handshake: %s', (query) => {
        expect(isDataQuery(query)).toBe(false);
    });

    test.each([
        'SELECT quote_ident(schemaname) || \'.\' || quote_ident(viewname) as "name" FROM "pg_views" WHERE 1=1',
        'SELECT quote_ident(schemaname) || \'.\' || quote_ident(matviewname) as "name" FROM "pg_matviews"',
        'SELECT quote_ident(schemaname) || \'.\' || quote_ident(tablename) as "name" FROM "pg_tables" WHERE 1=1',
        'SELECT quote_ident(n.nspname) as "name" FROM "pg_type" "t" INNER JOIN "pg_namespace" "n" ON 1=1',
    ])('ignores unqualified system catalogues: %s', (query) => {
        expect(isDataQuery(query)).toBe(false);
    });

    test('does not mistake a "version" column for the version() function', () => {
        expect(isDataQuery('SELECT "version" FROM "release"')).toBe(true);
    });

    test.each([
        'CREATE TABLE "organization" ("id" text NOT NULL)',
        'ALTER TABLE "organization" ADD "areaId" text',
        'DROP TABLE "organization"',
        'TRUNCATE "organization"',
    ])('ignores DDL: %s', (query) => {
        expect(isDataQuery(query)).toBe(false);
    });

    test.each([
        'SELECT * FROM "information_schema"."tables" WHERE "table_schema" = $1',
        'SELECT "table_name", obj_description(quote_ident("table_name")::regclass) FROM t',
    ])('ignores schema introspection: %s', (query) => {
        expect(isDataQuery(query)).toBe(false);
    });

    test('normalises case and repeated whitespace', () => {
        expect(isDataQuery('  start   transaction  ')).toBe(false);
    });

    test('when in doubt a query counts: under-counting would miss an N+1', () => {
        expect(isDataQuery('WITH ranked AS (SELECT 1) SELECT * FROM ranked')).toBe(true);
    });

    test('does not mistake a column named "commit" for a COMMIT', () => {
        expect(isDataQuery('SELECT "commit" FROM "build"')).toBe(true);
    });
});

describe('countingLogger', () => {
    test('counts every data query', () => {
        const counter = new Counter();
        const logger = countingLogger(counter);
        logger.logQuery('SELECT 1 FROM "t"');
        logger.logQuery('SELECT 2 FROM "t"');
        expect(counter.hits).toBe(2);
    });

    test('does not count transaction noise', () => {
        const counter = new Counter();
        const logger = countingLogger(counter);
        logger.logQuery('START TRANSACTION');
        logger.logQuery('INSERT INTO "t"("id") VALUES ($1)');
        logger.logQuery('COMMIT');
        expect(counter.hits).toBe(1);
    });

    test('counts failed queries too: they reached the database', () => {
        const counter = new Counter();
        const logger = countingLogger(counter);
        logger.logQueryError(new Error('boom'), 'SELECT 1 FROM "t"');
        expect(counter.hits).toBe(1);
    });

    test('does not count a slow query twice', () => {
        const counter = new Counter();
        const logger = countingLogger(counter);
        logger.logQuerySlow(1200, 'SELECT 1 FROM "t"');
        expect(counter.hits).toBe(0);
    });

    test('ignores schema, migration and log noise', () => {
        const counter = new Counter();
        const logger = countingLogger(counter);
        logger.logSchemaBuild('build');
        logger.logMigration('migration');
        logger.log('info', 'hello');
        expect(counter.hits).toBe(0);
    });

    test('an explicit filter replaces the default one', () => {
        const counter = new Counter();
        const logger = countingLogger(counter, { counts: (query) => query.includes('organization') });
        logger.logQuery('SELECT 1 FROM "t"');
        logger.logQuery('SELECT 1 FROM "organization"');
        expect(counter.hits).toBe(1);
    });
});
