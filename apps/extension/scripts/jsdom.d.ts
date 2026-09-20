/**
 * Just enough of jsdom for the dev scripts. The package ships no types and
 * `@types/jsdom` would be a dependency the extension carries for one script.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    pretendToBeVisual?: boolean;
    runScripts?: 'dangerously' | 'outside-only';
  }
  export class JSDOM {
    constructor(html: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
