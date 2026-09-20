/**
 * Plain page visits, from chrome.webNavigation: every top-level navigation is
 * logged with how the user got there (typed it, followed a link, submitted a
 * form, went back...), so the predictor knows about flows that did not start
 * with a click Carat saw.
 *
 * Only host + path is recorded: query strings and fragments often carry
 * tokens, emails and ids.
 */

import { isBlocked, loadSettings } from "../shared/settings.js";
import { appendHistory } from "./history.js";

/** A client-side redirect this soon after a visit replaces it instead of adding a line. */
const REDIRECT_MERGE_MS = 5_000;

function page(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return null;
  }
}

function describe(where: string, type: string, qualifiers: string[]): string | null {
  if (type === "reload") return null;
  if (qualifiers.includes("forward_back")) return `went back/forward to ${where}`;
  switch (type) {
    case "typed":
      return `opened ${where} (typed in the address bar)`;
    case "generated":
    case "keyword":
    case "keyword_generated":
      return `searched from the address bar, landed on ${where}`;
    case "auto_bookmark":
      return `opened ${where} from a bookmark`;
    case "form_submit":
      return `submitted a form, landed on ${where}`;
    case "link":
      return qualifiers.includes("from_address_bar")
        ? `opened ${where} from the address bar`
        : `followed a link to ${where}`;
    default:
      // auto_toplevel (opened by another app), start_page, etc.
      return `opened ${where}`;
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const where = page(details.url);
  if (!where) return;
  const entry = describe(where, details.transitionType, details.transitionQualifiers);
  if (!entry) return;

  const settings = await loadSettings();
  if (!settings.enabled || isBlocked(settings, details.url)) return;

  const redirect = details.transitionQualifiers.includes("client_redirect");
  await appendHistory(details.tabId, entry, details.url, {
    kind: "visit",
    replaceVisitWithin: redirect ? REDIRECT_MERGE_MS : undefined,
  });
});
