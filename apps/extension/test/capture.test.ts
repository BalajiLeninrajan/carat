import { beforeEach, describe, expect, it } from 'vitest';
import { captureVisibleText, collectVisibleText, shouldCapture } from '../src/capture';

const HTTPS = { protocol: 'https:', hostname: 'example.com' };
const LONG = 'Dinner at Seven Shores Cafe, Friday at 6? Bring the whole team along.';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Test Page';
});

describe('captureVisibleText', () => {
  it('skips script, style, aria-hidden and display:none text', () => {
    document.body.innerHTML = `
      <p>Visible paragraph</p>
      <script>var secret = 'SCRIPT_TEXT';</script>
      <style>.x { color: red }</style>
      <noscript>NOSCRIPT_TEXT</noscript>
      <div aria-hidden="true">ARIA_HIDDEN_TEXT</div>
      <div style="display:none">DISPLAY_NONE_TEXT</div>
      <div hidden>HIDDEN_ATTR_TEXT</div>
      <div style="visibility:hidden">VIS_HIDDEN_TEXT</div>
      <svg><text>SVG_TEXT</text></svg>
      <p>Second   visible
         paragraph</p>
    `;
    const text = captureVisibleText(document);
    expect(text).toContain('Visible paragraph');
    expect(text).toContain('Second visible paragraph');
    for (const bad of ['SCRIPT_TEXT', 'color: red', 'NOSCRIPT_TEXT', 'ARIA_HIDDEN_TEXT', 'DISPLAY_NONE_TEXT', 'HIDDEN_ATTR_TEXT', 'VIS_HIDDEN_TEXT', 'SVG_TEXT']) {
      expect(text).not.toContain(bad);
    }
  });

  it('prepends title and host', () => {
    document.body.innerHTML = '<p>Body text</p>';
    const text = captureVisibleText(document);
    expect(text.startsWith(`Test Page · ${location.host}\n`)).toBe(true);
  });

  it('prefers main over surrounding chrome', () => {
    document.body.innerHTML = '<nav>NAV_TEXT</nav><main><p>MAIN_TEXT</p></main><footer>FOOTER_TEXT</footer>';
    const text = captureVisibleText(document);
    expect(text).toContain('MAIN_TEXT');
    expect(text).not.toContain('NAV_TEXT');
    expect(text).not.toContain('FOOTER_TEXT');
  });

  it('skips a hidden preferred region in favour of a visible one', () => {
    document.body.innerHTML =
      '<div role="main" style="display:none">STALE_PANEL</div><div role="main"><p>LIVE_PANEL</p></div><nav>NAV_TEXT</nav>';
    const text = collectVisibleText(document);
    expect(text).toContain('LIVE_PANEL');
    expect(text).not.toContain('STALE_PANEL');
    expect(text).not.toContain('NAV_TEXT');
  });

  it('falls back to the body when the preferred region has no text', () => {
    document.body.innerHTML = '<main></main><p>BODY_TEXT</p>';
    expect(collectVisibleText(document)).toBe('BODY_TEXT');
  });

  it('prefers main over an article card that comes first', () => {
    document.body.innerHTML = '<aside><article>TEASER</article></aside><main><p>STORY</p></main>';
    const text = collectVisibleText(document);
    expect(text).toContain('STORY');
    expect(text).not.toContain('TEASER');
  });

  it('puts viewport-intersecting text first', () => {
    document.body.innerHTML = '<p id="a">OFFSCREEN</p><p id="b">ONSCREEN</p>';
    const b = document.getElementById('b')!;
    b.getBoundingClientRect = () => new DOMRect(0, 10, 100, 20);
    const text = collectVisibleText(document);
    expect(text.indexOf('ONSCREEN')).toBeLessThan(text.indexOf('OFFSCREEN'));
  });

  it('caps at 4000 chars', () => {
    document.body.innerHTML = `<p>${'word '.repeat(2000)}</p><p>${'more '.repeat(2000)}</p>`;
    const text = captureVisibleText(document);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.length).toBeGreaterThan(3900);
  });
});

describe('shouldCapture', () => {
  it('captures an ordinary https page with enough text', () => {
    document.body.innerHTML = `<p>${LONG}</p>`;
    expect(shouldCapture(document, HTTPS)).toBe(true);
  });

  it('refuses pages with a visible password input', () => {
    document.body.innerHTML = `<p>${LONG}</p><input type="Password">`;
    expect(shouldCapture(document, HTTPS)).toBe(false);
  });

  it('ignores password inputs the user cannot see', () => {
    document.body.innerHTML = `<p>${LONG}</p>
      <div style="display:none"><input type="password"></div>
      <div hidden><input type="password"></div>
      <input type="password" style="visibility:hidden">`;
    expect(shouldCapture(document, HTTPS)).toBe(true);
    document.body.insertAdjacentHTML('beforeend', '<input type="password">');
    expect(shouldCapture(document, HTTPS)).toBe(false);
  });

  it('refuses denylisted hosts and their subdomains', () => {
    document.body.innerHTML = `<p>${LONG}</p>`;
    expect(shouldCapture(document, { protocol: 'https:', hostname: 'chase.com' })).toBe(false);
    expect(shouldCapture(document, { protocol: 'https:', hostname: 'secure.chase.com' })).toBe(false);
  });

  it('refuses non-http protocols', () => {
    document.body.innerHTML = `<p>${LONG}</p>`;
    expect(shouldCapture(document, { protocol: 'chrome:', hostname: 'extensions' })).toBe(false);
    expect(shouldCapture(document, { protocol: 'chrome-extension:', hostname: 'abc' })).toBe(false);
    expect(shouldCapture(document, { protocol: 'http:', hostname: 'example.com' })).toBe(true);
  });

  it('refuses pages with under 40 chars of text', () => {
    document.body.innerHTML = '<p>Short.</p>';
    expect(shouldCapture(document, HTTPS)).toBe(false);
    expect(shouldCapture(document, HTTPS, LONG)).toBe(true);
  });
});
