// Обогащение: заходит на страницу каждой вакансии, забирает полное описание
// и ключевые навыки (keySkills), плюс извлекает технологии из текста по словарю.
// Запуск: npm run enrich            — все необогащённые
//         npm run enrich -- 300     — первые 300
import { db, ensureSkill, linkVacancySkill } from './db.mjs';
import { fetchHtml, parseInitialState, htmlToText, politePause } from './hh.mjs';
import { extractSkillsFromText, normalizeHHSkill } from './skills-dict.mjs';

const limit = Number(process.argv[2]) || 1_000_000;

const pending = db
  .prepare('SELECT id, title, url FROM Vacancy WHERE enrichedAt IS NULL ORDER BY id DESC LIMIT ?')
  .all(limit);

console.log(`К обогащению: ${pending.length} вакансий`);

const markEnriched = db.prepare('UPDATE Vacancy SET description = ?, enrichedAt = ? WHERE id = ?');
let done = 0;
let failed = 0;

for (const row of pending) {
  const now = new Date().toISOString();
  try {
    const { status, html } = await fetchHtml(`https://hh.ru/vacancy/${row.id}`);
    if (status === 404 || !html) {
      markEnriched.run(null, now, row.id); // вакансия снята — помечаем, чтобы не ходить снова
      done++;
      continue;
    }
    const state = parseInitialState(html);
    const vv = state?.vacancyView;
    if (!vv) {
      markEnriched.run(null, now, row.id);
      done++;
      continue;
    }

    const description = htmlToText(vv.description || '');
    markEnriched.run(description || null, now, row.id);

    // 1) ключевые навыки, которые проставил сам работодатель
    const hhSkills = (vv.keySkills?.keySkill || []).map(normalizeHHSkill);
    for (const name of hhSkills) {
      if (name && name.length <= 60) linkVacancySkill(row.id, ensureSkill(name), 'hh');
    }
    // 2) технологии из текста описания и названия
    for (const name of extractSkillsFromText(`${row.title}\n${description}`)) {
      linkVacancySkill(row.id, ensureSkill(name), 'text');
    }

    done++;
    if (done % 25 === 0) console.log(`  …${done}/${pending.length}`);
  } catch (err) {
    failed++;
    console.error(`  ! vacancy ${row.id}: ${err.message}`);
    if (failed > 20) {
      console.error('Слишком много ошибок подряд — останавливаюсь, чтобы не долбить сайт.');
      break;
    }
  }
  await politePause();
}

console.log(`\nГотово: обогащено ${done}, ошибок ${failed}`);
const s = db.prepare('SELECT COUNT(*) AS c FROM Vacancy WHERE enrichedAt IS NOT NULL').get();
console.log(`Всего обогащено в базе: ${s.c}`);
