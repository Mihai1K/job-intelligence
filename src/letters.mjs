// Черновики сопроводительных писем под каждую совпавшую вакансию.
// Собираются ТОЛЬКО из данных твоего профиля и совпавших навыков — ничего не выдумывается.
// Это база; более «живые» письма можно потом генерировать через LLM (тот же export/import).
// Запуск: npm run letters
import { readFileSync } from 'node:fs';
import { db } from './db.mjs';
import { projectPath } from './config.mjs';

const profile = JSON.parse(readFileSync(projectPath('../profile.json'), 'utf8'));

const rows = db.prepare(`
  SELECT a.vacancyId, a.reasons, v.title, c.name AS company
  FROM Application a
  JOIN Vacancy v ON v.id = a.vacancyId
  LEFT JOIN Company c ON c.id = v.companyId
  WHERE a.status = 'matched'
`).all();

const update = db.prepare('UPDATE Application SET coverLetter = ? WHERE vacancyId = ?');

// Люди «палят» ИИ по длинному тире (— и –). Убираем его из писем:
// « X — Y » → « X, Y », а одиночные остатки → обычный дефис. Пунктуация остаётся живой.
function deDash(s) {
  return s
    .replace(/ *[—–] +/g, ', ')  // тире-разделитель между словами → запятая
    .replace(/[—–]/g, '-');       // любой оставшийся длинный/средний штрих → дефис
}

// Живой человек не пишет «Команда X, здравствуйте!» и не цитирует название вакансии
// в кавычках — это шаблонные обороты, по которым узнают форму/ИИ. Вместо этого —
// несколько естественных вариантов приветствия и упоминания роли, без формального
// обращения к компании по имени и без дословной цитаты заголовка.
function hashPick(arr, seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return arr[h % arr.length];
}

// r — объект {matched, learnable}, не строка JSON. Экспортируется — используется и
// пакетной генерацией ниже, и /api/letter в cockpit.mjs для расширения.
export function buildLetter(title, company, r) {
  const matched = (r.matched || []).filter((s) => s.toLowerCase() !== 'api-интеграции');
  const skillsLine = matched.length
    ? `Из требований мне близки: ${matched.slice(0, 6).join(', ')}.`
    : '';
  const learn = (r.learnable || []).length
    ? ` Активно осваиваю ${r.learnable.slice(0, 3).join(', ')}, быстро подтяну недостающее.`
    : '';
  const hi = (profile.highlights || []).slice(0, 2).map((h) => `• ${deDash(h)}`).join('\n');

  const seed = `${title}|${company || ''}`;
  const closer = hashPick([
    'Буду рад обсудить детали и показать свои проекты.',
    'С удовольствием расскажу подробнее и покажу, что уже делал.',
    'Готов обсудить детали в удобное время.',
  ], seed + 'c');
  const firstName = (profile.name || '').split(' ')[0];

  const letter = `Здравствуйте! Заинтересовала ваша вакансия. ${deDash(profile.pitch)}

${skillsLine}${learn}

Что могу принести:
${hi}

${closer}${profile.hhResumeUrl ? ` Резюме: ${profile.hhResumeUrl}` : ''}

${firstName}`;

  return deDash(letter).replace(/\n{3,}/g, '\n\n'); // без «дырявых» пустых абзацев
}

let n = 0;
for (const row of rows) {
  update.run(buildLetter(row.title, row.company, JSON.parse(row.reasons)), row.vacancyId);
  n++;
}

console.log(`Черновики писем готовы: ${n}`);
