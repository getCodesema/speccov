import { describe, expect, test } from 'bun:test';
import { Gauge } from './gauge';

describe('Gauge', () => {
    test('tracks the number in flight', () => {
        const gauge = new Gauge();
        gauge.enter();
        gauge.enter();
        expect(gauge.current).toBe(2);
        gauge.exit();
        expect(gauge.current).toBe(1);
    });

    test('keeps the peak, not the last value', () => {
        const gauge = new Gauge();
        gauge.enter();
        gauge.enter();
        gauge.enter();
        gauge.exit();
        gauge.exit();
        gauge.exit();
        expect(gauge.current).toBe(0);
        expect(gauge.peak).toBe(3);
    });

    test('one exit() too many throws rather than underestimating the peak', () => {
        const gauge = new Gauge();
        expect(() => gauge.exit()).toThrow('unbalanced');
    });

    test('track() releases even when the work fails', async () => {
        const gauge = new Gauge();
        await expect(gauge.track(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        expect(gauge.current).toBe(0);
        expect(gauge.peak).toBe(1);
    });

    test('track() measures real concurrency', async () => {
        const gauge = new Gauge();
        await Promise.all(Array.from({ length: 5 }, () => gauge.track(() => Promise.resolve())));
        expect(gauge.peak).toBe(5);
    });

    test('reset() clears the peak and the current count', () => {
        const gauge = new Gauge();
        gauge.enter();
        gauge.exit();
        gauge.reset();
        expect(gauge.peak).toBe(0);
        expect(gauge.current).toBe(0);
    });
});
