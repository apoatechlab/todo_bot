/**
 * Moving many documents at once — the situation a late-added category creates:
 * everything it should hold is already sitting in «прочее».
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

let files, seq;
const reset = () => { files = new Map(); seq = 0; };
const mkFolder = (name, parent) => {
  const id = 'd' + ++seq;
  files.set(id, { id, name, parents: [parent], folder: true, trashed: false,
    createdTime: `2026-01-${String(seq).padStart(2, '0')}T00:00:00Z` });
  return id;
};
const live = () => [...files.values()].filter(f => !f.trashed);
const pathOf = id => {
  const f = files.get(id); if (!f) return '?';
  const p = files.get(f.parents[0]);
  return p ? `${pathOf(p.id)}/${f.name}` : f.name;
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method || 'GET';
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') return J({ access_token: 'a', expires_in: 3600 });
  if (!u.startsWith('https://www.googleapis.com/drive/v3/files')) throw new Error('unstubbed ' + u);
  const url_ = new URL(u);
  if (method === 'GET') {
    const q = decodeURIComponent(url_.searchParams.get('q') || '');
    const parent = /'([^']*)' in parents/.exec(q)?.[1];
    const name = /name = '([^']*)'/.exec(q)?.[1];
    let out = live().filter(f => f.parents.includes(parent) && f.folder);
    if (name) out = out.filter(f => f.name === name);
    out.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    return J({ files: out.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime })) });
  }
  if (method === 'POST') { const b = JSON.parse(init.body); return J({ id: mkFolder(b.name, b.parents[0]) }); }
  if (method === 'PATCH') {
    const id = /files\/([^?]+)/.exec(u)[1];
    const add = url_.searchParams.get('addParents'), rm = url_.searchParams.get('removeParents');
    const body = JSON.parse(init.body || '{}');
    if (!files.has(id)) files.set(id, { id, name: '', parents: [], trashed: false });
    const f = files.get(id);
    if (add) f.parents = [...f.parents.filter(p => p !== rm), add];
    if (body.name) f.name = body.name;
    return J({ id, name: f.name, webViewLink: `https://drive.google.com/file/d/${id}/view` });
  }
  throw new Error('unhandled');
};

const makeEnv = () => ({ CHATS: makeKV(), GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
  GOOGLE_REFRESH_TOKEN: 'r', DRIVE_ROOT_ID: 'ROOT' });
const put = (e, d) => e.CHATS.put(`doc:${d.id}`, JSON.stringify(d),
  { metadata: { c: d.category, p: d.person || '', d: d.date, t: d.title } });
const rec = (id, title, category, person = '', extra = {}) => ({
  id, title, category, person, date: '2026-03-0' + (id.length % 9 || 1),
  mimeType: 'application/pdf', ext: 'pdf', fileName: `${title}.pdf`,
  folderId: 'OLD', link: `https://drive.google.com/file/d/${id}/view`, size: 10, ...extra });

// --- the actual situation: passports stuck in «прочее» ----------------------
reset();
{
  const e = makeEnv();
  await put(e, rec('p1', 'паспорт Антона', 'прочее', 'Антон'));
  await put(e, rec('p2', 'паспорт Ксении', 'прочее', 'Ксения'));
  await put(e, rec('p3', 'загранпаспорт Майи', 'прочее', 'Майя'));
  await put(e, rec('o1', 'гарантия на холодильник', 'прочее'));

  const out = await W.runTool(e, 'refile_documents',
    { category: 'прочее', query: 'паспорт', to_category: 'паспорта' });
  eq('all three passports move', out.moved, 3);
  eq('and the unrelated one stays',
     (await e.CHATS.get('doc:o1', 'json')).category, 'прочее');
  for (const id of ['p1', 'p2', 'p3']) {
    eq(`${id} is in паспорта now`, (await e.CHATS.get(`doc:${id}`, 'json')).category, 'паспорта');
  }
  eq('each keeps its owner', (await e.CHATS.get('doc:p2', 'json')).person, 'Ксения');
  ok('and lands in the owner folder on Drive',
     pathOf('p2').includes('паспорта/Ксения/'), pathOf('p2'));
  ok('the file keeps its id, so old links still work',
     (await e.CHATS.get('doc:p1', 'json')).link.includes('/p1/'));
  ok('search finds them under the new category',
     (await W.searchDocs(e, { category: 'паспорта' })).total === 3);
}

// --- already-correct documents are not touched -------------------------------
{
  const e = makeEnv();
  await put(e, rec('a1', 'паспорт', 'паспорта', 'Антон'));
  const out = await W.runTool(e, 'refile_documents',
    { query: 'паспорт', to_category: 'паспорта' });
  eq('nothing to move is reported as nothing', out.moved, 0);
}

// --- moving people, not categories -------------------------------------------
{
  const e = makeEnv();
  await put(e, rec('m1', 'справка', 'школа', 'Майя'));
  await put(e, rec('m2', 'табель', 'школа', 'Майя'));
  const out = await W.runTool(e, 'refile_documents', { category: 'школа', to_person: 'Ксения' });
  eq('both change owner', out.moved, 2);
  eq('category untouched', (await e.CHATS.get('doc:m1', 'json')).category, 'школа');
  eq('owner changed', (await e.CHATS.get('doc:m1', 'json')).person, 'Ксения');
  const back = await W.runTool(e, 'refile_documents', { category: 'школа', to_person: '' });
  eq('an empty owner makes them household documents', back.moved, 2);
  eq('person cleared', (await e.CHATS.get('doc:m1', 'json')).person, '');
}

// --- the cap, and picking up where it left off -------------------------------
{
  const e = makeEnv();
  for (let i = 0; i < 20; i++) await put(e, rec('b' + i, 'паспорт ' + i, 'прочее'));
  const first = await W.runTool(e, 'refile_documents',
    { category: 'прочее', to_category: 'паспорта' });
  eq('one call moves at most twelve', first.moved, 12);
  ok('and says how many are left', first.remaining === 8, JSON.stringify(first.remaining));
  const second = await W.runTool(e, 'refile_documents',
    { category: 'прочее', to_category: 'паспорта' });
  eq('the same call again takes the rest', second.moved, 8);
  ok('and then reports nothing left', second.remaining === undefined, JSON.stringify(second));
  eq('all twenty arrived', (await W.searchDocs(e, { category: 'паспорта', limit: 20 })).total, 20);
}

// --- refusals ----------------------------------------------------------------
{
  const e = makeEnv();
  await put(e, rec('z1', 'что-то', 'прочее'));
  eq('an unknown target category is refused',
     (await W.runTool(e, 'refile_documents', { to_category: 'выдуманное' })).error?.slice(0, 20),
     'Категория «выдуманно');
  ok('a call with no target is refused',
     !!(await W.runTool(e, 'refile_documents', { category: 'прочее' })).error);
  const none = await W.runTool(e, 'refile_documents',
    { query: 'такого нет', to_category: 'паспорта' });
  eq('no match moves nothing', none.moved, 0);
  ok('and explains that query reads titles', /заголовку/.test(none.hint));
}

// --- the single-document tool still works through the shared mover -----------
{
  const e = makeEnv();
  await put(e, rec('s1', 'паспорт', 'прочее', 'Антон'));
  const out = await W.runTool(e, 'refile_document', { document_id: 's1', category: 'паспорта' });
  ok('refile_document still reports ok', out.ok === true, JSON.stringify(out));
  eq('and moved it', (await e.CHATS.get('doc:s1', 'json')).category, 'паспорта');
  eq('renaming still works',
     (await W.runTool(e, 'refile_document', { document_id: 's1', title: 'загранпаспорт' })).document.title,
     'загранпаспорт');
}

done();
