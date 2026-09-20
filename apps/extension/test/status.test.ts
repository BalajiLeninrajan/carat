// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/engine/shared/settings';
import { describeStatus } from '../src/status/info';
import { createStatusLine, PAUSED_NOTICE, statusText } from '../src/status';

const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x', statusLine: true };

describe('describeStatus', () => {
  it('reports the action model when a key is set and the page is allowed', () => {
    expect(describeStatus(settings, 'https://maps.google.com/')).toEqual({
      show: true,
      running: true,
      sound: true,
      acceptKey: DEFAULT_SETTINGS.acceptKey,
      model: DEFAULT_SETTINGS.actionModel,
    });
  });

  it('explains why it is not running, in priority order', () => {
    expect(describeStatus({ ...settings, enabled: false }, 'https://a.test/')).toMatchObject({
      running: false,
      reason: 'disabled',
    });
    expect(describeStatus(settings, 'chrome://extensions').reason).toBe('not-http');
    expect(describeStatus(settings, undefined).reason).toBe('not-http');
    // The built-in denylist, which no blocklist setting can turn off.
    expect(describeStatus(settings, 'https://accounts.google.com/signin').reason).toBe('blocked');
    expect(describeStatus({ ...settings, blocklist: ['a.test'] }, 'https://sub.a.test/x').reason).toBe('blocked');
    expect(describeStatus(settings, 'https://a.test/', true).reason).toBe('paused');
    expect(describeStatus({ ...settings, apiKey: '' }, 'https://a.test/').reason).toBe('no-key');
  });

  it('never includes the key', () => {
    expect(JSON.stringify(describeStatus(settings, 'https://a.test/'))).not.toContain('sk-x');
  });

  it('follows the statusLine setting for show', () => {
    expect(describeStatus({ ...settings, statusLine: false }, 'https://a.test/').show).toBe(false);
  });
});

describe('statusText', () => {
  const running = { show: true, running: true, sound: true, acceptKey: 'rightShift' as const, model: 'gpt-5.6-luna' };

  it('names the model while running and the reason while not', () => {
    expect(statusText(running)).toBe('carat · gpt-5.6-luna');
    expect(statusText(running, true)).toBe('carat · gpt-5.6-luna · thinking');
    expect(statusText({ ...running, running: false, reason: 'blocked' })).toBe('carat · off for this site');
    expect(statusText({ ...running, running: false, reason: 'paused' })).toBe(
      'carat · paused (debugger banner dismissed)',
    );
  });
});

describe('status line element', () => {
  afterEach(() => {
    document.querySelectorAll('[data-carat-status]').forEach((el) => el.remove());
  });

  it('stays out of the document until shown, and hides again when the setting is off', () => {
    const line = createStatusLine(document);
    expect(document.querySelector('[data-carat-status]')).toBeNull();
    line.update({ show: true, running: true, sound: true, acceptKey: 'rightShift', model: 'm' });
    const host = document.querySelector<HTMLElement>('[data-carat-status]');
    expect(host).not.toBeNull();
    expect(host!.style.display).toBe('block');
    expect(host!.style.pointerEvents).toBe('none');
    // Bottom-left: the banner owns the bottom centre and the chip may sit anywhere else.
    expect(host!.style.left).toBe('12px');
    expect(host!.style.bottom).toBe('12px');
    expect(line.visible).toBe(true);
    line.update({ show: false, running: true, sound: true, acceptKey: 'rightShift', model: 'm' });
    expect(host!.style.display).toBe('none');
    expect(line.visible).toBe(false);
  });

  it('shows a notice while switched off, then goes quiet again', () => {
    vi.useFakeTimers();
    // The pill's root is closed to the page, so borrow it on the way out.
    let root: ShadowRoot | undefined;
    const attach = Element.prototype.attachShadow;
    const spy = vi
      .spyOn(Element.prototype, 'attachShadow')
      .mockImplementation(function (this: Element, init: ShadowRootInit) {
        root = attach.call(this, { ...init, mode: 'open' });
        return root;
      });
    const line = createStatusLine(document);
    spy.mockRestore();

    line.update({ show: false, running: false, reason: 'paused', sound: true, acceptKey: 'rightShift', model: 'm' });
    expect(line.visible).toBe(false);

    line.notice(PAUSED_NOTICE, 4000);
    const host = document.querySelector<HTMLElement>('[data-carat-status]');
    expect(host!.style.display).toBe('block');
    expect(line.visible).toBe(true);
    expect(root!.querySelector('.text')?.textContent).toBe('carat · paused, click the icon to resume');

    vi.advanceTimersByTime(3999);
    expect(line.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(host!.style.display).toBe('none');
    expect(line.visible).toBe(false);
    vi.useRealTimers();
  });

  it('removes itself on destroy', () => {
    const line = createStatusLine(document);
    line.update({ show: true, running: true, sound: true, acceptKey: 'rightShift', model: 'm' });
    line.destroy();
    expect(document.querySelector('[data-carat-status]')).toBeNull();
  });
});
