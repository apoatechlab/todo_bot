/**
 * family-todo-bot.mjs
 * Telegram (text + voice) -> Whisper -> Claude (tool use) -> Todoist project
 *
 * Zero dependencies. Node 20+ (built-in fetch / FormData / Blob).
 * Run: node family-todo-bot.mjs        (long polling, no public URL needed)
 * Or:  pm2 start family-todo-bot.mjs --name todo-bot
 */

// ---------------------------------------------------------------- config ----
const TG_TOKEN        = req('TELEGRAM_BOT_TOKEN');
const ANTHROPIC_KEY   = req('ANTHROPIC_API_KEY');
const TODOIST_TOKEN   = req('TODOIST_API_TOKEN');
const PROJECT_ID      = req('TODOIST_PROJECT_ID');       // the family project
const GROQ_KEY        = process.env.GROQ_API_KEY || '';  // for voice messages
const ALLOWED_CHATS   = (process.env.ALLOWED_CHAT_IDS || '')
                          .split(',').map(s => s.trim()).filter(Boolean);
const DUE_LANG        = process.env.TODOIST_DUE_LANG || 'ru'; // ru|es|en|...
const TZ              = process.env.TZ_NAME || 'Europe/Madrid';
const ALLOW_DELETE    = process.env.ALLOW_DELETE === 'true';  // else -> complete
const MODEL           = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

function req(k) {
  const v = process.env[k];
  if (!v) { console.error(`Missing env var ${k}`); process.exit(1); }
  return v;
}

// --------------------------------------------------------------- todoist ----
const TD = 'https://api.todoist.com/api/v1';

