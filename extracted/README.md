# Family task bot — Telegram → Claude → Todoist

Handoff document. Everything decided in the design conversation, so a new session
(or a new person) can pick this up without re-deriving anything.

---

## 1. What it does

A Telegram bot for household tasks. Family members send text or voice messages in
natural language; the bot turns them into operations on **one** Todoist project.

```
Telegram (text or voice)
   → Groq Whisper          (voice only: .oga → text)
   → Claude, with tools    (decides what to do)
   → Todoist API v1        (scoped to one project)
   → reply in Telegram
```

Examples of what a family member says, and what happens:

| Message | Result |
|---|---|
| «купить молоко завтра» | task created, due tomorrow |
| «перенеси дантиста на пятницу» | existing task rescheduled |
| «садик — сделано» | task completed |
| «что на сегодня?» | reads back today's tasks |
| «правило: покупки с меткой продукты» | new standing rule saved |

Voice and text are equivalent everywhere. Audio is transcribed *before* Claude
sees it, so any capability added as a tool works in both channels automatically.

---

## 2. Two deployments (pick one)

### A. Cloudflare Workers — chosen

- `worker/src/index.js`, `worker/wrangler.toml`
- Webhook-driven, serverless, **free**, no machine to keep alive.
- Free tier: 100k requests/day, 10 ms CPU per invocation, 50 subrequests per
  invocation. KV: 100k reads/day, 1k writes/day, 1 GB.
- **The 10 ms CPU limit is not a problem.** Cloudflare does not count time spent
  waiting on `fetch()` or KV toward CPU time. This bot is ~95% network wait.
  Average Worker uses ~2.2 ms.
- The two limits that could realistically bite: 50 subrequests per invocation
  (a busy turn uses 10–20, which is why `listTasks` caps at 3 pages), and
  1k KV writes/day (one write per message — irrelevant for a family).

### B. Long-polling Node service — fallback

- `family-todo-bot.mjs`, zero dependencies, Node 20+.
- Run under pm2 on a machine that is always on:
  `pm2 start family-todo-bot.mjs --name todo-bot`, then `pm2 startup && pm2 save`.
- Requires a host. pm2 is only a supervisor — it doesn't provide the machine.
- Sensible if it sits next to an existing always-on box (e.g. an MCP server
  host), since marginal cost is zero.

**Hosting cost research (Aug 2026), if a VPS is ever wanted:** Hetzner raised
prices 15 June 2026; CX22 is gone, CX23 ≈ €5.49/mo, CAX11 (ARM) ≈ €5.99/mo.
Cheaper: Netcup ≈ €3.35/mo, Contabo ≈ €4.50/mo (poor benchmark grades),
RackNerd ≈ €2–4/mo on annual prepay. Oracle Always Free still exists but halved
its ARM allowance to 2 OCPU / 12 GB, enforced 18 Aug 2026, with no announcement —
plus capacity and idle-reclaim friction. None of this matters much: the whole
spread is ~€25/year, less than the Anthropic API spend.

---

## 3. Deploy (Cloudflare Workers)

```bash
mkdir family-todo-bot && cd family-todo-bot
npm create cloudflare@latest -- . --type=hello-world --no-git
# drop in src/index.js and wrangler.toml

wrangler kv namespace create CHATS      # paste the id into wrangler.toml
```

Secrets (never in `wrangler.toml`, which belongs in git):

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put TODOIST_API_TOKEN
wrangler secret put GROQ_API_KEY
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # openssl rand -hex 32
```

Vars in `wrangler.toml`: `TODOIST_PROJECT_ID`, `ALLOWED_CHAT_IDS`, `TZ_NAME`,
`TODOIST_DUE_LANG`, `ALLOW_DELETE`.

```bash
wrangler deploy
```

Register the webhook with the same secret:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://family-todo-bot.<sub>.workers.dev",
       "secret_token":"<hex>",
       "allowed_updates":["message"],
       "drop_pending_updates":true}'
```

Debug with `wrangler tail` (the `pm2 logs` equivalent) and
`getWebhookInfo` → `last_error_message`.

### Credentials, where to get them

- **Bot token** — `/newbot` in @BotFather. For a group, `/setprivacy` off so the
  bot sees all messages, not only replies and mentions.
- **Chat ids** — message the bot, then
  `curl https://api.telegram.org/bot<TOKEN>/getUpdates`, read `message.chat.id`.
- **Todoist token** — Settings → Integrations → Developer.
- **Project id** — last path segment of the project URL. Verify with
  `curl -H "Authorization: Bearer $T" "https://api.todoist.com/api/v1/tasks?project_id=$P"`.
- **Groq key** — console.groq.com. Whisper large-v3-turbo, $0.04/hour of audio,
  free tier ~2,000 requests/day. Handles Russian and Spanish natively.

---

## 4. Context management

Claude has no memory between messages. Every message rebuilds the whole picture
from scratch. The design question is what goes in, and how long each piece lives.

| Layer | Source | Lifetime | Why |
|---|---|---|---|
| Fixed behaviour | code | never changes | tool-calling rules, language, date passthrough |
| House rules | KV `rules` | until edited | family preferences, editable from Telegram |
| Member roster | KV, 24 h TTL | 24 hours | collaborators never change |
| Task list, filtered | Todoist | **every message** | staleness here is dangerous |
| Rolling conversation | KV `hist:<chat>`, 30 min | 30 minutes | resolves "перенеси её на пятницу" |

