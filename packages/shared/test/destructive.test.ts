import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESTRUCTIVE_NAMES, isDestructiveName } from '../src/destructive';

describe('destructive-names.json', () => {
  it('is the data file, lower case, unique, and never lists Save or Create', () => {
    const raw = JSON.parse(readFileSync(new URL('../src/destructive-names.json', import.meta.url), 'utf8')) as { names: string[] };
    expect(DESTRUCTIVE_NAMES).toEqual(raw.names);
    expect(new Set(raw.names).size).toBe(raw.names.length);
    for (const n of raw.names) expect(n).toBe(n.toLowerCase().trim());
    for (const allowed of ['save', 'create', 'add', 'done', 'apply', 'next', 'ok', 'confirm', 'submit', 'cancel', 'close']) {
      expect(raw.names).not.toContain(allowed);
    }
  });
});

describe('isDestructiveName', () => {
  it.each([
    'Delete',
    'delete event',
    'Yes, delete it',
    'Remove from cart',
    'Send',
    'Send now',
    'Pay $12.00',
    'Place order',
    'Confirm order',
    'Submit payment',
    'Sign out',
    'Log out',
    'Logout',
    'Unsubscribe',
    'Check out',
    'Checkout',
    'Discard changes',
    'Move to trash',
    'Leave server',
    'Block @alex',
    'Report post',
    'Publish',
    'Post',
    'Buy now',
    'Reset',
    'Transfer funds',
    '  DELETE  ',
    'Delete…',
  ])('refuses %j', (name) => {
    expect(isDestructiveName(name)).toBe(true);
  });

  it.each([
    'Save',
    'Save event',
    'Create',
    'Create event',
    'Add notification',
    'Done',
    'Apply',
    'Next',
    'Cancel',
    'Close',
    'Vegetarian',
    'Volume',
    'All day',
    'Sender name',
    'Payment method',
    'Postal code',
    'Blockchain news',
    'Reporting period',
    'Deleted items',
    'Reports',
    'Transferred',
    'Leaves of absence',
  ])('allows %j', (name) => {
    expect(isDestructiveName(name)).toBe(false);
  });
});
