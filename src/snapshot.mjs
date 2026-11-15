// Дневные снимки рынка: по каждой роли и каждому навыку.
// Идемпотентно: повторный запуск за ту же дату перезаписывает снимок.
// Запуск: node src/snapshot.mjs
import { db, localDate } from './db.mjs';
import { SETTINGS } from './config.mjs';

const date = localDate();
const NET = SETTINGS.netFactor;

const salaryExpr = `
  CASE WHEN v.currency = 'RUR' AND (v.salaryMode IS NULL OR v.salaryMode = 'MONTH')
       AND (v.salaryFrom IS NOT NULL OR v.salaryTo IS NOT NULL)
  THEN (COALESCE(v.salaryFrom, v.salaryTo) + COALESCE(v.salaryTo, v.salaryFrom)) / 2.0
       * (CASE WHEN v.gross = 1 THEN ${NET} ELSE 1 END)
  ELSE NULL END
`;

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// --- снимки по ролям ---
const upsertQS = db.prepare(`
  INSERT INTO QuerySnapshot (date, queryId, totalFound, activeCount, medianSalary, remoteShare)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(date, queryId) DO UPDATE SET
    totalFound = excluded.totalFound, activeCount = excluded.activeCount,
    medianSalary = excluded.medianSalary, remoteShare = excluded.remoteShare
`);

const queries = db.prepare('SELECT id, label, totalFound FROM Query').all();
for (const q of queries) {
  const rows = db.prepare(`
    SELECT ${salaryExpr} AS sal, v.remote
    FROM Vacancy v JOIN VacancyQuery vq ON vq.vacancyId = v.id
    WHERE vq.queryId = ? AND v.isActive = 1
  `).all(q.id);
  const sals = rows.map((r) => r.sal).filter((x) => x != null);
  const remoteShare = rows.length ? rows.filter((r) => r.remote).length / rows.length : null;
  upsertQS.run(date, q.id, q.totalFound ?? null, rows.length, median(sals), remoteShare);
}

// --- снимки по навыкам ---
const activeEnriched = db.prepare(
  'SELECT COUNT(*) c FROM Vacancy WHERE isActive = 1 AND enrichedAt IS NOT NULL AND description IS NOT NULL',
).get().c;

const upsertSS = db.prepare(`
  INSERT INTO SkillSnapshot (date, skillId, cnt, activeEnriched)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(date, skillId) DO UPDATE SET cnt = excluded.cnt, activeEnriched = excluded.activeEnriched
`);

const skillCounts = db.prepare(`
  SELECT vs.skillId, COUNT(DISTINCT vs.vacancyId) AS cnt
  FROM VacancySkill vs
  JOIN Vacancy v ON v.id = vs.vacancyId
  WHERE v.isActive = 1 AND v.enrichedAt IS NOT NULL
  GROUP BY vs.skillId
`).all();

for (const s of skillCounts) upsertSS.run(date, s.skillId, s.cnt, activeEnriched);

console.log(`Снимок за ${date}: ${queries.length} ролей, ${skillCounts.length} навыков (обогащённых активных: ${activeEnriched})`);