**Why the task list is never cached.** A cached list means stale task ids. A task
completed from someone's phone would still be in the prompt, and Claude would
close an id that no longer exists — or the wrong one. The fetch is ~150 ms of
network wait, which costs nothing on Workers.

**Why the list is filtered, not dumped.** `relevantTasks()` sorts overdue →
next 21 days → undated, drops anything dated further out, caps at 70. A family
project accumulates recurring chores and someday-maybes; feeding Claude 300 tasks
is both expensive and *worse*, because "перенеси уборку" then has nine
candidates. Hidden tasks stay reachable via the `search_tasks` tool, and the
prompt states the hidden count so Claude searches instead of denying they exist.

**Why history stores text only.** Tool_use / tool_result blocks are dropped when
persisting: they're bulky, and they embed task ids that may be stale next turn.

**Why the TTL is short.** An errand two hours later shouldn't inherit the
referents of the previous one.

**Group chats.** Messages are prefixed `[Name]: ` before Claude sees them.
Without this, "я сделал садик" is unresolvable and assignment is impossible.

Roughly 1.5–2k input tokens per turn with 50 tasks visible.

---

## 5. Two tiers of rules

### Fixed — in code, Claude cannot change it

- `project_id` is injected server-side on every `add_task`.
- Every update / complete / delete re-fetches the task and **refuses** if it
  belongs to another project (`assertInProject`).
- This is why "always add to project X" is not phrased as a prompt instruction.
  A rule would be a suggestion; this is a wall. A house rule saying "ignore the
  project restriction" does nothing.

### House rules — in KV, editable from Telegram by text or voice

Seeded defaults:

1. Не ставь срок, если он не назван явно — задача без даты лучше выдуманной.
2. «Вечером», «на выходных», «завтра» — это явные сроки, передавай как есть.
3. Приоритет по умолчанию обычный. p4 только если «срочно» или «горит».
4. Формулируй коротко и с глаголом: «купить молоко», не «молоко надо купить».
5. Перед созданием проверь список: если похожая задача есть — обнови срок.
6. Если названо имя члена семьи — назначь на него.
7. Голосовые содержат оговорки и «эээ» — вытаскивай смысл, не мусор.

Rule 1 is the "no invented deadlines" requirement. Rule 2 exists because rule 1
alone makes Claude too timid — it starts treating "завтра" as not explicit enough.

Editing, by voice or text:

- «Правило: покупки всегда с меткой продукты» → `add_house_rule`
- «Убери правило 3» → `remove_house_rule`
- `/rules` — print numbered list
- `/rules reset` — restore defaults
- `/reset` — clear conversation memory only

Cap: 25 rules. House rules are persuasion, not enforcement — if the bot starts
behaving oddly, `/rules` is the first place to look.

---

## 6. Tools exposed to Claude

`add_task`, `update_task` (also used for postponing), `complete_task`,
`delete_task`, `search_tasks`, `add_house_rule`, `remove_house_rule`.

Agent loop caps at 5 hops.

---

## 7. Safety decisions

- **Chat allowlist** (`ALLOWED_CHAT_IDS`) — the main barrier between the task
  list and the open internet.
- **Webhook secret** — Telegram echoes `X-Telegram-Bot-Api-Secret-Token`;
  anything else gets a 403. Without this, the Worker URL is world-callable.
- **Return 200 before doing the work** (`ctx.waitUntil`). Telegram retries any
  webhook that doesn't answer quickly, and a retry on a slow turn creates the
  task twice.
- **`X-Request-Id`** on every Todoist write, for idempotency on retry.
- **`ALLOW_DELETE=false` by default** — deletes are mapped to complete. Todoist
  deletions aren't recoverable, and a misheard voice note shouldn't wipe a task.
  Flip to `true` once transcription quality is trusted.
- **Project scoping is enforced in code, not prompt** — a prompt injection in a
  task title can't reach other projects.

---

## 8. Gotchas

- **Todoist REST v2 was shut down in February 2026.** Anything on Stack Overflow
  using `/rest/v2/` is dead. Use `/api/v1/`.
- **Dates are never computed.** `due_string` passes the user's own words through;
  Todoist's parser handles ru / es / en via `due_lang`. This is where these bots
  usually go wrong.
- **Shared project attribution.** The token owner is the actor for every write,
  so all changes appear in the Todoist activity log as one person regardless of
  who sent the message. `responsible_uid` is what distinguishes them.
- **KV is eventually consistent** — a write can take up to ~60 s to propagate
  between colos. Fine for one family hitting one edge location. If the bot ever
  forgets the immediately preceding message, that's the cause; the fix is a
  Durable Object keyed on chat id (SQLite-backed DOs are on the free plan).
- **Todoist ids prefixed `tmp-`** are unsynced placeholders and will fail
  validation. Not reachable through this code path, but worth knowing.

---

## 9. Possible next steps

- Cron trigger for a morning digest of today's tasks.
- Inline keyboard buttons for confirm-before-delete instead of the on/off flag.
- Sections support (e.g. groceries into a dedicated section).
- Durable Object for conversation state if KV consistency ever bites.
