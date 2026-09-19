import data from './destructive-names.json';

/**
 * Control names carat never offers to click, whatever the model says. Each
 * entry is a word or phrase; a name matches when the entry appears in it as
 * whole words ("Yes, delete it", "Send now", "Pay $12.00"). Save and Create
 * are allowed on purpose: they commit what carat just filled.
 */
export const DESTRUCTIVE_NAMES: readonly string[] = data.names;

const PATTERN = new RegExp(
  `(?:^|[^a-z0-9])(?:${DESTRUCTIVE_NAMES.map((n) => normalize(n).replace(/ /g, '\\s+')).join('|')})(?![a-z0-9])`,
);

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when an element with this accessible name must never get a chip. */
export function isDestructiveName(name: string): boolean {
  return PATTERN.test(normalize(name));
}
