import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './config.mjs';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS Company (
    id            INTEGER PRIMARY KEY,      -- id работодателя на hh
    name          TEXT NOT NULL,
    trusted       INTEGER,
    accreditedIT  INTEGER,
    rating        REAL,
    reviewsCount  INTEGER
  );

  CREATE TABLE IF NOT EXISTS Vacancy (
    id            INTEGER PRIMARY KEY,      -- vacancyId hh
    title         TEXT NOT NULL,
    companyId     INTEGER REFERENCES Company(id),
    salaryFrom    INTEGER,
    salaryTo      INTEGER,
    currency      TEXT,
    gross         INTEGER,
    salaryMode    TEXT,                     -- MONTH / SHIFT / ...
    experience    TEXT,                     -- noExperience / between1And3 / between3And6 / moreThan6
    employmentForm TEXT,
    remote        INTEGER,                  -- 1 если доступен формат REMOTE
    workFormats   TEXT,                     -- CSV: REMOTE,HYBRID,ON_SITE
    area          TEXT,
    description   TEXT,                     -- plain text, появляется после enrich
    url           TEXT,
    publishedAt   TEXT,
    collectedAt   TEXT,
    enrichedAt    TEXT
  );

  CREATE TABLE IF NOT EXISTS Skill (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS VacancySkill (
    vacancyId INTEGER NOT NULL REFERENCES Vacancy(id),
    skillId   INTEGER NOT NULL REFERENCES Skill(id),
    source    TEXT,                          -- 'hh' (keySkills) | 'text' (из описания)
    PRIMARY KEY (vacancyId, skillId)
  );

  CREATE TABLE IF NOT EXISTS Query (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT UNIQUE NOT NULL,
    category   TEXT NOT NULL,
    searchText TEXT NOT NULL,
    totalFound INTEGER                       -- сколько всего нашёл hh по этому запросу
  );

  CREATE TABLE IF NOT EXISTS VacancyQuery (
    vacancyId INTEGER NOT NULL REFERENCES Vacancy(id),
    queryId   INTEGER NOT NULL REFERENCES Query(id),
    PRIMARY KEY (vacancyId, queryId)
  );

  CREATE TABLE IF NOT EXISTS AIAnalysis (
    vacancyId      INTEGER PRIMARY KEY REFERENCES Vacancy(id),
    level          TEXT,                     -- Junior / Middle / Senior / Lead
    difficulty     INTEGER,                  -- 1–10
    summary        TEXT,
    requiredSkills TEXT,                     -- JSON-массив
    optionalSkills TEXT,                     -- JSON-массив
    roadmap        TEXT,                     -- JSON-массив шагов
    salaryEstimate INTEGER,
    analyzedAt     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_vacancy_enriched ON Vacancy(enrichedAt);
  CREATE INDEX IF NOT EXISTS idx_vs_skill ON VacancySkill(skillId);

  -- Персональный агент поиска работы (режим 1: подтверждение человеком)
  CREATE TABLE IF NOT EXISTS Application (
    vacancyId   INTEGER PRIMARY KEY REFERENCES Vacancy(id),
    score         REAL,             -- 0..100 Application Score
    reasons       TEXT,             -- JSON: {matched:[], missing:[], salaryOk, remoteOk, freshDays}
    coverLetter   TEXT,             -- черновик письма
    tailoredResume TEXT,            -- адаптированное под вакансию резюме (JSON)
    status        TEXT DEFAULT 'matched',  -- matched / sent / viewed / interview / offer / rejected / skipped
    matchedAt     TEXT,
    decidedAt     TEXT
  );

  CREATE TABLE IF NOT EXISTS ApplicationEvent (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancyId INTEGER NOT NULL,
    type      TEXT NOT NULL,   -- matched / sent / skipped / reset
    createdAt TEXT NOT NULL
  );

  -- Событийная модель: запуски сбора, события по вакансиям, дневные снимки рынка
  CREATE TABLE IF NOT EXISTS CollectionRun (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    startedAt    TEXT NOT NULL,
    finishedAt   TEXT,
    status       TEXT NOT NULL DEFAULT 'running',  -- running / ok / failed
    seen         INTEGER DEFAULT 0,
    newCount     INTEGER DEFAULT 0,
    updatedCount INTEGER DEFAULT 0,
    closedCount  INTEGER DEFAULT 0,
    errorCount   INTEGER DEFAULT 0,
    note         TEXT
  );

  CREATE TABLE IF NOT EXISTS VacancyEvent (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancyId INTEGER NOT NULL,
    runId     INTEGER,
    type      TEXT NOT NULL,   -- new / salary_changed / description_changed / skills_changed / closed / reopened
    oldValue  TEXT,
    newValue  TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_event_run ON VacancyEvent(runId, type);
  CREATE INDEX IF NOT EXISTS idx_event_vacancy ON VacancyEvent(vacancyId);

  CREATE TABLE IF NOT EXISTS QuerySnapshot (
    date         TEXT NOT NULL,   -- YYYY-MM-DD (локальная дата)
    queryId      INTEGER NOT NULL,
    totalFound   INTEGER,
    activeCount  INTEGER,
    medianSalary REAL,
    remoteShare  REAL,
    PRIMARY KEY (date, queryId)
  );

  CREATE TABLE IF NOT EXISTS SkillSnapshot (
    date           TEXT NOT NULL,
    skillId        INTEGER NOT NULL,
    cnt            INTEGER NOT NULL,   -- активных обогащённых вакансий с этим навыком
    activeEnriched INTEGER NOT NULL,   -- всего активных обогащённых на эту дату (знаменатель доли)
    PRIMARY KEY (date, skillId)
  );
`);

// Миграция существующей базы: колонки жизненного цикла вакансии
{
  const cols = db.prepare('PRAGMA table_info(Vacancy)').all().map((c) => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE Vacancy ADD COLUMN ${ddl}`); };
  add('firstSeenAt', 'firstSeenAt TEXT');
  add('lastSeenAt', 'lastSeenAt TEXT');
  add('closedAt', 'closedAt TEXT');
  add('isActive', 'isActive INTEGER DEFAULT 1');
  db.exec(`
    UPDATE Vacancy SET
      firstSeenAt = COALESCE(firstSeenAt, collectedAt),
      lastSeenAt  = COALESCE(lastSeenAt, collectedAt),
      isActive    = COALESCE(isActive, 1)
  `);
}

