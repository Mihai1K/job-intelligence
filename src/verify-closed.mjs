// Проверка закрытых вакансий: активные, которых давно не видно в выдаче,
// проверяем напрямую по странице — архив/404 => событие closed.
// Мы не помечаем закрытыми всё, что не встретили в выдаче: по большим запросам
// (python, backend) мы собираем только первые страницы, и «не увидели» ≠ «закрыта».
// Запуск: node src/verify-closed.mjs [лимит]   (внутри пайплайна: RUN_ID=<id>)
import { db, addEvent } from './db.mjs';
import { fetchHtml, politePause } from './hh.mjs';

const runId = process.env.RUN_ID ? Number(process.env.RUN_ID) : null;
const limit = Number(process.argv[2]) || 150;

// кандидаты: активные, не встречались в выдаче ≥ 2 дней, давние — первыми
const staleBefore = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
const candidates = db.prepare(`
  SELECT id, title, lastSeenAt FROM Vacancy
  WHERE isActive = 1 AND lastSeenAt < ?
  ORDER BY lastSeenAt ASC LIMIT ?
`).all(staleBefore, limit);

console.log(`Кандидатов на проверку закрытия: ${candidates.length}`);

const close = db.prepare('UPDATE Vacancy SET isActive = 0, closedAt = ? WHERE id = ?');
const touch = db.prepare('UPDATE Vacancy SET lastSeenAt = ? WHERE id = ?');
let closed = 0;

for (const c of candidates) {
  const now = new Date().toISOString();
  try {
    const { status, html } = await fetchHtml(`https://hh.ru/vacancy/${c.id}`);
    const archived = status === 404 || !html || /"archived":\s*true/.test(html) || /вакансия в архиве/i.test(html);
    if (archived) {
      close.run(now, c.id);
      addEvent(c.id, runId, 'closed', null, null);
      closed++;
    } else {
      touch.run(now, c.id); // жива — просто не попала в первые страницы выдачи
    }
  } catch (err) {
    console.error(`  ! vacancy ${c.id}: ${err.message}`);
  }
  await politePause();
}

console.log(`Закрыто: ${closed} из ${candidates.length} проверенных`);
