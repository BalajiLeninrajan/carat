import type { ChatMessage } from './prompt';

/**
 * The other half of "Cursor tab for the browser": the user is mid-sentence in
 * a field and the model writes the rest of it. One question, one plain-text
 * answer, streamed, and the first token is on screen before the last one is
 * written.
 *
 * The instructions are one static string, byte for byte the same on every
 * call, so the provider's prompt cache has something to hit.
 */
export const GHOST_INSTRUCTIONS = `You are Carat's inline completion, running inside a web browser. The user is typing into a field on the page below. Continue their text from exactly where it stops, in their voice, as if they had gone on typing it themselves.

Rules:
- Write only the continuation. Never repeat a word they already typed and never restate what they wrote.
- Plain text. No quotation marks around it, no preamble, no explanation, no markdown, no code fences.
- Match what they started: their capitalisation, their punctuation, how formal they are being. Begin with the space or punctuation the sentence needs to read on.
- Use a fact from <notes> or from the page only when it plainly fits what they are writing. Never invent a name, an address, an email address, a phone number or a figure the page does not give.
- Finish the thought they started and stop. A short continuation beats a long one.
- When nothing is worth adding, answer with nothing at all. An empty answer is a real answer: it hands the keystroke back to the rest of Carat.`;

/**
 * The output cap. A one-line field gets a phrase; a textarea or an editor gets
 * a sentence or two. Characters are the backstop for a model that ignores the
 * token cap.
 */
export const GHOST_LIMITS = {
  singleLineTokens: 24,
  multiLineTokens: 48,
  singleLineChars: 120,
  multiLineChars: 240,
} as const;

export interface GhostRequest {
  /** What the user has typed in the field, up to the caret. */
  prefix: string;
  /** What follows the caret in the same field, when anything does. */
  suffix?: string;
  /** The viewport outline, so the model knows what page this field is on. */
  outline: string;
  /** Facts from pages read in other tabs, newest first. */
  notes: readonly string[];
  /** The field's accessible name, when the page gives it one. */
  field?: string;
  /** An input rather than a textarea or an editor: one line, and a tighter cap. */
  singleLine: boolean;
}

export function ghostMaxTokens(singleLine: boolean): number {
  return singleLine ? GHOST_LIMITS.singleLineTokens : GHOST_LIMITS.multiLineTokens;
}

export function ghostMaxChars(singleLine: boolean): number {
  return singleLine ? GHOST_LIMITS.singleLineChars : GHOST_LIMITS.multiLineChars;
}

/**
 * System first and unchanging, then the page, then the text being typed. The
 * prefix moves on every keystroke, so it goes last and everything in front of
 * it can be cached.
 */
export function buildGhostMessages(req: GhostRequest): ChatMessage[] {
  const notes = req.notes.length > 0 ? req.notes.map((n) => `- ${n}`).join('\n') : '(none)';
  const parts = [
    `<notes>\n${notes}\n</notes>`,
    `<page>\n${req.outline.trim()}\n</page>`,
    ...(req.field ? [`<field>${req.field}</field>`] : []),
    `<typed>\n${req.prefix}\n</typed>`,
    ...(req.suffix ? [`<after-caret>\n${req.suffix}\n</after-caret>`] : []),
    'Continue the text in <typed> from its last character.',
  ];
  return [
    { role: 'system', content: GHOST_INSTRUCTIONS },
    { role: 'user', content: parts.join('\n') },
  ];
}

const FENCE = /^```[a-z]*\n?|\n?```$/g;
const OPENERS = '"“\'‘';
const CLOSERS = '"”\'’';

/**
 * What the model wrote, made safe to paste at the caret. Runs on the partial
 * text after every chunk as well as on the whole answer, so it only ever
 * removes from the ends and never reflows what is in between: a leading space
 * is the continuation's own and stays.
 */
export function cleanGhost(raw: string, singleLine: boolean): string {
  let text = raw.replace(/\r/g, '').replace(FENCE, '');
  const open = OPENERS.indexOf(text[0] ?? '');
  if (open >= 0) {
    text = text.slice(1);
    if (text.endsWith(CLOSERS[open]!)) text = text.slice(0, -1);
    else if (text.endsWith(OPENERS[open]!)) text = text.slice(0, -1);
  }
  if (singleLine) text = text.split('\n')[0] ?? '';
  else text = text.replace(/\n+$/, '');
  return text.slice(0, ghostMaxChars(singleLine));
}
