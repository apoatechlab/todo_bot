#!/usr/bin/env node
/**
 * One-time Google OAuth, so the Worker gets a refresh token it can use forever.
 *
 * Google killed the copy-a-code-from-the-browser flow in 2022, so a redirect
 * back to localhost is the only option left for a desktop client. This serves
 * exactly one request on 127.0.0.1, takes the code, trades it for tokens and
 * prints them. Nothing is written to disk — you paste the results into
 * `wrangler secret put`, which is the only place they belong.
 *
 *   npm run google:auth
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}`;
// The narrow scope: files this app created, and nothing else in the Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const SETUP = `
Нужен OAuth-клиент Google. Если его ещё нет:

  1. Создай проект:
     https://console.cloud.google.com/projectcreate

  2. Включи Google Drive API:
     https://console.cloud.google.com/apis/library/drive.googleapis.com

  3. Настрой Google Auth Platform (бывший "OAuth consent screen"):
     https://console.cloud.google.com/auth/overview
     "Get started" → App name, свой email → Audience → контактный email
     → согласиться с политикой → Create.

  4. Audience: https://console.cloud.google.com/auth/audience

     Есть Google Workspace (почта на своём домене)? Ставь INTERNAL.
     Ничего больше заполнять и публиковать не нужно, и refresh-токен
     живёт вечно. Это самый короткий путь.

     Нет Workspace (обычный gmail)? Тогда External, и придётся:
       - на странице Branding заполнить home page и privacy policy
         на домене, который ты подтвердил в Search Console
         (без этого кнопка Publish app ругается на incomplete config);
       - нажать Publish app → статус "In production".
     Иначе refresh-токен умрёт через 7 дней: это ограничение
     связки External + Testing. Верификацию проходить не надо —
     scope drive.file несенситивный.

  5. Создай клиент:
     https://console.cloud.google.com/auth/clients
     Create client → Application type: Desktop app → Create.
     Скопируй оттуда Client ID и Client secret.
`;

/**
 * Credentials come from the flags, the environment, or a prompt — in that order.
 *
 * The prompt is last because stdin is not always a terminal: run through a
 * wrapper that does not attach one and readline never resolves, which Node
 * reports as an unsettled top-level await rather than anything useful. So the
 * non-interactive paths exist, and a missing terminal says so plainly.
 */
const flag = name => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

let clientId = (flag('id') || process.env.GOOGLE_CLIENT_ID || '').trim();
let clientSecret = (flag('secret') || process.env.GOOGLE_CLIENT_SECRET || '').trim();

// --file takes the JSON the Cloud console hands you when you create the client,
// so the secret goes from disk to memory without passing through a clipboard,
// a shell history or a terminal window.
const clientFile = flag('file') || process.env.GOOGLE_CLIENT_FILE || '';
if (clientFile && (!clientId || !clientSecret)) {
  let raw;
  try {
    raw = JSON.parse(await readFile(clientFile, 'utf8'));
  } catch (e) {
    console.error(`Не читается ${clientFile}: ${e.message}`);
    process.exit(1);
  }
  // Desktop clients come as {"installed": {...}}, web ones as {"web": {...}}.
  const block = raw.installed || raw.web;
  if (!block?.client_id || !block?.client_secret) {
    console.error(`В ${clientFile} нет client_id/client_secret — это точно файл OAuth-клиента?`);
    process.exit(1);
  }
  if (raw.web) {
    console.error('Внимание: это клиент типа Web application. Нужен Desktop app —'
      + '\nиначе Google не пустит редирект на localhost. Создай новый клиент.');
    process.exit(1);
  }
  clientId = clientId || block.client_id;
  clientSecret = clientSecret || block.client_secret;
  console.log(`Клиент взят из файла: ${clientId}`);
}

