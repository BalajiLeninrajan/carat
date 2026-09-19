import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESTRUCTIVE_NAMES, MONEY_NAMES, isDestructiveName, isMoneyName, mayPay } from '../src/destructive';

describe('destructive-names.json', () => {
  it('is the data file, two disjoint lower-case lists, and never lists Save or Create', () => {
    const raw = JSON.parse(readFileSync(new URL('../src/destructive-names.json', import.meta.url), 'utf8')) as {
      destructive: string[];
      money: string[];
    };
    expect(DESTRUCTIVE_NAMES).toEqual(raw.destructive);
    expect(MONEY_NAMES).toEqual(raw.money);
    const all = [...raw.destructive, ...raw.money];
    expect(new Set(all).size).toBe(all.length);
    for (const n of all) expect(n).toBe(n.toLowerCase().trim());
    for (const allowed of ['save', 'create', 'add', 'done', 'apply', 'next', 'ok', 'confirm', 'submit', 'cancel', 'close', 'continue', 'search', 'select', 'book']) {
      expect(all).not.toContain(allowed);
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
    'Sign out',
    'Log out',
    'Logout',
    'Unsubscribe',
    'Cancel booking',
    'Cancel flight',
    'Discard changes',
    'Move to trash',
    'Leave server',
    'Block @alex',
    'Report post',
    'Publish',
    'Post',
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
    'Continue',
    'Search',
    'Select flight',
    'Book',
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
    // Money, not destructive: these are gated, not banned.
    'Pay $12.00',
    'Place order',
    'Book now',
    'Checkout',
  ])('allows %j', (name) => {
    expect(isDestructiveName(name)).toBe(false);
  });
});

describe('isMoneyName', () => {
  it.each([
    'Pay',
    'Pay $12.00',
    'Pay now',
    'Place order',
    'Confirm order',
    'Submit payment',
    'Confirm and pay',
    'Confirm & pay',
    'Book now',
    'Complete booking',
    'Confirm booking',
    'Check out',
    'Checkout',
    'Buy now',
    'Purchase',
    'Subscribe',
  ])('marks %j', (name) => {
    expect(isMoneyName(name)).toBe(true);
    expect(isDestructiveName(name)).toBe(false);
  });

  it.each(['Payment method', 'Book', 'Select flight', 'Continue to payment', 'Review and book', 'Booking reference', 'Subscribed', 'Buyer name', 'Delete', 'Save'])(
    'does not mark %j',
    (name) => {
      expect(isMoneyName(name)).toBe(false);
    },
  );
});

describe('mayPay', () => {
  it('follows the allowPayments setting and nothing else', () => {
    expect(mayPay({ allowPayments: false })).toBe(false);
    expect(mayPay({ allowPayments: true })).toBe(true);
    expect(mayPay({ allowPayments: 'yes' as unknown as boolean })).toBe(false);
  });
});
