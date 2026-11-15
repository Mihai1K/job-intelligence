// Генератор дашборда: агрегаты из SQLite → dashboard/index.html (самодостаточный файл)
// Запуск: npm run report
import { writeFileSync, mkdirSync } from 'node:fs';
import { db, lastFinishedRun, localDate } from './db.mjs';
import { SETTINGS, projectPath } from './config.mjs';

const NET = SETTINGS.netFactor;

// ---------- агрегаты ----------

// зарплата к «чистыми в месяц»: только RUR и месячный режим
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

const allSalaries = db.prepare(`SELECT ${salaryExpr} AS sal FROM Vacancy v`).all()
  .map((r) => r.sal).filter((x) => x != null);

const overview = {
  vacancies: db.prepare('SELECT COUNT(*) c FROM Vacancy').get().c,
  companies: db.prepare('SELECT COUNT(DISTINCT companyId) c FROM Vacancy WHERE companyId IS NOT NULL').get().c,
  enriched: db.prepare('SELECT COUNT(*) c FROM Vacancy WHERE enrichedAt IS NOT NULL').get().c,
  withSalary: allSalaries.length,
  medianSalary: median(allSalaries),
  remoteShare: db.prepare('SELECT AVG(remote) s FROM Vacancy').get().s,
  noExpShare: db.prepare(`SELECT AVG(CASE WHEN experience='noExperience' THEN 1.0 ELSE 0 END) s FROM Vacancy`).get().s,
  analyzed: db.prepare('SELECT COUNT(*) c FROM AIAnalysis').get().c,
  generatedAt: new Date().toISOString(),
};

// по ролям (запросам)
const roleRows = db.prepare(`
  SELECT q.label, q.category, q.totalFound, COUNT(vq.vacancyId) AS cnt,
         AVG(v.remote) AS remoteShare,
         AVG(CASE WHEN v.experience IN ('noExperience','between1And3') THEN 1.0 ELSE 0 END) AS entryShare
  FROM Query q
  LEFT JOIN VacancyQuery vq ON vq.queryId = q.id
  LEFT JOIN Vacancy v ON v.id = vq.vacancyId
  GROUP BY q.id ORDER BY cnt DESC
`).all();

const roles = roleRows.map((r) => {
  const sals = db.prepare(`
    SELECT ${salaryExpr} AS sal FROM Vacancy v
    JOIN VacancyQuery vq ON vq.vacancyId = v.id
    JOIN Query q ON q.id = vq.queryId WHERE q.label = ?
  `).all(r.label).map((x) => x.sal).filter((x) => x != null);
  return {
    label: r.label, category: r.category, totalFound: r.totalFound, count: r.cnt,
    medianSalary: median(sals), salaryN: sals.length,
    remoteShare: r.remoteShare, entryShare: r.entryShare,
  };
});

// топ навыков (по обогащённым вакансиям)
const skillRows = db.prepare(`
  SELECT s.name, COUNT(*) AS cnt
  FROM VacancySkill vs JOIN Skill s ON s.id = vs.skillId
  GROUP BY s.id ORDER BY cnt DESC LIMIT 30
`).all();

const skillsByCategory = {};
for (const cat of ['AI и разработка', 'Автоматизация']) {
  skillsByCategory[cat] = db.prepare(`
    SELECT s.name, COUNT(DISTINCT vs.vacancyId) AS cnt
    FROM VacancySkill vs
    JOIN Skill s ON s.id = vs.skillId
    JOIN VacancyQuery vq ON vq.vacancyId = vs.vacancyId
    JOIN Query q ON q.id = vq.queryId
    WHERE q.category = ?
    GROUP BY s.id ORDER BY cnt DESC LIMIT 15
  `).all(cat);
}

// опыт: распределение и медианная зарплата
const expOrder = ['noExperience', 'between1And3', 'between3And6', 'moreThan6'];
const expLabels = { noExperience: 'Без опыта', between1And3: '1–3 года', between3And6: '3–6 лет', moreThan6: '6+ лет' };
const experience = expOrder.map((code) => {
  const cnt = db.prepare('SELECT COUNT(*) c FROM Vacancy WHERE experience = ?').get(code).c;
  const sals = db.prepare(`SELECT ${salaryExpr} AS sal FROM Vacancy v WHERE v.experience = ?`).all(code)
    .map((x) => x.sal).filter((x) => x != null);
  return { code, label: expLabels[code], count: cnt, medianSalary: median(sals) };
});

// гистограмма зарплат
const buckets = [
  { label: 'до 100', max: 100_000 }, { label: '100–150', max: 150_000 },
  { label: '150–200', max: 200_000 }, { label: '200–250', max: 250_000 },
  { label: '250–300', max: 300_000 }, { label: '300–400', max: 400_000 },
  { label: '400+', max: Infinity },
];
const histogram = buckets.map((b) => ({ label: b.label, count: 0 }));
for (const s of allSalaries) {
  const i = buckets.findIndex((b) => s < b.max);
  histogram[i === -1 ? buckets.length - 1 : i].count++;
}

