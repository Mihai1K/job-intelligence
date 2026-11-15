// Личный кокпит поиска работы (режим 1: агент готовит — ты подтверждаешь).
// Локальный сервер: очередь совпавших вакансий, письмо, «Открыть на hh», Отправлено/Пропустить.
// Никакой автоматизации кликов на hh — отклик ты делаешь сам, кокпит только ведёт учёт.
// Запуск: npm run cockpit  → http://localhost:8899
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Пароль (Basic Auth). Источник: COCKPIT_PASS из окружения, иначе файл .cockpit-password
// в корне проекта (права 600). Так пароль не попадает ни в plist launchd, ни в логи.
// Без обоих — локально без пароля.
const __root = join(dirname(fileURLToPath(import.meta.url)), '..');
function readPasswordFile() {
  try { return readFileSync(join(__root, '.cockpit-password'), 'utf8').trim(); }
  catch { return ''; }
}
const AUTH_USER = process.env.COCKPIT_USER || 'me';
const AUTH_PASS = process.env.COCKPIT_PASS || readPasswordFile();
function authed(req) {
  if (!AUTH_PASS) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [u, p] = Buffer.from(m[1], 'base64').toString().split(':');
  const pB = Buffer.from(p || ''), aB = Buffer.from(AUTH_PASS);
  return u === AUTH_USER && pB.length === aB.length && timingSafeEqual(pB, aB);
}
import { db, addEvent } from './db.mjs';
import { projectPath } from './config.mjs';
import { extractSkillsFromText, normalizeHHSkill } from './skills-dict.mjs';
import { weightOf, CORE_LANGS, categorize } from './scoring.mjs';
import { buildLetter } from './letters.mjs';
import { tailor } from './resume.mjs';

