/**
 * Family task bot — Cloudflare Workers edition.
 * Telegram webhook -> (voice: Groq Whisper) -> Claude tool use -> Todoist project.
 *
 * Bindings expected:
 *   KV namespace: CHATS
 *   Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ANTHROPIC_API_KEY,
 *            TODOIST_API_TOKEN, GROQ_API_KEY,
 *            GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   Vars:    TODOIST_PROJECT_ID, TZ_NAME, TODOIST_DUE_LANG, ALLOWED_CHAT_IDS,
 *            ALLOW_DELETE, CLAUDE_MODEL, CLAUDE_EFFORT,
 *            DIGEST_CHAT_ID, DIGEST_AT, DIGEST_SKIP_EMPTY, SUGGEST_COUNT,
 *            ALERT_LEAD_MIN, ALERT_MIN_PRIORITY, ALERT_CHAT_ID,
 *            BOT_USERNAME, MINIAPP_SHORT_NAME, DRIVE_ROOT_NAME, DRIVE_ROOT_ID,
 *            DELETE_REQUESTS, WEEKEND_LABEL, WEEKEND_AT, WEEKEND_COUNT,
 *            WEEKEND_CHAT_ID
 */

import APP_HTML from './app.html';

const TD = 'https://api.todoist.com/api/v1';
const MODEL = 'claude-sonnet-5';

// Adaptive thinking is the only on-mode on Sonnet 5, and thinking tokens count
// against max_tokens — so this is deliberately generous. Replies are two lines;
// we only ever pay for what is actually generated.
const MAX_TOKENS = 16000;

const TG_LIMIT = 4096; // Telegram rejects sendMessage above this

// ============================================================ entrypoint ====
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    // The Mini App page and the data it reads are the only GET surface here;
    // everything else this Worker answers is the Telegram webhook.
    if (path === '/app' || path === '/app/') {
      return new Response(APP_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Telegram caches Mini App pages aggressively; revalidate every time
          // so a deploy is visible without anyone clearing the client cache.
          'cache-control': 'no-cache',
        },
      });
    }
    if (path === '/api/tasks') return apiTasks(request, env);

    if (request.method !== 'POST') return new Response('ok');

    // Telegram proves it's Telegram by echoing the secret we registered.
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const update = await request.json().catch(() => null);

    // Return 200 straight away — Telegram retries anything slower, which would
    // duplicate tasks. Real work continues in the background.
    ctx.waitUntil(handleUpdate(update, env).catch(err => console.error('handler', err.stack)));
    return new Response('ok');
  },

  // Two cron jobs share this handler; event.cron says which one fired.
  //
  //   */5 * * * *          -> dueSoonAlerts: high-priority tasks about to start
  //   30 5 / 30 6 * * *    -> morningDigest: the day's plan
  //
  // Cloudflare schedules in UTC only, so both the summer and winter UTC
  // equivalents of DIGEST_AT are registered and morningDigest() decides which
  // one is actually 07:30 in Madrid today.
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    // Day-of-week 4 is the Thursday pair; */5 is the alert sweep; the rest is
    // the morning digest's summer/winter pair.
    const job = cron.startsWith('*/5')
      ? dueSoonAlerts(env).catch(err => console.error('alerts', err.stack))
      : cron.endsWith(' 4')
        ? weekendIdeas(env).catch(err => console.error('weekend', err.stack))
        : morningDigest(env).catch(err => console.error('digest', err.stack));
    ctx.waitUntil(job);
  },
};

async function handleUpdate(update, env) {
  const msg = update?.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const allowed = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(chatId)) {
    console.warn('blocked chat', chatId, msg.from?.username);
    return;
  }

  let text = msg.text;
  const voice = msg.voice || msg.audio;
  if (voice) {
    await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    try {
      text = await transcribe(env, voice.file_id);
    } catch (e) {
      console.error('transcribe', e.stack);
      return void say(env, chatId, `⚠️ Не смог разобрать голосовое: ${e.message}`);
    }
  }
  // A file or a photo goes to the archive, not into the task loop. Photos have
  // no mime_type of their own — Telegram re-encodes every one to JPEG — and the
  // last entry of the array is the largest rendition.
  const upload = msg.document
    || (msg.photo?.length ? { ...msg.photo[msg.photo.length - 1], mime_type: 'image/jpeg' } : null);
  if (upload) {
    await tg(env, 'sendChatAction', { chat_id: chatId, action: 'upload_document' });
    try {
      await fileIncomingDocument(env, chatId, upload, msg.caption, msg.from?.first_name);
    } catch (e) {
      console.error('doc', e.stack);
      await say(env, chatId, `⚠️ Не смог положить документ в архив: ${e.message}`);
    }
    return;
  }

  if (!text) return;

  // In a group, commands arrive as "/rules@botname" — strip the mention.
  const cmd = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    return void say(env, chatId,
      'Пиши или наговаривай: «купить молоко завтра», «перенеси дантиста на пятницу», «садик — сделано», «что на сегодня?»\n\n' +
      'Напоминания: «напомни завтра в 18:00 забрать посылку» или «это важно» — подниму приоритет и пришлю сюда сигнал за 5 минут.\n\n' +
      '/digest — прислать утренний дайджест прямо сейчас.\n' +
      '/weekend — идеи на выходные; сами приходят по четвергам.\n' +
      '/school — дни без школы, закрашенные в календаре.\n' +
      '/docs — архив документов; кинь файл или фото, и он туда попадёт.\n' +
      '/rules — правила бота, /rules reset — сбросить, /reset — забыть контекст разговора.');
  }
  // Same code path the 07:30 cron takes, posted into this chat on demand —
  // the only way to see the real digest without waiting for tomorrow.
  if (cmd === '/digest') {
    await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    return void await morningDigest(env, { force: true, chatId });
  }
  if (cmd === '/reset') {
    await env.CHATS.delete(`hist:${chatId}`);
    return void say(env, chatId, 'Контекст очищен.');
  }
  if (cmd === '/weekend') {
    await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    return void await weekendIdeas(env, { force: true, chatId });
  }
  if (cmd === '/docs') {
    if (text.includes('fix')) {
      await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
      try {
        const r = await repairArchive(env);
        return void say(env, chatId,
          r.merged.length || r.movedFiles
            ? `Слил ${r.merged.length} дублей папок, перенёс ${r.movedFiles} файлов`
              + `${r.repointed ? `, поправил ${r.repointed} записей` : ''}.\n`
              + r.merged.map(m => `• ${m}`).join('\n')
              + (r.more ? '\n\n_Дошёл до лимита запросов — запусти `/docs fix` ещё раз._' : '')
            : 'Дублей папок не нашёл — в архиве порядок.');
      } catch (e) {
        console.error('repair', e.stack);
        return void say(env, chatId, `⚠️ Не смог прибраться: ${e.message}`);
      }
    }
    const cats = await getDocCategories(env);
    const { total } = await searchDocs(env, { limit: 1 });
    const counts = await Promise.all(cats.map(async c => {
      const r = await searchDocs(env, { category: c, limit: 1 });
      return [c, r.total];
    }));
    const used = counts.filter(([, n]) => n > 0);
    // The id is what you need to pin DRIVE_ROOT_ID or to find the folder after
    // moving it, and there is nowhere else to read it off.
    let folder = '';
    try {
      const id = await driveRoot(env);
      folder = `\n\n[Папка архива](https://drive.google.com/drive/folders/${id})`
        + `\n\`DRIVE_ROOT_ID = "${id}"\``;
    } catch (e) {
      folder = `\n\n_Drive не отвечает: ${e.message}_`;
    }

    return void say(env, chatId,
      `*Архив документов* — ${total} шт.\n`
      + (used.length ? used.map(([c, n]) => `• ${c} — ${n}`).join('\n') : '_пока пусто_')
      + folder
      + `\n\n_Категории: ${cats.join(', ')}._`
      + '\n_Кинь файл или фото — разберу и разложу. «Найди анализы Ксении» — найду._'
      + '\n_`/docs fix` — слить папки-дубли, если они завелись._');
  }
  if (cmd === '/school') {
    if (text.includes('reset')) {
      await env.CHATS.delete('marks');
      return void say(env, chatId, 'Отметки в календаре очищены.');
    }
    const marks = await getMarks(env);
    if (!marks.length) {
      return void say(env, chatId,
        'Отметок нет. Скажи «в школе каникулы с 22 декабря по 7 января» — закрашу эти дни в календаре.');
    }
    return void say(env, chatId,
      `*Отметки в календаре:*\n${marks.map((m, i) => `${i + 1}. ${markLine(m)}`).join('\n')}\n\n`
      + '_«убери отметку N» чтобы удалить, /school reset — очистить всё._');
  }
  if (cmd === '/rules') {
    if (text.includes('reset')) {
      await env.CHATS.delete('rules');
      return void say(env, chatId, 'Правила сброшены на стандартные.');
    }
    const rules = await getRules(env);
    return void say(env, chatId,
      `*Правила бота:*\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
      '_Скажи или напиши «правило: …» чтобы добавить, «убери правило N» чтобы удалить._');
  }

  // In a group, who spoke matters — Claude needs it to resolve "я сделал".
  const speaker = msg.from?.first_name || 'unknown';
  const isGroup = msg.chat.type !== 'private';
  const userTurn = isGroup ? `[${speaker}]: ${text}` : text;

  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const { reply, touched } = await converse(env, chatId, userTurn);

    // «купи молоко» has served its purpose once the task exists; the reply says
    // what changed and links to it. Only when something was actually written,
    // though — a question like «что на сегодня?» is part of the conversation.
    const drop = env.DELETE_REQUESTS === 'true' && touched.size > 0;

    await say(env, chatId, (voice ? `🎤 _${text}_\n\n` : '') + reply, {
      // Quoting a message that is about to disappear leaves a reply pointing at
      // nothing, so skip the quote exactly when we are going to delete.
      reply_to_message_id: isGroup && !drop ? msg.message_id : undefined,
      ...taskButtons(touched),
    });

    if (drop) {
      // Needs can_delete_messages in a group. Nothing here is worth interrupting
      // the person over if it is missing — the task was still created.
      const del = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
      if (!del?.ok) console.warn('deleteMessage:', del?.description);
    }
  } catch (e) {
    console.error(e.stack);
    await say(env, chatId, `⚠️ ${e.message}`.slice(0, 500));
  }
}

// =============================================================== todoist ====
/**
 * Todoist has visible bad spells — slow responses and intermittent 502s — so
 * 429 and 5xx are retried, matching what claude() already did.
 *
 * The X-Request-Id is generated ONCE per call and reused across attempts. That
 * is what makes retrying a write safe: Todoist deduplicates on it, so a retried
 * add_task cannot create the task twice. (Regenerating it per attempt, as this
 * did before, made the header decorative.)
 */
async function todoist(env, path, { method = 'GET', body } = {}) {
  const reqId = crypto.randomUUID();
  let status = 0;
  let detail = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(TD + path, {
        method,
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
          ...(method !== 'GET' ? { 'X-Request-Id': reqId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {                                   // DNS / TLS / connection reset
      status = 0;
      detail = e.message;
      if (attempt === 2) break;
      await sleep(400 * 2 ** attempt);
      continue;
    }

    if (r.ok) return r.status === 204 ? null : r.json();

    status = r.status;
    detail = (await r.text()).slice(0, 300);
    if (status !== 429 && status < 500) break;      // 4xx is our bug, not theirs
    if (attempt === 2) break;
    const retryAfter = Number(r.headers.get('retry-after')) * 1000;
    await sleep(Math.min(retryAfter || 400 * 2 ** attempt, 5000));
  }

  console.error(`Todoist ${method} ${path} -> ${status} ${detail}`);
  // Keep the raw shape for our own mistakes; give people something human for theirs.
  if (status === 0 || status >= 500) {
    throw new Error('Todoist сейчас не отвечает. Попробуй ещё раз через минуту.');
  }
  throw new Error(`Todoist ${method} ${path} → ${status} ${detail}`);
}

async function listTasks(env) {
  const out = [];
  let cursor = null;
  // Cap pages: the free plan allows 50 subrequests per invocation in total.
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ project_id: env.TODOIST_PROJECT_ID, limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const res = await todoist(env, `/tasks?${q}`);
    out.push(...(res.results ?? res));
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

async function assertInProject(env, taskId) {
  const t = await todoist(env, `/tasks/${taskId}`);
  if (String(t.project_id) !== String(env.TODOIST_PROJECT_ID)) {
    throw new Error('Task is outside the allowed project — refused.');
  }
  return t;
}

/** Roster changes ~never. Cache it for a day so we skip a /sync round-trip. */
async function roster(env) {
  const key = `roster:${env.TODOIST_PROJECT_ID}`;
  const cached = await env.CHATS.get(key, 'json');
  if (cached) return cached;
  try {
    const r = await fetch(`${TD}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        sync_token: '*',
        resource_types: '["collaborators","collaborator_states"]',
      }),
    });
    const d = await r.json();
    const inProject = new Set(
      (d.collaborator_states || [])
        .filter(s => String(s.project_id) === String(env.TODOIST_PROJECT_ID))
        .map(s => String(s.user_id)),
    );
    const people = (d.collaborators || [])
      .filter(c => inProject.has(String(c.id)))
      .map(c => ({ id: String(c.id), name: c.full_name }));
    await env.CHATS.put(key, JSON.stringify(people), { expirationTtl: 86400 });
    return people;
  } catch { return []; }
}

