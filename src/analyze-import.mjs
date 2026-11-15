// Импорт результатов AI-анализа из ai/results.json в таблицу AIAnalysis.
// Запуск: npm run analyze:import
import { readFileSync } from 'node:fs';
import { db } from './db.mjs';
import { projectPath } from './config.mjs';

const path = projectPath('../ai/results.json');
const results = JSON.parse(readFileSync(path, 'utf8'));

const stmt = db.prepare(`
  INSERT INTO AIAnalysis (vacancyId, level, difficulty, summary, requiredSkills, optionalSkills, roadmap, salaryEstimate, analyzedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(vacancyId) DO UPDATE SET
    level = excluded.level, difficulty = excluded.difficulty, summary = excluded.summary,
    requiredSkills = excluded.requiredSkills, optionalSkills = excluded.optionalSkills,
    roadmap = excluded.roadmap, salaryEstimate = excluded.salaryEstimate, analyzedAt = excluded.analyzedAt
`);

const now = new Date().toISOString();
let n = 0;
for (const r of results) {
  if (!r.id) continue;
  stmt.run(
    r.id,
    r.level ?? null,
    r.difficulty ?? null,
    r.summary ?? null,
    JSON.stringify(r.required_skills ?? []),
    JSON.stringify(r.optional_skills ?? []),
    JSON.stringify(r.roadmap ?? []),
    r.salary_estimate ?? null,
    now,
  );
  n++;
}
console.log(`Импортировано анализов: ${n}`);
