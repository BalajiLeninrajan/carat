import { DEFAULT_SETTINGS, type Settings } from '@/src/engine/shared/settings';

const TEXT_KEYS = ['apiKey', 'baseUrl', 'textModel', 'actionModel'] as const;
const BOOL_KEYS = ['enabled', 'textEnabled', 'actionsEnabled', 'memoryEnabled', 'sound', 'statusLine'] as const;
const TIERS: ReadonlySet<Settings['serviceTier']> = new Set(['auto', 'default', 'priority']);

function input(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

export function renderForm(form: HTMLFormElement, s: Settings): void {
  for (const k of TEXT_KEYS) input(form, k).value = s[k];
  for (const k of BOOL_KEYS) input(form, k).checked = s[k];
  // Ours: the clipboard box is not part of Save. It needs a user gesture to
  // ask Chrome for the permission, so it saves itself the moment it is ticked.
  input(form, 'clipboardRead').checked = s.clipboardRead;
  (form.elements.namedItem('serviceTier') as HTMLSelectElement).value = s.serviceTier;
  (form.elements.namedItem('blocklist') as HTMLTextAreaElement).value = s.blocklist.join('\n');
}

/**
 * What the form is asking to save. A blank URL or model falls back to the
 * documented default, so a cleared field can never produce a request to
 * `/responses` on nothing, or a request with model "".
 */
export function readForm(form: HTMLFormElement): Partial<Settings> {
  const tier = (form.elements.namedItem('serviceTier') as HTMLSelectElement).value as Settings['serviceTier'];
  const patch: Partial<Settings> = {
    apiKey: input(form, 'apiKey').value.trim(),
    baseUrl: input(form, 'baseUrl').value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.baseUrl,
    textModel: input(form, 'textModel').value.trim() || DEFAULT_SETTINGS.textModel,
    actionModel: input(form, 'actionModel').value.trim() || DEFAULT_SETTINGS.actionModel,
    serviceTier: TIERS.has(tier) ? tier : DEFAULT_SETTINGS.serviceTier,
    blocklist: parseBlocklist((form.elements.namedItem('blocklist') as HTMLTextAreaElement).value),
  };
  for (const k of BOOL_KEYS) patch[k] = input(form, k).checked;
  return patch;
}

/** Ours: the optional permission behind "Read the system clipboard". */
export const CLIPBOARD_PERMISSION = 'clipboardRead' as const;

/** The slice of `chrome.permissions` the toggle uses. Both calls need a user gesture. */
export interface PermissionsApi {
  request(p: { permissions: chrome.runtime.ManifestPermission[] }): Promise<boolean>;
  remove(p: { permissions: chrome.runtime.ManifestPermission[] }): Promise<boolean>;
}

/**
 * Turn the clipboard permission on or off, and say where the box should end
 * up. Chrome asks the user on `request`, so a refusal, a missing
 * `chrome.permissions` and a call that throws all leave the setting off: the
 * box reverts rather than promising a read that cannot happen.
 */
export async function setClipboardPermission(api: PermissionsApi | undefined, want: boolean): Promise<boolean> {
  if (!api) return false;
  try {
    if (!want) {
      await api.remove({ permissions: [CLIPBOARD_PERMISSION] });
      return false;
    }
    return (await api.request({ permissions: [CLIPBOARD_PERMISSION] })) === true;
  } catch {
    return false;
  }
}

const MAX_BLOCKED_HOSTS = 200;

export function parseBlocklist(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\s+/)) {
    const host = line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host) out.add(host);
    if (out.size >= MAX_BLOCKED_HOSTS) break;
  }
  return [...out];
}