// Миграция Application: адаптированное резюме + снимок оценок на момент отклика.
// appliedSnapshot фиксирует score/category/зарплату в момент отправки — чтобы позже
// откалибровать прогнозы на реальных исходах (данные нельзя восстановить задним числом).
{
  const cols = db.prepare('PRAGMA table_info(Application)').all().map((c) => c.name);
  if (!cols.includes('tailoredResume')) db.exec('ALTER TABLE Application ADD COLUMN tailoredResume TEXT');
  if (!cols.includes('appliedSnapshot')) db.exec('ALTER TABLE Application ADD COLUMN appliedSnapshot TEXT');
}

// Миграция ApplicationEvent: причина решения (для ручной обратной связи по пропускам/отказам)
{
  const cols = db.prepare('PRAGMA table_info(ApplicationEvent)').all().map((c) => c.name);
  if (!cols.includes('reason')) db.exec('ALTER TABLE ApplicationEvent ADD COLUMN reason TEXT');
}

// node:sqlite не умеет биндить undefined — приводим к null
const nn = (v) => (v === undefined ? null : v);

export function upsertCompany(c) {
  if (c.id == null) return;
  db.prepare(`
    INSERT INTO Company (id, name, trusted, accreditedIT, rating, reviewsCount)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, trusted = excluded.trusted,
      accreditedIT = excluded.accreditedIT,
      rating = excluded.rating, reviewsCount = excluded.reviewsCount
  `).run(nn(c.id), nn(c.name), c.trusted ? 1 : 0, c.accreditedIT ? 1 : 0, nn(c.rating), nn(c.reviewsCount));
}

