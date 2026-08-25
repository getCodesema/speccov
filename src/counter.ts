/** Minimal probe: counts occurrences. Knows nothing about the domain it observes. */
export class Counter {
    #hits = 0;

    hit(): void {
        this.#hits += 1;
    }

    get hits(): number {
        return this.#hits;
    }

    reset(): void {
        this.#hits = 0;
    }
}