if (!clientId || !clientSecret) {
  if (!process.stdin.isTTY) {
    console.error(SETUP);
    console.error(`Ввести их некуда — stdin не терминал (так бывает, когда скрипт
запускают из обёртки, а не из обычного терминала).

Запусти в обычном терминале:

  npm run google:auth

или скорми ему JSON, который скачивается из консоли при создании клиента:

  npm run google:auth -- --file=~/Downloads/client_secret_....json

Браузер откроется в любом случае — на согласие Google есть 5 минут.`);
    process.exit(1);
  }
  console.log(SETUP);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  clientId = clientId || (await rl.question('Client ID: ')).trim();
  clientSecret = clientSecret || (await rl.question('Client secret: ')).trim();
  rl.close();
}

if (!clientId || !clientSecret) {
  console.error('Пусто — нечего делать.');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  // Both are required to get a refresh token back: offline asks for one,
  // consent forces a fresh one even if this app was authorised before.
  access_type: 'offline',
  prompt: 'consent',
});

const code = await new Promise((resolve, reject) => {
  let giveUp;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    const got = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
      ${got ? '✅ Готово — возвращайся в терминал.' : `❌ ${err || 'нет кода'}`}</body>`);
    clearTimeout(giveUp);
    server.close();
    got ? resolve(got) : reject(new Error(err || 'no code in redirect'));
  });
  server.listen(PORT, '127.0.0.1', () => {
    // Nothing should hang forever on a browser tab nobody opened.
    giveUp = setTimeout(() => {
      server.close();
      reject(new Error('Пять минут без ответа от Google — согласие так и не выдали.'));
    }, 5 * 60_000);

    console.log(`\nОткрываю браузер. Если не откроется — зайди сюда вручную:\n\n${authUrl}\n`);
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(opener, [authUrl], { stdio: 'ignore', detached: true });
    // No opener on this box is not fatal — the URL is on screen above. Without
    // this listener an ENOENT from spawn would take the whole script down.
    child.on('error', () => console.log('(браузер сам не открылся — открой ссылку выше)'));
    child.unref();
  });
  server.on('error', e => {
    clearTimeout(giveUp);
    reject(e.code === 'EADDRINUSE'
      ? new Error(`Порт ${PORT} занят — закрой то, что его держит, и запусти снова.`)
      : e);
  });
});

const r = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});
const tok = await r.json();
if (!r.ok || !tok.refresh_token) {
  console.error('\nОбмен кода не удался:', JSON.stringify(tok, null, 2));
  console.error('\nЕсли refresh_token не пришёл, а access_token есть — Google решил, что'
    + '\nдоступ уже выдавался. Отзови его на https://myaccount.google.com/permissions'
    + '\nи запусти скрипт заново.');
  process.exit(1);
}

const secrets = {
  GOOGLE_CLIENT_ID: clientId,
  GOOGLE_CLIENT_SECRET: clientSecret,
  GOOGLE_REFRESH_TOKEN: tok.refresh_token,
};

if (flag('save') !== null || process.argv.includes('--save')) {
  // Pipe each value into wrangler's stdin. Nothing is printed, so the refresh
  // token never reaches the screen, the scrollback, or a shell history.
  for (const [name, value] of Object.entries(secrets)) {
    process.stdout.write(`secret put ${name} … `);
    const code = await new Promise(resolve => {
      const w = spawn('./scripts/wg.sh', ['secret', 'put', name],
        { stdio: ['pipe', 'ignore', 'inherit'] });
      w.stdin.end(value);
      w.on('close', resolve);
      w.on('error', () => resolve(-1));
    });
    if (code !== 0) {
      console.error(`\nНе получилось (код ${code}). Положи вручную: npm run secret put ${name}`);
      process.exit(1);
    }
    console.log('ок');
  }
  console.log('\nВсе три секрета в воркере. Дальше: npm run deploy');
} else {
  console.log(`
Готово. Положи три секрета в воркер — по одному, значение вводится в ответ на запрос:

  npm run secret put GOOGLE_CLIENT_ID
  ${clientId}

  npm run secret put GOOGLE_CLIENT_SECRET
  ${clientSecret}

  npm run secret put GOOGLE_REFRESH_TOKEN
  ${tok.refresh_token}

Потом: npm run deploy

(В следующий раз добавь --save — скрипт положит их сам, ничего не печатая.)
`);
}