// топ работодателей
const employers = db.prepare(`
  SELECT c.name, c.accreditedIT, COUNT(*) AS cnt
  FROM Vacancy v JOIN Company c ON c.id = v.companyId
  GROUP BY c.id ORDER BY cnt DESC LIMIT 12
`).all();

// «точки входа»: junior-friendly + удалёнка + зарплата указана
const entryPoints = db.prepare(`
  SELECT v.title, v.url, v.area, v.salaryFrom, v.salaryTo, v.currency, v.gross, v.experience,
         c.name AS company, ${salaryExpr} AS sal
  FROM Vacancy v LEFT JOIN Company c ON c.id = v.companyId
  WHERE v.experience IN ('noExperience', 'between1And3') AND v.remote = 1 AND sal IS NOT NULL
  ORDER BY sal DESC LIMIT 15
`).all();

// AI-анализ: примеры карточек
const aiCards = db.prepare(`
  SELECT a.*, v.title, v.url, c.name AS company
  FROM AIAnalysis a JOIN Vacancy v ON v.id = a.vacancyId
  LEFT JOIN Company c ON c.id = v.companyId
  ORDER BY a.analyzedAt DESC LIMIT 12
`).all().map((r) => ({
  ...r,
  requiredSkills: JSON.parse(r.requiredSkills || '[]'),
  optionalSkills: JSON.parse(r.optionalSkills || '[]'),
  roadmap: JSON.parse(r.roadmap || '[]'),
}));

const aiLevels = db.prepare(`
  SELECT level, COUNT(*) c FROM AIAnalysis WHERE level IS NOT NULL GROUP BY level
`).all();

// ---------- статус последнего сбора ----------
const lastRun = lastFinishedRun();

// ---------- динамика: сравнение снимков (7/30/90 дней или сколько есть) ----------
const snapshotDates = db.prepare('SELECT DISTINCT date FROM QuerySnapshot ORDER BY date').all().map((r) => r.date);
const latestDate = snapshotDates[snapshotDates.length - 1] ?? null;

// ближайший снимок, который старше latest хотя бы на daysBack (или самый старый доступный)
function baselineDate(daysBack) {
  if (!latestDate || snapshotDates.length < 2) return null;
  const target = new Date(new Date(latestDate + 'T00:00:00').getTime() - daysBack * 86400000)
    .toLocaleDateString('sv-SE');
  const older = snapshotDates.filter((d) => d <= target);
  return older.length ? older[older.length - 1] : snapshotDates[0] !== latestDate ? snapshotDates[0] : null;
}

function roleTrends(daysBack) {
  const base = baselineDate(daysBack);
  if (!base || base === latestDate) return null;
  const rows = db.prepare(`
    SELECT q.label, cur.totalFound AS now, old.totalFound AS was,
           cur.medianSalary AS salNow, old.medianSalary AS salWas
    FROM QuerySnapshot cur
    JOIN QuerySnapshot old ON old.queryId = cur.queryId AND old.date = ?
    JOIN Query q ON q.id = cur.queryId
    WHERE cur.date = ? AND cur.totalFound IS NOT NULL AND old.totalFound IS NOT NULL AND old.totalFound > 0
  `).all(base, latestDate);
  return {
    base,
    rows: rows
      .map((r) => ({ ...r, deltaPct: ((r.now - r.was) / r.was) * 100 }))
      .sort((a, b) => b.deltaPct - a.deltaPct),
  };
}

function skillTrends(daysBack, minCnt = 8) {
  const base = baselineDate(daysBack);
  if (!base || base === latestDate) return null;
  const rows = db.prepare(`
    SELECT s.name,
           cur.cnt AS now, CAST(cur.cnt AS REAL) / cur.activeEnriched AS shareNow,
           old.cnt AS was, CAST(old.cnt AS REAL) / old.activeEnriched AS shareWas
    FROM SkillSnapshot cur
    JOIN SkillSnapshot old ON old.skillId = cur.skillId AND old.date = ?
    JOIN Skill s ON s.id = cur.skillId
    WHERE cur.date = ? AND cur.cnt >= ? AND old.activeEnriched > 50
  `).all(base, latestDate, minCnt);
  return {
    base,
    rows: rows
      .map((r) => ({ ...r, deltaPp: (r.shareNow - r.shareWas) * 100 }))
      .sort((a, b) => b.deltaPp - a.deltaPp),
  };
}

