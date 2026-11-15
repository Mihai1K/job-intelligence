// Resume Optimizer: под каждую совпавшую вакансию адаптирует резюме под её требования.
// Что делает (детерминированно, ничего не выдумывая сверх профиля):
//   1) summary — акцент на навыках, которые нужны именно этой вакансии;
//   2) ключевые навыки — сначала совпавшие с вакансией, потом остальные;
//   3) опыт — пункты переупорядочены: релевантные вакансии сверху.
// Запуск: npm run resume
import { readFileSync } from 'node:fs';
import { db } from './db.mjs';
import { projectPath } from './config.mjs';

const profile = JSON.parse(readFileSync(projectPath('../profile.json'), 'utf8'));
const experience = profile.experience || [];

const rows = db.prepare(`
  SELECT a.vacancyId, a.reasons, v.title
  FROM Application a JOIN Vacancy v ON v.id = a.vacancyId
  WHERE a.status = 'matched'
`).all();

const update = db.prepare('UPDATE Application SET tailoredResume = ? WHERE vacancyId = ?');

// сколько тегов пункта опыта совпадает с требованиями вакансии
function relevance(exp, wantSet) {
  return (exp.tags || []).filter((t) => wantSet.has(t.toLowerCase())).length;
}

// r — объект {matched, missing}, не строка JSON. Экспортируется — используется и
// пакетной адаптацией ниже, и /api/resume в cockpit.mjs для расширения.
export function tailor(title, r) {
  const matched = (r.matched || []).filter((s) => s.toLowerCase() !== 'api-интеграции');
  // всё, что вакансия хочет (совпавшее + недостающее) — по этому ранжируем опыт
  const wantSet = new Set([...(r.matched || []), ...(r.missing || [])].map((s) => s.toLowerCase()));

  const summary = matched.length
    ? `${profile.pitch} Под роль «${title}» особенно релевантно: ${matched.slice(0, 5).join(', ')}.`
    : profile.pitch;

  // навыки: совпавшие с вакансией вперёд
  const profSkills = profile.skills;
  const matchedLower = new Set(matched.map((s) => s.toLowerCase()));
  const keySkills = [
    ...profSkills.filter((s) => matchedLower.has(s.toLowerCase())),
    ...profSkills.filter((s) => !matchedLower.has(s.toLowerCase())),
  ];

  // опыт: по релевантности к вакансии (стабильная сортировка сохраняет исходный порядок при равенстве)
  const ranked = experience
    .map((exp, i) => ({ exp, i, rel: relevance(exp, wantSet) }))
    .sort((a, b) => b.rel - a.rel || a.i - b.i)
    .map(({ exp, rel }) => ({ bullet: exp.bullet, highlighted: rel > 0 }));

  return { summary, keySkills, experience: ranked };
}

let n = 0;
for (const row of rows) {
  update.run(JSON.stringify(tailor(row.title, JSON.parse(row.reasons || '{}'))), row.vacancyId);
  n++;
}

console.log(`Адаптированных резюме готово: ${n}`);
if (!experience.length) {
  console.log('⚠ В profile.json нет блока experience — резюме адаптируется только по summary и навыкам. Добавь опыт для полной адаптации.');
}
