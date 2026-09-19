import data from './destructive-names.json';

/**
 * Control names carat never offers to click, whatever the model says. Each
 * entry is a word or phrase; a name matches when the entry appears in it as
 * whole words ("Yes, delete it", "Send now"). Save and Create are allowed on
 * purpose: they commit what carat just filled.
 */
export const DESTRUCTIVE_NAMES: readonly string[] = data.destructive;

/**
 * Names that move money: Pay, Book now, Place order. Not a hard no like the
 * destructive list, but offered only when `mayPay` says so, and then behind
 * Enter rather than Tab.
 */
export const MONEY_NAMES: readonly string[] = data.money;

const DESTRUCTIVE = pattern(DESTRUCTIVE_NAMES);
const MONEY = pattern(MONEY_NAMES);

function pattern(names: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])(?:${names.map((n) => normalize(n).replace(/ /g, '\\s+')).join('|')})(?![a-z0-9])`);
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when an element with this accessible name must never get a chip. */
export function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE.test(normalize(name));
}

/** True when an element with this accessible name pays, buys, books or orders. */
export function isMoneyName(name: string): boolean {
  return MONEY.test(normalize(name));
}

/**
 * What a payment decision is made from. Today only the setting; a later layer
 * adds per-task consent here without touching the callers.
 */
export interface PayContext {
  allowPayments: boolean;
}

/** The one place that says whether a money control may be offered at all. */
export function mayPay(ctx: PayContext): boolean {
  return ctx.allowPayments === true;
}
