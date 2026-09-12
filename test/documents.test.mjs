/**
 * The document archive: which formats are taken in, how they are labelled when
 * Claude cannot see inside them, and what comes back out.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

let classifyAs = { category: 'счета', person: '', date: '2026-09-12', title: 'счёт', confident: true };
let anthropicCalls = [];
const sent = [];
const folders = new Map();
let dirSeq = 0, fileSeq = 0, uploadName = '', payload = new Uint8Array([1, 2, 3]);

globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body;
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

  if (u.includes('/getFile')) return J({ ok: true, result: { file_path: 'd/f' } });
  if (u.startsWith('https://api.telegram.org/file/')) return new Response(payload.buffer ?? payload);
  if (u.startsWith('https://api.telegram.org/bot')) {
    if (u.includes('/sendMessage')) sent.push(JSON.parse(body));
    return J({ ok: true, result: { message_id: 1 } });
  }
  if (u === 'https://oauth2.googleapis.com/token') return J({ access_token: 'a', expires_in: 3600 });
  if (u === 'https://api.anthropic.com/v1/messages') {
    anthropicCalls.push(JSON.parse(body));
    return J({ content: [{ type: 'tool_use', id: 't', name: 'file_document', input: classifyAs }] });
  }
  if (u.startsWith('https://www.googleapis.com/upload/')) {
    if (init.method === 'POST') { uploadName = JSON.parse(body).name;
      return new Response(null, { headers: { location: 'https://up/s' } }); }
  }
  if (u === 'https://up/s') {
    const id = 'file' + ++fileSeq;
    return J({ id, name: uploadName, webViewLink: `https://drive.google.com/file/d/${id}/view` });
  }
  if (u.startsWith('https://www.googleapis.com/drive/v3/files')) {
    if (u.includes('alt=media')) return new Response(payload.buffer ?? payload);
    if ((init.method || 'GET') === 'GET') {
      const q = decodeURIComponent(new URL(u).searchParams.get('q') || '');
      const id = folders.get(/'([^']*)' in parents/.exec(q)?.[1] + '/' + /name = '([^']*)'/.exec(q)?.[1]);
      return J({ files: id ? [{ id }] : [] });
    }
    if (init.method === 'POST') {
      const b = JSON.parse(body); const id = 'dir' + ++dirSeq;
      folders.set(b.parents[0] + '/' + b.name, id); return J({ id });
    }
    if (init.method === 'PATCH') return J({ id: 'file1', name: JSON.parse(body).name,
      webViewLink: 'https://drive.google.com/file/d/file1/view' });
  }
  throw new Error('unstubbed ' + u);
};

const env = () => ({
  CHATS: makeKV(), TELEGRAM_BOT_TOKEN: 't', ANTHROPIC_API_KEY: 'k', TZ_NAME: 'Europe/Madrid',
  GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r',
  DRIVE_ROOT_NAME: 'Документы семьи',
});
const file = (name, mime, size = 5) =>
  ({ file_id: 'F', file_name: name, mime_type: mime, file_size: size });
const card = () => sent.at(-1).text;
const lastContent = () => anthropicCalls.at(-1).messages[0].content;

// ---------------------------------------------------------------- extFor ----
eq('extension comes from the name, not a wrong mime',
   W.extFor('расписание.xlsx', 'application/octet-stream'), 'xlsx');
eq('a named extension is lowercased', W.extFor('SCAN.PDF', 'application/pdf'), 'pdf');
eq('no name falls back to the mime map', W.extFor(null, 'application/vnd.ms-excel'), 'xls');
eq('an unknown mime with no name is bin', W.extFor(null, 'application/x-weird'), 'bin');
eq('a name with no extension falls back too', W.extFor('счёт', 'image/jpeg'), 'jpg');
eq('a dotted name keeps only the last part', W.extFor('отчёт.v2.docx', ''), 'docx');

// ------------------------------------------------- office files are stored --
for (const [name, mime, ext] of [
  ['таблица.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['старая.xls', 'application/vnd.ms-excel', 'xls'],
  ['договор.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['письмо.doc', 'application/msword', 'doc'],
  ['презентация.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['данные.ods', 'application/vnd.oasis.opendocument.spreadsheet', 'ods'],
]) {
  const e = env();
  sent.length = 0; anthropicCalls = [];
  classifyAs = { category: 'счета', person: 'Антон', date: '2026-09-12', title: 'счёт за свет', confident: true };
  await W.fileIncomingDocument(e, '-100', file(name, mime), null, 'Антон');
  const rec = await e.CHATS.get('doc:file' + fileSeq, 'json');
  ok(`${ext} is stored`, !!rec, 'nothing filed');
  eq(`${ext} keeps its extension in Drive`, rec?.fileName, `2026-09-12 — счёт за свет.${ext}`);
  eq(`${ext} records the extension`, rec?.ext, ext);
  ok(`${ext} is not shown to Claude`,
     lastContent().every(b => b.type === 'text'), JSON.stringify(lastContent().map(b => b.type)));
  ok(`${ext} tells Claude it is going blind`,
     /открыть не могу/.test(lastContent().at(-1).text));
  ok(`${ext} says so on the card`, /заглянуть не могу/.test(card()), card());
}

// ------------------------------------------------ pdf and images still read --
for (const [name, mime, kind] of [
  ['скан.pdf', 'application/pdf', 'document'],
  ['фото.jpg', 'image/jpeg', 'image'],
  ['снимок.png', 'image/png', 'image'],
]) {
  const e = env();
  sent.length = 0; anthropicCalls = [];
  classifyAs = { category: 'анализы', person: 'Ксения', date: '2026-05-05', title: 'анализ', confident: true };
  await W.fileIncomingDocument(e, '-100', file(name, mime), null, 'Антон');
  ok(`${name} is attached as a ${kind} block`,
     lastContent().some(b => b.type === kind), JSON.stringify(lastContent().map(b => b.type)));
  ok(`${name} gets no "cannot open" note`, !/заглянуть не могу/.test(card()));
}

// ----------------------------------------------------- text is pasted in ----
{
  const e = env();
  sent.length = 0; anthropicCalls = [];
  payload = new TextEncoder().encode('Дата;Сумма\n2026-09-01;42,50');
  classifyAs = { category: 'счета', person: '', date: '2026-09-01', title: 'выписка', confident: true };
  await W.fileIncomingDocument(e, '-100', file('выписка.csv', 'text/csv', 30), null, 'Антон');
  ok('csv contents are pasted into the prompt',
     lastContent().some(b => b.type === 'text' && b.text.includes('2026-09-01;42,50')));
  ok('and it does not claim to be blind', !/заглянуть не могу/.test(card()));
  payload = new Uint8Array([1, 2, 3]);
}

// ----------------------------------------------------------- heic is kept ---
{
  const e = env();
  sent.length = 0;
  classifyAs = { category: 'прочее', person: '', date: '2026-09-12', title: 'фото', confident: true };
  await W.fileIncomingDocument(e, '-100', file('IMG_1.heic', 'image/heic'), null, 'Антон');
  ok('heic is stored rather than refused', !!(await e.CHATS.get('doc:file' + fileSeq, 'json')));
  ok('and the card admits it was not read', /заглянуть не могу/.test(card()));
}

// --------------------------------------------------- unknown types too ------
{
  const e = env();
  sent.length = 0;
  classifyAs = { category: 'прочее', person: '', date: '2026-09-12', title: 'архив', confident: true };
  await W.fileIncomingDocument(e, '-100', file('бумаги.zip', 'application/zip'), null, 'Антон');
  const rec = await e.CHATS.get('doc:file' + fileSeq, 'json');
  eq('an unreadable format is still filed with its extension', rec?.ext, 'zip');
}

// ------------------------------------------------------- limits unchanged ---
{
  const e = env();
  sent.length = 0;
  await W.fileIncomingDocument(e, '-100', file('huge.xlsx',
    'application/vnd.ms-excel', 25 * 1024 * 1024), null, 'Антон');
  ok('over 20 MB is still refused', /20 МБ/.test(card()));
  eq('and nothing is filed', (await e.CHATS.list({ prefix: 'doc:' })).keys.length, 0);
}

// ------------------------------------------- reading skips what it cannot ---
{
  const e = env();
  const put = async d => e.CHATS.put(`doc:${d.id}`, JSON.stringify(d),
    { metadata: { c: d.category, p: d.person, d: d.date, t: d.title } });
  await put({ id: 'x1', category: 'счета', person: 'Антон', date: '2026-01-01', title: 'таблица',
    mimeType: 'application/vnd.ms-excel', ext: 'xls', size: 10, link: 'l1' });
  await put({ id: 'x2', category: 'счета', person: 'Антон', date: '2026-01-02', title: 'скан',
    mimeType: 'application/pdf', ext: 'pdf', size: 10, link: 'l2' });
  anthropicCalls = [];
  const out = await W.runTool(e, 'read_documents', { question: 'сколько', person: 'Антон' });
  eq('only the readable one is opened', out.read.map(r => r.title), ['скан']);
  ok('and the other is reported with its format',
     out.skipped?.some(s => /xls нельзя открыть/.test(s)), JSON.stringify(out.skipped));
}

// ------------------------------------------ refile keeps the extension ------
{
  const e = env();
  sent.length = 0; anthropicCalls = [];
  classifyAs = { category: 'счета', person: 'Антон', date: '2026-02-02', title: 'счёт', confident: true };
  await W.fileIncomingDocument(e, '-100', file('c.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), null, 'Антон');
  const id = 'file' + fileSeq;
  const out = await W.runTool(e, 'refile_document', { document_id: id, title: 'счёт за газ' });
  ok('refile succeeds', out.ok === true, JSON.stringify(out));
  eq('and the file keeps .xlsx, not .bin',
     (await e.CHATS.get('doc:' + id, 'json')).fileName, '2026-02-02 — счёт за газ.xlsx');
}

done();
