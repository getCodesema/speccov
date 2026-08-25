import { readFile } from 'node:fs/promises';
import { extractSite, type Extraction } from './extract';
import { harvestSpec } from './harvest';
import { readDomain } from './domain';
import { renderDraft, type Draft } from './render';
import { renderForbidden } from './render-forbidden';

export type DraftResult =
    { readonly kind: 'drafted'; readonly draft: Draft } | { readonly kind: 'refused'; readonly reason: string };

export async function draft(file: string, line: number): Promise<DraftResult> {
    const extraction: Extraction = extractSite(file, await readFile(file, 'utf8'), line);
    if (extraction.kind === 'refused') {
        return extraction;
    }
    const { subject } = extraction.site;
    const harvest = await harvestSpec(file, subject.kind === 'class' ? subject.className : subject.functionName);
    return { kind: 'drafted', draft: renderDraft(extraction.site, harvest) };
}

/**
 * Forbidden draft: the domain comes from the type, not from a code site.
 *
 * A forbidden cannot be spotted statically — it is a business sentence. What speccov can
 * do is fill the input space in your stead, exhaustively.
 */
export function draftForbidden(file: string, typeName: string): DraftResult {
    const read = readDomain(file, typeName);
    if (read.kind === 'refused') {
        return read;
    }
    return { kind: 'drafted', draft: renderForbidden(file, read.typeName, read.fields) };
}

export { readDomain, type DomainField, type DomainRead } from './domain';
export { renderForbidden } from './render-forbidden';
export { extractSite, type DraftSite, type Extraction, type Parameter, type Probe, type Subject } from './extract';
export { harvestSpec, readSpec, type Harvest } from './harvest';
export { renderDraft, type Draft } from './render';
