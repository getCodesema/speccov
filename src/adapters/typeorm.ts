import type { Counter } from '../counter';

/**
 * Structural subset of TypeORM's `Logger` interface. Declared here rather than
 * imported: speccov depends on no ORM.
 */
export type TypeOrmLogger = {
    logQuery(query: string, parameters?: unknown[], queryRunner?: unknown): void;
    logQueryError(error: string | Error, query: string, parameters?: unknown[], queryRunner?: unknown): void;
    logQuerySlow(time: number, query: string, parameters?: unknown[], queryRunner?: unknown): void;
    logSchemaBuild(message: string, queryRunner?: unknown): void;
    logMigration(message: string, queryRunner?: unknown): void;
    log(level: 'log' | 'info' | 'warn', message: unknown, queryRunner?: unknown): void;
};

export type CountingLoggerOptions = {
    /** Decides whether a query counts. Defaults to {@link isDataQuery}. */
    readonly counts?: (query: string) => boolean;
};

/** Transaction boundaries: TypeORM hands them to the logger like any other query. */
const TRANSACTION_CONTROL = ['START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'];

/**
 * Connection introspection functions. TypeORM calls them in several shapes
 * (`SELECT version()`, `SELECT current_schema() AS "currentSchema"`, `SELECT * FROM
 * current_schema()`): they are recognised by the function, not by the whole query.
 */
const CONNECTION_FUNCTIONS = ['VERSION()', 'CURRENT_SCHEMA()', 'CURRENT_DATABASE()'];

/** `FROM pg_tables`, `JOIN pg_namespace`… Postgres reserves the `pg_` prefix: never a business table. */
const SYSTEM_RELATION = /\s(?:FROM|JOIN)\s+PG_/u;

/** A query that reads no table, or only a system function. */
const NO_USER_TABLE = /\sFROM\s+(?!CURRENT_)/u;

/** Schema definition verbs: `synchronize` and the migrations, not the business code. */
const SCHEMA_VERBS = ['CREATE ', 'ALTER ', 'DROP ', 'TRUNCATE '];

/** Introspection catalogues, read by `synchronize`. */
const CATALOGS = ['INFORMATION_SCHEMA.', 'OBJ_DESCRIPTION('];

/**
 * True if the query is a read or a write of data, and not of infrastructure.
 *
 * Deliberately conservative: under-counting would *miss* N+1s, and that is the dangerous
 * direction. When in doubt, a query counts.
 */
export function isDataQuery(query: string): boolean {
    // Quotes are stripped: TypeORM writes `"information_schema"."tables"`, and the dot is
    // then no longer flush against the catalogue name.
    const normalised = query.trim().replaceAll(/\s+/gu, ' ').replaceAll('"', '').toUpperCase();
    if (TRANSACTION_CONTROL.some((keyword) => normalised === keyword || normalised.startsWith(`${keyword} `))) {
        return false;
    }
    const callsConnectionFunction = CONNECTION_FUNCTIONS.some((name) => normalised.includes(name));
    if (callsConnectionFunction && !NO_USER_TABLE.test(normalised)) {
        return false;
    }
    if (SCHEMA_VERBS.some((verb) => normalised.startsWith(verb))) {
        return false;
    }
    if (SYSTEM_RELATION.test(normalised)) {
        return false;
    }
    return !CATALOGS.some((catalog) => normalised.includes(catalog));
}

/**
 * A TypeORM logger that does nothing but count. Pass it as the DataSource `logger` option.
 *
 * `logQueryError` counts too: a query that fails did reach the database, it weighs as much as
 * any other in an N+1.
 */
export function countingLogger(counter: Counter, options: CountingLoggerOptions = {}): TypeOrmLogger {
    const counts = options.counts ?? isDataQuery;
    const hit = (query: string): void => {
        if (counts(query)) {
            counter.hit();
        }
    };
    return {
        logQuery: (query) => hit(query),
        logQueryError: (_error, query) => hit(query),
        logQuerySlow: () => {},
        logSchemaBuild: () => {},
        logMigration: () => {},
        log: () => {},
    };
}
