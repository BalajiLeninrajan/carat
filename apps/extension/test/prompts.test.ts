import { describe, expect, it } from 'vitest';
import {
  ACTION_INSTRUCTIONS,
  TEXT_INSTRUCTIONS,
  buildActionRequest,
  buildTextRequest,
} from '../src/engine/background/prompts';
import type { FieldInfo } from '../src/engine/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/engine/shared/settings';

const field: FieldInfo = {
  tag: 'input',
  inputType: 'search',
  multiline: false,
  name: 'Search',
  placeholder: '',
  maxLength: null,
  typed: 'waterproof ',
  trailing: '',
  redacted: false,
};

function textRequest() {
  return buildTextRequest({
    settings: DEFAULT_SETTINGS,
    url: 'https://shop.real/search',
    outline: 'PAGE: Shop (https://shop.real/search)',
    notes: '(none)',
    field,
  });
}

function actionRequest() {
  return buildActionRequest({
    settings: DEFAULT_SETTINGS,
    url: 'https://shop.real/cart',
    outline: 'PAGE: Cart (https://shop.real/cart)',
    notes: '(none)',
    history: '(nothing yet)',
    browser: 'no other tabs are open',
  });
}

describe('few-shots', () => {
  it('goes out quoted in the system message, not as turns of its own', () => {
    for (const instructions of [TEXT_INSTRUCTIONS, ACTION_INSTRUCTIONS]) {
      expect(instructions).toContain('<examples>');
      expect(instructions).toContain('</examples>');
      expect(instructions).toContain('Never copy a value out of an example into an answer');
    }
    for (const request of [textRequest(), actionRequest()]) {
      expect(request.input).toHaveLength(1);
      expect(request.input[0]!.role).toBe('user');
    }
  });

  it('pairs every example input with an output', () => {
    for (const instructions of [TEXT_INSTRUCTIONS, ACTION_INSTRUCTIONS]) {
      const inputs = instructions.match(/<input>/g)?.length ?? 0;
      const outputs = instructions.match(/<output>/g)?.length ?? 0;
      expect(inputs).toBeGreaterThan(0);
      expect(outputs).toBe(inputs);
    }
  });

  it('names no host or address outside the reserved .test domain', () => {
    const both = `${TEXT_INSTRUCTIONS}\n${ACTION_INSTRUCTIONS}`;
    const hosts = [...both.matchAll(/https?:\/\/([^/\s")]+)/g)].map((m) => m[1]!);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toMatch(/\.test$/);
    const addresses = [...both.matchAll(/[\w.-]+@([\w.-]+)/g)].map((m) => m[1]!);
    for (const domain of addresses) expect(domain).toMatch(/\.test$/);
  });

  it('keeps example values out of the live turn', () => {
    const content = actionRequest().input[0]!.content;
    for (const leak of ['EX-55821', 'Example Outfitters', 'Thornbury']) {
      expect(content).not.toContain(leak);
    }
  });
});

describe('action guidance', () => {
  it('ranks the evidence, page first and old notes last', () => {
    expect(ACTION_INSTRUCTIONS).toContain('Weigh the evidence in this order');
    const rule = ACTION_INSTRUCTIONS.split('\n').find((l) => l.includes('Weigh the evidence'))!;
    expect(rule.indexOf('the page in front of you')).toBeLessThan(rule.indexOf("this tab's history"));
    expect(rule.indexOf("this tab's history")).toBeLessThan(rule.indexOf('the newest notes'));
    expect(rule.indexOf('the newest notes')).toBeLessThan(rule.indexOf('old notes last'));
  });

  it('says a title is not a query', () => {
    expect(ACTION_INSTRUCTIONS).toContain('None of them is a search query');
    expect(ACTION_INSTRUCTIONS).toMatch(/A page title, a site name, a tab name, a button label and a badge/);
  });

  it('keeps prediction out of anything written in the user’s name', () => {
    expect(ACTION_INSTRUCTIONS).toContain("Never write anything that goes out in the user's name");
    expect(ACTION_INSTRUCTIONS).toContain('is not a fill target');
  });

  it('leaves the ghost free to continue a comment the user started', () => {
    expect(TEXT_INSTRUCTIONS).not.toContain('is not a fill target');
  });
});

describe('request shape', () => {
  it('puts the live page first in the turn, for the cache prefix', () => {
    expect(actionRequest().input[0]!.content.startsWith('<page>')).toBe(true);
    expect(textRequest().input[0]!.content.startsWith('<page>')).toBe(true);
  });
});
