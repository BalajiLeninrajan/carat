/**
 * `pnpm outline:dump <file.html>` — the outline carat would send for a page
 * saved to disk, printed as it goes over the wire, followed by the numbered
 * controls and how many of the page's controls were described at all.
 *
 * Chrome's "Save as → Webpage, complete" writes the DOM as it stands, so a
 * booking form with its pickers open can be kept and read here instead of
 * being guessed at. Page scripts are not run unless `--scripts` says so; a
 * page built from web components needs them, because a shadow root only
 * exists once the component that attaches it has run.
 *
 * jsdom lays nothing out: every box is zero and the page never scrolls, so
 * the fold filter passes everything through and what is printed is the whole
 * document rather than one screen of it. That is the point — the gaps this
 * tool is for are naming and numbering gaps, not viewport ones.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildOutline } from '../src/outline';

interface Args {
  file: string;
  budget?: number;
  scripts: boolean;
}

function parse(argv: readonly string[]): Args {
  const rest: string[] = [];
  let budget: number | undefined;
  let scripts = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--scripts') scripts = true;
    else if (arg === '--budget') budget = Number(argv[++i]);
    else if (arg.startsWith('--budget=')) budget = Number(arg.slice('--budget='.length));
    else rest.push(arg);
  }
  const file = rest[0];
  if (!file) {
    throw new Error('usage: pnpm outline:dump <file.html> [--scripts] [--budget=9000]');
  }
  return { file, scripts, ...(budget !== undefined && Number.isFinite(budget) ? { budget } : {}) };
}

/**
 * The few DOM classes the outline reaches for by bare name. Node has none of
 * them, and every jsdom window has its own, so they are borrowed from the
 * window the page was parsed into.
 */
function installGlobals(win: JSDOM['window']): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ['NodeFilter', 'DOMRect', 'Node', 'Element', 'HTMLElement', 'ShadowRoot', 'getComputedStyle']) {
    g[name] = (win as unknown as Record<string, unknown>)[name];
  }
}

/**
 * Run from the repository root, `pnpm outline:dump` hands the script to the
 * extension package and the working directory moves with it, so a path the
 * user typed is tried where they typed it as well as where the script landed.
 */
function locate(file: string): string {
  const here = resolve(process.cwd(), file);
  if (existsSync(here)) return here;
  const called = process.env.INIT_CWD ? resolve(process.env.INIT_CWD, file) : '';
  if (called && existsSync(called)) return called;
  throw new Error(`no such file: ${file}`);
}

function main(): void {
  const args = parse(process.argv.slice(2));
  const path = locate(args.file);
  const dom = new JSDOM(readFileSync(path, 'utf8'), {
    url: 'https://example.invalid/',
    pretendToBeVisual: true,
    ...(args.scripts ? { runScripts: 'dangerously' as const } : {}),
  });
  installGlobals(dom.window);
  const built = buildOutline(dom.window.document, dom.window as unknown as Window, {
    ...(args.budget !== undefined ? { budget: args.budget } : {}),
  });

  process.stdout.write(`${built.outline}\n`);
  process.stdout.write('\ncontrols:\n');
  for (const c of built.controls) {
    const parts = [
      `[${c.n}]`,
      c.role,
      c.name ? JSON.stringify(c.name) : '(unnamed)',
      ...(c.value ? [`= ${JSON.stringify(c.value)}`] : []),
      ...(c.popup ? [`(opens ${c.popup})`] : []),
      ...(c.state ? [`(${c.state})`] : []),
      ...(c.host ? [`-> ${c.host}`] : []),
    ];
    process.stdout.write(`${parts.join(' ')}\n`);
  }
  process.stdout.write(
    `\n${built.describedControls} of ${built.pageControls} controls described; ${built.outline.length} characters\n`,
  );
  dom.window.close();
}

main();