const trends = {
  historyDays: snapshotDates.length,
  firstDate: snapshotDates[0] ?? null,
  latestDate,
  roles7: roleTrends(7),
  roles30: roleTrends(30),
  skills7: skillTrends(7),
  skills30: skillTrends(30),
};

// история общего числа вакансий по датам (для мини-графика)
const marketHistory = db.prepare(`
  SELECT date, SUM(totalFound) AS total FROM QuerySnapshot GROUP BY date ORDER BY date
`).all();

// ---------- выводы и сводка (считаются из данных при каждой пересборке) ----------

// «Если начинать сегодня»: роль с лучшим балансом зарплаты, спроса и входа
const startCandidates = roles.filter((r) => r.medianSalary && r.salaryN >= 5 && r.totalFound >= 50);
const bestStart = startCandidates
  .map((r) => ({ ...r, score: r.medianSalary / 1000 + r.totalFound / 10 + (r.entryShare ?? 0) * 100 + (r.remoteShare ?? 0) * 50 }))
  .sort((a, b) => b.score - a.score)[0] ?? null;

const roleSkillRows = bestStart ? db.prepare(`
  SELECT s.name, COUNT(DISTINCT vs.vacancyId) AS cnt
  FROM VacancySkill vs
  JOIN Skill s ON s.id = vs.skillId
  JOIN VacancyQuery vq ON vq.vacancyId = vs.vacancyId
  JOIN Query q ON q.id = vq.queryId
  WHERE q.label = ? AND s.name NOT IN ('API-интеграции', 'Git', 'REST API', 'SQL', 'Agile/Scrum', 'HTML/CSS')
  GROUP BY s.id ORDER BY cnt DESC LIMIT 12
`).all(bestStart.label) : [];

// путь обучения всегда начинается с самого частого языка роли
const LANGS = new Set(['Python', 'JavaScript', 'TypeScript', 'Java', 'Go', 'C#', 'C++', 'PHP', 'Kotlin', 'Swift', '1С']);
const topLang = roleSkillRows.find((s) => LANGS.has(s.name));
const bestStartSkills = bestStart
  ? [...(topLang ? [topLang] : []), ...roleSkillRows.filter((s) => !LANGS.has(s.name))].slice(0, 5)
  : [];

// выводы по блокам
const salarySorted = roles.filter((r) => r.medianSalary != null && r.salaryN >= 5).sort((a, b) => b.medianSalary - a.medianSalary);
const topRole = salarySorted[0];
const bottomRole = salarySorted[salarySorted.length - 1];
const salaryGapPct = topRole && bottomRole ? Math.round(((topRole.medianSalary - bottomRole.medianSalary) / bottomRole.medianSalary) * 100) : null;

let expJump = null;
for (let i = 1; i < experience.length; i++) {
  const a = experience[i - 1], b = experience[i];
  if (a.medianSalary && b.medianSalary) {
    const d = b.medianSalary - a.medianSalary;
    if (!expJump || d > expJump.delta) expJump = { from: a.label, to: b.label, delta: d };
  }
}

const llmRank = skillRows.findIndex((s) => s.name === 'LLM') + 1;
const llmCount = db.prepare(`
  SELECT COUNT(DISTINCT vq.vacancyId) c FROM VacancyQuery vq JOIN Query q ON q.id = vq.queryId WHERE q.label = 'LLM Engineer'
`).get().c;
const totalSkills = db.prepare('SELECT COUNT(*) c FROM Skill').get().c;

// достоверность вывода по размеру выборки
const starsOf = (n) => (n >= 300 ? 5 : n >= 150 ? 4 : n >= 75 ? 3 : n >= 30 ? 2 : 1);
const stars = (n) => '★'.repeat(starsOf(n)) + '☆'.repeat(5 - starsOf(n));

// ROI обучения: прирост зарплаты считаем из данных (медиана вакансий с навыком vs рынок),
// время освоения — модельная оценка
const ROI_SKILLS = [
  { name: 'Docker', weeks: 2 }, { name: 'PostgreSQL', weeks: 3 }, { name: 'FastAPI', weeks: 3 },
  { name: 'Redis', weeks: 2 }, { name: 'Kubernetes', weeks: 8 }, { name: 'LLM', weeks: 4 },
  { name: 'CI/CD', weeks: 2 }, { name: 'Kafka', weeks: 4 },
];
const roiRows = ROI_SKILLS.map(({ name, weeks }) => {
  const sals = db.prepare(`
    SELECT ${salaryExpr} AS sal FROM Vacancy v
    JOIN VacancySkill vs ON vs.vacancyId = v.id
    JOIN Skill s ON s.id = vs.skillId WHERE s.name = ?
  `).all(name).map((r) => r.sal).filter((x) => x != null);
  const med = median(sals);
  const uplift = med != null && overview.medianSalary != null ? med - overview.medianSalary : null;
  const perWeek = uplift != null ? uplift / 1000 / weeks : null;
  return {
    name, weeks, n: sals.length, uplift,
    roi: perWeek == null ? null : perWeek >= 8 ? 'Очень высокий' : perWeek >= 4 ? 'Высокий' : 'Средний',
  };
}).filter((r) => r.uplift != null && r.uplift > 0 && r.n >= 10).sort((a, b) => (b.uplift / b.weeks) - (a.uplift / a.weeks));

