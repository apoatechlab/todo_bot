/**
 * Duplicate folders: how they stopped happening, and how the ones already in
 * the Drive get merged away.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

// --- a tiny Drive ------------------------------------------------------------
let files, seq, calls;
const reset = () => { files = new Map(); seq = 0; calls = 0; };
const mkFolder = (name, parent, created) => {
  const id = 'd' + ++seq;
  files.set(id, { id, name, parents: [parent], mimeType: 'application/vnd.google-apps.folder',
    createdTime: created ?? `2026-01-${String(seq).padStart(2, '0')}T00:00:00Z`, trashed: false });
  return id;
};
const mkFile = (name, parent) => {
  const id = 'f' + ++seq;
  files.set(id, { id, name, parents: [parent], mimeType: 'application/pdf',
    createdTime: '2026-02-01T00:00:00Z', trashed: false });
  return id;
};
const live = () => [...files.values()].filter(f => !f.trashed);
const kidsOf = id => live().filter(f => f.parents.includes(id));

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') return J({ access_token: 'a', expires_in: 3600 });
  if (!u.startsWith('https://www.googleapis.com/drive/v3/files')) throw new Error('unstubbed ' + u);
  calls++;
  const url_ = new URL(u);
  const method = init.method || 'GET';

  if (method === 'GET') {
    const q = decodeURIComponent(url_.searchParams.get('q') || '');
    const parent = /'([^']*)' in parents/.exec(q)?.[1];
    const name = /name = '([^']*)'/.exec(q)?.[1];
    const foldersOnly = q.includes('mimeType =');
    let out = live().filter(f => f.parents.includes(parent));
    if (name) out = out.filter(f => f.name === name);
    if (foldersOnly) out = out.filter(f => f.mimeType.endsWith('.folder'));
    out.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    return J({ files: out.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime })) });
  }
  if (method === 'POST') {
    const b = JSON.parse(init.body);
    return J({ id: mkFolder(b.name, b.parents[0], `2026-06-${String(seq + 10)}T00:00:00Z`) });
  }
  if (method === 'PATCH') {
    const id = /files\/([^?]+)/.exec(u)[1];
    const f = files.get(id);
    const body = JSON.parse(init.body || '{}');
    if (body.trashed) f.trashed = true;
    const add = url_.searchParams.get('addParents'), rm = url_.searchParams.get('removeParents');
    if (add) f.parents = [...f.parents.filter(p => p !== rm), add];
    if (body.name) f.name = body.name;
    return J({ id, name: f.name, webViewLink: 'https://drive.google.com/file/d/' + id + '/view' });
  }
  throw new Error('unhandled ' + method);
};

const env = () => ({ CHATS: makeKV(), GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
  GOOGLE_REFRESH_TOKEN: 'r', DRIVE_ROOT_ID: 'ROOT' });

// --- lookups converge on the oldest twin ------------------------------------
reset();
{
  const e = env();
  const old_ = mkFolder('анализы', 'ROOT', '2026-01-01T00:00:00Z');
  mkFolder('анализы', 'ROOT', '2026-03-01T00:00:00Z');
  eq('an existing duplicate resolves to the oldest', await W.driveFolder(e, 'анализы', 'ROOT'), old_);
  eq('and nothing new is created', live().filter(f => f.name === 'анализы').length, 2);
}

// --- losing the race cleans up after itself ----------------------------------
reset();
{
  const e = env();
  // Another invocation creates the folder between our lookup and our create.
  const theirs = mkFolder('счета', 'ROOT', '2026-01-01T00:00:00Z');
  files.get(theirs).parents = ['HIDDEN'];              // invisible to our first lookup
  const realFetch = globalThis.fetch;
  let created = false;
  globalThis.fetch = async (u, i) => {
    const r = await realFetch(u, i);
    if ((i?.method || 'GET') === 'POST' && !created) {
      created = true;
      files.get(theirs).parents = ['ROOT'];            // …and becomes visible now
    }
    return r;
  };
  const got = await W.driveFolder(e, 'счета', 'ROOT');
  globalThis.fetch = realFetch;
  eq('the older folder wins', got, theirs);
  eq('and the one we made is binned', live().filter(f => f.name === 'счета').length, 1);
}

// --- the cache is used, and only once ---------------------------------------
reset();
{
  const e = env();
  const id = mkFolder('школа', 'ROOT', '2026-01-01T00:00:00Z');
  await W.driveFolder(e, 'школа', 'ROOT');
  const before = calls;
  eq('second call is cached', await W.driveFolder(e, 'школа', 'ROOT'), id);
  eq('and costs no request', calls, before);
}

// --- the repair -------------------------------------------------------------
reset();
{
  const e = env();
  const a1 = mkFolder('анализы', 'ROOT', '2026-01-01T00:00:00Z');
  const a2 = mkFolder('анализы', 'ROOT', '2026-02-01T00:00:00Z');
  const a3 = mkFolder('анализы', 'ROOT', '2026-03-01T00:00:00Z');
  const sc = mkFolder('счета', 'ROOT', '2026-01-05T00:00:00Z');
  const keep = mkFile('старый.pdf', a1);
  const lost1 = mkFile('потеряшка.pdf', a2);
  const lost2 = mkFile('вторая.pdf', a3);
  // Duplicate person folders one level down.
  const p1 = mkFolder('Ксения', a1, '2026-01-02T00:00:00Z');
  const p2 = mkFolder('Ксения', a2, '2026-02-02T00:00:00Z');
  const inP2 = mkFile('её.pdf', p2);

  await e.CHATS.put(`doc:${lost1}`, JSON.stringify({ id: lost1, folderId: a2, category: 'анализы',
    person: '', date: '2026-02-01', title: 'потеряшка' }), { metadata: { c: 'анализы', p: '', d: '2026-02-01', t: 'потеряшка' } });
  await e.CHATS.put('gdrive:dir:ROOT:анализы', a3);

  const r = await W.repairArchive(e);
  ok('it reports what it merged', r.merged.length >= 2, JSON.stringify(r));
  eq('one «анализы» is left', live().filter(f => f.name === 'анализы').length, 1);
  eq('and it is the oldest', live().find(f => f.name === 'анализы').id, a1);
  eq('untouched folders are left alone', live().filter(f => f.name === 'счета').length, 1);
  ok('the stray files moved into the survivor',
     kidsOf(a1).map(f => f.id).includes(lost1) && kidsOf(a1).map(f => f.id).includes(lost2),
     JSON.stringify(kidsOf(a1).map(f => f.name)));
  ok('the file that was already right stayed', kidsOf(a1).map(f => f.id).includes(keep));
  eq('duplicate person folders merge too',
     live().filter(f => f.name === 'Ксения').length, 1);
  ok('and their files come along', kidsOf(p1).map(f => f.id).includes(inP2));
  eq('the index points at the survivor',
     (await e.CHATS.get(`doc:${lost1}`, 'json')).folderId, a1);
  eq('the stale folder cache is cleared',
     await e.CHATS.get('gdrive:dir:ROOT:анализы'), null);
  ok('nothing left to do', r.more === false, JSON.stringify(r));
}

// --- a clean archive is left alone ------------------------------------------
reset();
{
  const e = env();
  mkFolder('анализы', 'ROOT', '2026-01-01T00:00:00Z');
  mkFolder('счета', 'ROOT', '2026-01-02T00:00:00Z');
  const r = await W.repairArchive(e);
  eq('nothing merged', r.merged, []);
  eq('nothing moved', r.movedFiles, 0);
  eq('and nothing trashed', live().length, 2);
}

// --- the budget stops it and says so -----------------------------------------
reset();
{
  const e = env();
  const first = mkFolder('анализы', 'ROOT', '2026-01-01T00:00:00Z');
  for (let i = 0; i < 6; i++) {
    const d = mkFolder('анализы', 'ROOT', `2026-0${i + 2}-01T00:00:00Z`);
    for (let j = 0; j < 5; j++) mkFile(`f${i}-${j}.pdf`, d);
  }
  const r = await W.repairArchive(e, 8);
  ok('a tight budget stops early', r.more === true, JSON.stringify(r));
  ok('but what it did do is real', r.movedFiles > 0);
  const r2 = await W.repairArchive(e, 200);
  ok('running again finishes the job', r2.more === false, JSON.stringify(r2));
  eq('one folder survives', live().filter(f => f.name === 'анализы').length, 1);
  eq('holding every file', kidsOf(first).length, 30);
}

// --- categories --------------------------------------------------------------
{
  const e = env();
  ok('паспорта is a category now', (await W.getDocCategories(e)).includes('паспорта'));
  const out = await W.runTool(e, 'add_doc_category', { name: '  Права ' });
  ok('a new one can be added', out.ok && out.categories.includes('права'), JSON.stringify(out));
  eq('«прочее» stays last', out.categories.at(-1), 'прочее');
  const again = await W.runTool(e, 'add_doc_category', { name: 'права' });
  eq('adding it twice is a no-op', again.categories.filter(c => c === 'права').length, 1);
  eq('an empty name is refused', (await W.runTool(e, 'add_doc_category', { name: ' ' })).error,
     'Пустое название.');
}

done();