const PORT = 8899;
// Слушаем только loopback: снаружи кокпит доступен исключительно через Tailscale Serve,
// который проксирует приватный tailnet-адрес на localhost. Так его не видно даже домашней сети.
const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const profile = JSON.parse(readFileSync(projectPath('../profile.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const fmtK = (n) => (n == null ? '—' : `${Math.round(n / 1000)} 000 ₽`);
const EXP = { noExperience: 'без опыта', between1And3: '1–3 года', between3And6: '3–6 лет', moreThan6: '6+ лет' };

// воронка поиска работы: стадии по порядку. matched/skipped — вне воронки.
const STAGES = [
  { key: 'sent', label: 'Отклик отправлен', next: 'viewed' },
  { key: 'viewed', label: 'Просмотрено работодателем', next: 'interview' },
  { key: 'interview', label: 'Интервью', next: 'offer' },
  { key: 'offer', label: 'Оффер', next: null },
];
const STAGE_KEYS = STAGES.map((s) => s.key);
const STAGE_LABEL = Object.fromEntries([...STAGES.map((s) => [s.key, s.label]), ['rejected', 'Отказ']]);

function queue(statuses) {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  const ph = list.map(() => '?').join(',');
  return db.prepare(`
    SELECT a.vacancyId, a.score, a.reasons, a.coverLetter, a.tailoredResume, a.status,
           v.title, v.url, v.area, v.salaryFrom, v.salaryTo, v.currency, v.gross, v.experience, v.remote,
           c.name AS company
    FROM Application a
    JOIN Vacancy v ON v.id = a.vacancyId
    LEFT JOIN Company c ON c.id = v.companyId
    WHERE a.status IN (${ph})
    ORDER BY a.score DESC
  `).all(...list);
}

function counts() {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM Application GROUP BY status').all();
  const m = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const inPipeline = STAGE_KEYS.reduce((s, k) => s + (m[k] || 0), 0) + (m.rejected || 0);
  return {
    matched: m.matched || 0, skipped: m.skipped || 0, pipeline: inPipeline,
    sent: m.sent || 0, viewed: m.viewed || 0, interview: m.interview || 0,
    offer: m.offer || 0, rejected: m.rejected || 0,
  };
}

// Skill Gap: каких навыков чаще всего не хватает в подходящих вакансиях.
// Считаем по всем откликам в работе (matched + воронка), берём missing из reasons.
function skillGap() {
  const rows = db.prepare(`
    SELECT reasons FROM Application WHERE status IN ('matched','sent','viewed','interview','offer','rejected')
  `).all();
  const total = rows.length || 1;
  const profSkills = new Set(profile.skills.map((s) => s.toLowerCase()));
  const gap = new Map();
  for (const { reasons } of rows) {
    const r = JSON.parse(reasons || '{}');
    const missing = new Set((r.missing || [])
      .filter((s) => s.toLowerCase() !== 'api-интеграции' && !profSkills.has(s.toLowerCase())));
    for (const s of missing) gap.set(s, (gap.get(s) || 0) + 1);
  }
  const want = new Set((profile.wantToLearn || []).map((s) => s.toLowerCase()));
  return [...gap.entries()]
    .map(([name, n]) => ({ name, n, share: n / total, inPlan: want.has(name.toLowerCase()) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
}

const CAT = { green: { icon: '🟢', cls: 'green' }, yellow: { icon: '🟡', cls: 'yellow' }, orange: { icon: '🟠', cls: 'orange' }, red: { icon: '🔴', cls: 'red' } };
const starsHtml = (n) => `<span class="stars" title="приоритет — эвристика, не калиброванная вероятность">${'★'.repeat(n)}<span class="dim">${'☆'.repeat(5 - n)}</span></span>`;
const CONF = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const LEVEL = { high: 'высокий', medium: 'средний', low: 'низкий' };
const PRIO = { today: { t: 'Откликнуться сегодня', c: 'ptoday' }, week: { t: 'До конца недели', c: 'pweek' }, spare: { t: 'Если останется время', c: 'pspare' } };

function card(a) {
  const r = JSON.parse(a.reasons || '{}');
  const matched = (r.matched || []).filter((s) => s.toLowerCase() !== 'api-интеграции');
  const missing = (r.missing || []).slice(0, 5);
  const fmt = a.remote ? 'удалёнка' : (r.locOk ? esc(a.area) : esc(a.area || 'офис'));
  const cat = CAT[r.tier] || CAT[r.category] || CAT.yellow;
  const gap = r.gap || [];
  const gapUp = r.projectedScore && r.projectedScore > a.score;
  const prio = PRIO[r.priority] || PRIO.spare;
  const iv = r.interview || {};
  return `
  <div class="card cat-${cat.cls}" id="v${a.vacancyId}">
    <div class="chead">
      <div class="scorecol">
        ${starsHtml(r.stars || 3)}
        <div class="scorepct">приоритет</div>
      </div>
      <div class="cmeta">
        <a class="ctitle" href="${esc(a.url)}" target="_blank" rel="noopener">${cat.icon} ${esc(decode(a.title))}</a>
        <div class="csub">${esc(a.company ?? '—')} · ${fmt} · ${EXP[a.experience] ?? '—'} · ${r.salaryNet ? fmtK(r.salaryNet) : 'зп не указана'} · опубл. ${r.freshDays} дн. назад</div>
      </div>
      <div class="prio ${prio.c}">${prio.t}</div>
    </div>
    <div class="metrics">
      <span>Совпадение навыков <b>${a.score}%</b></span>
      <span>Шанс пройти HR: <b class="lvl-${r.hrLevel || 'medium'}">${LEVEL[r.hrLevel] || 'средний'}</b></span>
      <span class="conf conf-${r.confidence || 'medium'}">достоверность оценки: ${CONF[r.confidence] || 'средняя'}</span>
    </div>
    ${(r.redFlags || []).length ? `<div class="flags">${r.redFlags.map((f) => `<span class="flag">❌ ${esc(f)}</span>`).join('')}</div>` : ''}
    <div class="reasons">
      ${matched.map((s) => `<span class="pill ok">✓ ${esc(s)}</span>`).join('')}
      ${missing.map((s) => `<span class="pill no">✗ ${esc(s)}</span>`).join('')}
    </div>
    ${gap.length ? `<div class="gap"><b class="gproj">${gapUp ? `${a.score} → ${r.projectedScore}%` : ''}</b> подтянуть: ${gap.map((g) => `<span class="gpill">${esc(g.name)} · ~${g.hours} ч</span>`).join('')}</div>` : ''}
    ${(r.why || []).length ? `<details class="why"><summary>Почему подходит</summary><ul>${r.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    ${(iv.willAsk || []).length || (iv.risk || []).length ? `<details class="why"><summary>Подготовка к интервью</summary>
      ${(iv.willAsk || []).length ? `<div class="ivrow">Точно спросят: ${iv.willAsk.map((s) => `<span class="pill ok">${esc(s)}</span>`).join('')}</div>` : ''}
      ${(iv.risk || []).length ? `<div class="ivrow">Зона риска (чего нет): ${iv.risk.map((s) => `<span class="pill no">${esc(s)}</span>`).join('')}</div>` : ''}
    </details>` : ''}
    <details>
      <summary>Сопроводительное письмо</summary>
      <textarea id="letter${a.vacancyId}" class="letter">${esc(a.coverLetter || '')}</textarea>
      <button class="copy" onclick="copyText('letter${a.vacancyId}', this)">Скопировать письмо</button>
    </details>
    ${resumeBlock(a)}
    <div class="actions">
      <a class="btn open" href="${esc(a.url)}" target="_blank" rel="noopener">Открыть на hh →</a>
      <button class="btn copy" onclick="copyText('letter${a.vacancyId}', this)">📋 Письмо</button>
      ${a.tailoredResume ? `<button class="btn copy" onclick="copyText('resume${a.vacancyId}', this)">📋 Резюме</button>` : ''}
      <button class="btn sent" onclick="act(${a.vacancyId}, 'sent')">✓ Отправлено</button>
      <button class="btn skip" onclick="act(${a.vacancyId}, 'skipped')">✗ Пропустить</button>
    </div>
  </div>`;
}

function resumeBlock(a) {
  if (!a.tailoredResume) return '';
  let t;
  try { t = JSON.parse(a.tailoredResume); } catch { return ''; }
  const skills = (t.keySkills || []).slice(0, 10).map((s) => esc(s)).join(' · ');
  const exp = (t.experience || []).map((e) => `<li class="${e.highlighted ? 'hl' : ''}">${esc(e.bullet)}</li>`).join('');
  const plain = `О себе: ${t.summary}\n\nКлючевые навыки: ${(t.keySkills || []).join(', ')}\n\nОпыт:\n${(t.experience || []).map((e) => '• ' + e.bullet).join('\n')}`;
  return `
    <details>
      <summary>Адаптированное резюме под эту вакансию</summary>
      <div class="resume">
        <div class="rsum">${esc(t.summary)}</div>
        <div class="rskills"><b>Ключевые навыки:</b> ${skills}</div>
        <ul class="rexp">${exp}</ul>
        <textarea id="resume${a.vacancyId}" class="letter" style="display:none">${esc(plain)}</textarea>
        <button class="copy" onclick="copyText('resume${a.vacancyId}', this)">Скопировать резюме</button>
      </div>
    </details>`;
}

function shell(activeTab, bodyHtml) {
  const c = counts();
  const tab = (href, label, key) => `<a class="tab${activeTab === key ? ' active' : ''}" href="${href}">${label}</a>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Поиск работы — кокпит</title>
<style>
  :root { --bg:#f9f9f7; --surf:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781; --border:rgba(11,11,11,.1); --blue:#2a78d6; --good:#0a8a0a; --red:#d03b3b; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#0d0d0d; --surf:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --muted:#898781; --border:rgba(255,255,255,.1); --blue:#3987e5; --good:#0ca30c; } }
  *{box-sizing:border-box;margin:0} body{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:28px 18px 64px}
  .wrap{max-width:840px;margin:0 auto}
  h1{font-size:24px;letter-spacing:-.02em} .sub{color:var(--ink2);margin:6px 0 18px;font-size:14px}
  .tabs{display:flex;gap:8px;margin-bottom:18px}
  .tab{background:var(--surf);border:1px solid var(--border);border-radius:99px;padding:6px 15px;font-size:13.5px;color:var(--ink);text-decoration:none}
  .tab.active{background:var(--blue);color:#fff;border-color:var(--blue)}
  .card{background:var(--surf);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:14px}
  .chead{display:flex;gap:14px;align-items:flex-start}
  .score{font-size:20px;font-weight:700;min-width:56px;text-align:center;border-radius:10px;padding:6px 0}
  .shi{color:#fff;background:var(--good)} .smid{color:#fff;background:var(--blue)} .slo{color:var(--ink2);background:var(--border)}
  .ctitle{font-size:16px;font-weight:600;color:var(--ink);text-decoration:none} .ctitle:hover{color:var(--blue)}
  .csub{font-size:13px;color:var(--muted);margin-top:2px}
  .reasons{margin:12px 0 4px;display:flex;flex-wrap:wrap;gap:5px}
  .pill{font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid var(--border)}
  .pill.ok{color:var(--good);border-color:var(--good)} .pill.no{color:var(--muted)}
  details{margin:10px 0} summary{cursor:pointer;font-size:13.5px;color:var(--ink2)}
  .letter{width:100%;min-height:180px;margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);font:13.5px/1.5 system-ui;resize:vertical}
  .copy{margin-top:6px;background:none;border:1px solid var(--border);border-radius:7px;padding:5px 12px;font-size:12.5px;color:var(--ink);cursor:pointer}
  .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .btn{border:1px solid var(--border);border-radius:9px;padding:8px 16px;font-size:13.5px;cursor:pointer;text-decoration:none;color:var(--ink);background:var(--surf)}
  .btn.open{background:var(--blue);color:#fff;border-color:var(--blue)} .btn.sent:hover{border-color:var(--good);color:var(--good)} .btn.skip:hover{border-color:var(--red);color:var(--red)}
  .btn.copy{margin-top:0;font-size:13.5px;padding:8px 16px} .btn.copy:hover{border-color:var(--blue);color:var(--blue)}
  .empty{color:var(--muted);text-align:center;padding:40px}
  .note{background:var(--surf);border:1px solid var(--border);border-left:3px solid var(--blue);border-radius:0 10px 10px 0;padding:12px 16px;font-size:13.5px;color:var(--ink2);margin-bottom:18px}
  .funnel{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
  .fstage{flex:1;min-width:110px;background:var(--surf);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
  .fstage .fn{font-size:26px;font-weight:700} .fstage .fl{font-size:12px;color:var(--muted)}
  .fstage.rej{border-color:var(--red)}
  .stages{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
  .sbtn{border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer;background:var(--surf);color:var(--ink2)}
  .sbtn.on{background:var(--blue);color:#fff;border-color:var(--blue)} .sbtn.rej:hover{border-color:var(--red);color:var(--red)}
  .gaprow{display:grid;grid-template-columns:150px 1fr 88px;gap:10px;align-items:center;padding:5px 0}
  .gaplabel{font-size:14px} .gaplabel .plan{font-size:11px;color:var(--blue);margin-left:6px}
  .gaptrack{height:16px;background:var(--border);border-radius:0 4px 4px 0} .gapfill{height:100%;background:var(--blue);border-radius:0 4px 4px 0}
  .gapval{font-size:13px;text-align:right;color:var(--ink2)}
  .resume{margin-top:8px;font-size:13.5px}
  .rsum{color:var(--ink2)} .rskills{margin:8px 0} .rskills b{color:var(--ink)}
  .rexp{margin:6px 0 8px;padding-left:20px} .rexp li{margin:3px 0;color:var(--ink2)} .rexp li.hl{color:var(--ink);font-weight:500}
  .batchbar{display:flex;gap:10px;align-items:center;margin-bottom:16px}
  .batchbar .bb{background:var(--surf);border:1px solid var(--border);border-radius:9px;padding:8px 16px;font-size:13.5px;cursor:pointer;color:var(--ink)}
  .batchbar .bb:hover{border-color:var(--blue);color:var(--blue)}
  .cattitle{font-size:17px;margin:24px 0 2px;display:flex;align-items:center;gap:8px}
  .catn{font-size:13px;color:var(--muted);font-weight:400}
  .catsub{font-size:13px;color:var(--muted);margin-bottom:12px}
  .scorecol{min-width:92px;text-align:center}
  .stars{font-size:16px;color:#eda100;letter-spacing:1px} .stars .dim{color:var(--border)}
  .scorepct{font-size:11.5px;color:var(--muted);margin-top:2px}
  .cat-green{border-left:3px solid var(--good)} .cat-red{opacity:.75}
  .flags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 2px}
  .flag{font-size:12px;color:var(--red);background:transparent}
  .gap{margin-top:10px;font-size:12.5px;color:var(--ink2)}
  .gpill{display:inline-block;border:1px dashed var(--border);border-radius:99px;padding:1px 9px;margin:0 4px 4px 0}
  .gproj{color:var(--good);font-weight:600}
  .reddet{margin-top:24px} .reddet>summary{cursor:pointer;color:var(--muted);font-size:14px;padding:8px 0}
  .prio{font-size:12px;padding:4px 10px;border-radius:8px;white-space:nowrap;align-self:flex-start}
  .ptoday{background:var(--good);color:#fff} .pweek{background:var(--blue);color:#fff} .pspare{background:var(--border);color:var(--ink2)}
  .metrics{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0 2px;font-size:13px;color:var(--ink2)} .metrics b{color:var(--ink)}
  .conf{font-size:12px} .conf-high{color:var(--good)} .conf-low{color:#eda100}
  .why{margin-top:10px} .why>summary{cursor:pointer;font-size:13px;color:var(--ink2)} .why ul{margin:6px 0 0 18px} .why li{font-size:13px;color:var(--ink2);margin:2px 0}
  .ivrow{font-size:13px;margin:6px 0;color:var(--ink2);display:flex;flex-wrap:wrap;gap:5px;align-items:center}
  .toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2);margin:0 0 4px}
  .daily{background:var(--surf);border:1px solid var(--border);border-radius:12px;padding:14px 18px;font-size:16px;margin-bottom:10px}
  .disc{font-size:12.5px;color:var(--muted);margin-bottom:14px;font-style:italic}
  .lvl-high{color:var(--good)} .lvl-medium{color:var(--ink)} .lvl-low{color:#eda100}
  .muted{color:var(--muted)}
  .cat-orange{border-left:3px solid #eda100}
  .cat-orange .prio,.cat-red .prio{opacity:.85}
</style></head><body><div class="wrap">
  <h1>Поиск работы — кокпит</h1>
  <div class="sub">Профиль: ${esc(profile.name)} · цель ${fmtK(profile.salaryTarget)} · агент подобрал и написал письма, отклик отправляешь ты сам на hh</div>
  <div class="note"><b>Режим 1 — ручное подтверждение.</b> Кокпит не кликает за тебя на hh (это против правил площадки и грозит блокировкой). Он готовит пакет, ты жмёшь «Открыть на hh», откликаешься там и отмечаешь «Отправлено» здесь для учёта.</div>
  <div class="tabs">
    ${tab('/', `Подходящие (${c.matched})`, 'matched')}
    ${tab('/pipeline', `Воронка (${c.pipeline})`, 'pipeline')}
    ${tab('/learn', 'Что учить', 'learn')}
    ${tab('/skipped', `Пропущенные (${c.skipped})`, 'skipped')}
  </div>
  ${bodyHtml}
</div>
<script>
  const SKIP_REASONS = ['вакансия в архиве / закрыта','слишком техническая','низкая зарплата','нерелевантная роль','неудобный формат','не доверяю компании','другое'];
  async function act(id, status){
    let reason = null;
    if (status === 'skipped'){
      const ans = prompt('Почему пропускаешь? (для обучения агента)\\n' + SKIP_REASONS.map((r,i)=>(i+1)+'. '+r).join('\\n') + '\\n\\nВведи номер или свой текст (Отмена — без причины):');
      if (ans === null) { /* всё равно пропускаем, без причины */ }
      else { const n = parseInt(ans,10); reason = (n>=1 && n<=SKIP_REASONS.length) ? SKIP_REASONS[n-1] : ans.trim() || null; }
    }
    await fetch('/action', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({vacancyId:id, status, reason})});
    const el = document.getElementById('v'+id);
    el.style.transition='opacity .2s'; el.style.opacity='0';
    setTimeout(()=>{ el.remove(); }, 200);
  }
  async function setStage(id, status){
    await fetch('/action', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({vacancyId:id, status})});
    location.reload();
  }
  function copyText(elId, btn){
    const t = document.getElementById(elId);
    navigator.clipboard.writeText(t.value);
    const orig = btn.textContent;
    btn.textContent = 'Скопировано ✓';
    setTimeout(()=>{ btn.textContent = orig; }, 1500);
  }
  function openBatch(n){
    const links = [...document.querySelectorAll('.card .btn.open')].slice(0, n);
    if (!links.length) return;
    if (!confirm('Открыть ' + links.length + ' вакансий в новых вкладках? Разреши всплывающие окна, если браузер спросит.')) return;
    links.forEach((a, i) => setTimeout(() => window.open(a.href, '_blank'), i * 300));
  }
</script>
</body></html>`;
}

function homePage(showRed = false) {
  const matched = queue('matched');
  if (!matched.length) {
    return shell('matched', '<div class="empty">Пока нет подходящих вакансий. Запусти <code>npm run match</code> после сбора.</div>');
  }
  const tierOf = (a) => { try { const r = JSON.parse(a.reasons || '{}'); return r.tier || r.category || 'yellow'; } catch { return 'yellow'; } };
  const groups = { green: [], yellow: [], orange: [], red: [] };
  for (const a of matched) (groups[tierOf(a)] || groups.orange).push(a);

  // ежедневный экран: сколько куда
  const daily = `<div class="daily">Сегодня: <b class="lvl-high">${groups.green.length} обязательных</b> · <b>${groups.yellow.length} хороший шанс</b> · <span class="muted">${groups.orange.length} пограничных</span>${groups.red.length ? ` · <span class="muted">${groups.red.length} не подходят</span>` : ''}</div>`;
  const disclaimer = `<div class="disc">Оценки (приоритет, шанс HR) — эвристические, без калибровки. Станут точными после ~50 твоих откликов, когда воронка накопит исходы.</div>`;

  const batchbar = groups.green.length + groups.yellow.length >= 3
    ? `<div class="batchbar"><span style="color:var(--muted);font-size:13px">Открыть пачкой и пройти отклики подряд:</span>
        <button class="bb" onclick="openBatch(5)">Топ-5</button>
        <button class="bb" onclick="openBatch(10)">Топ-10</button></div>`
    : '';

  const toggle = groups.red.length
    ? `<div class="toggle"><label><input type="checkbox" ${showRed ? 'checked' : ''} onchange="location.href = this.checked ? '/?showRed=1' : '/'"> Показывать неподходящие вакансии (🔴 ${groups.red.length}) — станут актуальны, когда выучишь недостающее</label></div>`
    : '';

  const section = (icon, title, sub, rows) => rows.length
    ? `<h2 class="cattitle">${icon} ${title} <span class="catn">${rows.length}</span></h2><div class="catsub">${sub}</div>${rows.map(card).join('')}`
    : '';

  const redBlock = showRed && groups.red.length
    ? section('🔴', 'Не подходит', 'Требуют навыков не из твоего профиля (Python, backend). Держим на будущее — когда подтянешь стек, поднимутся выше', groups.red)
    : '';

  const body = daily + disclaimer + toggle + batchbar
    + section('🟢', 'Приоритет — откликаться обязательно', 'AI-автоматизация, интеграции, промпт — твоя целевая роль', groups.green)
    + section('🟡', 'Хороший шанс — откликаться после проверки', 'Близко к твоему опыту, стоит откликнуться', groups.yellow)
    + section('🟠', 'Пограничные — только если интересна компания или зарплата', 'Совпадение слабее или есть флаги — не распыляйся', groups.orange)
    + redBlock;
  return shell('matched', body);
}

// карточка в воронке: заголовок + кнопки перевода по стадиям
function pipelineCard(a) {
  const stage = STAGE_KEYS.indexOf(a.status); // -1 если rejected
  const stageBtns = STAGES.map((s, i) => {
    const done = stage >= i;
    return `<button class="sbtn${a.status === s.key ? ' on' : ''}" onclick="setStage(${a.vacancyId},'${s.key}')">${done && a.status !== s.key ? '✓ ' : ''}${s.label}</button>`;
  }).join('');
  return `
  <div class="card" id="v${a.vacancyId}">
    <div class="chead">
      <div class="score smid">${a.score}%</div>
      <div class="cmeta">
        <a class="ctitle" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(decode(a.title))}</a>
        <div class="csub">${esc(a.company ?? '—')} · сейчас: <b>${STAGE_LABEL[a.status] ?? a.status}</b></div>
      </div>
    </div>
    <div class="stages">
      ${stageBtns}
      <button class="sbtn rej${a.status === 'rejected' ? ' on' : ''}" onclick="setStage(${a.vacancyId},'rejected')">✗ Отказ</button>
      <button class="sbtn" onclick="setStage(${a.vacancyId},'reset')">↩ В подходящие</button>
    </div>
  </div>`;
}

function pipelinePage() {
  const c = counts();
  const rows = queue(STAGE_KEYS.concat('rejected'));
  const conv = c.sent ? Math.round((c.interview / c.sent) * 100) : null;
  const funnel = `
    <div class="funnel">
      ${STAGES.map((s) => `<div class="fstage"><div class="fn">${c[s.key]}</div><div class="fl">${s.label}</div></div>`).join('')}
      <div class="fstage rej"><div class="fn">${c.rejected}</div><div class="fl">Отказ</div></div>
    </div>
    ${c.sent ? `<div class="note">Из отправленных до интервью дошло <b>${conv}%</b>. Это твоя личная воронка — по мере откликов она покажет, где теряются шансы.</div>` : ''}`;
  const body = funnel + (rows.length ? rows.map(pipelineCard).join('') : '<div class="empty">Воронка пуста. Отметь «Отправлено» на подходящих вакансиях — они появятся здесь.</div>');
  return shell('pipeline', body);
}

function learnPage() {
  const gap = skillGap();
  const total = counts().matched + counts().pipeline;
  const max = Math.max(...gap.map((g) => g.share), 0.01);
  const body = gap.length ? `
    <div class="note">Навыки, которых чаще всего не хватает в твоих подходящих вакансиях (${total} шт). Добавь верхние в план обучения — каждый расширяет число доступных вакансий. Отмеченные <span style="color:var(--blue)">★ в плане</span> уже у тебя в целях.</div>
    <div class="card">
      ${gap.map((g) => `
        <div class="gaprow">
          <div class="gaplabel">${esc(g.name)}${g.inPlan ? '<span class="plan">★ в плане</span>' : ''}</div>
          <div class="gaptrack"><div class="gapfill" style="width:${Math.max(4, (g.share / max) * 100)}%"></div></div>
          <div class="gapval">${Math.round(g.share * 100)}% вакансий</div>
        </div>`).join('')}
    </div>
    <div class="note">Как считается: доля твоих подходящих вакансий, где навык требуется, а у тебя его нет. Когда пойдут отказы, этот список станет ещё точнее — агент увидит, чего не хватило именно на практике.</div>
  ` : '<div class="empty">Мало данных. Запусти подбор (<code>npm run match</code>), и здесь появится, что учить.</div>';
  return shell('learn', body);
}

function listPage(status) {
  const rows = queue(status);
  const body = rows.length
    ? rows.map((a) => `<div class="card"><div class="chead"><div class="score smid">${a.score}%</div><div class="cmeta"><a class="ctitle" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(decode(a.title))}</a><div class="csub">${esc(a.company ?? '—')}</div></div></div><div class="actions"><button class="btn" onclick="act(${a.vacancyId},'reset')">↩ Вернуть в подходящие</button></div></div>`).join('')
    : `<div class="empty">Пусто</div>`;
  return shell(status, body);
}

// --- JSON API для Chrome-расширения (см. ROADMAP_EXTENSION.md) ---
// Тонкий клиент: вся логика скоринга/писем/резюме уже написана выше и в
// scoring.mjs/skills-dict.mjs/letters.mjs/resume.mjs — здесь только HTTP-обвязка.
// CORS разрешён только для https://hh.ru — расширение работает исключительно там.
const API_ORIGIN = 'https://hh.ru';
const profSkillsSet = new Set(profile.skills.map((s) => normalizeHHSkill(s).toLowerCase()));

async function readJSON(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// Скоринг вакансии по сырому тексту со страницы hh (без обращения к БД) —
// та же логика весов/категорий, что в match.mjs, но без опыта/зарплаты/формата,
// которые расширение со страницы вакансии надёжно не вытащит.
function scoreInput({ title = '', description = '', skills = [] }) {
  const fromText = extractSkillsFromText(`${title} ${description}`);
  const explicit = (skills || []).map((s) => normalizeHHSkill(String(s)));
  const vSkillNames = [...new Set([...fromText, ...explicit])];
  const meaningful = vSkillNames.filter((s) => s.toLowerCase() !== 'api-интеграции');
  const matched = meaningful.filter((s) => profSkillsSet.has(s.toLowerCase()));
  const missing = meaningful.filter((s) => !profSkillsSet.has(s.toLowerCase()));
  const missingCore = missing.filter((s) => CORE_LANGS.includes(s));

  let totalW = 0, matchedW = 0;
  for (const s of meaningful) {
    const w = weightOf(s);
    totalW += w;
    if (profSkillsSet.has(s.toLowerCase())) matchedW += w;
  }
  const skillScore = totalW ? Math.round((matchedW / totalW) * 100) : null;
  const category = categorize(title, missingCore);

  const redFlags = [];
  for (const lang of missingCore) redFlags.push(`Требуют ${lang}`);
  if (/(senior|lead|ведущий|тимлид|principal)/i.test(title.toLowerCase())) redFlags.push('Уровень Senior/Lead');

  return { matched, missing, missingCore, skillScore, category, redFlags };
}

async function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (req.method === 'GET' && req.url === '/api/profile') {
      res.writeHead(200);
      res.end(JSON.stringify({
        name: profile.name, salaryTarget: profile.salaryTarget, salaryFloor: profile.salaryFloor,
        skills: profile.skills, wantToLearn: profile.wantToLearn || [], targetRoles: profile.targetRoles || [],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/score') {
      const input = await readJSON(req);
      res.writeHead(200);
      res.end(JSON.stringify(scoreInput(input)));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/letter') {
      const { title, company, matched, learnable } = await readJSON(req);
      res.writeHead(200);
      res.end(JSON.stringify({ letter: buildLetter(title || '', company || '', { matched: matched || [], learnable: learnable || [] }) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/resume') {
      const { title, matched, missing } = await readJSON(req);
      res.writeHead(200);
      res.end(JSON.stringify(tailor(title || '', { matched: matched || [], missing: missing || [] })));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/applied') {
      // Фиксирует РЕШЕНИЕ, которое человек уже принял и выполнил сам на hh (отправил
      // отклик или пропустил) — расширение не отправляет отклики, только записывает факт.
      const { vacancyId, title, url, company, status } = await readJSON(req);
      if (!vacancyId || !['sent', 'skipped'].includes(status)) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
        return;
      }
      const now = new Date().toISOString();
      let companyId = null;
      if (company) {
        const existing = db.prepare('SELECT id FROM Company WHERE name = ?').get(company);
        if (existing) companyId = existing.id;
      }
      db.prepare(`
        INSERT INTO Vacancy (id, title, url, companyId, collectedAt, firstSeenAt, lastSeenAt, isActive)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET lastSeenAt = excluded.lastSeenAt
      `).run(vacancyId, title || '(без названия)', url || null, companyId, now, now, now);
      const exists = db.prepare('SELECT 1 FROM Application WHERE vacancyId = ?').get(vacancyId);
      if (!exists) db.prepare('INSERT INTO Application (vacancyId, status, matchedAt) VALUES (?, ?, ?)').run(vacancyId, status, now);
      else db.prepare('UPDATE Application SET status = ?, decidedAt = ? WHERE vacancyId = ?').run(status, now, vacancyId);
      db.prepare('INSERT INTO ApplicationEvent (vacancyId, type, createdAt) VALUES (?, ?, ?)').run(vacancyId, status, now);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

const server = createServer(async (req, res) => {
  const isApi = req.url.startsWith('/api/');
  if (isApi && req.headers.origin === API_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', API_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (isApi && req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Job Intelligence"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Нужен вход');
    return;
  }
  if (isApi) return handleApi(req, res);
  if (req.method === 'POST' && req.url === '/action') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { vacancyId, status, reason } = JSON.parse(body);
    const now = new Date().toISOString();
    const newStatus = status === 'reset' ? 'matched' : status;

    // при отклике фиксируем снимок оценок — чтобы позже откалибровать прогноз на исходах
    if (status === 'sent') {
      const a = db.prepare('SELECT score, reasons, coverLetter, tailoredResume FROM Application WHERE vacancyId = ?').get(vacancyId);
      if (a && !db.prepare('SELECT appliedSnapshot FROM Application WHERE vacancyId = ?').get(vacancyId)?.appliedSnapshot) {
        let rr = {}; try { rr = JSON.parse(a.reasons || '{}'); } catch {}
        const snap = {
          appliedAt: now, score: a.score, tier: rr.tier, category: rr.category,
          stars: rr.stars, hrLevel: rr.hrLevel, confidence: rr.confidence,
          salaryNet: rr.salaryNet, experience: rr.experience,
          letterLen: (a.coverLetter || '').length, hasResume: !!a.tailoredResume,
          matchedSkills: (rr.matched || []).length, missing: (rr.missing || []).length,
        };
        db.prepare('UPDATE Application SET appliedSnapshot = ? WHERE vacancyId = ?').run(JSON.stringify(snap), vacancyId);
      }
    }

    db.prepare('UPDATE Application SET status = ?, decidedAt = ? WHERE vacancyId = ?').run(newStatus, now, vacancyId);
    db.prepare('INSERT INTO ApplicationEvent (vacancyId, type, createdAt, reason) VALUES (?, ?, ?, ?)').run(vacancyId, status, now, reason ?? null);

    // Ты — самый быстрый сигнал «эта вакансия закрыта»: сразу помечаем вакансию неактивной
    // (то же самое, что делает verify-closed.mjs при обходе), чтобы она больше не попадала
    // в подбор ни тебе, ни в письма/резюме при следующей пересборке.
    if (status === 'skipped' && /архив/i.test(reason || '')) {
      db.prepare('UPDATE Vacancy SET isActive = 0, closedAt = ? WHERE id = ?').run(now, vacancyId);
      addEvent(vacancyId, null, 'closed', null, 'reported_by_user');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url === '/pipeline') res.end(pipelinePage());
  else if (req.url === '/learn') res.end(learnPage());
  else if (req.url === '/skipped') res.end(listPage('skipped'));
  else res.end(homePage(req.url.includes('showRed=1')));
});

server.listen(PORT, HOST, () => console.log(`Кокпит: http://localhost:${PORT} (слушает ${HOST})`));
