import type { FieldDescriptor } from '@carat/shared';

export type FieldKind = 'email' | 'phone' | 'location' | 'title' | 'search';

// Credential and card fields are never filled from other tabs' text, whatever their label says.
const NEVER_FILL = /\b(?:username|current-password|new-password|one-time-code|cc-[a-z-]+)\b/;

/** Guess what a field wants from its descriptor, or null when it is none of the kinds we can fill. */
export function classifyField(f: FieldDescriptor): FieldKind | null {
  const text = [f.nm, f.ph, f.al, f.lb, f.nb].filter(Boolean).join(' ').toLowerCase();
  const ac = (f.ac ?? '').toLowerCase();
  const nm = (f.nm ?? '').toLowerCase();

  if (NEVER_FILL.test(ac)) return null;
  if (f.t === 'input:email' || ac.includes('email') || /\be-?mail\b|\brecipients?\b/.test(text) || nm === 'to') {
    return 'email';
  }
  if (f.t === 'input:tel' || ac.includes('tel') || /\b(phone|mobile|tel)\b/.test(text)) return 'phone';
  if (/address|street/.test(ac) || /\b(location|address|where|venue)\b/.test(text)) return 'location';
  if (/\b(title|subject|summary|event name)\b/.test(text)) return 'title';
  if (f.t === 'input:search' || f.t === 'searchbox' || nm === 'q' || /\bsearch\b/.test(text)) return 'search';
  return null;
}