// ================================================================= tools ====
const tools = [
  {
    name: 'add_task',
    description: 'Create a new task in the family project.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: "Task title, in the user's language." },
        due_string: { type: 'string', description: 'Due date in the user\'s own words, e.g. "завтра в 18:00", "cada lunes". Omit if none was mentioned.' },
        description: { type: 'string' },
        priority: { type: 'integer', description: '1 = normal … 4 = urgent' },
        labels: { type: 'array', items: { type: 'string' } },
        weekend: { type: 'boolean', description: 'True if this is something the family could DO on a free day — an outing, a place to visit, a restaurant, a trip, a show, a walk. Not errands, calls, paperwork or shopping, even at the weekend. Every Thursday these get sent to the chat as ideas.' },
        assignee_id: { type: 'string', description: 'Member id from the roster, if someone was named.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_task',
    description: 'Change title, due date, priority or assignee. Use this to postpone.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        content: { type: 'string' },
        due_string: { type: 'string', description: '"next friday", or "no date" to clear.' },
        priority: { type: 'integer' },
        weekend: { type: 'boolean', description: 'Add (true) or remove (false) the weekend-ideas mark. Use on «это на выходные» / «убери из выходных». Omit to leave it as it is.' },
        assignee_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete. Only when the user explicitly says delete/remove, not "done".',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'search_tasks',
    description: 'Look up tasks that were not in the visible list — e.g. far-future ones. Returns matches by keyword.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'add_house_rule',
    description: 'Save a new standing rule about how you should behave. Use when the person says "from now on…", "always…", "never…", "правило:", "запомни, что…". Not for one-off instructions.',
    input_schema: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: 'The rule as a short imperative sentence, in the language it was given.' },
      },
      required: ['rule'],
    },
  },
  {
    name: 'add_day_marks',
    description: 'Shade whole days on the family calendar. Currently only school closures: holidays, teacher days, and public holidays that shut the school. These are NOT tasks — never call add_task for them. A school publishes its year in one go, so pass every range from the message in a SINGLE call.',
    input_schema: {
      type: 'object',
      properties: {
        marks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['school-off'] },
              from: { type: 'string', description: 'First day as YYYY-MM-DD. Unlike task dates, you DO resolve this yourself — work the year out from today. A school year crosses New Year, so «с 22 декабря по 7 января» spans two different years.' },
              to: { type: 'string', description: 'Last day, inclusive, YYYY-MM-DD. Omit for a single day.' },
              note: { type: 'string', description: 'Short label, e.g. "каникулы", "Fiesta Nacional". Omit if the person gave none.' },
            },
            required: ['kind', 'from'],
          },
        },
      },
      required: ['marks'],
    },
  },
  {
    name: 'remove_day_mark',
    description: 'Delete a calendar mark by its number, as shown in the Calendar marks list.',
    input_schema: {
      type: 'object',
      properties: { number: { type: 'integer' } },
      required: ['number'],
    },
  },
  {
    name: 'add_doc_category',
    description: 'Add a category to the document archive. Use when a document has no sensible home in the current list — «заведи категорию для прав», or when you were about to file something as «прочее» and the person named what it is. Ask first if you are inventing the name yourself.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short, lowercase, plural, in Russian — «паспорта», «права», «квитанции».' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_documents',
    description: 'Search the family document archive in Google Drive — анализы, страховки, прописка, TIE, договоры, счета. Call this whenever someone asks to find, show or send a document. Returns titles, dates and a Drive link for each.',
    input_schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Whose document, e.g. «Ксения». Omit if nobody was named.' },
        category: { type: 'string', description: 'One of the archive categories, if the person named one.' },
        query: { type: 'string', description: 'Distinctive words from the title, e.g. «анализ крови». EVERY word must appear in the title, so pass only the ones that matter — not «найди мне последние».' },
        limit: { type: 'integer', description: 'How many to return. Default 5; pass 1 for «последний».' },
      },
    },
  },
  {
    name: 'read_documents',
    description: 'Open archived documents and answer a question about what is INSIDE them — lab values, policy numbers, expiry dates, dosages, names printed on a card. Use this whenever the question is about what a document SAYS rather than where it is: «какой был HDL у Антона», «все замеры холестерина за год», «когда истекает страховка», «какой номер полиса». find_documents only returns titles and links and cannot see inside. Pass on every document number and link it returns — a value the family cannot trace back to a document is useless.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to look for, in Russian, as specifically as the person asked — the exact analyte, field or number. Not «расскажи про анализы».' },
        person: { type: 'string', description: 'Whose documents, e.g. «Антон».' },
        category: { type: 'string', description: 'Narrow to one archive category — «анализы» for lab work. Do this whenever you can: it keeps unrelated documents out.' },
        query: { type: 'string', description: 'Distinctive words that must appear in the document TITLE. Leave empty when unsure — titles rarely mention individual measurements, and every word has to match.' },
        limit: { type: 'integer', description: 'How many documents to open, newest first. Default 5, max 6 — each one costs time.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'refile_document',
    description: 'Fix a document that was filed wrongly — move it to another category or person, correct its date or title. Use after «это не анализы, а страховка» or «это Ксении». Call find_documents first to get the id.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        category: { type: 'string' },
        person: { type: 'string', description: 'Empty string files it as a household document with no owner.' },
        date: { type: 'string', description: 'YYYY-MM-DD.' },
        title: { type: 'string' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'remove_house_rule',
    description: 'Delete a standing rule by its number, as shown in the House rules list.',
    input_schema: {
      type: 'object',
      properties: { number: { type: 'integer' } },
      required: ['number'],
    },
  },
];

