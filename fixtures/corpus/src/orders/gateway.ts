/** The outgoing calls the corpus fans out over. Declared, never executed. */

export type Order = {
    readonly id: string;
    readonly total: number;
};

// @expect unbounded-primitive
export declare function loadOrder(id: string): Promise<Order>;

// Two parameters, two questions: the marker counts them, it does not merge them.
// @expect unbounded-primitive, unbounded-primitive
export declare function chargeOrder(id: string, amount: number): Promise<void>;

// @expect none
export declare function countOrders(): Promise<number>;
