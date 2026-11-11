import type { Measurement } from './rule';

export type Growth = {
    /** Extra cost per input item, estimated by least squares. */
    readonly perItem: number;
    /** The measured series, ready to display: "1→3, 2→4, 4→6". */
    readonly series: string;
};

/** Float margin. Costs are integers: a genuinely flat slope is 0. */
export const EPSILON = 1e-9;

/**
 * Estimates how the cost grows with the input size.
 *
 * Least squares rather than a gap between the extremes: a single noisy measurement must not
 * decide on its own. Any unusable data throws — a tool you trust never concludes "held" for
 * want of a measurement.
 */
export function measureGrowth(measurements: readonly Measurement[]): Growth {
    assertUsable(measurements);

    const meanSize = mean(measurements.map(({ size }) => size));
    const meanCost = mean(measurements.map(({ cost }) => cost));

    let covariance = 0;
    let variance = 0;
    for (const { size, cost } of measurements) {
        const deltaSize = size - meanSize;
        covariance += deltaSize * (cost - meanCost);
        variance += deltaSize * deltaSize;
    }

    if (variance <= EPSILON) {
        throw new Error('speccov: every measurement carries the same input size; growth is undecidable.');
    }

    return {
        perItem: covariance / variance,
        series: measurements.map(({ size, cost }) => `${size}→${cost}`).join(', '),
    };
}

function assertUsable(measurements: readonly Measurement[]): void {
    if (measurements.length < 2) {
        throw new Error(`speccov: judging growth needs at least two measurements, got ${measurements.length}.`);
    }
    for (const { size, cost } of measurements) {
        if (!Number.isFinite(size) || size <= 0) {
            throw new Error(`speccov: invalid input size (${size}), expected a finite number greater than zero.`);
        }
        if (!Number.isFinite(cost) || cost < 0) {
            throw new Error(`speccov: invalid cost (${cost}), expected a finite number of zero or more.`);
        }
    }
}

function mean(values: readonly number[]): number {
    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total / values.length;
}
