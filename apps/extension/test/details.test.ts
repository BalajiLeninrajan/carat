import { describe, expect, it, vi } from 'vitest';
import { createElasticMemory, extractDetails } from '../src/background/elastic';
import { DEFAULT_SETTINGS } from '../src/engine/shared/settings';

const settings = () => ({
  ...DEFAULT_SETTINGS,
  elasticUrl: 'https://es.example.com',
  elasticApiKey: 'k',
  elasticIndexPrefix: 'caret',
});

/** A cluster that keeps documents, so details accumulate across notes. */
function cluster() {
  const docs = new Map<string, Record<string, unknown>>();
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const p = String(url);
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    if (init?.method === 'GET') {
      const id = decodeURIComponent(p.split('/_doc/')[1] ?? '');
      return docs.has(id) ? Response.json({ _source: docs.get(id) }) : new Response(null, { status: 404 });
    }
    if (init?.method === 'PUT' && p.includes('/_doc/')) {
      const id = decodeURIComponent((p.split('/_doc/')[1] ?? '').split('?')[0] ?? '');
      docs.set(id, JSON.parse(String(init.body)));
      return Response.json({ result: 'created' });
    }
    if (p.includes('caret-details/_search')) {
      return Response.json({ hits: { hits: [...docs.values()].filter((d) => d.detailField).map((d) => ({ _source: d })) } });
    }
    return Response.json({ hits: { hits: [] } });
  });
  return { fetchImpl, docs };
}

const obs = { id: 'c1', tabId: 2, url: 'https://discord.com/channels/@me/1', title: 'Discord', text: 'x', at: Date.now() };
const note = (text: string) => ({ at: Date.now(), source: 'read' as const, url: obs.url, title: 'Discord', text });

const passengerForm = {
  url: 'https://reservia.viarail.ca/en/booking/create/passengers/FE1821',
  title: 'Book a Trip | VIA Rail',
  text: 'form:\n  [1] textbox "First name"\n  [2] textbox "Last name"',
  candidates: [
    { n: 1, backendNodeId: 1, role: 'textbox', name: 'First name' },
    { n: 2, backendNodeId: 2, role: 'textbox', name: 'Last name' },
  ],
  focused: { role: 'textbox', name: 'First name' },
};

describe('extractDetails', () => {
  it('files a name said about someone else under that person, not the user', () => {
    expect(extractDetails('Crazydodo asked nuth whether his name is Pez Guan.')).toEqual([
      { subject: 'Pez Guan', field: 'full_name', value: 'Pez Guan' },
      { subject: 'Pez Guan', field: 'given_name', value: 'Pez' },
      { subject: 'Pez Guan', field: 'family_name', value: 'Guan' },
    ]);
  });

  it('files the user\'s own name under the user', () => {
    const out = extractDetails('My name is Nuthanan Tharmarajah.');
    expect(out.every((d) => d.subject === 'user')).toBe(true);
  });

  it('picks up who a booking is for', () => {
    expect(extractDetails('I am booking the VIA Rail ticket for Pez Guan.')[0]?.subject).toBe('Pez Guan');
  });

  it('takes nothing from a note that states no detail', () => {
    expect(extractDetails('Dinner at Seven Shores Cafe on Friday at 6.')).toEqual([]);
  });
});

describe('details on a form', () => {
  it('offers every person the form could be for and flags the ambiguity', async () => {
    const { fetchImpl } = cluster();
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(obs, [note('Crazydodo asked nuth whether his name is Pez Guan.')]);
    await elastic.indexFacts(obs, [note('My name is Nuthanan Tharmarajah.')]);
    const lines = await elastic.retrieve(passengerForm, 9);

    expect(lines).toContain('[task] personal_detail for Pez Guan — still to enter: given_name="Pez", family_name="Guan"');
    expect(lines).toContain('[task] personal_detail for you — still to enter: given_name="Nuthanan", family_name="Tharmarajah"');
    // Whose name goes in the box is the question the page has to answer.
    expect(lines.some((l) => l.includes('2 people could fill this form'))).toBe(true);
  });

  it('says nothing on a page with nowhere to put a name', async () => {
    const { fetchImpl } = cluster();
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });
    await elastic.indexFacts(obs, [note('My name is Nuthanan Tharmarajah.')]);

    const lines = await elastic.retrieve(
      {
        url: 'https://news.example.com/story',
        title: 'A story',
        text: 'main:\n  [1] searchbox "Search"',
        candidates: [{ n: 1, backendNodeId: 1, role: 'searchbox', name: 'Search' }],
        focused: null,
      },
      3,
    );
    expect(lines.some((l) => l.includes('personal_detail'))).toBe(false);
  });

  it('marks a detail as a conflict when two sources disagree, and refuses to fill it', async () => {
    const { fetchImpl, docs } = cluster();
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(obs, [note('His name is Pez Guan.')]);
    await elastic.indexFacts(obs, [note('His name is Pez Kwan.')]);

    const full = [...docs.values()].find((d) => d.detailField === 'full_name');
    expect(full?.status).toBe('conflict');
    expect(full?.values).toEqual(['Pez Guan', 'Pez Kwan']);

    const lines = await elastic.retrieve(passengerForm, 9);
    // The form asks for a surname, and the surname is the part in dispute.
    expect(lines.some((l) => l.includes('conflict') && l.includes('Guan / Kwan'))).toBe(true);
    expect(lines.some((l) => l.includes('do not fill it'))).toBe(true);
    // One person with a disputed surname, not two people.
    expect(lines.some((l) => l.includes('people could fill this form'))).toBe(false);
  });

  it('never spends a detail: it is still there after the form is filled', async () => {
    const { fetchImpl, docs } = cluster();
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });
    await elastic.indexFacts(obs, [note('Crazydodo asked nuth whether his name is Pez Guan.')]);
    const before = [...docs.values()].filter((d) => d.detailField).length;

    await elastic.recordAction({
      tabId: 9,
      host: 'reservia.viarail.ca',
      kind: 'fill',
      label: 'Fill First name with "Pez"',
      value: 'Pez',
      accepted: true,
    });

    // A name is reference data, not an errand: the next form wants it too.
    expect([...docs.values()].filter((d) => d.detailField)).toHaveLength(before);
    const lines = await elastic.retrieve(passengerForm, 9);
    expect(lines.some((l) => l.includes('Pez'))).toBe(true);
  });
});
