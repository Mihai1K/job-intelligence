// Коллектор: обходит поисковую выдачу hh.ru и пишет события (new / salary_changed / reopened).
// Запуск отдельно: npm run collect
// Внутри пайплайна: RUN_ID=<id> node src/collect.mjs (запуск уже создан оркестратором)
import { QUERIES, SETTINGS } from './config.mjs';
import {
  db, upsertCompany, upsertVacancy, ensureQuery, linkVacancyQuery,
  startRun, finishRun, bumpRun, addEvent,
} from './db.mjs';
import { fetchHtml, parseInitialState, normalizeVacancy, politePause } from './hh.mjs';

const runId = process.env.RUN_ID ? Number(process.env.RUN_ID) : startRun('collect (ручной запуск)');
const standalone = !process.env.RUN_ID;
const now = () => new Date().toISOString();

const getExisting = db.prepare('SELECT id, salaryFrom, salaryTo, currency, isActive FROM Vacancy WHERE id = ?');
const touch = db.prepare('UPDATE Vacancy SET lastSeenAt = ?, isActive = 1, closedAt = NULL WHERE id = ?');

const salaryKey = (v) => JSON.stringify({ from: v.salaryFrom ?? null, to: v.salaryTo ?? null, cur: v.currency ?? null });

for (const q of QUERIES) {
  const queryId = ensureQuery(q);
  let queryCount = 0;
  let totalFound = null;

  for (let page = 0; page < SETTINGS.maxPagesPerQuery; page++) {
    const url =
      'https://hh.ru/search/vacancy?' +
      new URLSearchParams({
        text: q.searchText,
        search_field: 'name',
        area: String(SETTINGS.area),
        page: String(page),
      });

    let state;
    try {
      const { html } = await fetchHtml(url);
      state = html && parseInitialState(html);
    } catch (err) {
      console.error(`  ! ${q.label} стр.${page}: ${err.message}`);
      bumpRun(runId, 'errorCount');
      break;
    }

    const vsr = state?.vacancySearchResult;
    if (!vsr || !Array.isArray(vsr.vacancies) || vsr.vacancies.length === 0) break;

    if (totalFound === null) {
      totalFound = vsr.totalResults ?? null;
      db.prepare('UPDATE Query SET totalFound = ? WHERE id = ?').run(totalFound, queryId);
    }

    for (const raw of vsr.vacancies) {
      if (raw['@isAdv']) continue; // рекламные врезки не считаем рынком
      const v = normalizeVacancy(raw, now());
      const existing = getExisting.get(v.id);

      if (v.company) upsertCompany(v.company);

      if (!existing) {
        upsertVacancy(v);
        db.prepare('UPDATE Vacancy SET firstSeenAt = ?, lastSeenAt = ?, isActive = 1 WHERE id = ?')
          .run(v.collectedAt, v.collectedAt, v.id);
        addEvent(v.id, runId, 'new', null, v.title);
      } else {
        const oldSalary = salaryKey(existing);
        const newSalary = salaryKey(v);
        if (oldSalary !== newSalary) {
          addEvent(v.id, runId, 'salary_changed', oldSalary, newSalary);
        }
        if (!existing.isActive) {
          addEvent(v.id, runId, 'reopened', null, null);
        }
        upsertVacancy(v);
        touch.run(v.collectedAt, v.id);
      }

      linkVacancyQuery(v.id, queryId);
      queryCount++;
      bumpRun(runId, 'seen');
    }

    const next = vsr.paging?.next;
    if (!next || next.disabled) break;
    await politePause();
  }

  console.log(`✓ ${q.label}: обработано ${queryCount}, всего на hh: ${totalFound ?? '?'}`);
  await politePause();
}

if (standalone) finishRun(runId, 'ok');
const run = db.prepare('SELECT * FROM CollectionRun WHERE id = ?').get(runId);
console.log(`\nЗапуск #${runId}: обработано ${run.seen}, ошибок ${run.errorCount}`);
