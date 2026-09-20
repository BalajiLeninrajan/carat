// Hosts Caret never touches, whatever the user has in their own blocklist. Ours, kept from the old engine.
export const DENYLIST_HOSTS: readonly string[] = [
  'accounts.google.com',
  'myaccount.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'login.yahoo.com',
  'auth0.com',
  'okta.com',
  'paypal.com',
  'stripe.com',
  'checkout.stripe.com',
  'venmo.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'capitalone.com',
  'americanexpress.com',
  'td.com',
  'rbcroyalbank.com',
  'scotiabank.com',
  'bmo.com',
  'cibc.com',
  'wealthsimple.com',
  'coinbase.com',
  'mychart.com',
  'healthcare.gov',
  'irs.gov',
  'canada.ca',
  '1password.com',
  'lastpass.com',
  'bitwarden.com',
];

const HOSTS = new Set(DENYLIST_HOSTS);

export function isDenylisted(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (HOSTS.has(h)) return true;
  // Match parent domains so app.chase.com is caught by chase.com.
  let dot = h.indexOf('.');
  while (dot !== -1) {
    if (HOSTS.has(h.slice(dot + 1))) return true;
    dot = h.indexOf('.', dot + 1);
  }
  return false;
}