const data = { overview, lastRun, trends, marketHistory, roles, skills: skillRows, skillsByCategory, experience, histogram, employers, entryPoints, aiCards, aiLevels, bestStart, bestStartSkills };

// ---------- рендер ----------

const fmtK = (n) => (n == null ? '—' : `${Math.round(n / 1000)} 000 ₽`);
const fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
// hh отдаёт названия с HTML-сущностями (&amp;, &quot;) — сначала декодируем, потом экранируем сами
const decode = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const esc = (s) => decode(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const hbar = (rows, { valueOf, labelOf, format, sub }) => {
  const max = Math.max(...rows.map(valueOf).filter((x) => x != null), 1);
  return rows.map((r) => {
    const v = valueOf(r);
    const w = v == null ? 0 : Math.max(2, (v / max) * 100);
    return `
      <div class="hrow" data-tip="${esc(labelOf(r))}: ${esc(format(v, r))}${sub ? ' · ' + esc(sub(r)) : ''}">
        <div class="hlabel">${esc(labelOf(r))}</div>
        <div class="htrack"><div class="hfill" style="width:${w.toFixed(1)}%"></div></div>
        <div class="hvalue">${esc(format(v, r))}</div>
      </div>`;
  }).join('');
};

const roleSalary = roles.filter((r) => r.medianSalary != null && r.salaryN >= 5).sort((a, b) => b.medianSalary - a.medianSalary);

const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

const statusLabel = lastRun && lastRun.status === 'broken'
  ? ' · <b>⛔ СБОР НАРУШЕН — данные не обновлялись, вакансии не трогали</b>'
  : (lastRun && lastRun.status !== 'ok' ? ' · <b>с ошибками</b>' : '');
const statusBlock = lastRun ? `
  <div class="status ${lastRun.status === 'ok' ? '' : 'bad'}">
    <span><b>Последний ${lastRun.status === 'ok' ? 'успешный ' : ''}сбор:</b> ${fmtDT(lastRun.finishedAt)}${statusLabel}</span>
    <span>Собрано: <b>${lastRun.seen.toLocaleString('ru-RU')}</b></span>
    <span>Новых: <b>${lastRun.newCount}</b></span>
    <span>Обновлено: <b>${lastRun.updatedCount}</b></span>
    <span>Закрыто: <b>${lastRun.closedCount}</b></span>
    <span>Ошибок: <b>${lastRun.errorCount}</b></span>
  </div>` : '';

// стрелка тренда: рост — хорошо (зелёный), падение — красный
const arrow = (v, unit = '%') => {
  if (v == null) return '—';
  const s = v >= 0.05 ? '▲' : v <= -0.05 ? '▼' : '≈';
  const cls = v >= 0.05 ? 'up' : v <= -0.05 ? 'down' : 'flat';
  return `<span class="delta ${cls}">${s} ${v > 0 ? '+' : ''}${v.toFixed(1)}${unit}</span>`;
};

// сводка рынка: генерируется из данных при каждой пересборке
function summaryBlock() {
  const topRoles = [...roles].filter((r) => r.totalFound).sort((a, b) => b.totalFound - a.totalFound).slice(0, 3);
  const path = bestStartSkills.slice(0, 4).map((s) => s.name).join(' → ');
  return `
  <div class="panel hero">
    <div class="wow">🤖 AI проанализировал <b>${(lastRun?.seen ?? overview.vacancies).toLocaleString('ru-RU')}</b> вакансий и нашёл <b>${totalSkills.toLocaleString('ru-RU')}</b> уникальных навыков</div>
    <p>Больше всего рынок сейчас нанимает: <b>${topRoles.map((r) => esc(r.label)).join(', ')}</b>.
    Удалёнка доступна в <b>${fmtPct(overview.remoteShare)}</b> вакансий, но позиций «без опыта» всего <b>${fmtPct(overview.noExpShare)}</b> — вход через стажировки закрыт, реальная точка входа — junior-роли с 1–3 годами практики или собственными проектами.</p>
    <p>AI-навыки перестали быть нишей: <b>LLM уже ${llmRank ? `на ${llmRank}-м месте` : 'в топе'}</b> среди всех технологий рынка <span class="conf">${stars(llmCount)} · ${llmCount} вакансий</span>, а LLM Engineer — самая высокооплачиваемая роль выборки (${fmtK(topRole?.medianSalary)}).
    Самый короткий путь для старта сегодня: <b>${path || 'Python → FastAPI → Docker → PostgreSQL'}</b> <span class="conf">${stars(bestStart?.totalFound ?? 0)} · ${bestStart?.totalFound ?? '?'} вакансий</span>.</p>
  </div>`;
}

// ROI обучения: что выучить, чтобы вырасти в деньгах быстрее всего
function roiBlock() {
  if (!roiRows.length) return '';
  return `
  <h2>ROI обучения <span style="color:var(--muted); font-weight:400; font-size:13px">(прирост — из данных: медиана вакансий с навыком против рынка; сроки — оценка модели)</span></h2>
  <div class="panel">
    <table>
      <tr><th>Навык</th><th style="text-align:right">Освоение</th><th style="text-align:right">Прирост к медиане</th><th style="text-align:right">ROI</th><th style="text-align:right">Достоверность</th></tr>
      ${roiRows.map((r) => `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">~${r.weeks} нед.</td>
        <td class="num">+${Math.round(r.uplift / 1000)} тыс. ₽</td>
        <td class="num">${r.roi}</td>
        <td class="num"><span class="conf">${stars(r.n)} · ${r.n}</span></td>
      </tr>`).join('')}
    </table>
    <p style="color:var(--muted); font-size:12.5px; margin-top:10px">Прирост — корреляция, а не гарантия: часть разницы объясняется тем, что навык чаще встречается в senior-вакансиях.</p>
  </div>`;
}

// «Если начинать сегодня» — расчёт из данных + модельные оценки (помечены)
function startTodayBlock() {
  if (!bestStart) return '';
  return `
  <h2>Если начинать сегодня</h2>
  <div class="cards">
    <div class="card"><div class="label">Самое выгодное направление</div><div class="value" style="font-size:22px">${esc(bestStart.label)}</div><div class="note">${bestStart.totalFound.toLocaleString('ru-RU')} вакансий на hh</div></div>
    <div class="card"><div class="label">Медианная зарплата</div><div class="value">${fmtK(bestStart.medianSalary)}</div><div class="note">на руки, по ${bestStart.salaryN} вакансиям</div></div>
    <div class="card"><div class="label">Удалёнка</div><div class="value">${fmtPct(bestStart.remoteShare)}</div><div class="note">опыт до 3 лет: ${fmtPct(bestStart.entryShare)} вакансий</div></div>
    <div class="card"><div class="label">До первого оффера</div><div class="value">6–10 мес</div><div class="note">оценка модели при ~10 ч обучения в неделю</div></div>
  </div>
  <div class="panel" style="margin-top:12px">
    <b style="font-size:13.5px">Что учить (по частоте в вакансиях этой роли):</b>
    <div style="margin-top:8px">${bestStartSkills.map((s) => `<span class="pill req">${esc(s.name)} · ${s.cnt}</span>`).join('')}</div>
  </div>`;
}

// выводы собираются в список для режима «Только выводы»; n — размер выборки для доверия
const insights = [];
const conclusion = (text, n = null) => {
  const conf = n ? ` <span class="conf">${stars(n)} · ${n.toLocaleString('ru-RU')} вак.</span>` : '';
  insights.push(text + conf);
  return `<div class="conclusion"><b>Вывод:</b> ${text}${conf}</div>`;
};

function forecastBlock() {
  return `
  <h2>Куда движется рынок <span style="color:var(--muted); font-weight:400; font-size:13px">(прогноз модели Claude, не данные — обновляется при AI-анализе)</span></h2>
  <div class="panel">
    <p style="color:var(--ink-2)">Судя по составу свежих вакансий (LLM в топ-15, отдельные роли «AI-инженер по оценке качества», «Prompt Engineer», спрос на агентные системы), в ближайший год сильнее всего вырастут:</p>
    <div style="margin-top:10px">
      ${['AI-агенты и tool calling', 'LLM Evaluation (Ragas, LangSmith)', 'MCP и интеграции моделей', 'RAG-пайплайны', 'AI-автоматизация процессов (n8n, Claude Code)'].map((s) => `<span class="pill req">${s}</span>`).join('')}
    </div>
    <p style="color:var(--muted); font-size:12.5px; margin-top:10px">Прогноз станет проверяемым: ежедневные снимки навыков уже копятся, и через месяц здесь будут реальные кривые роста вместо экспертной оценки.</p>
  </div>`;
}

function trendsBlock() {
  if (!trends.roles7) {
    return `
  <h2>Динамика рынка</h2>
  <div class="panel">
    <p style="color:var(--ink-2)">История копится с <b>${trends.firstDate ?? localDate()}</b> — сейчас в базе ${trends.historyDays || 1} ${trends.historyDays === 1 ? 'снимок' : 'снимка(ов)'} рынка.
    Первые тренды (рост и падение ролей и технологий) появятся после 2–3 ежедневных сборов, недельная динамика — через 7 дней. Сбор запускается автоматически каждый день.</p>
  </div>`;
  }
  const t = trends.roles7;
  const s = trends.skills7;
  const period = `с ${new Date(t.base).toLocaleDateString('ru-RU')} по ${new Date(trends.latestDate).toLocaleDateString('ru-RU')}`;
  return `
  <h2>Динамика рынка <span style="color:var(--muted); font-weight:400; font-size:13px">(${period})</span></h2>
  <div class="grid2">
    <div class="panel">
      <h3 style="font-size:14px; margin-bottom:10px">Роли: изменение числа вакансий</h3>
      <table>
        <tr><th>Роль</th><th style="text-align:right">Вакансий</th><th style="text-align:right">Изменение</th></tr>
        ${t.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.now.toLocaleString('ru-RU')}</td><td class="num">${arrow(r.deltaPct)}</td></tr>`).join('')}
      </table>
    </div>
    <div class="panel">
      <h3 style="font-size:14px; margin-bottom:10px">Технологии: изменение доли вакансий</h3>
      <table>
        <tr><th>Навык</th><th style="text-align:right">Доля</th><th style="text-align:right">Изменение</th></tr>
        ${(s?.rows ?? []).slice(0, 8).map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${(r.shareNow * 100).toFixed(0)}%</td><td class="num">${arrow(r.deltaPp, ' п.п.')}</td></tr>`).join('')}
        ${(s?.rows ?? []).length > 8 ? `<tr><td colspan="3" style="color:var(--muted)">…и ${(s.rows.length - 8)} ниже</td></tr>` : ''}
      </table>
    </div>
  </div>`;
}