async function runTool(env, name, args) {
  switch (name) {
    case 'add_task': {
      const t = await todoist(env, '/tasks', {
        method: 'POST',
        body: {
          project_id: env.TODOIST_PROJECT_ID,
          content: args.content,
          description: args.description,
          due_string: args.due_string,
          due_lang: args.due_string ? (env.TODOIST_DUE_LANG || 'ru') : undefined,
          priority: args.priority,
          labels: args.weekend
            ? [...new Set([...(args.labels || []), weekendLabel(env)])]
            : args.labels,
          responsible_uid: args.assignee_id,
        },
      });
      return { ok: true, task: compact(t) };
    }
    case 'update_task': {
      const cur = await assertInProject(env, args.task_id);

      // Todoist replaces the whole label array on write, so build the new set
      // from what the task actually carries rather than from what the model
      // remembers — otherwise every other label on it quietly disappears.
      let labels;
      if (args.weekend !== undefined) {
        const L = weekendLabel(env).toLowerCase();
        const kept = (cur.labels || []).filter(x => x.toLowerCase() !== L);
        labels = args.weekend ? [...kept, weekendLabel(env)] : kept;
      }

      const t = await todoist(env, `/tasks/${args.task_id}`, {
        method: 'POST',
        body: {
          content: args.content,
          due_string: args.due_string,
          due_lang: args.due_string ? (env.TODOIST_DUE_LANG || 'ru') : undefined,
          priority: args.priority,
          labels,
          responsible_uid: args.assignee_id,
        },
      });
      return { ok: true, task: compact(t) };
    }
    case 'complete_task': {
      const t = await assertInProject(env, args.task_id);
      await todoist(env, `/tasks/${args.task_id}/close`, { method: 'POST' });
      return { ok: true, completed: t.content };
    }
    case 'delete_task': {
      const t = await assertInProject(env, args.task_id);
      if (env.ALLOW_DELETE !== 'true') {
        await todoist(env, `/tasks/${args.task_id}/close`, { method: 'POST' });
        return { ok: true, note: 'Deletion disabled; completed instead.', task: t.content };
      }
      await todoist(env, `/tasks/${args.task_id}`, { method: 'DELETE' });
      return { ok: true, deleted: t.content };
    }
    case 'search_tasks': {
      const all = await listTasks(env);
      const q = args.query.toLowerCase();
      return { matches: all.filter(t => t.content.toLowerCase().includes(q)).map(compact).slice(0, 20) };
    }
    case 'add_house_rule': {
      const rules = await getRules(env);
      if (rules.length >= 25) return { error: 'Rule list is full (25). Remove one first.' };
      rules.push(args.rule.trim());
      await putRules(env, rules);
      return { ok: true, number: rules.length, rules };
    }
    case 'add_day_marks': {
      const today = localParts(env.TZ_NAME || 'Europe/Madrid').date;
      const existing = await getMarks(env);
      const added = [];
      const rejected = [];
      for (const raw of args.marks || []) {
        const { mark, error } = validateMark(raw);
        if (error) { rejected.push({ input: raw, error }); continue; }
        // Same kind and same span twice is a repeat, not a second closure.
        const dup = existing.some(m => m.kind === mark.kind && m.from === mark.from
          && (m.to || m.from) === (mark.to || mark.from));
        if (!dup) { existing.push(mark); added.push(mark); }
      }
      if (existing.length > MARK_LIMIT) {
        return { error: `Calendar mark list is full (${MARK_LIMIT}). Remove some first.` };
      }
      const marks = await putMarks(env, existing, today);
      return {
        ok: added.length > 0,
        added: added.map(markLine),
        ...(rejected.length ? { rejected } : {}),
        marks: marks.map((m, i) => `${i + 1}. ${markLine(m)}`),
      };
    }
    case 'remove_day_mark': {
      const today = localParts(env.TZ_NAME || 'Europe/Madrid').date;
      const marks = await getMarks(env);
      const i = args.number - 1;
      if (i < 0 || i >= marks.length) {
        return { error: `No mark ${args.number}. There are ${marks.length}.` };
      }
      const [gone] = marks.splice(i, 1);
      const kept = await putMarks(env, marks, today);
      return { ok: true, removed: markLine(gone), marks: kept.map((m, n) => `${n + 1}. ${markLine(m)}`) };
    }
    case 'add_doc_category': {
      const name = String(args.name || '').trim().toLowerCase().slice(0, 30);
      if (!name) return { error: 'Пустое название.' };
      const cats = await getDocCategories(env);
      if (cats.some(c => c.toLowerCase() === name)) {
        return { ok: true, note: `«${name}» уже есть.`, categories: cats };
      }
      if (cats.length >= 30) return { error: 'Категорий уже 30 — больше не поможет, а найти станет труднее.' };
      // «прочее» stays last: it is the fallback, and a list that ends in it
      // reads as "…or none of the above".
      const next = [...cats.filter(c => c !== 'прочее'), name,
        ...(cats.includes('прочее') ? ['прочее'] : [])];
      await env.CHATS.put('doccats', JSON.stringify(next));
      return { ok: true, categories: next };
    }
    case 'find_documents': {
      const cats = await getDocCategories(env);
      const category = args.category && cats.includes(args.category) ? args.category : undefined;
      const { total, docs } = await searchDocs(env, { ...args, category });
      if (!docs.length) {
        return { found: 0, note: 'Ничего не нашлось.', categories: cats,
          hint: 'Попробуй без query или с другой категорией.' };
      }
      return {
        found: total,
        showing: docs.length,
        documents: docs.map(d => ({
          id: d.id, title: d.title, date: d.date, person: d.person || null,
          category: d.category, link: d.link,
        })),
      };
    }
    case 'read_documents': {
      const cats = await getDocCategories(env);
      const category = args.category && cats.includes(args.category) ? args.category : undefined;
      const { total, docs } = await searchDocs(env, {
        person: args.person, category, query: args.query,
        limit: Math.min(Math.max(args.limit || 5, 1), MAX_READ_DOCS),
      });
      if (!docs.length) {
        return { found: 0, note: 'Под запрос ничего не нашлось — открывать нечего.',
          categories: cats,
          hint: 'query ищет по заголовку, а не по содержимому. Убери его и повтори.' };
      }
      return readDocuments(env, docs, args.question, total);
    }
    case 'refile_document': {
      const rec = await env.CHATS.get(`doc:${args.document_id}`, 'json');
      if (!rec) return { error: `Нет документа ${args.document_id}. Найди его через find_documents.` };

      const cats = await getDocCategories(env);
      if (args.category && !cats.includes(args.category)) {
        return { error: `Категория «${args.category}» не из списка: ${cats.join(', ')}` };
      }
      const next = {
        ...rec,
        category: args.category ?? rec.category,
        person: args.person !== undefined ? String(args.person).trim() : rec.person,
        date: /^\d{4}-\d{2}-\d{2}$/.test(args.date || '') ? args.date : rec.date,
        title: args.title ? String(args.title).trim().slice(0, 90) : rec.title,
      };

      const root = await driveRoot(env);
      const catDir = await driveFolder(env, next.category, root);
      const dir = next.person ? await driveFolder(env, next.person, catDir) : catDir;
      const name = `${next.date} — ${next.title}.${rec.ext || extFor(rec.fileName, rec.mimeType)}`
        .replace(/[/\\]/g, '-');
      const moved = await driveMove(env, rec.id, { name, parentId: dir, oldParentId: rec.folderId });

      next.folderId = dir;
      next.fileName = moved.name ?? name;
      next.link = moved.webViewLink ?? rec.link;
      await indexDoc(env, next);
      return { ok: true, document: { id: next.id, title: next.title, date: next.date,
        person: next.person || null, category: next.category, link: next.link } };
    }
    case 'remove_house_rule': {
      const rules = await getRules(env);
      const i = args.number - 1;
      if (i < 0 || i >= rules.length) return { error: `No rule ${args.number}. There are ${rules.length}.` };
      const [gone] = rules.splice(i, 1);
      await putRules(env, rules);
      return { ok: true, removed: gone, rules };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/**
 * One button per task created or changed this turn, so «купить молоко завтра»
 * comes back with a way straight to it.
 *
 * Capped at three: a turn that adds a shopping list of eight would otherwise
 * bury the reply under a keyboard taller than the message.
 */
function taskButtons(touched) {
  if (!touched?.size) return {};
  const rows = [...touched].slice(0, 3).map(([id, title]) => [{
    text: `📋 ${title.length > 28 ? title.slice(0, 27) + '…' : title}`,
    url: `${TD_APP}/task/${id}`,
  }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function compact(t) {
  return {
    id: t.id,
    content: t.content,
    due: t.due?.string ?? null,
    priority: t.priority,
    assignee: t.responsible_uid ?? null,
    labels: t.labels?.length ? t.labels : undefined,
  };
}

// =============================================== context assembly (layers) ==
/**
 * Only put tasks in the prompt that the user could plausibly mean right now.
 * Everything else stays reachable via the search_tasks tool.
 */
function relevantTasks(tasks, horizonDays = 21, cap = 70) {
  const now = Date.now();
  const horizon = now + horizonDays * 864e5;
  const dueTime = t => {
    const d = t.due?.date;
    if (!d) return null;
    return Date.parse(d.length === 10 ? `${d}T23:59:59Z` : d);
  };
  const scored = tasks.map(t => {
    const dt = dueTime(t);
    let bucket;
    if (dt === null) bucket = 2;              // undated — often the ones people mean
    else if (dt < now) bucket = 0;            // overdue — highest salience
    else if (dt <= horizon) bucket = 1;       // upcoming
    else bucket = 3;                          // far future — usually noise
    return { t, bucket, dt: dt ?? Infinity };
  });
  return scored
    .sort((a, b) => a.bucket - b.bucket || a.dt - b.dt)
    .filter(s => s.bucket !== 3)
    .slice(0, cap)
    .map(s => compact(s.t));
}

/** Seeded on first run; editable afterwards from Telegram by text or voice. */
const DEFAULT_RULES = [
  'Не ставь срок, если он не назван явно — задача без даты лучше, чем выдуманная дата.',
  '«Вечером», «на выходных», «завтра» — это явные сроки, передавай их как есть.',
  'Приоритет по умолчанию обычный. p4 ставь только если сказано «срочно» или «горит».',
  'Формулируй задачу коротко и с глаголом: «купить молоко», а не «молоко надо купить».',
  'Перед созданием проверь список: если похожая задача уже есть, обнови её срок вместо новой.',
  'Если названо имя члена семьи — назначь задачу на него.',
  'Голосовые часто содержат оговорки и «эээ» — вытаскивай смысл, не переноси мусор в название.',
];

// =========================================================== google drive ===
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google access tokens live an hour; the refresh token is the long-lived secret
 * and never leaves the Worker. Cache the access token so a burst of uploads
 * costs one token exchange, and retire ours early so an upload that started
 * just before expiry cannot finish with a dead one.
 */
async function driveToken(env) {
  const cached = await env.CHATS.get('gdrive:token');
  if (cached) return cached;

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    // invalid_grant means the refresh token was revoked or aged out — that
    // needs a human, so say which of the two it is rather than "Drive failed".
    const why = d.error === 'invalid_grant'
      ? 'refresh-токен Google отозван или истёк — нужно перевыпустить (npm run google:auth)'
      : `Google OAuth ${r.status}: ${JSON.stringify(d).slice(0, 200)}`;
    throw new Error(why);
  }
  await env.CHATS.put('gdrive:token', d.access_token,
    { expirationTtl: Math.max(60, (d.expires_in || 3600) - 300) });
  return d.access_token;
}

async function drive(env, path, { method = 'GET', body } = {}) {
  const token = await driveToken(env);
  const r = await fetch(DRIVE_API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Drive ${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

/** Drive query strings are single-quoted; a name with an apostrophe would end one. */
const driveQuote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Folders of one name under a parent, oldest first. */
async function findFolders(env, name, parentId) {
  const q = `name = '${driveQuote(name)}' and '${driveQuote(parentId)}' in parents`
    + ` and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const r = await drive(env, `/files?q=${encodeURIComponent(q)}`
    + '&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=20');
  return r.files || [];
}

/**
 * Find or create a folder under `parentId`, caching the id for a month.
 *
 * Two uploads arriving together — a burst of files in the chat is several
 * separate webhooks, so several Worker invocations at once — both miss the
 * cache, both find nothing, and both create the folder. That is how the archive
 * grew several «анализы» side by side.
 *
 * Two things stop it. Lookups take the OLDEST match rather than any match, so
 * everyone converges on the same folder even while duplicates exist; and after
 * creating one we look again, and if somebody else's folder is older we bin
 * ours — it is empty, we just made it — and use theirs. Whatever still slips
 * through is swept up by /docs fix.
 */
async function driveFolder(env, name, parentId) {
  const key = `gdrive:dir:${parentId}:${name}`;
  const hit = await env.CHATS.get(key);
  if (hit) return hit;

  const remember = async id => {
    await env.CHATS.put(key, id, { expirationTtl: 2592000 });
    return id;
  };

  const found = await findFolders(env, name, parentId);
  if (found.length) return remember(found[0].id);

  const mine = (await drive(env, '/files?fields=id', {
    method: 'POST',
    body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
  })).id;

  const after = await findFolders(env, name, parentId);
  const winner = after[0]?.id ?? mine;
  if (winner !== mine) {
    // Lost the race. Ours is empty and one second old; trash it rather than
    // leave a twin behind.
    await drive(env, `/files/${mine}`, { method: 'PATCH', body: { trashed: true } })
      .catch(e => console.warn('race cleanup:', e.message));
  }
  return remember(winner);
}

/**
 * The archive root.
 *
 * By default the bot creates it, because `drive.file` only reaches files this
 * app made — a folder someone made by hand in the Drive UI is invisible to it,
 * and writing into one by id comes back 404.
 *
 * DRIVE_ROOT_ID pins it instead. That matters once the folder has been dragged
 * somewhere — into a shared folder, say, so the family inherits access. The app
 * keeps its own folder wherever it ends up, but the lookup below searches the
 * Drive root by name and would quietly start a second archive there. An id does
 * not move.
 */
function driveRoot(env) {
  const pinned = (env.DRIVE_ROOT_ID || '').trim();
  if (pinned && pinned !== 'REPLACE_ME') return Promise.resolve(pinned);
  return driveFolder(env, env.DRIVE_ROOT_NAME || 'Документы семьи', 'root');
}

/**
 * Resumable upload: one request for a session URL, one for the bytes.
 * Multipart would be a single request but caps at 5 MB, and Telegram hands us
 * up to 20.
 */
async function driveUpload(env, { name, mimeType, parentId, bytes }) {
  const token = await driveToken(env);
  const start = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(bytes.byteLength),
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  if (!start.ok) {
    throw new Error(`Drive upload session → ${start.status} ${(await start.text()).slice(0, 200)}`);
  }
  const session = start.headers.get('location');
  if (!session) throw new Error('Drive returned no upload session URL.');

  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'content-type': mimeType },
    body: bytes,
  });
  if (!put.ok) throw new Error(`Drive upload → ${put.status} ${(await put.text()).slice(0, 200)}`);
  return put.json();
}

/** Rename and/or move a file that was filed under the wrong heading. */
async function driveMove(env, fileId, { name, parentId, oldParentId }) {
  const q = new URLSearchParams({ fields: 'id,name,webViewLink' });
  if (parentId && parentId !== oldParentId) {
    q.set('addParents', parentId);
    q.set('removeParents', oldParentId);
  }
  return drive(env, `/files/${fileId}?${q}`, { method: 'PATCH', body: name ? { name } : {} });
}

// ================================================ document archive (drive) ===
/**
 * Throw a scan or a photo at the bot; it works out what the document is, files
 * it into Drive under <категория>/<человек>/ and remembers enough to find it
 * again later.
 *
 * Categories are a controlled list on purpose. Asked freely every time, a model
 * will produce «анализы» today and «медицина» next month, and the archive stops
 * being searchable. People are the opposite — a family gains names the roster
 * never had — so those stay free text, with the names already used shown to the
 * model so it reuses a spelling instead of inventing one.
 */
const DEFAULT_DOC_CATEGORIES = [
  'паспорта', 'TIE', 'прописка', 'анализы', 'страховка',
  'договоры', 'счета', 'школа', 'прочее',
];

// Telegram will not let a bot download more than this, whatever the plan.
const MAX_DOC_BYTES = 20 * 1024 * 1024;
// Base64 inflates by a third, and the Anthropic request cap is 32 MB. Past this
// the file still gets filed — just classified from its name and caption alone.
const MAX_VISION_BYTES = 14 * 1024 * 1024;

/**
 * What Claude can actually be shown. Everything else is still stored — a family
 * archive that refuses the school's xlsx is not an archive — but it gets filed
 * from its name and caption rather than its contents.
 */
const VIEWABLE_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Small enough to paste into the prompt verbatim instead of attaching. */
const TEXT_MIME = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
const MAX_INLINE_TEXT = 100_000;

/** Fallback extension when the file name has none of its own. */
const EXT_BY_MIME = {
  ...VIEWABLE_MIME,
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/rtf': 'rtf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/**
 * Trust the file's own extension first: Telegram reports whatever the sending
 * client claimed, and an .xlsx arriving as application/octet-stream is common.
 */
function extFor(fileName, mimeType) {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(fileName || '')?.[1];
  return (fromName || EXT_BY_MIME[mimeType] || 'bin').toLowerCase();
}

async function getDocCategories(env) {
  const stored = await env.CHATS.get('doccats', 'json');
  return Array.isArray(stored) && stored.length ? stored : DEFAULT_DOC_CATEGORIES.slice();
}

/** Names already used, so the model reuses «Ксения» instead of coining «ксюша». */
async function knownPeople(env) {
  const seen = new Set();
  let cursor;
  do {
    const page = await env.CHATS.list({ prefix: 'doc:', cursor, limit: 1000 });
    for (const k of page.keys) if (k.metadata?.p) seen.add(k.metadata.p);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return [...seen];
}

/** btoa() over a 20 MB string blows the stack; feed it in chunks. */
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

const FILE_DOC_TOOL = {
  name: 'file_document',
  description: 'Report what this document is so it can be filed.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Exactly one value from the allowed list.' },
      person: { type: 'string', description: 'Who the document is about, in the nominative case («Ксения», «Майя»). Reuse a name from the known list when it is the same person. Omit for a household document that belongs to nobody in particular.' },
      date: { type: 'string', description: 'The date ON the document (issued, drawn, valid from) as YYYY-MM-DD. Omit if the document shows none — do not substitute today.' },
      title: { type: 'string', description: 'Short human title in Russian, lowercase unless a proper noun, e.g. «общий анализ крови», «полис Sanitas», «empadronamiento». No dates, no person name — those are stored separately.' },
      confident: { type: 'boolean', description: 'False if the document is unreadable or you are guessing.' },
    },
    required: ['category', 'title', 'confident'],
  },
};

/**
 * One dedicated call, not the conversational one: the reply must be a filled-in
 * schema, and a 20 MB attachment has no business entering the chat history.
 *
 * Thinking is off because forced tool choice and extended thinking cannot be
 * combined — and with the schema forced there is nothing to reason about.
 */
async function classifyDocument(env, { bytes, mimeType, fileName, caption, cats, people, today }) {
  const content = [];
  let blind = '';

  if (!bytes) {
    blind = '';
  } else if (VIEWABLE_MIME[mimeType]) {
    if (bytes.byteLength <= MAX_VISION_BYTES) {
      content.push(mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: toBase64(bytes) } }
        : { type: 'image', source: { type: 'base64', media_type: mimeType, data: toBase64(bytes) } });
    } else {
      blind = 'Файл слишком большой, чтобы его показать — суди по имени и подписи.';
    }
  } else if (TEXT_MIME.has(mimeType) && bytes.byteLength <= MAX_INLINE_TEXT) {
    // Plain text needs no attachment machinery; paste it and it is readable.
    content.push({ type: 'text', text: `Содержимое файла:\n${new TextDecoder().decode(bytes)}` });
  } else {
    blind = `Формат ${mimeType} я открыть не могу — суди по имени файла и подписи.`;
  }

  content.push({
    type: 'text',
    text: [
      'Определи, что это за документ, и вызови file_document.',
      fileName ? `Имя файла: ${fileName}` : '',
      caption ? `Подпись от человека (она важнее того, что ты видишь в файле): ${caption}` : '',
      blind,
    ].filter(Boolean).join('\n'),
  });

  const system = `Ты разбираешь семейный архив документов.
Сегодня ${today}.

Категории — выбери РОВНО ОДНУ из списка, ничего своего:
${cats.map(c => `- ${c}`).join('\n')}
Если ничего не подходит — «прочее».

Имена, которые уже встречались (используй ту же форму, если это тот же человек):
${people.length ? people.map(p => `- ${p}`).join('\n') : '(пока никого)'}

Даты: бери ту, что напечатана в документе — дату выдачи, забора анализа, начала действия. Если её нет, не подставляй сегодняшнюю, просто не заполняй поле.`;

  const res = await claude(env, system, [{ role: 'user', content }], {
    tools: [FILE_DOC_TOOL],
    tool_choice: { type: 'tool', name: 'file_document' },
    thinking: { type: 'disabled' },
    max_tokens: 1024,
  });

  const call = res.content?.find(b => b.type === 'tool_use');
  if (!call) throw new Error('Claude не вернул разбор документа.');
  return call.input;
}

// How many documents one question may open, and how many bytes of them may go
// into a single Anthropic request. The Worker gets 50 subrequests per
// invocation and a conversation has already spent some; the byte budget keeps
// the base64 well under the 32 MB request cap and out of the Worker's memory
// ceiling.
const MAX_READ_DOCS = 6;
const MAX_READ_BYTES = 12 * 1024 * 1024;

/**
 * Answer a question from what is *inside* archived documents.
 *
 * The index holds only category, person, date and title — the contents were
 * never stored — so a question about a lab value or an expiry date has to open
 * the files. They come back from Drive, go to Claude as attachments, and the
 * answer carries document numbers that the caller turns back into links.
 *
 * Reading on demand rather than extracting at intake is a deliberate first cut:
 * it works on everything already filed, and it does not need a schema of
 * analyte names kept canonical across two languages and every lab's spelling.
 * The cost is that each question re-reads the files.
 */
async function readDocuments(env, docs, question, matched) {
  const token = await driveToken(env);
  const skipped = [];
  const read = [];
  const content = [];
  let budget = MAX_READ_BYTES;

  // Oldest first: a question about a value over time should read as a series.
  const ordered = docs.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  for (const d of ordered) {
    if (!VIEWABLE_MIME[d.mimeType]) {
      skipped.push({ ...d, why: `${d.ext || 'формат'} нельзя открыть` });
      continue;
    }
    if ((d.size || 0) > budget) { skipped.push({ ...d, why: 'не поместился' }); continue; }

    const r = await fetch(`${DRIVE_API}/files/${d.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) { skipped.push({ ...d, why: `Drive ${r.status}` }); continue; }

    const bytes = await r.arrayBuffer();
    budget -= bytes.byteLength;
    const n = read.length + 1;
    content.push({ type: 'text', text: `Документ ${n}: ${d.date} · ${d.title}`
      + (d.person ? ` · ${d.person}` : '') + ` · ${d.category}` });
    content.push(VIEWABLE_MIME[d.mimeType] === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: d.mimeType, data: toBase64(bytes) } }
      : { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: toBase64(bytes) } });
    read.push({ n, id: d.id, title: d.title, date: d.date, person: d.person || null, link: d.link });
  }

  if (!read.length) {
    return { answer: null, error: 'Ни один документ не удалось открыть.', skipped };
  }

  content.push({ type: 'text', text: `Вопрос: ${question}` });

  const res = await claude(env, `Ты читаешь документы семьи и отвечаешь строго по тому, что в них напечатано.

- Отвечай только тем, что действительно видишь. Не нашёл — так и скажи прямо, не додумывай.
- К КАЖДОМУ числу добавляй номер документа, откуда оно: «HDL 1.42 ммоль/л (документ 2)». Число без источника бесполезно — его нельзя перепроверить.
- Если показатель есть в нескольких документах, перечисли все значения с датами по возрастанию, чтобы была видна динамика.
- Приводи единицы измерения и референсный интервал, если они напечатаны.
- Ты не ставишь диагнозов и не даёшь медицинских рекомендаций — только то, что написано в документе, включая пометки самой лаборатории о выходе за норму.
- Коротко. Без вступлений.`,
    [{ role: 'user', content }],
    { tools: undefined, tool_choice: undefined, max_tokens: 4000 });

  const answer = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return {
    answer: answer || 'Не удалось ничего прочитать.',
    read,
    matched,
    ...(skipped.length ? { skipped: skipped.map(d => `${d.date} · ${d.title} — ${d.why}`) } : {}),
  };
}

/**
 * Sweep up duplicate folders: move everything into the oldest of each name and
 * bin the empties.
 *
 * Needed because the race above was live for a while, and because no amount of
 * care at write time fully closes a read-then-create window against a service
 * that has no atomic "create if absent".
 *
 * Bounded by a subrequest budget — a Worker invocation gets 50 on the free plan
 * — and reports whether more is left, so /docs fix can simply be run again.
 */
async function repairArchive(env, budget = 30) {
  let calls = 0;
  let ranOut = false;
  const spend = () => { if (calls >= budget) { ranOut = true; return false; } calls++; return true; };

  const root = await driveRoot(env);
  const remap = new Map();          // trashed folder id -> the one that survived
  const merged = [];
  let movedFiles = 0;

  const childrenOf = async (parentId, foldersOnly) => {
    const q = `'${driveQuote(parentId)}' in parents and trashed = false`
      + (foldersOnly ? ` and mimeType = '${FOLDER_MIME}'` : '');
    const r = await drive(env, `/files?q=${encodeURIComponent(q)}`
      + '&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=200');
    return r.files || [];
  };

  /** Merge same-named folders under one parent; returns the survivors. */
  async function mergeUnder(parentId, where) {
    if (!spend()) return [];
    const byName = new Map();
    for (const f of await childrenOf(parentId, true)) {
      const k = f.name.trim().toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(f);          // orderBy=createdTime, so oldest first
    }

    const keepers = [];
    for (const group of byName.values()) {
      const [keep, ...dupes] = group;
      keepers.push(keep);

      for (const dup of dupes) {
        if (!spend()) return keepers;
        const kids = await childrenOf(dup.id, false);

        let emptied = true;
        for (const kid of kids) {
          if (!spend()) { emptied = false; break; }
          await drive(env, `/files/${kid.id}?addParents=${keep.id}`
            + `&removeParents=${dup.id}&fields=id`, { method: 'PATCH', body: {} });
          movedFiles++;
        }
        remap.set(dup.id, keep.id);
        if (!emptied) return keepers;

        if (!spend()) return keepers;
        await drive(env, `/files/${dup.id}`, { method: 'PATCH', body: { trashed: true } });
        merged.push(`${where}${keep.name}`);
      }
    }
    return keepers;
  }

  const cats = await mergeUnder(root, '');
  for (const c of cats) {
    if (ranOut) break;
    await mergeUnder(c.id, `${c.name}/`);
  }

  // Point the index at the folders that survived. KV operations are not
  // subrequests, so this part is not on the budget.
  let repointed = 0;
  for (let cursor; ;) {
    const page = await env.CHATS.list({ prefix: 'doc:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const rec = await env.CHATS.get(k.name, 'json');
      if (rec && remap.has(rec.folderId)) {
        rec.folderId = remap.get(rec.folderId);
        await indexDoc(env, rec);
        repointed++;
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  // The folder cache may name something we just binned.
  for (let cursor; ;) {
    const page = await env.CHATS.list({ prefix: 'gdrive:dir:', cursor, limit: 1000 });
    for (const k of page.keys) await env.CHATS.delete(k.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  console.log(`repair: merged ${merged.length} folders, moved ${movedFiles} files,`
    + ` repointed ${repointed}, more=${ranOut}`);
  return { merged, movedFiles, repointed, more: ranOut };
}

/** Index entry. Metadata rides on the KV key so search never reads values. */
async function indexDoc(env, rec) {
  await env.CHATS.put(`doc:${rec.id}`, JSON.stringify(rec), {
    // KV caps key metadata at 1 KB; short field names and a clipped title keep
    // a Cyrillic record well inside it.
    metadata: { c: rec.category, p: rec.person || '', d: rec.date || '', t: rec.title.slice(0, 90) },
  });
}

/**
 * Search the archive. One KV list walks the metadata; only the handful of
 * records actually returned are read in full.
 */
async function searchDocs(env, { category, person, query, limit = 5 } = {}) {
  const needle = (query || '').toLowerCase().trim();
  const words = needle ? needle.split(/\s+/) : [];
  const hits = [];

  let cursor;
  do {
    const page = await env.CHATS.list({ prefix: 'doc:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const m = k.metadata || {};
      if (category && m.c !== category) continue;
      if (person && (m.p || '').toLowerCase() !== person.toLowerCase()) continue;
      // Every word must appear somewhere — «анализ крови» should not match every
      // анализ in the archive just because one word landed.
      const hay = `${m.t || ''} ${m.c || ''} ${m.p || ''}`.toLowerCase();
      if (words.length && !words.every(w => hay.includes(w))) continue;
      hits.push({ key: k.name, date: m.d || '' });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  // Newest first — "последние анализы" is the question people actually ask.
  hits.sort((a, b) => b.date.localeCompare(a.date));
  const top = hits.slice(0, Math.min(Math.max(limit, 1), 20));
  const recs = await Promise.all(top.map(h => env.CHATS.get(h.key, 'json')));
  return { total: hits.length, docs: recs.filter(Boolean) };
}

const docLine = d => `${d.date || '—'} · ${d.title}`
  + `${d.person ? ` · ${d.person}` : ''} · ${d.category}`;

/**
 * The whole intake: download from Telegram, work out what it is, put it in
 * Drive, index it, and say what happened.
 */
async function fileIncomingDocument(env, chatId, file, caption, speaker) {
  if (!env.GOOGLE_REFRESH_TOKEN) {
    return void say(env, chatId,
      'Архив документов ещё не подключён к Google Drive — нужен разовый вход '
      + '(npm run google:auth). Файл я не сохранил.');
  }
  const mimeType = file.mime_type || 'application/octet-stream';
  // No format is turned away any more. Refusing an .xlsx the school sent, on the
  // grounds that Claude cannot read it, loses the document to save the labelling
  // — so it gets stored either way and labelled from its name and caption.
  if ((file.file_size || 0) > MAX_DOC_BYTES) {
    return void say(env, chatId,
      `Файл ${Math.round(file.file_size / 1048576)} МБ — Telegram не отдаёт ботам больше 20 МБ.`);
  }

  const info = await (await fetch(`${tgBase(env)}/getFile?file_id=${file.file_id}`)).json();
  if (!info?.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile: ${info?.description ?? 'нет file_path'}`);
  }
  const bytes = await (await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`,
  )).arrayBuffer();

  const today = localParts(env.TZ_NAME || 'Europe/Madrid').date;
  const [cats, people] = await Promise.all([getDocCategories(env), knownPeople(env)]);
  const guess = await classifyDocument(env, {
    bytes, mimeType, fileName: file.file_name, caption, cats, people, today,
  });

  // The model is told to pick from the list, but a filed document that lands in
  // an invented category is invisible to every later search — so verify.
  const category = cats.includes(guess.category) ? guess.category : 'прочее';
  const person = (guess.person || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(guess.date || '') ? guess.date : today;
  const title = (guess.title || 'документ').trim().slice(0, 90);

  const root = await driveRoot(env);
  const catDir = await driveFolder(env, category, root);
  const dir = person ? await driveFolder(env, person, catDir) : catDir;

  const ext = extFor(file.file_name, mimeType);
  const name = `${date} — ${title}.${ext}`.replace(/[/\\]/g, '-');
  const up = await driveUpload(env, { name, mimeType, parentId: dir, bytes });

  const rec = {
    id: up.id,
    category, person, date, title,
    link: up.webViewLink,
    fileName: up.name,
    folderId: dir,
    mimeType,
    ext,
    size: bytes.byteLength,
    addedAt: new Date().toISOString(),
    addedBy: speaker || null,
  };
  await indexDoc(env, rec);
  console.log(`doc: filed ${category}/${person || '—'}/${name} (${bytes.byteLength}b)`);

  // The next turn in this chat is very likely about this document — «это анализ
  // Антона», «это не анализы». Leave a pointer so the model has an id to correct
  // rather than having to search for one.
  await env.CHATS.put(`lastdoc:${chatId}`, rec.id, { expirationTtl: 21600 });

  const where = `${category}${person ? ` / ${person}` : ''}`;
  // File first, ask second. A document nobody claimed is still safer in Drive
  // than held hostage to a question that may never get answered.
  // Say when the label came from the name alone — otherwise a wrong category on
  // an .xlsx looks like the bot read it and got it wrong.
  const unread = !VIEWABLE_MIME[mimeType] && !TEXT_MIME.has(mimeType)
    ? `\n\n<i>Внутрь ${escapeHtml(ext)} заглянуть не могу — разложил по имени файла`
      + `${caption ? ' и подписи' : ''}. Поправь, если не туда.</i>`
    : '';

  const ask = !person
    ? '\n\n<i>Чей это документ? Ответь именем — переложу в его папку.</i>'
    : guess.confident === false
      ? '\n\n<i>Не уверен, что разобрал верно — поправь, если не то.</i>'
      : '';

  await say(env, chatId,
    `📄 <b>${escapeHtml(title)}</b>\n${escapeHtml(where)} · ${escapeHtml(date)}${unread}${ask}`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '📂 Открыть в Drive', url: up.webViewLink }]] },
    });
}

// ========================================================= calendar marks ===
/**
 * Whole-day facts that are not tasks: days the school is closed, and whatever
 * else the family wants shaded on the calendar later.
 *
 * Kept as date ranges in KV rather than as Todoist tasks. They cannot be
 * "done", have no assignee and live in blocks — two weeks of Christmas
 * holidays is one row here and would be fourteen tasks there, each of which
 * the digest would announce and the undated nudge could pick up.
 *
 * The colour lives in code, not in KV: storing it would mean rewriting stored
 * data to restyle the calendar.
 */
const MARK_KINDS = {
  // Two hexes because one cannot serve both cards: the amber that reads as a
  // warm cream on white turns olive at the alpha a near-black card needs.
  'school-off': { label: 'Нет школы', color: '#e5a50a', colorDark: '#f5c451' },
};

const MARK_LIMIT = 200;          // a decade of school years
const MARK_MAX_DAYS = 120;       // Spanish summer break is ~75; longer means a misparse

const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Date arithmetic on YYYY-MM-DD via UTC noon, so no zone or DST can shift it. */
function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

async function getMarks(env) {
  const stored = await env.CHATS.get('marks', 'json');
  return Array.isArray(stored) ? stored : [];
}

/**
 * Ranges are absolute dates, so without pruning the list grows by a school
 * year every year. Anything that ended over two months ago is history.
 */
async function putMarks(env, marks, today) {
  const cutoff = shiftDate(today, -60);
  const kept = marks
    .filter(m => (m.to || m.from) >= cutoff)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  await env.CHATS.put('marks', JSON.stringify(kept));
  return kept;
}

/** Normalise one mark from the model, or explain why it is unusable. */
function validateMark(m) {
  if (!m || !MARK_KINDS[m.kind]) {
    return { error: `kind must be one of ${Object.keys(MARK_KINDS).join(', ')}` };
  }
  if (!isDate(m.from)) return { error: `"from" must be YYYY-MM-DD, got ${JSON.stringify(m.from)}` };
  const to = m.to == null || m.to === '' ? m.from : m.to;
  if (!isDate(to)) return { error: `"to" must be YYYY-MM-DD, got ${JSON.stringify(m.to)}` };
  if (to < m.from) return { error: `"to" (${to}) is before "from" (${m.from})` };
  const span = daysBetween(m.from, to) + 1;
  if (span > MARK_MAX_DAYS) {
    return { error: `${m.from}…${to} spans ${span} days — check the year, that looks like a misparse` };
  }
  const out = { kind: m.kind, from: m.from };
  if (to !== m.from) out.to = to;
  const note = (m.note || '').trim();
  if (note) out.note = note.slice(0, 60);
  return { mark: out };
}

/** "22 дек — 7 янв · каникулы" for the /school listing and the model's context. */
function markLine(m) {
  const range = m.to ? `${shortDate(m.from)} — ${shortDate(m.to)}` : shortDate(m.from);
  return `${range} · ${MARK_KINDS[m.kind]?.label ?? m.kind}${m.note ? ` (${m.note})` : ''}`;
}

async function getRules(env) {
  const stored = await env.CHATS.get('rules', 'json');
  return stored ?? DEFAULT_RULES.slice();
}
async function putRules(env, rules) {
  await env.CHATS.put('rules', JSON.stringify(rules));
}

function systemPrompt(env, tasks, people, hidden, rules, marks, cats, lastDoc) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  const lead = Number(env.ALERT_LEAD_MIN || 5);
  return `You are the household task assistant for a family. You operate on exactly ONE Todoist project — every task you create goes there automatically, and you cannot touch anything outside it.
Now: ${new Date().toLocaleString('en-GB', { timeZone: tz })} (${tz}).

How you work (fixed):
- Turn what the person says into tool calls. Don't ask permission for ordinary adds, postpones or completions — just do them.
- One message may hold several instructions; handle all of them.
- Pass dates through verbatim in due_string, in the person's own words. Todoist parses natural language itself — never compute a date yourself.
- "done / сделал / listo" → complete_task. "delete / удали / borra" → delete_task.
- Messages in a group are prefixed with [Name]. Use that to resolve "мне", "я сделал", and to pick an assignee.
- If a task isn't in the list below, call search_tasks before saying it doesn't exist.
- If a reference is truly ambiguous, ask one short question instead of guessing.
- Not every message is a task. If someone is just chatting, reply briefly and call no tools.

Reminders — raised priority IS the reminder:
- A background job alerts this chat ${lead} minutes before any task whose priority is 2 or higher AND that has a specific time. There is no separate reminder object; priority is the switch.
- Treat as a reminder request: «напомни», «напоминание», «не забудь», «не дай забыть», «поставь будильник», «recuérdame», or the person calling something важно / срочно / important / urgente.
- On such a request set priority — 4 for «срочно», «горит», «urgente»; 3 for «важно», «important»; 2 otherwise — and make sure the task has a TIME, not just a day.
- A task with only a day and no time never alerts. If a reminder was asked for but no time was given, still create or update the task with the raised priority FIRST — never withhold the task while waiting for an answer — and then ask for the time in one short question so the alert can be armed. Do not invent a time yourself.
- If a task already exists and someone asks to be reminded about it, raise its priority with update_task and add a time — do not create a duplicate.
- When you set a reminder, say so and state when the alert will arrive, e.g. «Напомню в 17:55».
- Weekend ideas: when a task is something the family could DO on a free day — «сходить в Прадо», «съездить в Сеговию», «попробовать ту кофейню», концерт, поход, выставка — set weekend: true on add_task. Errands, calls, paperwork and shopping are not, even if they happen on a Saturday. Every Thursday evening the marked ones are posted to the chat as ideas. «Это на выходные» / «убери из выходных» about an existing task is update_task with weekend true/false. Do not mention the mark in your reply unless asked — just set it.
- When the person states a standing preference ("always…", "never…", "с этого момента…", "правило:"), call add_house_rule instead of just agreeing.
- If a document has no sensible category and «прочее» would be a shrug — паспорт, права, квитанция — call add_doc_category and then refile_document into it, rather than leaving it in «прочее». One new category is better than a drawer labelled "misc".
- Documents file themselves: a photo or a file is classified and put in Drive before you ever see the turn, so never offer to file one. That does NOT mean messages about documents are none of your business — the opposite. Anything said about the document that was just filed is addressed to you: «это анализ Антона», «это Ксении», «это не анализы, а страховка», «это от 5 мая», or a bare name in reply to your question about whose it is. Call refile_document with the id shown under "Последний документ" below. Never answer that such messages are not for you.
- Two different tools for documents, and picking the wrong one wastes the turn. WHERE something is → find_documents, which returns titles and links only. WHAT IS WRITTEN in it → read_documents, which actually opens the files: «какой был HDL у Антона», «все замеры холестерина», «когда истекает страховка», «какая доза». If the question names a value, a number or a date printed inside a document, it is read_documents.
- read_documents answers with «(документ 2)» markers. Replace each one with a link to that document from the "read" list it returned — a number the family cannot trace back to its source is worse than no number. Never state a medical value without its link, and never add an interpretation of your own on top of what the document says.
- To fix a document filed wrongly, find_documents first, then refile_document.
- School closures — каникулы, «нет школы», teacher days, a public holiday that shuts the school — are whole-day facts, not tasks. Call add_day_marks, never add_task. This is the one place you DO work out calendar dates yourself: pass ISO YYYY-MM-DD and resolve the year from today, remembering a school year crosses New Year. Put every range from one message into one call.
- Reply in the language the person wrote in, one or two lines, stating only what changed. No preamble.
- Never paste a Todoist link into your text. Every task you add or change already gets a button under the reply — a link written out as well is noise, and task titles break Markdown.

House rules (set by the family; follow them unless they conflict with the fixed behaviour above):
${rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none set)'}

Document archive categories (find_documents accepts only these):
${cats.length ? cats.join(', ') : '(none)'}

Последний документ, загруженный в этот чат — если следующее сообщение о нём, это его id:
${lastDoc ? `${lastDoc.id} | ${lastDoc.date} · ${lastDoc.title} · ${lastDoc.category}`
    + `${lastDoc.person ? ` · ${lastDoc.person}` : ' · ЧЕЛОВЕК НЕ УКАЗАН — если назовут имя, это ответ на вопрос, чей он'}`
  : '(ничего не загружали)'}

Calendar marks — whole days shaded on the shared calendar, not tasks:
${marks.length ? marks.map((m, i) => `${i + 1}. ${markLine(m)}`).join('\n') : '(none set)'}

Members:
${people.length ? people.map(p => `- ${p.name} (id ${p.id})`).join('\n') : '- (personal project, no members)'}

Open tasks — overdue first, then upcoming, then undated (id | title | due):
${tasks.length ? tasks.map(t => `${t.id} | ${t.content} | ${t.due ?? '—'}`
    + `${t.labels?.length ? ` | ${t.labels.join(', ')}` : ''}`).join('\n') : '(none)'}
${hidden > 0 ? `\n(${hidden} further tasks are dated beyond the horizon and not shown — use search_tasks to reach them.)` : ''}`;
}

// ================================================================ claude ====
async function converse(env, chatId, userTurn) {
  const [all, people, history, rules, marks, cats, lastDocId] = await Promise.all([
    listTasks(env),
    roster(env),
    env.CHATS.get(`hist:${chatId}`, 'json'),
    getRules(env),
    getMarks(env),
    getDocCategories(env),
    env.CHATS.get(`lastdoc:${chatId}`),
  ]);

  const visible = relevantTasks(all);
  const system = systemPrompt(env, visible, people, all.length - visible.length, rules, marks, cats,
    lastDocId ? await env.CHATS.get(`doc:${lastDocId}`, 'json') : null);
  const messages = [...(history?.messages ?? []), { role: 'user', content: userTurn }];

  // Tasks created or changed this turn, id -> title. A Map so the same task
  // touched twice ("добавь" then "и поставь срок") yields one button.
  const touched = new Map();

  for (let hop = 0; hop < 5; hop++) {
    const res = await claude(env, system, messages);

    if (res.stop_reason === 'refusal') {
      return { reply: 'Не могу это выполнить.', touched };
    }

    // Echo the assistant turn back verbatim — thinking blocks included. They
    // must survive the tool round-trip unchanged or the next call 400s.
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      await saveHistory(env, chatId, messages);
      return { reply: reply || 'Готово.', touched };
    }

    const results = [];
    for (const block of res.content.filter(b => b.type === 'tool_use')) {
      let out;
      try { out = await runTool(env, block.name, block.input); }
      catch (e) { out = { error: String(e.message).slice(0, 300) }; }
      console.log('tool', block.name, JSON.stringify(block.input));
      // A button beats a link in the text: task titles routinely contain _ * [ ],
      // which breaks Markdown, and say() then falls back to plain text and shows
      // the raw brackets. A keyboard has nothing to escape.
      if (out?.ok && out.task?.id && (block.name === 'add_task' || block.name === 'update_task')) {
        touched.set(String(out.task.id), out.task.content);
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    // All results for one assistant turn go back in a SINGLE user message.
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'Слишком много шагов — остановился.', touched };
}

async function claude(env, system, messages, overrides = {}) {
  const body = {
    model: env.CLAUDE_MODEL || MODEL,
    max_tokens: MAX_TOKENS,
    // Adaptive thinking is the only on-mode on Sonnet 5; effort controls depth.
    // "low" keeps a "купить молоко" turn fast and cheap.
    thinking: { type: 'adaptive' },
    output_config: { effort: env.CLAUDE_EFFORT || 'low' },
    system,
    tools,
    messages,
    ...overrides,
  };

  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();

    last = `Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`;
    // 429 and 5xx are worth another go; 400/401/404 never are.
    if (r.status !== 429 && r.status < 500) break;
    if (attempt === 2) break;
    const retryAfter = Number(r.headers.get('retry-after')) * 1000;
    await sleep(Math.min(retryAfter || 400 * 2 ** attempt, 5000));
  }
  throw new Error(last);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Persist text only. Tool blocks are dropped deliberately: they are bulky and
 * they embed task ids that may be stale by the next message. Thinking blocks go
 * too — they are only required within a single tool round-trip, not across turns.
 */
async function saveHistory(env, chatId, messages) {
  const trimmed = messages
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    }))
    .filter(m => m.content.trim())
    .slice(-6); // three exchanges
  await env.CHATS.put(`hist:${chatId}`, JSON.stringify({ messages: trimmed }), {
    expirationTtl: 1800, // 30 min — a new errand shouldn't inherit the last one
  });
}

// ============================================================== telegram ====
function tgBase(env) { return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`; }

async function tg(env, method, params) {
  const r = await fetch(`${tgBase(env)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

/**
 * Send with Markdown, and fall back to plain text if Telegram rejects it.
 * Task titles routinely contain _ * ` and [ ], any of which makes Telegram
 * 400 the whole message — which would otherwise look like the bot went silent.
 */
async function say(env, chatId, text, extra = {}) {
  const body = text.length > TG_LIMIT ? `${text.slice(0, TG_LIMIT - 1)}…` : text;
  const res = await tg(env, 'sendMessage', {
    chat_id: chatId, text: body, parse_mode: 'Markdown', ...extra,
  });
  if (res?.ok) return res;
  console.warn('formatted send failed:', res?.description);
  // Drop parse_mode on the retry — keeping it would fail for the same reason.
  const { parse_mode: _drop, ...rest } = extra;
  return tg(env, 'sendMessage', { chat_id: chatId, text: body, ...rest });
}

async function transcribe(env, fileId) {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — voice disabled.');

  const info = await (await fetch(`${tgBase(env)}/getFile?file_id=${fileId}`)).json();
  if (!info?.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${info?.description ?? 'no file_path'}`);
  }
  const audio = await (await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`,
  )).arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([audio]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  // No `language` field: the family speaks Russian and Spanish, so let Whisper detect.

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).text;
}

// ========================================================= morning digest ===
const TD_APP = 'https://app.todoist.com/app';
/** KV key holding the ids the last few morning nudges already suggested. */
const RECENT_KEY = 'suggest:recent';

/** Local wall-clock parts in `tz`, as the family experiences them. */
function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "14 авг" — built from the date string itself, so no timezone shifting. */
function shortDate(isoDate) {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

/**
 * Posts today's plan to DIGEST_CHAT_ID at DIGEST_AT local time.
 *
 * Cloudflare cron expressions are UTC-only with no timezone support, so
 * wrangler.toml registers 06:20 and 07:20 UTC — the CEST and CET equivalents of
 * 08:20 Madrid. Whichever one lands inside the window runs; the other returns
 * immediately. A KV day-key makes the send idempotent regardless.
 */
async function morningDigest(env, { force = false, chatId: to = null } = {}) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  const chatId = to || (env.DIGEST_CHAT_ID || (env.ALLOWED_CHAT_IDS || '').split(',')[0] || '').trim();
  if (!chatId) return void console.warn('digest: no DIGEST_CHAT_ID / ALLOWED_CHAT_IDS');

  const now = localParts(tz);

  // /digest asks for the digest here and now. Both guards below exist to stop
  // the cron sending twice, so a hand-run skips them — and deliberately does
  // not write the day key either, or a test before 07:30 would swallow the
  // real one.
  if (!force) {
    const [th, tm] = (env.DIGEST_AT || '08:20').split(':').map(Number);
    const drift = (now.hour * 60 + now.minute) - (th * 60 + tm);
    // 30-minute window: cron firings can be delayed, but the other half-year's
    // trigger is a full hour away and must not slip through.
    if (drift < 0 || drift >= 30) {
      return void console.log(`digest: skip, local ${now.hour}:${now.minute} (drift ${drift}m)`);
    }

    const dayKey = `digest:${now.date}`;
    if (await env.CHATS.get(dayKey)) return void console.log('digest: already sent', now.date);
    await env.CHATS.put(dayKey, '1', { expirationTtl: 172800 });
  }

  const [all, people] = await Promise.all([listTasks(env), roster(env)]);
  const nameOf = Object.fromEntries(people.map(p => [p.id, p.name.split(' ')[0]]));

  const due = all
    .filter(t => t.due?.date && t.due.date.slice(0, 10) <= now.date)
    .sort((a, b) => a.due.date.localeCompare(b.due.date));

  const line = t => {
    const who = t.responsible_uid ? nameOf[String(t.responsible_uid)] : null;
    const at = t.due.date.length > 10 ? ` ${t.due.date.slice(11, 16)}` : '';
    const bits = [`• <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>${at}`];
    if (who) bits.push(`· ${escapeHtml(who)}`);
    return bits.join(' ');
  };

  const kb = calendarButton(env);
  let posted = false;

  const overdue = due.filter(t => t.due.date.slice(0, 10) < now.date);
  const today = due.filter(t => t.due.date.slice(0, 10) === now.date);

  if (due.length) {
    const out = [`🌅 <b>Задачи на ${shortDate(now.date)}</b>`];
    if (overdue.length) {
      out.push('', `⚠️ <b>Просрочено</b>`);
      out.push(...overdue.map(t => `${line(t)} <i>(${shortDate(t.due.date)})</i>`));
    }
    if (today.length) {
      out.push('', `📅 <b>Сегодня</b>`);
      out.push(...today.map(line));
    }
    out.push('', `<a href="${TD_APP}/project/${env.TODOIST_PROJECT_ID}">Открыть в Todoist</a>`);
    await say(env, chatId, out.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true, ...kb });
    posted = true;
    console.log(`digest: sent ${overdue.length} overdue + ${today.length} today`);
  } else if (force || env.DIGEST_SKIP_EMPTY === 'false') {
    await say(env, chatId, `🌅 <b>${shortDate(now.date)}</b> — на сегодня ничего не запланировано.`,
      { parse_mode: 'HTML', disable_web_page_preview: true, ...kb });
    posted = true;
  } else {
    console.log('digest: nothing due');
  }

  // Follow-up nudge. Runs even on a quiet morning — a day with nothing planned
  // is exactly when picking something off the undated pile is worth suggesting.
  //
  // The calendar button rides along with the digest; when the digest stayed
  // silent the nudge is the only message of the morning, so it carries it.
  await suggestUndated(env, chatId, all, nameOf, posted ? {} : kb);
}

/**
 * Fisher-Yates over a copy, drawing from Web Crypto rather than Math.random().
 *
 * A cron firing usually gets a cold isolate, and Math.random() there replayed
 * the same sequence every morning — so the "может, сегодня?" nudge kept naming
 * the same two tasks. crypto.getRandomValues() is properly seeded per call.
 */
function shuffled(items) {
  const out = items.slice();
  const rnd = new Uint32Array(out.length);
  crypto.getRandomValues(rnd);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Second morning message: a couple of tasks that have no due date at all,
 * chosen at random, offered as candidates for today.
 *
 * Random rather than oldest-first on purpose — a fixed order would surface the
 * same stale tasks every morning until someone finally did them, and the family
 * would learn to skim past the message. Recently suggested ids are remembered
 * for a few days on top of that, so chance alone cannot repeat yesterday.
 */
async function suggestUndated(env, chatId, all, nameOf, extra = {}) {
  const n = Number(env.SUGGEST_COUNT || 5);
  if (n < 1) return;

  const pool = all.filter(t => !t.due?.date);
  if (!pool.length) return void console.log('suggest: no undated tasks');

  // Prefer tasks the last few mornings have not already offered; fall back to
  // the whole pile once the cooldown list has eaten most of it.
  const recent = (await env.CHATS.get(RECENT_KEY, 'json')) || [];
  const unseen = pool.filter(t => !recent.includes(String(t.id)));
  const picks = shuffled(unseen.length >= n ? unseen : pool).slice(0, n);

  const lines = picks.map(t => {
    const who = t.responsible_uid ? nameOf[String(t.responsible_uid)] : null;
    return `\u2022 <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>`
      + (who ? ` \u00b7 ${escapeHtml(who)}` : '');
  });

  const rest = pool.length - lines.length;
  const tail = rest > 0 ? `\n\n<i>\u0415\u0449\u0451 ${rest} \u0431\u0435\u0437 \u0441\u0440\u043e\u043a\u0430.</i>` : '';

  await say(env, chatId,
    `\ud83d\udca1 <b>\u0411\u0435\u0437 \u0441\u0440\u043e\u043a\u0430 \u2014 \u043c\u043e\u0436\u0435\u0442, \u0441\u0435\u0433\u043e\u0434\u043d\u044f?</b>\n${lines.join('\n')}${tail}\n\n`
    + `<i>\u0421\u043a\u0430\u0436\u0438 \u00ab${escapeHtml(picks[0].content)} \u2014 \u0441\u0435\u0433\u043e\u0434\u043d\u044f\u00bb, \u0438 \u043f\u043e\u0441\u0442\u0430\u0432\u043b\u044e \u0441\u0440\u043e\u043a.</i>`,
    { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

  // Keep a few rounds of history, but never more than the pool can spare.
  const keep = Math.min(n * 3, Math.max(0, pool.length - n));
  const memo = [...picks.map(t => String(t.id)), ...recent].slice(0, keep);
  await env.CHATS.put(RECENT_KEY, JSON.stringify(memo), { expirationTtl: 1209600 });

  console.log(`suggest: sent ${lines.length} of ${pool.length} undated, ${recent.length} on cooldown`);
}

// =============================================================== mini app ===
/**
 * Direct link to the Mini App, e.g. https://t.me/my_bot/calendar.
 *
 * A direct link and not an inline `web_app` button on purpose: Bot API allows
 * `web_app` buttons only in private chats, and the digest goes to the family
 * group. A t.me/<bot>/<app> url button opens the same Mini App everywhere.
 * Needs BotFather /newapp once; without the two vars the button is omitted.
 */
function miniAppLink(env) {
  const set = v => {
    const s = (v || '').trim();
    // The tracked config ships REPLACE_ME placeholders; a button built from one
    // would look real in the family chat and 404 on tap.
    return s && s !== 'REPLACE_ME' ? s : null;
  };
  const bot = set(env.BOT_USERNAME)?.replace(/^@/, '');
  const app = set(env.MINIAPP_SHORT_NAME);
  return bot && app ? `https://t.me/${bot}/${app}` : null;
}

function calendarButton(env) {
  const link = miniAppLink(env);
  if (!link) return {};
  return { reply_markup: { inline_keyboard: [[{ text: '📅 Календарь', url: link }]] } };
}

const utf8 = s => new TextEncoder().encode(s);
const toHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

/** Length-independent equality, so a wrong hash leaks nothing through timing. */
function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate a Mini App launch and return its parsed initData, or null.
 *
 * Telegram signs the launch parameters with HMAC-SHA256 keyed by a digest of
 * the bot token. The page URL is public, so nothing a client sends is trusted
 * until this passes. `signature` is only part of the separate Ed25519 scheme
 * for third parties, and Telegram has shipped both "keep it" and "drop it"
 * variants of the check string, so try both rather than guess.
 */
async function verifyInitData(env, initData) {
  if (!initData || !env.TELEGRAM_BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const secret = await hmacSha256(utf8('WebAppData'), utf8(env.TELEGRAM_BOT_TOKEN));

  const checkString = drop => [...params]
    .filter(([k]) => !drop.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  let ok = false;
  for (const drop of [['hash'], ['hash', 'signature']]) {
    if (sameSecret(toHex(await hmacSha256(secret, utf8(checkString(drop)))), hash)) {
      ok = true;
      break;
    }
  }
  if (!ok) return null;

  // A signature stays valid forever unless we age it out; a day is long enough
  // for one session and short enough that a leaked link stops working.
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!authDate || Date.now() - authDate > 86400_000) return null;

  try {
    return { user: JSON.parse(params.get('user') || 'null'), authDate };
  } catch { return null; }
}

/**
 * A valid signature only proves the launch came from Telegram — any stranger who
 * finds the link gets one too. Membership of the family chat is the actual ACL,
 * cached briefly so a calendar swipe does not hit the Bot API every time.
 */
async function isFamily(env, userId) {
  if (!userId) return false;
  const chatId = (env.DIGEST_CHAT_ID || (env.ALLOWED_CHAT_IDS || '').split(',')[0] || '').trim();
  if (!chatId) return false;

  const key = `member:${chatId}:${userId}`;
  const cached = await env.CHATS.get(key);
  if (cached) return cached === '1';

  const r = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  const st = r?.ok ? r.result?.status : null;
  const ok = st === 'creator' || st === 'administrator' || st === 'member'
    || (st === 'restricted' && r.result?.is_member === true);
  if (!r?.ok) console.warn('getChatMember:', r?.description);
  // Cache the "no" for far less time: someone just added to the chat should not
  // have to wait an hour, and a Bot API hiccup should not lock the family out.
  await env.CHATS.put(key, ok ? '1' : '0', { expirationTtl: ok ? 3600 : 120 });
  return ok;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/**
 * Everything the calendar needs, in one shot. The project holds tens of tasks,
 * not thousands, so range filtering server-side would only add a round trip
 * every time somebody flips to the next month.
 */
async function apiTasks(request, env) {
  const auth = await verifyInitData(
    env, (request.headers.get('Authorization') || '').replace(/^tma /i, ''));
  if (!auth) return json({ error: 'Не получилось подтвердить запуск из Telegram.' }, 401);
  if (!await isFamily(env, auth.user?.id)) {
    return json({ error: 'Этот календарь только для участников семейного чата.' }, 403);
  }

  const [all, people, marks] = await Promise.all([listTasks(env), roster(env), getMarks(env)]);
  const nameOf = Object.fromEntries(people.map(p => [p.id, p.name.split(' ')[0]]));

  return json({
    today: localParts(env.TZ_NAME || 'Europe/Madrid').date,
    // Kinds ride along with the marks so a new one — or a restyle — is a change
    // in MARK_KINDS alone, with nothing to keep in sync on the page.
    marks,
    markKinds: MARK_KINDS,
    project: `${TD_APP}/project/${env.TODOIST_PROJECT_ID}`,
    tasks: all.map(t => ({
      id: String(t.id),
      content: t.content,
      // Todoist timed dues are floating local time; the client only ever shows
      // them, never converts, so slicing the string is both right and cheapest.
      date: t.due?.date ? t.due.date.slice(0, 10) : null,
      time: t.due?.date && t.due.date.length > 10 ? t.due.date.slice(11, 16) : null,
      priority: t.priority ?? 1,
      recurring: !!t.due?.is_recurring,
      who: t.responsible_uid ? nameOf[String(t.responsible_uid)] ?? null : null,
      url: `${TD_APP}/task/${t.id}`,
    })),
  });
}

// ========================================================== weekend ideas ===
/**
 * Thursday evening: what could we actually do this weekend?
 *
 * The pool is tasks carrying the WEEKEND_LABEL — «сходить в Прадо», «съездить в
 * Сеговию». A Todoist label rather than a store of our own, so the mark travels
 * with the task, shows up in the app and can be added or taken off by hand
 * without the bot.
 */
const WEEKEND_COUNT = 6;

const weekendLabel = env => (env.WEEKEND_LABEL || 'выходные').trim();

/** Saturday and Sunday of the weekend we are heading into; on a weekend, this one. */
function comingWeekend(today) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();   // 0 = Sunday … 6 = Saturday
  const sat = shiftDate(today, dow === 0 ? -1 : 6 - dow);
  return { sat, sun: shiftDate(sat, 1) };
}

const RU_SHORT_DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/**
 * Posts the weekend list. Same two guards as the morning digest — a local-time
 * window and a day key — because Cloudflare cron is UTC-only and both the
 * summer and winter equivalents are registered. `force` is /weekend by hand.
 */
async function weekendIdeas(env, { force = false, chatId: to = null } = {}) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  const chatId = to || (env.WEEKEND_CHAT_ID || env.DIGEST_CHAT_ID
    || (env.ALLOWED_CHAT_IDS || '').split(',')[0] || '').trim();
  if (!chatId) return void console.warn('weekend: no chat to post to');

  const now = localParts(tz);

  if (!force) {
    // The cron fires on Thursday UTC; confirm it is still Thursday here.
    if (new Date(`${now.date}T12:00:00Z`).getUTCDay() !== 4) {
      return void console.log('weekend: skip, not Thursday locally', now.date);
    }
    const [th, tm] = (env.WEEKEND_AT || '18:00').split(':').map(Number);
    const drift = (now.hour * 60 + now.minute) - (th * 60 + tm);
    if (drift < 0 || drift >= 30) {
      return void console.log(`weekend: skip, local ${now.hour}:${now.minute} (drift ${drift}m)`);
    }
    const key = `weekend:${now.date}`;
    if (await env.CHATS.get(key)) return void console.log('weekend: already sent', now.date);
    await env.CHATS.put(key, '1', { expirationTtl: 172800 });
  }

  const label = weekendLabel(env);
  const all = await listTasks(env);
  const tagged = all.filter(t => (t.labels || []).some(l => l.toLowerCase() === label.toLowerCase()));

  const { sat, sun } = comingWeekend(now.date);
  const planned = tagged
    .filter(t => t.due?.date && t.due.date.slice(0, 10) >= sat && t.due.date.slice(0, 10) <= sun)
    .sort((a, b) => a.due.date.localeCompare(b.due.date));
  const pool = tagged.filter(t => !t.due?.date);

  if (!planned.length && !pool.length) {
    if (!force) return void console.log(`weekend: nothing labelled «${label}»`);
    return void say(env, chatId,
      `Пока нечего предложить — ни одной задачи с меткой «${label}».\n\n`
      + 'Скажи «сходить в музей Прадо, это на выходные» — помечу, и в четверг напомню.',
      { disable_web_page_preview: true });
  }

  const picks = shuffled(pool).slice(0, Number(env.WEEKEND_COUNT || WEEKEND_COUNT));
  const link = t => `• <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>`;

  const out = [`🎉 <b>Идеи на выходные</b> — ${shortDate(sat)} и ${shortDate(sun)}`];

  if (planned.length) {
    out.push('', '📅 <b>Уже в планах</b>');
    out.push(...planned.map(t => {
      const d = new Date(`${t.due.date.slice(0, 10)}T12:00:00Z`).getUTCDay();
      const at = t.due.date.length > 10 ? ` ${t.due.date.slice(11, 16)}` : '';
      return `${link(t)} — ${RU_SHORT_DOW[d]}${at}`;
    }));
  }
  if (picks.length) {
    out.push('', '💡 <b>Можно сделать</b>');
    out.push(...picks.map(link));
    const rest = pool.length - picks.length;
    if (rest > 0) out.push('', `<i>Ещё ${rest} с этой меткой.</i>`);
  }

  await say(env, chatId, out.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...calendarButton(env),
  });
  console.log(`weekend: sent ${planned.length} planned + ${picks.length} of ${pool.length} ideas`);
}

// ======================================================== due-soon alerts ===
/**
 * Offset of `tz` from UTC, in ms, at a given instant. Positive east of Greenwich.
 */
function tzOffsetMs(instant, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(instant).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - instant.getTime();
}

/**
 * Todoist returns timed due dates as FLOATING local time ("2026-08-19T18:00:00",
 * timezone: null) — wall clock in the user's zone, with no offset. Workers run in
 * UTC, so Date.parse() would read that as 18:00 UTC, two hours early in Madrid.
 * Resolve it against TZ_NAME instead; the second pass catches the DST edge where
 * the first guess lands on the other side of a transition.
 */
function dueInstant(due, tz) {
  const s = due?.date;
  if (!s) return null;
  if (s.length <= 10) return null;                 // date-only: no time to lead
  if (/[Z+]|-\d\d:\d\d$/.test(s.slice(10))) return Date.parse(s);  // already absolute
  const base = Date.parse(`${s}Z`);
  if (Number.isNaN(base)) return null;
  let t = base - tzOffsetMs(new Date(base), tz);
  t = base - tzOffsetMs(new Date(t), tz);
  return t;
}

const PRIORITY_MARK = { 4: '🔴', 3: '🟠', 2: '🔵' };  // API 4/3/2 = UI p1/p2/p3

/**
 * Every 5 minutes: warn the chat about high-priority tasks coming due within
 * ALERT_LEAD_MIN. One message per task per due-time, deduped in KV.
 *
 * Only tasks with an actual time qualify — a date-only task has no moment to
 * count back from, and would otherwise fire at midnight.
 */
async function dueSoonAlerts(env) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  const chatId = (env.ALERT_CHAT_ID || env.DIGEST_CHAT_ID
    || (env.ALLOWED_CHAT_IDS || '').split(',')[0] || '').trim();
  if (!chatId) return void console.warn('alerts: no chat id');

  const lead = Number(env.ALERT_LEAD_MIN || 5);
  const minPrio = Number(env.ALERT_MIN_PRIORITY || 2);   // API scale: >1 = above default

  const all = await listTasks(env);
  const now = Date.now();

  const soon = [];
  for (const t of all) {
    if ((t.priority ?? 1) < minPrio) continue;
    const at = dueInstant(t.due, tz);
    if (at === null) continue;
    const mins = (at - now) / 60000;
    // Window runs slightly past the lead time and a little before it, to absorb
    // cron jitter. Double firings are harmless — the KV key below dedupes.
    if (mins > lead + 1 || mins < -2) continue;
    soon.push({ t, at });
  }
  if (!soon.length) return;

  const people = await roster(env);
  const nameOf = Object.fromEntries(people.map(p => [p.id, p.name.split(' ')[0]]));
  const hhmm = ms => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));

  const fresh = [];
  for (const s of soon) {
    // Keyed on the due time too, so rescheduling a task re-arms its alert.
    const key = `alert:${s.t.id}:${s.t.due.date}`;
    if (await env.CHATS.get(key)) continue;
    await env.CHATS.put(key, '1', { expirationTtl: 172800 });
    fresh.push(s);
  }
  if (!fresh.length) return;

  const lines = fresh.map(({ t, at }) => {
    const who = t.responsible_uid ? nameOf[String(t.responsible_uid)] : null;
    const mark = PRIORITY_MARK[t.priority] || '';
    return `${mark} <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>`
      + ` — ${hhmm(at)}${who ? ` · ${escapeHtml(who)}` : ''}`;
  });

  await say(env, chatId, `⏰ <b>Скоро (через ~${lead} мин)</b>\n${lines.join('\n')}`,
    { parse_mode: 'HTML', disable_web_page_preview: true });
  console.log(`alerts: sent ${fresh.length}`);
}
