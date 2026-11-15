// Ежедневный пайплайн Job Intelligence:
//   сбор → обогащение новых → проверка закрытых → снимки истории → пересборка дашборда.
// Завершается контролируемо и пишет итоговый статус в CollectionRun (виден в дашборде).
// Запуск: npm run daily   (его же дергает launchd каждый день)
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { db, startRun, finishRun, bumpRun } from './db.mjs';
import { projectPath } from './config.mjs';

const LOCK = projectPath('../data/daily.lock');
const nodeBin = process.execPath;
const step = (name, args, env = {}) => {
  console.log(`\n=== ${name} ===`);
  execFileSync(nodeBin, args, {
    cwd: projectPath('..'),
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 90 * 60 * 1000,
  });
};

// защита от параллельных запусков (вчерашний ещё идёт / запущен вручную)
if (existsSync(LOCK)) {
  const age = Date.now() - Number(readFileSync(LOCK, 'utf8') || 0);
  if (age < 3 * 3600 * 1000) {
    console.error('Уже идёт другой запуск (data/daily.lock свежий) — выходим.');
    process.exit(0);
  }
  console.error('Найден устаревший lock — перезаписываем.');
}
writeFileSync(LOCK, String(Date.now()));

const runId = startRun('daily');
console.log(`Запуск #${runId}, ${new Date().toLocaleString('ru-RU')}`);

let status = 'ok';
let broken = false;
try {
  step('1/6 Сбор вакансий', [projectPath('collect.mjs')], { RUN_ID: String(runId) });

  // АВАРИЙНЫЙ СТОП: если сбор массово провалился (сеть/бан/пустая выдача), собрано будет
  // катастрофически мало. В этом случае НЕ трогаем вакансии (иначе закроем живые как в тот
  // раз со 147), не строим снимок истории (испортит тренды) и помечаем «сбор нарушен».
  const cur = db.prepare('SELECT seen, errorCount FROM CollectionRun WHERE id = ?').get(runId);
  // база — последний РЕАЛЬНО успешный запуск (seen>0); прошлые false-ok с seen=0 игнорируем
  const lastGood = db.prepare("SELECT seen FROM CollectionRun WHERE status = 'ok' AND seen > 0 AND id < ? ORDER BY id DESC LIMIT 1").get(runId);
  const baseline = lastGood?.seen || 0;
  const floor = Math.max(50, Math.round(baseline * 0.3)); // ждём хотя бы 30% от прошлого успешного
  if (cur.seen < floor) {
    broken = true;
    console.error(`⛔ СБОР НАРУШЕН: собрано ${cur.seen}, ошибок ${cur.errorCount}, ожидалось ≥ ${floor} (база ${baseline}).`);
    console.error('   Пропускаю обогащение/проверку закрытых/снимок/подбор — вакансии и история НЕ меняются.');
  } else {
    step('2/6 Обогащение новых', [projectPath('enrich.mjs'), '400'], { RUN_ID: String(runId) });
    step('3/6 Проверка закрытых', [projectPath('verify-closed.mjs'), '150'], { RUN_ID: String(runId) });
    step('4/6 Снимки истории', [projectPath('snapshot.mjs')]);
    // персональный агент: пересчитать совпадения и письма под профиль
    step('5/6 Подбор вакансий под профиль', [projectPath('match.mjs')]);
    step('5.1 Черновики писем', [projectPath('letters.mjs')]);
    step('5.2 Адаптация резюме', [projectPath('resume.mjs')]);
  }
} catch (err) {
  status = 'failed';
  bumpRun(runId, 'errorCount');
  console.error(`Пайплайн упал: ${err.message}`);
}

// итог фиксируем ДО пересборки дашборда, чтобы статус попал на страницу
finishRun(runId, broken ? 'broken' : status);
try {
  step('6/6 Пересборка дашборда', [projectPath('report.mjs')]);
} catch (err) {
  status = 'failed';
  console.error(`Пересборка дашборда упала: ${err.message}`);
}
try { unlinkSync(LOCK); } catch {}

const run = db.prepare('SELECT * FROM CollectionRun WHERE id = ?').get(runId);
console.log(`
Последний сбор: ${new Date(run.finishedAt).toLocaleString('ru-RU')} (${run.status})
Собрано:   ${run.seen}
Новых:     ${run.newCount}
Обновлено: ${run.updatedCount}
Закрыто:   ${run.closedCount}
Ошибок:    ${run.errorCount}
`);
process.exit(status === 'ok' ? 0 : 1);
