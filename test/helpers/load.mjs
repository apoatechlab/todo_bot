/**
 * Import src/index.js as a plain ES module.
 *
 * The Worker entrypoint imports app.html as a bundler text module and exports
 * only a default handler, neither of which Node can do. This rewrites the one
 * import and appends an export list *derived from the source*, so a test never
 * breaks because a hand-kept list went stale.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function loadWorker() {
  const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8')
    .replace("import APP_HTML from './app.html';", "const APP_HTML = '<!doctype html>';");

  const names = new Set();
  for (const m of src.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);

  const file = join(mkdtempSync(join(tmpdir(), 'worker-')), 'worker.mjs');
  writeFileSync(file, `${src}\n\nexport { ${[...names].join(', ')} };\n`);
  return import(file);
}

/** Tiny assertion helpers; every suite prints one line per check. */
export function harness() {
  const state = { fails: 0 };
  const ok = (name, cond, extra = '') => {
    if (!cond) { state.fails++; console.log('FAIL  ' + name + (extra ? ': ' + extra : '')); }
    else console.log('pass  ' + name);
  };
  const eq = (name, got, want) =>
    ok(name, JSON.stringify(got) === JSON.stringify(want),
       JSON.stringify(got) + ' != ' + JSON.stringify(want));
  const done = () => {
    console.log(state.fails ? `\n${state.fails} FAILED` : '\nall passed');
    process.exit(state.fails ? 1 : 0);
  };
  return { ok, eq, done };
}
