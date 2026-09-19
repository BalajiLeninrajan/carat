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

// A link named like an action is one: "Sign out", "Unsubscribe", "Delete my account".
const ACTION_LINK_WORDS = 4;

/**
 * Whether a described element must never get a chip. A control is judged by
 * its name alone, and a money name is not refused here: the payments setting
 * and the Enter chip have it. A real link (role `link` with a destination
 * site) is a page title as often as an action label, and following "Order Now
 * | Quick and Easy Food Delivery" orders nothing, so only a short link is
 * refused. A short one is refused off either list, since no link carries the
 * `m: 1` flag that puts a control behind Enter.
 */
export function isDestructiveElement(e: { r: string; nm: string; h?: string }): boolean {
  if (e.r !== 'link' || !e.h) return isDestructiveName(e.nm);
  if (e.nm.trim().split(/\s+/).length > ACTION_LINK_WORDS) return false;
  return isDestructiveName(e.nm) || isMoneyName(e.nm);
}