async function todoist(path, { method = 'GET', body } = {}) {
  const r = await fetch(TD + path, {
    method,
    headers: {
      Authorization: `Bearer ${TODOIST_TOKEN}`,
      'Content-Type': 'application/json',
      // idempotency for writes, so retries never double-create
      ...(method !== 'GET' ? { 'X-Request-Id': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Todoist ${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function listTasks() {
  const out = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ project_id: PROJECT_ID, limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const page = await todoist(`/tasks?${q}`);
    out.push(...(page.results ?? page));
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return out;
}

/** Refuse to touch anything outside the family project. */
async function assertInProject(taskId) {
  const t = await todoist(`/tasks/${taskId}`);
  if (String(t.project_id) !== String(PROJECT_ID)) {
    throw new Error('Task is outside the allowed project — refused.');
  }
  return t;
}

function compact(t) {
  return {
    id: t.id,
    content: t.content,
    due: t.due?.string ?? null,
    priority: t.priority,
    labels: t.labels,
    assignee: t.responsible_uid ?? null,
    section_id: t.section_id ?? null,
  };
}

// ----------------------------------------------------------------- tools ----
const tools = [
  {
    name: 'add_task',
    description: 'Create a new task in the family project.',
    input_schema: {
      type: 'object',
      properties: {
        content:     { type: 'string', description: 'Task title, in the user\'s language.' },
        due_string:  { type: 'string', description: 'Natural-language due date exactly as the user said it, e.g. "завтра в 18:00", "cada lunes". Omit if no date was mentioned.' },
        description: { type: 'string' },
        priority:    { type: 'integer', description: '1 = normal ... 4 = urgent' },
        labels:      { type: 'array', items: { type: 'string' } },
        assignee_id: { type: 'string', description: 'Collaborator user id from the roster, if the user named someone.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_task',
    description: 'Change the title, due date, priority or assignee of an existing task. Use this to postpone.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:     { type: 'string' },
        content:     { type: 'string' },
        due_string:  { type: 'string', description: 'e.g. "next friday", "no date" to clear.' },
        priority:    { type: 'integer' },
        assignee_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task. Only when the user explicitly says delete/remove (not "done").',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'refresh_tasks',
    description: 'Re-read the current open tasks in the project.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function runTool(name, args) {
  switch (name) {
    case 'add_task': {
      const t = await todoist('/tasks', {
        method: 'POST',
        body: {
          project_id: PROJECT_ID,
          content: args.content,
          description: args.description,
          due_string: args.due_string,
          due_lang: args.due_string ? DUE_LANG : undefined,
          priority: args.priority,
          labels: args.labels,
          responsible_uid: args.assignee_id,
        },
      });
      return { ok: true, task: compact(t) };
    }
    case 'update_task': {
      await assertInProject(args.task_id);
      const t = await todoist(`/tasks/${args.task_id}`, {
        method: 'POST',
        body: {
          content: args.content,
          due_string: args.due_string,
          due_lang: args.due_string ? DUE_LANG : undefined,
          priority: args.priority,
          responsible_uid: args.assignee_id,
        },
      });
      return { ok: true, task: compact(t) };
    }
    case 'complete_task': {
      const t = await assertInProject(args.task_id);
      await todoist(`/tasks/${args.task_id}/close`, { method: 'POST' });
      return { ok: true, completed: t.content };
    }
    case 'delete_task': {
      const t = await assertInProject(args.task_id);
      if (!ALLOW_DELETE) {
        await todoist(`/tasks/${args.task_id}/close`, { method: 'POST' });
        return { ok: true, note: 'Deletion is disabled; task was completed (archived) instead.', task: t.content };
      }
      await todoist(`/tasks/${args.task_id}`, { method: 'DELETE' });
      return { ok: true, deleted: t.content };
    }
    case 'refresh_tasks':
      return { tasks: (await listTasks()).map(compact) };
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ------------------------------------------------------------ collaborators -
async function collaborators() {
  try {
    const r = await fetch(`${TD}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TODOIST_TOKEN}`,
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
        .filter(s => String(s.project_id) === String(PROJECT_ID))
        .map(s => String(s.user_id)),
    );
    return (d.collaborators || [])
      .filter(c => inProject.has(String(c.id)))
      .map(c => ({ id: String(c.id), name: c.full_name, email: c.email }));
  } catch { return []; }
}

// ---------------------------------------------------------------- claude ----
function systemPrompt(tasks, people) {
  return `You are the household task assistant for a family, operating on ONE Todoist project.
Today is ${new Date().toLocaleString('en-GB', { timeZone: TZ })} (timezone ${TZ}).

Rules:
- Turn what the person says into tool calls. Do not ask for confirmation on ordinary adds, postpones or completions — just do it.
- One message may contain several instructions ("buy milk and move the dentist to Friday"). Handle all of them.
- Pass dates through as natural language in the user's own words via due_string; Todoist parses them.
- "done / сделал / listo" -> complete_task. "delete / удали / borra" -> delete_task.
- If a referenced task is genuinely ambiguous, ask one short clarifying question instead of guessing.
- Reply in the same language the person wrote in. Keep the reply to one or two lines: what you changed, nothing else. No preamble.

Project members:
${people.length ? people.map(p => `- ${p.name} (id ${p.id})`).join('\n') : '- (none / personal project)'}

Current open tasks (id — title — due):
${tasks.length ? tasks.map(t => `- ${t.id} — ${t.content} — ${t.due ?? 'no date'}`).join('\n') : '- (empty)'}`;
}

async function claude(messages, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}

async function handleText(chatId, text) {
  const [tasks, people] = await Promise.all([listTasks(), collaborators()]);
  const system = systemPrompt(tasks.map(compact), people);

  const history = getHistory(chatId);
  const messages = [...history, { role: 'user', content: text }];

  for (let hop = 0; hop < 6; hop++) {
    const res = await claude(messages, system);
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      saveHistory(chatId, messages);
      return reply || 'Готово.';
    }

    const results = [];
    for (const block of res.content.filter(b => b.type === 'tool_use')) {
      let out;
      try { out = await runTool(block.name, block.input); }
      catch (e) { out = { error: String(e.message).slice(0, 300) }; }
      console.log(`[tool] ${block.name}`, JSON.stringify(block.input), '->', JSON.stringify(out).slice(0, 200));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Слишком много шагов, останавливаюсь.';
}

// ------------------------------------------------------- short-term memory --
const memory = new Map(); // chatId -> { at, messages }
const MEM_TTL = 20 * 60 * 1000;

function getHistory(chatId) {
  const m = memory.get(chatId);
  if (!m || Date.now() - m.at > MEM_TTL) return [];
  return m.messages;
}
function saveHistory(chatId, messages) {
  // keep the last 3 exchanges only; tool blocks are dropped to stay small
  const trimmed = messages
    .filter(m => typeof m.content === 'string' ||
                 (Array.isArray(m.content) && m.content.some(b => b.type === 'text')))
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    }))
    .slice(-6);
  memory.set(chatId, { at: Date.now(), messages: trimmed });
}

// -------------------------------------------------------------- telegram ----
const TG = `https://api.telegram.org/bot${TG_TOKEN}`;

async function tg(method, params) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

async function transcribe(fileId) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set — voice messages disabled.');
  const { result } = await (await fetch(`${TG}/getFile?file_id=${fileId}`)).json();
  const audio = await (await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${result.file_path}`)).arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([audio]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  // form.append('language', 'ru');   // set to skip auto-detection

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
  return (await r.json()).text;
}

async function onMessage(msg) {
  const chatId = String(msg.chat.id);
  if (ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(chatId)) {
    console.warn('blocked chat', chatId, msg.from?.username);
    return;
  }

  let text = msg.text;
  const voice = msg.voice || msg.audio;
  if (voice) {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    text = await transcribe(voice.file_id);
    console.log('[voice]', text);
  }
  if (!text) return;
  if (text.startsWith('/start') || text.startsWith('/help')) {
    return void tg('sendMessage', { chat_id: chatId, text:
      'Пиши или наговаривай задачи: «купить молоко завтра», «перенеси дантиста на пятницу», «садик — сделано», «что на сегодня?»' });
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const reply = await handleText(chatId, text);
    await tg('sendMessage', { chat_id: chatId, text: (voice ? `🎤 _${text}_\n\n` : '') + reply, parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await tg('sendMessage', { chat_id: chatId, text: `⚠️ ${e.message}`.slice(0, 500) });
  }
}

// ------------------------------------------------------------------ main ----
async function main() {
  console.log('bot up; project', PROJECT_ID, '| delete', ALLOW_DELETE ? 'ON' : 'OFF (completes instead)');
  await tg('deleteWebhook', { drop_pending_updates: true });
  let offset = 0;
  for (;;) {
    try {
      const { result = [] } = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of result) {
        offset = u.update_id + 1;
        if (u.message) onMessage(u.message).catch(console.error);
      }
    } catch (e) {
      console.error('poll error', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

main();
