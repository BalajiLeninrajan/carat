/**
 * How readily carat offers a chip. A wrong chip costs one Esc; a missing chip
 * costs the whole retype. `eager`, the default, offers whenever there is a
 * plausible candidate. `conservative` is the old behaviour: no suggestion
 * beats a wrong one. Every knob that used to be a fixed constant lives here,
 * so the providers, the eval and the service worker read the same numbers.
 */
export const EAGERNESS_LEVELS = ['conservative', 'balanced', 'eager'] as const;
export type Eagerness = (typeof EAGERNESS_LEVELS)[number];

export interface EagernessKnobs {
  /** Suggestions under this confidence are dropped, by the provider and again by the service worker. */
  minConfidence: number;
  /** Jev's request-level "is any of this relevant" answer must reach this before any field is filled. */
  jevGateMin: number;
  /** Fills per answer, and interactions per answer; still one per field or element. */
  maxSuggestions: number;
  /** Fresh text from another tab on the page's own origin counts as context. The requesting tab's own text never does. */
  sameOriginContext: boolean;
  /** The regex provider also offers bare capitalised names and lowercase quoted strings for search and title fields. */
  looseNames: boolean;
  /** The page's primary continue-style button may be offered with no prior fill, when there is no empty field to fill instead. */
  primaryWithoutFill: boolean;
}

export const EAGERNESS: Record<Eagerness, EagernessKnobs> = {
  conservative: { minConfidence: 0.7, jevGateMin: 0.6, maxSuggestions: 2, sameOriginContext: false, looseNames: false, primaryWithoutFill: false },
  balanced: { minConfidence: 0.55, jevGateMin: 0.5, maxSuggestions: 2, sameOriginContext: false, looseNames: false, primaryWithoutFill: false },
  eager: { minConfidence: 0.35, jevGateMin: 0.25, maxSuggestions: 4, sameOriginContext: true, looseNames: true, primaryWithoutFill: true },
};

export const DEFAULT_EAGERNESS: Eagerness = 'eager';

/** One line per level, for the options page and anywhere else the choice is explained. */
export const EAGERNESS_HELP: Record<Eagerness, string> = {
  conservative: 'Only sure values, and only from other sites. No suggestion beats a wrong one.',
  balanced: 'Likely values. Two chips per answer, nothing from another tab on the same site.',
  eager: "Any plausible value, up to four chips per answer, other tabs on the same site included, and the page's Continue or Search button once there is nothing left to fill. A wrong chip costs one Esc.",
};

export function isEagerness(v: unknown): v is Eagerness {
  return typeof v === 'string' && (EAGERNESS_LEVELS as readonly string[]).includes(v);
}

/**
 * The floor a suggestion would have needed at the next stricter level: what
 * "weak" means for a chip that only the current level lets through. At
 * `conservative` there is no stricter level and nothing counts as weak.
 */
export function weakBelow(level: Eagerness): number {
  const i = EAGERNESS_LEVELS.indexOf(level);
  return i <= 0 ? 0 : EAGERNESS[EAGERNESS_LEVELS[i - 1]!].minConfidence;
}
