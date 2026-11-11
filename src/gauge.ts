/**
 * Concurrency probe: tracks the number of operations in flight and keeps the peak.
 *
 * The counterpart of {@link Counter}: one counts the total, the other measures the peak.
 */
export class Gauge {
    #current = 0;
    #peak = 0;

    enter(): void {
        this.#current += 1;
        this.#peak = Math.max(this.#peak, this.#current);
    }

    /**
     * One `exit()` too many throws rather than dropping below zero: an unbalanced probe
     * underestimates the peak, so it would let through a rule that does not hold.
     */
    exit(): void {
        if (this.#current === 0) {
            throw new Error('speccov: exit() without a matching enter(); the concurrency probe is unbalanced.');
        }
        this.#current -= 1;
    }

    /** Wraps a piece of asynchronous work. The `exit()` happens even on failure. */
    async track<T>(work: () => Promise<T>): Promise<T> {
        this.enter();
        try {
            return await work();
        } finally {
            this.exit();
        }
    }

    get current(): number {
        return this.#current;
    }

    get peak(): number {
        return this.#peak;
    }

    reset(): void {
        this.#current = 0;
        this.#peak = 0;
    }
}
