// Экспорт очереди вакансий на AI-анализ.
// Запуск: npm run analyze:export -- 50   → ai/queue.json
// Дальше очередь анализирует Claude (Claude Code или API) и кладёт результат в ai/results.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { db } from './db.mjs';
import { projectPath } from './config.mjs';

const limit = Number(process.argv[2]) || 50;

// Берём обогащённые вакансии без анализа, разнообразно: по каждой роли поровну
const rows = db.prepare(`
  SELECT v.id, v.title, v.salaryFrom, v.salaryTo, v.currency, v.gross,
         v.experience, v.remote, v.area, v.description,
         c.name AS company,
         (SELECT GROUP_CONCAT(q.label, ', ') FROM VacancyQuery vq JOIN Query q ON q.id = vq.queryId WHERE vq.vacancyId = v.id) AS queries,
         ROW_NUMBER() OVER (PARTITION BY (SELECT MIN(vq2.queryId) FROM VacancyQuery vq2 WHERE vq2.vacancyId = v.id) ORDER BY v.publishedAt DESC) AS rn
  FROM Vacancy v
  LEFT JOIN Company c ON c.id = v.companyId
  WHERE v.description IS NOT NULL
    AND LENGTH(v.description) > 300
    AND v.id NOT IN (SELECT vacancyId FROM AIAnalysis)
  ORDER BY rn, v.publishedAt DESC
  LIMIT ?
`).all(limit);

const queue = rows.map((r) => ({
  id: r.id,
  title: r.title,
  company: r.company,
  queries: r.queries,
  salary: r.salaryFrom || r.salaryTo ? { from: r.salaryFrom, to: r.salaryTo, currency: r.currency, gross: !!r.gross } : null,
  experience: r.experience,
  remote: !!r.remote,
  area: r.area,
  description: r.description.slice(0, 6000),
}));

mkdirSync(projectPath('../ai'), { recursive: true });
const out = projectPath('../ai/queue.json');
writeFileSync(out, JSON.stringify(queue, null, 2));
console.log(`Экспортировано ${queue.length} вакансий → ${out}`);
console.log('Формат результата (ai/results.json): [{ "id", "level", "difficulty", "summary", "required_skills", "optional_skills", "roadmap", "salary_estimate" }]');