export function upsertVacancy(v) {
  db.prepare(`
    INSERT INTO Vacancy (id, title, companyId, salaryFrom, salaryTo, currency, gross, salaryMode,
                         experience, employmentForm, remote, workFormats, area, url, publishedAt, collectedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, companyId = excluded.companyId,
      salaryFrom = excluded.salaryFrom, salaryTo = excluded.salaryTo,
      currency = excluded.currency, gross = excluded.gross, salaryMode = excluded.salaryMode,
      experience = excluded.experience, employmentForm = excluded.employmentForm,
      remote = excluded.remote, workFormats = excluded.workFormats,
      area = excluded.area, url = excluded.url, publishedAt = excluded.publishedAt
  `).run(
    nn(v.id), nn(v.title), nn(v.companyId), nn(v.salaryFrom), nn(v.salaryTo), nn(v.currency),
    nn(v.gross), nn(v.salaryMode), nn(v.experience), nn(v.employmentForm), nn(v.remote),
    nn(v.workFormats), nn(v.area), nn(v.url), nn(v.publishedAt), nn(v.collectedAt),
  );
}

export function ensureQuery(q) {
  db.prepare(`
    INSERT INTO Query (label, category, searchText) VALUES (?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET category = excluded.category, searchText = excluded.searchText
  `).run(q.label, q.category, q.searchText);
  return db.prepare('SELECT id FROM Query WHERE label = ?').get(q.label).id;
}

export function linkVacancyQuery(vacancyId, queryId) {
  db.prepare('INSERT OR IGNORE INTO VacancyQuery (vacancyId, queryId) VALUES (?, ?)').run(vacancyId, queryId);
}

export function ensureSkill(name) {
  db.prepare('INSERT OR IGNORE INTO Skill (name) VALUES (?)').run(name);
  return db.prepare('SELECT id FROM Skill WHERE name = ?').get(name).id;
}

export function linkVacancySkill(vacancyId, skillId, source) {
  db.prepare('INSERT OR IGNORE INTO VacancySkill (vacancyId, skillId, source) VALUES (?, ?, ?)').run(vacancyId, skillId, source);
}

// ---------- событийная модель ----------

export function startRun(note = null) {
  const r = db.prepare("INSERT INTO CollectionRun (startedAt, status, note) VALUES (?, 'running', ?)")
    .run(new Date().toISOString(), nn(note));
  return Number(r.lastInsertRowid);
}

export function finishRun(runId, status = 'ok') {
  // счётчики берём из событий этого запуска — единый источник правды
  const cnt = (type) => db.prepare('SELECT COUNT(*) c FROM VacancyEvent WHERE runId = ? AND type = ?').get(runId, type).c;
  db.prepare(`
    UPDATE CollectionRun SET finishedAt = ?, status = ?,
      newCount = ?, updatedCount = ?, closedCount = ?
    WHERE id = ?
  `).run(new Date().toISOString(), status, cnt('new'), cnt('salary_changed'), cnt('closed'), runId);
}

export function bumpRun(runId, field, delta = 1) {
  db.prepare(`UPDATE CollectionRun SET ${field} = ${field} + ? WHERE id = ?`).run(delta, runId);
}

export function addEvent(vacancyId, runId, type, oldValue = null, newValue = null) {
  db.prepare('INSERT INTO VacancyEvent (vacancyId, runId, type, oldValue, newValue, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(vacancyId, nn(runId), type, nn(oldValue), nn(newValue), new Date().toISOString());
}

export function lastFinishedRun() {
  return db.prepare("SELECT * FROM CollectionRun WHERE status != 'running' ORDER BY id DESC LIMIT 1").get() ?? null;
}

export const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD в локальном времени
