import type { Settings } from '@carat/shared';

/** Hosts are matched exactly (with port), so turning off maps leaves calendar alone. */
export function isSiteOff(settings: Pick<Settings, 'disabledHosts'>, host: string): boolean {
  return settings.disabledHosts.includes(host.toLowerCase());
}

/** The `disabledHosts` patch that turns carat on or off for one host. */
export function withSite(
  settings: Pick<Settings, 'disabledHosts'>,
  host: string,
  enabled: boolean,
): Pick<Settings, 'disabledHosts'> {
  const h = host.toLowerCase();
  const rest = settings.disabledHosts.filter((x) => x !== h);
  return { disabledHosts: enabled ? rest : [...rest, h] };
}

/** The host of a tab carat could run on, or undefined for chrome://, file:// and the like. */
export function siteHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
  } catch {
    return undefined;
  }
}
