import { describe, expect, it } from 'vitest';
import type { NextAction } from '@carat/shared';
import { AnswerCache } from '../src/background/answer-cache';
import { RefineQueue, TICKETS_KEY } from '../src/background/refine';
import type { StorageArea } from '../src/store';

/** chrome.storage.session, as far as these two care: it outlives the worker, the worker's Maps do not. */
class FakeArea implements StorageArea {
  data: Record<string, unknown> = {};
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

const never = () => undefined;
const queueOver = (area: StorageArea): RefineQueue => new RefineQueue({ setTimer: never, area });

const answer: NextAction = {
  kind: 'click',
  target: 2,
  value: '',
  label: 'Click "Directions"',
  irreversible: false,
  confidence: 0.8,
  reason: 'the card the search was for',
};

describe('a worker that restarts holding a ticket', () => {
  it('tells an open ticket it lost from one that closed with nothing to say', async () => {
    const area = new FakeArea();
    const worker = queueOver(area);
    const open = worker.open(7);
    const closed = worker.open(7);
    closed.close();
    await worker.flush();

    // The worker goes down. Its Maps go with it; storage.session does not.
    const restarted = queueOver(area);
    expect(await restarted.claim(open.id, 7)).toEqual({ lost: true });
    expect(await restarted.claim(closed.id, 7)).toEqual({});
    // And a ticket nobody ever issued is nothing, not a lost one.
    expect(await restarted.claim('made-up', 7)).toEqual({});
  });

  it('hands over an answer that landed before the worker went down', async () => {
    const area = new FakeArea();
    const worker = queueOver(area);
    const ticket = worker.open(3);
    ticket.push({ target: 2 });
    ticket.push({ action: answer });
    await worker.flush();

    const restarted = queueOver(area);
    // The ring on its own was not worth keeping; the action was.
    expect(await restarted.claim(ticket.id, 3)).toEqual({ action: answer });
    expect(await restarted.claim(ticket.id, 3)).toEqual({});
  });

  it('answers nothing to a tab the ticket was not issued to', async () => {
    const area = new FakeArea();
    const worker = queueOver(area);
    const ticket = worker.open(1);
    await worker.flush();
    expect(await queueOver(area).claim(ticket.id, 2)).toEqual({});
  });

  it('leaves nothing behind once every ticket is claimed', async () => {
    const area = new FakeArea();
    const worker = queueOver(area);
    const ticket = worker.open(1);
    ticket.push({ action: null });
    ticket.close();
    expect(await worker.claim(ticket.id, 1)).toEqual({ action: null });
    await worker.flush();
    expect(area.data[TICKETS_KEY]).toBeUndefined();
  });

  it('is memory only with no area, as it was', async () => {
    const worker = new RefineQueue({ setTimer: never });
    const ticket = worker.open(1);
    expect(await new RefineQueue({ setTimer: never }).claim(ticket.id, 1)).toEqual({});
  });
});

describe('the answer cache across a restart', () => {
  it('reads back what the last worker had already paid for', async () => {
    const area = new FakeArea();
    const cache = new AnswerCache();
    cache.attach(area);
    await cache.set('maps|/search|abc|3|eager', { at: 1000, action: answer });
    await cache.flush();

    const restarted = new AnswerCache();
    restarted.attach(area);
    expect(await restarted.get('maps|/search|abc|3|eager')).toEqual({ at: 1000, action: answer });
    expect(await restarted.get('maps|/search|other|3|eager')).toBeUndefined();
  });

  it('drops what a clear wiped, in storage as well as in the worker', async () => {
    const area = new FakeArea();
    const cache = new AnswerCache();
    cache.attach(area);
    await cache.set('k', { at: 1000, action: null });
    cache.clear();
    await cache.flush();
    expect(await cache.get('k')).toBeUndefined();
    expect(await new AnswerCache().get('k')).toBeUndefined();
    expect(area.data).toEqual({});
  });

  it('keeps an answer no longer than the sixty seconds it stands for', async () => {
    const area = new FakeArea();
    const cache = new AnswerCache();
    cache.attach(area);
    await cache.set('old', { at: 1000, action: answer });
    await cache.set('new', { at: 1000 + 60_000, action: answer });
    await cache.flush();
    expect(await cache.get('old')).toBeUndefined();
    expect(await cache.get('new')).toBeDefined();
  });
});
