#!/usr/bin/env node
'use strict';
// Командная строка для Вех. Нужны переменные ROADMAP_URL и ROADMAP_TOKEN
// (токен создаётся в приложении: Настройки → CLI и API).
const fs = require('node:fs');

const URL_ = (process.env.ROADMAP_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.ROADMAP_TOKEN;

const HELP = `Вехи CLI

  roadmap list                          список карт
  roadmap import <file.json|->          создать карту из JSON (- читает stdin)
  roadmap export <id> [--md] [-o file]  выгрузить карту в JSON или Markdown
  roadmap delete <id>                   удалить карту
  roadmap format                        показать пример формата JSON

Переменные окружения:
  ROADMAP_URL    адрес сервера, сейчас ${URL_}
  ROADMAP_TOKEN  токен из «Настройки → CLI и API»`;

const SAMPLE = {
  name: 'Релиз 1.0',
  stages: [
    { id: 'm0', lane: 'Владелец', title: 'Аккаунт и ранние шаги', desc: 'Что нужно в первую неделю', status: 'active', due: '2026-11-20', priority: 'high', subtasks: ['Завести аккаунт', { t: 'Проверить доступы', done: true, c: ['Сервер', 'Репозиторий'] }] },
    { id: 'm1', lane: 'Параллельно', title: 'Лицензии и ассеты', subtasks: ['Реестр ассетов'] },
  ],
  links: [{ from: 'm0', to: 'm1', style: 'dashed', label: 'параллельно' }],
};

async function call(method, path, body) {
  if (!TOKEN) die('Задайте ROADMAP_TOKEN. Токен создаётся в приложении: Настройки → CLI и API.');
  const r = await fetch(URL_ + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => die(`Не удалось подключиться к ${URL_}: ${e.message}`));
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) die(data?.error || `Ошибка ${r.status}`);
  return data;
}
function die(msg) { console.error(msg); process.exit(1); }
const readInput = (f) => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8'));

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  switch (cmd) {
    case 'list': {
      const { maps } = await call('GET', '/api/maps');
      if (!maps.length) return console.log('Карт пока нет.');
      for (const m of maps) console.log(`${m.id}  ${String(m.done + '/' + m.total).padStart(6)}  ${m.name}`);
      break;
    }
    case 'import': {
      if (!args[0]) die('Укажите файл: roadmap import plan.json');
      let json; try { json = JSON.parse(readInput(args[0])); } catch (e) { die('Файл не похож на корректный JSON: ' + e.message); }
      const { map } = await call('POST', '/api/maps/import', json);
      console.log(`Создана карта «${map.name}»: ${map.total} этапов`);
      console.log(`${URL_}/#${map.id}`);
      break;
    }
    case 'export': {
      if (!args[0]) die('Укажите id карты: roadmap export <id>');
      const md = flag('--md');
      const data = await call('GET', `/api/maps/${args[0]}/export${md ? '?format=md' : ''}`);
      const out = md ? data : JSON.stringify(data, null, 2);
      if (opt('-o')) { fs.writeFileSync(opt('-o'), out); console.log('Сохранено в ' + opt('-o')); } else process.stdout.write(out + '\n');
      break;
    }
    case 'delete': {
      if (!args[0]) die('Укажите id карты');
      await call('DELETE', `/api/maps/${args[0]}`);
      console.log('Карта удалена');
      break;
    }
    case 'format': console.log(JSON.stringify(SAMPLE, null, 2)); break;
    default: console.log(HELP);
  }
})();
