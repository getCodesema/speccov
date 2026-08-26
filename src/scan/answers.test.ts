import { describe, expect, test } from 'bun:test';
import { acceptSite, applySiteAnswers, parseSiteAnswers, shapeOf, type SiteAnswer } from './answers';
import type { Site } from './shapes';

const SITE: Site = {
    kind: 'unbounded-fanout',
    file: 'src/list.ts',
    line: 41,
    excerpt: 'Promise.all(users.map((u) => sync(u)))',
};

const TODAY = '2026-08-26';

describe('answering a site', () => {
    test('an answered site goes quiet but stays counted', () => {
        const applied = applySiteAnswers([SITE], [acceptSite(SITE, TODAY)]);

        expect(applied.sites).toEqual([]);
        expect(applied.accepted).toEqual([SITE]);
    });

    test('the same code moved down the file is the same answer', () => {
        const moved: Site = { ...SITE, line: 118 };

        expect(applySiteAnswers([moved], [acceptSite(SITE, TODAY)]).accepted).toEqual([moved]);
    });

    test('reformatting is not a new question', () => {
        const reformatted: Site = { ...SITE, excerpt: 'Promise.all(\n    users.map((u) => sync(u)),\n)' };

        expect(applySiteAnswers([reformatted], [acceptSite(SITE, TODAY)]).accepted).toHaveLength(1);
    });

    test('changed code asks again: it is no longer what was ruled on', () => {
        const changed: Site = { ...SITE, excerpt: 'Promise.all(users.map((u) => sync(u, opts)))' };
        const applied = applySiteAnswers([changed], [acceptSite(SITE, TODAY)]);

        expect(applied.sites).toEqual([changed]);
        expect(applied.accepted).toEqual([]);
    });

    test('the other question on the same code is not answered by it', () => {
        const other: Site = { ...SITE, kind: 'async-per-item' };
        const applied = applySiteAnswers([other], [acceptSite(SITE, TODAY)]);

        expect(applied.sites).toEqual([other]);
    });

    test('the same shape in another file is another site', () => {
        const elsewhere: Site = { ...SITE, file: 'src/other.ts' };

        expect(applySiteAnswers([elsewhere], [acceptSite(SITE, TODAY)]).sites).toEqual([elsewhere]);
    });

    test('a reason is kept, and an empty one is not written', () => {
        expect(acceptSite(SITE, TODAY, '  known, ticket #4  ').why).toBe('known, ticket #4');
        expect(acceptSite(SITE, TODAY, '   ')).not.toHaveProperty('why');
    });

    test('the shape drops the layout, never the code', () => {
        expect(shapeOf('  Promise.all(\n\txs.map(f),\n)  ')).toBe('Promise.all( xs.map(f), )');
    });
});

describe('reading the answers file', () => {
    test('a well-formed file is read', () => {
        const answer: SiteAnswer = { file: 'a.ts', kind: 'unbounded-fanout', shape: 'Promise.all(xs)', at: TODAY };

        expect(parseSiteAnswers({ version: 1, sites: [answer] }, 'p.json')).toEqual([answer]);
    });

    test('an unreadable file throws rather than read as empty or as all-accepted', () => {
        expect(() => parseSiteAnswers({ version: 2, sites: [] }, 'p.json')).toThrow('not a valid scan answers file');
        expect(() => parseSiteAnswers(null, 'p.json')).toThrow('not a valid scan answers file');
        expect(() => parseSiteAnswers({ version: 1, sites: [{ file: 'a.ts' }] }, 'p.json')).toThrow('unreadable');
    });
});