const htmlRaw = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Intelligence — рынок IT сегодня</title>
<style>
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6; --series-2: #1baf7a; --series-3: #eda100;
    --good: #006300;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5; --series-2: #199e70; --series-3: #c98500;
      --good: #0ca30c;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 32px 20px 64px; }
  .wrap { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 26px; letter-spacing: -0.02em; }
  .sub { color: var(--ink-2); margin: 6px 0 28px; }
  h2 { font-size: 17px; margin: 40px 0 14px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .card .label { font-size: 13px; color: var(--ink-2); }
  .card .value { font-size: 30px; font-weight: 600; margin-top: 2px; }
  .card .note { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .panel { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
  .hrow { display: grid; grid-template-columns: 160px 1fr 92px; gap: 10px; align-items: center; padding: 4px 0; position: relative; }
  .hlabel { font-size: 13px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .htrack { height: 18px; }
  .hfill { height: 100%; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 2px; }
  .hrow.alt .hfill { background: var(--series-2); }
  .hvalue { font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); }
  .cols { display: flex; align-items: flex-end; gap: 8px; height: 180px; padding-top: 8px; }
  .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; position: relative; }
  .colfill { width: 100%; max-width: 46px; background: var(--series-1); border-radius: 4px 4px 0 0; }
  .colv { font-size: 12px; color: var(--ink-2); }
  .colx { font-size: 12px; color: var(--muted); margin-top: 6px; text-align: center; }
  .axis { border-top: 1px solid var(--grid); margin-top: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12.5px; padding: 6px 10px; border-bottom: 1px solid var(--grid); }
  td { padding: 7px 10px; border-bottom: 1px solid var(--grid); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  a { color: var(--series-1); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .pill { display: inline-block; font-size: 12px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 99px; color: var(--ink-2); margin: 0 4px 4px 0; }
  .pill.req { border-color: var(--series-1); }
  .ai-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .ai-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px; font-size: 13.5px; }
  .ai-card h3 { font-size: 14.5px; margin-bottom: 2px; }
  .ai-meta { color: var(--muted); font-size: 12.5px; margin-bottom: 8px; }
  .ai-level { font-weight: 600; color: var(--ink); }
  .roadmap { margin: 8px 0 0 0; padding-left: 18px; color: var(--ink-2); }
  .roadmap li { margin: 2px 0; }
  .footer { color: var(--muted); font-size: 12.5px; margin-top: 48px; }
  .status { display: flex; flex-wrap: wrap; gap: 6px 18px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; margin: 0 0 20px; font-size: 13px; color: var(--ink-2); }
  .status b { color: var(--ink); font-weight: 600; }
  .status.bad { border-color: #d03b3b; }
  .delta.up { color: var(--good); }
  .delta.down { color: #d03b3b; }
  .delta.flat { color: var(--muted); }
  .hero { margin: 0 0 24px; font-size: 15.5px; }
  .hero p { margin: 10px 0 0; }
  .wow { font-size: 17px; }
  .head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .mode-btn { background: var(--surface-1); border: 1px solid var(--border); border-radius: 99px; padding: 7px 16px; font-size: 13px; color: var(--ink); cursor: pointer; white-space: nowrap; margin-top: 6px; }
  .mode-btn:hover { border-color: var(--series-1); }
  .conf { color: var(--muted); font-size: 12px; white-space: nowrap; }
  body.insights .detail { display: none; }
  .insights-only { display: none; }
  body.insights .insights-only { display: block; }
  .insights-list { margin: 0; padding-left: 20px; }
  .insights-list li { margin: 8px 0; color: var(--ink-2); }
  .insights-list b { color: var(--ink); }
  .conclusion { background: var(--surface-1); border-left: 3px solid var(--series-1); border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 10px 0 0; font-size: 14px; color: var(--ink-2); }
  .conclusion b { color: var(--ink); }
  #tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--page); font-size: 12.5px; padding: 5px 9px; border-radius: 7px; opacity: 0; transition: opacity .12s; z-index: 10; max-width: 320px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head-row">
    <div>
      <h1>Рынок IT сегодня</h1>
      <p class="sub">Job Intelligence · данные hh.ru, Россия · зарплаты приведены к «на руки, ₽/мес»</p>
    </div>
    <button id="modeBtn" class="mode-btn">Только выводы</button>
  </div>

  ${statusBlock}

  ${summaryBlock()}

  ${startTodayBlock()}

  <div class="detail">
  <h2>Главные цифры</h2>
  <div class="cards">
    <div class="card"><div class="label">Вакансий в базе</div><div class="value">${overview.vacancies.toLocaleString('ru-RU')}</div><div class="note">${overview.companies.toLocaleString('ru-RU')} компаний</div></div>
    <div class="card"><div class="label">Медианная зарплата</div><div class="value">${fmtK(overview.medianSalary)}</div><div class="note">указана в ${overview.withSalary} вакансиях</div></div>
    <div class="card"><div class="label">Удалёнка</div><div class="value">${fmtPct(overview.remoteShare)}</div><div class="note">доступен формат remote</div></div>
    <div class="card"><div class="label">Без опыта</div><div class="value">${fmtPct(overview.noExpShare)}</div><div class="note">вакансий для старта</div></div>
  </div>
  </div>

  ${trendsBlock()}

  ${roiBlock()}

  {{INSIGHTS}}

  <div class="detail">
  <h2>Зарплаты по ролям (медиана, на руки)</h2>
  <div class="panel">
    ${hbar(roleSalary, {
      labelOf: (r) => r.label,
      valueOf: (r) => r.medianSalary,
      format: (v) => fmtK(v),
      sub: (r) => `${r.salaryN} вакансий с зарплатой, удалёнка ${fmtPct(r.remoteShare)}`,
    })}
    <p style="color:var(--muted); font-size:12.5px; margin-top:10px">Показаны роли, где зарплата указана минимум в 5 вакансиях.</p>
  </div>
  ${topRole && bottomRole && salaryGapPct != null ? conclusion(`${esc(topRole.label)} сейчас оплачивается выше всех — разница <b>+${salaryGapPct}%</b> к ${esc(bottomRole.label)}. AI-роли в среднем дороже классической разработки.`, overview.withSalary) : ''}

  <div class="grid2">
    <div>
      <h2>Спрос по ролям (вакансий на hh)</h2>
      <div class="panel">
        ${hbar(roles.filter((r) => r.totalFound).sort((a, b) => b.totalFound - a.totalFound), {
          labelOf: (r) => r.label,
          valueOf: (r) => r.totalFound,
          format: (v) => (v == null ? '—' : v.toLocaleString('ru-RU')),
          sub: (r) => `в базе ${r.count}`,
        })}
      </div>
    </div>
    <div>
      <h2>Распределение зарплат (тыс. ₽)</h2>
      <div class="panel">
        <div class="cols">
          ${histogram.map((b) => {
            const max = Math.max(...histogram.map((x) => x.count), 1);
            return `<div class="col" data-tip="${b.label} тыс. ₽: ${b.count} вакансий">
              <div class="colv">${b.count}</div>
              <div class="colfill" style="height:${Math.max(3, (b.count / max) * 130)}px"></div>
            </div>`;
          }).join('')}
        </div>
        <div class="axis"></div>
        <div style="display:flex; gap:8px">${histogram.map((b) => `<div class="colx" style="flex:1">${b.label}</div>`).join('')}</div>
      </div>
    </div>
  </div>

  <h2>Самые востребованные технологии</h2>
  <div class="panel">
    ${hbar(skillRows.slice(0, 20), {
      labelOf: (r) => r.name,
      valueOf: (r) => r.cnt,
      format: (v) => `${v} ваканс.` ,
      sub: () => 'по ключевым навыкам hh + анализу описаний',
    })}
  </div>
  ${conclusion(`База рынка неизменна — Python, PostgreSQL, Docker, SQL. Но обрати внимание: <b>LLM уже на ${llmRank}-м месте</b> — AI-навыки вошли в мейнстрим найма.`, overview.enriched)}

  <div class="grid2">
    <div>
      <h2>Опыт: сколько требуют и сколько платят</h2>
      <div class="panel">
        <table>
          <tr><th>Опыт</th><th style="text-align:right">Вакансий</th><th style="text-align:right">Медиана, на руки</th></tr>
          ${experience.map((e) => `<tr><td>${e.label}</td><td class="num">${e.count}</td><td class="num">${fmtK(e.medianSalary)}</td></tr>`).join('')}
        </table>
        ${expJump ? conclusion(`Самый большой скачок зарплаты — переход «${expJump.from}» → «${expJump.to}»: <b>+${Math.round(expJump.delta / 1000)} тыс. ₽</b>. Первые 3 года опыта окупаются сильнее всего.`, overview.withSalary) : ''}
      </div>
    </div>
    <div>
      <h2>Кто нанимает больше всех</h2>
      <div class="panel">
        <table>
          <tr><th>Компания</th><th style="text-align:right">Вакансий в выборке</th></tr>
          ${employers.map((e) => `<tr><td>${esc(e.name)}${e.accreditedIT ? ' <span class="pill">аккредит. IT</span>' : ''}</td><td class="num">${e.cnt}</td></tr>`).join('')}
        </table>
      </div>
    </div>
  </div>

  <h2>Точки входа: удалёнка + опыт до 3 лет + зарплата указана</h2>
  <div class="panel">
    <table>
      <tr><th>Вакансия</th><th>Компания</th><th>Опыт</th><th style="text-align:right">На руки, до</th></tr>
      ${entryPoints.map((v) => `<tr>
        <td><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a></td>
        <td>${esc(v.company ?? '—')}</td>
        <td>${expLabels[v.experience] ?? '—'}</td>
        <td class="num">${fmtK(v.sal)}</td>
      </tr>`).join('')}
    </table>
  </div>

  </div>

  ${forecastBlock()}

  <div class="detail">
  ${aiCards.length ? `
  <h2>AI-анализ вакансий <span style="color:var(--muted); font-weight:400; font-size:13px">(${overview.analyzed} проанализировано · Claude)</span></h2>
  <div class="ai-grid">
    ${aiCards.map((a) => `
    <div class="ai-card">
      <h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      <div class="ai-meta">${esc(a.company ?? '')} · <span class="ai-level">${esc(a.level ?? '?')}</span> · сложность ${a.difficulty ?? '?'}/10${a.salaryEstimate ? ` · оценка ${fmtK(a.salaryEstimate)}` : ''}</div>
      <div>${a.requiredSkills.map((s) => `<span class="pill req">${esc(s)}</span>`).join('')}${a.optionalSkills.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div>
      ${a.roadmap.length ? `<ol class="roadmap">${a.roadmap.slice(0, 4).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    </div>`).join('')}
  </div>` : ''}
  </div>

  <p class="footer">Job Intelligence v0.1 · сбор: страницы поиска hh.ru (${overview.vacancies} вакансий, ${overview.enriched} с полным описанием) · зарплаты: середина вилки, gross → net ×${NET} · это исследовательский срез, не оферта</p>
</div>
<div id="tip"></div>
<script>
  const modeBtn = document.getElementById('modeBtn');
  modeBtn.addEventListener('click', () => {
    const on = document.body.classList.toggle('insights');
    modeBtn.textContent = on ? 'Показать всё' : 'Только выводы';
  });
  const tip = document.getElementById('tip');
  document.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      tip.textContent = el.dataset.tip;
      tip.style.opacity = '1';
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 340) + 'px';
      tip.style.top = (e.clientY + 16) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });
</script>
</body>
</html>`;

// список выводов подставляется после сборки шаблона: conclusion() наполняет его по ходу рендера
const insightsHtml = insights.length ? `
  <div class="insights-only">
    <h2>Главные выводы</h2>
    <div class="panel"><ul class="insights-list">${insights.map((t) => `<li>${t}</li>`).join('')}</ul></div>
  </div>` : '';
const html = htmlRaw.replace('{{INSIGHTS}}', insightsHtml);

mkdirSync(projectPath('../dashboard'), { recursive: true });
const out = projectPath('../dashboard/index.html');
writeFileSync(out, html);
writeFileSync(projectPath('../dashboard/data.json'), JSON.stringify(data, null, 2));
console.log(`Дашборд: ${out}`);
console.log(`Данные: dashboard/data.json`);
