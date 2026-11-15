// Скоринг активных вакансий под твой профиль (profile.json).
// Application Score — объяснимый: навыки + опыт + зарплата + формат + свежесть.
// Пишет совпавшие в таблицу Application со статусом matched (если ещё не решено).
// Запуск: npm run match
import { readFileSync } from 'node:fs';
import { db } from './db.mjs';
import { projectPath, SETTINGS } from './config.mjs';
import { normalizeHHSkill } from './skills-dict.mjs';
import { weightOf, CORE_LANGS, LEARN_HOURS, categorize } from './scoring.mjs';

const profile = JSON.parse(readFileSync(projectPath('../profile.json'), 'utf8'));
const NET = SETTINGS.netFactor;

const EXP_ORDER = ['noExperience', 'between1And3', 'between3And6', 'moreThan6'];
const EXP_LABEL = { noExperience: 'без опыта', between1And3: '1–3 года', between3And6: '3–6 лет', moreThan6: '6+ лет' };
const profExpIdx = EXP_ORDER.indexOf(profile.experienceLevel);
const profSkills = new Set(profile.skills.map((s) => normalizeHHSkill(s).toLowerCase()));
const wantSkills = new Set((profile.wantToLearn || []).map((s) => s.toLowerCase()));
const excludeKw = (profile.excludeKeywords || []).map((s) => s.toLowerCase());
const nowMs = Date.now();

// вилка «на руки» из вакансии
function netSalary(v) {
  if (v.currency !== 'RUR' || (v.salaryMode && v.salaryMode !== 'MONTH')) return null;
  const lo = v.salaryFrom, hi = v.salaryTo;
  if (lo == null && hi == null) return null;
  const mid = ((lo ?? hi) + (hi ?? lo)) / 2;
  return v.gross ? mid * NET : mid;
}

const activeVacancies = db.prepare(`
  SELECT v.*, c.name AS company FROM Vacancy v
  LEFT JOIN Company c ON c.id = v.companyId
  WHERE v.isActive = 1 AND v.enrichedAt IS NOT NULL AND v.description IS NOT NULL
`).all();

const skillsOf = db.prepare('SELECT s.name FROM VacancySkill vs JOIN Skill s ON s.id = vs.skillId WHERE vs.vacancyId = ?');

// взвешенный скор навыков: сумма весов совпавших / сумма весов требуемых
function weightedSkillScore(vSkillNames, addSkills = new Set()) {
  const meaningful = vSkillNames.filter((s) => s.toLowerCase() !== 'api-интеграции');
  if (!meaningful.length) return { score: 0.35, totalW: 0 };
  let totalW = 0, matchedW = 0;
  for (const s of meaningful) {
    const w = weightOf(s);
    totalW += w;
    if (profSkills.has(s.toLowerCase()) || addSkills.has(s.toLowerCase())) matchedW += w;
  }
  return { score: totalW ? matchedW / totalW : 0.35, totalW };
}

function scoreVacancy(v) {
  const vSkillNames = skillsOf.all(v.id).map((r) => r.name);

  const matched = vSkillNames.filter((s) => profSkills.has(s.toLowerCase()));
  const missing = vSkillNames.filter((s) => !profSkills.has(s.toLowerCase()));
  const learnable = missing.filter((s) => wantSkills.has(s.toLowerCase()));

  // недостающие языки ядра роли — красные флаги
  const missingCore = missing.filter((s) => CORE_LANGS.includes(s));

  // 1) навыки по весам (0.45)
  const { score: skillScore } = weightedSkillScore(vSkillNames);

  // 2) опыт (0.20)
  const vExpIdx = EXP_ORDER.indexOf(v.experience);
  let expScore = 0.6;
  if (vExpIdx === -1) expScore = 0.6;
  else if (vExpIdx <= profExpIdx) expScore = 1;
  else if (vExpIdx === profExpIdx + 1) expScore = 0.5;
  else expScore = 0.1;

  // 3) зарплата (0.15)
  const net = netSalary(v);
  let salScore = 0.5, salaryOk = null;
  if (net != null) {
    salaryOk = net >= profile.salaryFloor;
    salScore = net >= profile.salaryTarget ? 1 : net >= profile.salaryFloor ? 0.7 : 0.2;
  }

  // 4) формат/локация (0.10)
  const locOk = profile.locations.some((l) => (v.area || '').toLowerCase().includes(l.toLowerCase()));
  let fmtScore = 0.4;
  if (v.remote) fmtScore = 1;
  else if (locOk) fmtScore = 0.8;
  else if (profile.remoteOnly) fmtScore = 0;

  // 5) свежесть (0.10)
  const days = v.publishedAt ? (nowMs - new Date(v.publishedAt).getTime()) / 86400000 : 30;
  const freshScore = days <= 3 ? 1 : days <= 7 ? 0.8 : days <= 14 ? 0.5 : 0.3;

  let score = (skillScore * 0.45 + expScore * 0.20 + salScore * 0.15 + fmtScore * 0.10 + freshScore * 0.10) * 100;

  // красные флаги — реальные блокеры
  const redFlags = [];
  for (const lang of missingCore) redFlags.push(`Требуют ${lang}`);
  const titleLow = v.title.toLowerCase();
  if (/(senior|lead|ведущий|тимлид|principal)/i.test(titleLow)) redFlags.push('Уровень Senior/Lead');
  if (vExpIdx > profExpIdx + 1) redFlags.push(`Опыт ${{ between3And6: '3–6 лет', moreThan6: '6+ лет' }[v.experience] ?? 'выше твоего'}`);
  if (net != null && !salaryOk) redFlags.push('Зарплата ниже цели');

  const hitKw = excludeKw.filter((kw) => titleLow.includes(kw));
  if (hitKw.length) score *= 0.55;
  if (missingCore.length) score *= 0.6; // роль на чужом языке — вниз

  const category = categorize(v.title, missingCore);
  if (category === 'red') score *= 0.85;

  // вероятность приглашения (звёзды 1–5): категория + попадание в требования + свежесть
  let stars = category === 'green' ? 4 : category === 'yellow' ? 3 : 1;
  if (category !== 'red') {
    if (score >= 78) stars += 1;
    if (score < 60) stars -= 1;
    if (redFlags.some((f) => f.startsWith('Требуют') || f.startsWith('Опыт') || f.startsWith('Уровень'))) stars -= 1;
    if (days <= 3) stars += 0; // свежесть уже в score
  }
  stars = Math.max(1, Math.min(5, stars));

  // skill-gap: что выучить, чтобы поднять совпадение (без языков ядра — они в флагах)
  const gapCandidates = missing
    .filter((s) => s.toLowerCase() !== 'api-интеграции' && !CORE_LANGS.includes(s))
    .filter((s) => wantSkills.has(s.toLowerCase()) || LEARN_HOURS[s] != null)
    .map((s) => ({ name: s, hours: LEARN_HOURS[s] ?? 15, weight: weightOf(s) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);

  // прогноз совпадения, если освоить эти навыки
  let projectedScore = score;
  if (gapCandidates.length) {
    const add = new Set(gapCandidates.map((g) => g.name.toLowerCase()));
    const { score: newSkill } = weightedSkillScore(vSkillNames, add);
    let ps = (newSkill * 0.45 + expScore * 0.20 + salScore * 0.15 + fmtScore * 0.10 + freshScore * 0.10) * 100;
    if (hitKw.length) ps *= 0.55;
    if (missingCore.length) ps *= 0.6;
    if (category === 'red') ps *= 0.85;
    projectedScore = Math.round(ps);
  }

  // достоверность оценки: качество данных вакансии
  const meaningfulCount = vSkillNames.filter((s) => s.toLowerCase() !== 'api-интеграции').length;
  const dq = [net != null, meaningfulCount >= 4, (v.description || '').length > 400].filter(Boolean).length;
  const confidence = dq >= 3 ? 'high' : dq === 2 ? 'medium' : 'low';

  // шанс пройти HR-фильтр (ЭВРИСТИКА, не вероятность): HR режет по опыту, уровню, названию.
  // Показываем уровнем, а не процентом — пока нет исходов, точное число вводило бы в заблуждение.
  let hr = 68;
  if (vExpIdx > profExpIdx) hr -= 25;
  if (category === 'green') hr += 12;
  if (category === 'red') hr -= 30;
  if (net != null && salaryOk) hr += 5;
  if (redFlags.some((f) => f.startsWith('Уровень'))) hr -= 22;
  if (['noExperience', 'between1And3'].includes(v.experience)) hr += 8;
  hr = Math.max(10, Math.min(92, hr));
  const hrLevel = hr >= 68 ? 'high' : hr >= 48 ? 'medium' : 'low';

  // приоритет отклика
  let priority = 'spare';
  if (category !== 'red' && stars >= 5 && days <= 7) priority = 'today';
  else if (category !== 'red' && stars >= 4) priority = 'today';
  else if (category !== 'red' && stars >= 3) priority = 'week';

  // тир для группировки: жёлтый слишком широк — делим на 🟡 хороший шанс и 🟠 пограничная
  let tier = category;
  if (category === 'yellow') {
    const hardFlag = redFlags.some((f) => f.startsWith('Требуют') || f.startsWith('Уровень') || f.startsWith('Опыт'));
    tier = (score >= 72 && !hardFlag) ? 'yellow' : 'orange';
  }

  // почему подходит (объяснение ранжирования)
  const why = [];
  if (matched.length) why.push(`Совпадают ключевые навыки: ${matched.filter((s) => s.toLowerCase() !== 'api-интеграции').slice(0, 4).join(', ')}`);
  if (vExpIdx <= profExpIdx || v.experience === 'noExperience') why.push(`Уровень «${EXP_LABEL[v.experience] ?? '—'}» — подходит под твой опыт`);
  if (v.remote) why.push('Удалённый формат');
  if (net != null && salaryOk) why.push('Зарплата соответствует цели');
  if (['noExperience', 'between1And3'].includes(v.experience)) why.push('Опыт до 3 лет — реальная точка входа');

  // подготовка к интервью: что точно спросят (твои навыки) и зона риска (чего нет)
  const willAsk = matched.filter((s) => s.toLowerCase() !== 'api-интеграции')
    .sort((a, b) => weightOf(b) - weightOf(a)).slice(0, 5);
  const riskAsk = [...missingCore, ...missing.filter((s) => ['Docker', 'Kubernetes', 'PostgreSQL', 'FastAPI', 'RAG'].includes(s))]
    .filter((s, i, arr) => arr.indexOf(s) === i).slice(0, 5);

  // keepScore — для решения «хранить или нет»: без red-штрафов, чтобы неподходящие
  // вакансии не удалялись (выучишь язык — сами станут актуальны)
  let keepScore = (skillScore * 0.45 + expScore * 0.20 + salScore * 0.15 + fmtScore * 0.10 + freshScore * 0.10) * 100;
  if (hitKw.length) keepScore *= 0.55;

  return {
    score: Math.round(score),
    keepScore: Math.round(keepScore),
    reasons: {
      matched, missing: missing.filter((s) => s.toLowerCase() !== 'api-интеграции'),
      learnable, missingCore,
      category, tier, stars, redFlags, confidence, hrLevel, priority, why,
      interview: { willAsk, risk: riskAsk },
      gap: gapCandidates.map((g) => ({ name: g.name, hours: g.hours })),
      projectedScore,
      salaryNet: net ? Math.round(net) : null, salaryOk,
      remoteOk: !!v.remote, locOk, area: v.area,
      experience: v.experience, freshDays: Math.round(days),
    },
  };
}

const MIN_SCORE = Number(process.argv[2]) || 55;

const upsert = db.prepare(`
  INSERT INTO Application (vacancyId, score, reasons, status, matchedAt)
  VALUES (?, ?, ?, 'matched', ?)
  ON CONFLICT(vacancyId) DO UPDATE SET
    score = excluded.score, reasons = excluded.reasons
  WHERE Application.status = 'matched'
`);
const logEvent = db.prepare('INSERT INTO ApplicationEvent (vacancyId, type, createdAt) VALUES (?, ?, ?)');

const now = new Date().toISOString();
let matched = 0;
const scored = activeVacancies.map((v) => ({ v, ...scoreVacancy(v) })).sort((a, b) => b.score - a.score);

const passedIds = new Set();
for (const { v, score, keepScore, reasons } of scored) {
  // храним, если проходит порог по «чистому» скору (red-роли не удаляем — прячем в UI)
  if (keepScore < MIN_SCORE) continue;
  passedIds.add(v.id);
  const existed = db.prepare('SELECT 1 FROM Application WHERE vacancyId = ?').get(v.id);
  upsert.run(v.id, score, JSON.stringify(reasons), now);
  if (!existed) logEvent.run(v.id, 'matched', now);
  matched++;
}

// убрать из очереди то, что больше не проходит порог (не трогаем решённые: sent/skipped/воронку)
const stale = db.prepare("SELECT vacancyId FROM Application WHERE status = 'matched'").all()
  .filter((r) => !passedIds.has(r.vacancyId));
const del = db.prepare('DELETE FROM Application WHERE vacancyId = ? AND status = \'matched\'');
for (const r of stale) del.run(r.vacancyId);
if (stale.length) console.log(`Убрано из очереди (больше не проходят порог): ${stale.length}`);

const passed = scored.filter((x) => x.keepScore >= MIN_SCORE);
const byCat = (c) => passed.filter((x) => x.reasons.category === c).length;
console.log(`Профиль: ${profile.name} · цель ${profile.salaryTarget.toLocaleString('ru-RU')} ₽ · навыков ${profile.skills.length}`);
console.log(`Порог: ${MIN_SCORE}. Подходящих: ${matched} — 🟢 ${byCat('green')} · 🟡 ${byCat('yellow')} · 🔴 ${byCat('red')}`);
console.log('\nТоп-10 (🟢/🟡):');
const CAT_ICON = { green: '🟢', yellow: '🟡', red: '🔴' };
for (const { v, score, reasons } of passed.filter((x) => x.reasons.category !== 'red').slice(0, 10)) {
  const st = '★'.repeat(reasons.stars) + '☆'.repeat(5 - reasons.stars);
  console.log(`  ${CAT_ICON[reasons.category]} ${score}% ${st}  ${v.title}${reasons.redFlags.length ? ' ⚠ ' + reasons.redFlags.join(', ') : ''}`);
}
