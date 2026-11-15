// Конфигурация Job Intelligence

// Поисковые запросы. searchText — на языке поиска hh.ru (поддерживает OR, скобки, *)
// Поиск идёт по названию вакансии (search_field=name), чтобы не ловить мусор из описаний.
export const QUERIES = [
  // --- AI и разработка ---
  { label: 'AI Engineer',            category: 'AI и разработка', searchText: '"ai engineer" OR "ии-инженер" OR "инженер ии"' },
  { label: 'LLM Engineer',           category: 'AI и разработка', searchText: 'LLM' },
  { label: 'Prompt Engineer',        category: 'AI и разработка', searchText: 'prompt OR промпт' },
  { label: 'Python Developer',       category: 'AI и разработка', searchText: 'python' },
  { label: 'Backend Developer',      category: 'AI и разработка', searchText: 'backend OR бэкенд' },
  { label: 'Fullstack Developer',    category: 'AI и разработка', searchText: 'fullstack OR "full stack" OR фулстек' },
  { label: 'TypeScript Developer',   category: 'AI и разработка', searchText: 'typescript' },
  { label: 'Node.js Developer',      category: 'AI и разработка', searchText: '"node.js" OR nodejs' },

  // --- Автоматизация и интеграции ---
  { label: 'AI Automation Engineer', category: 'Автоматизация', searchText: 'автоматизаци* AND (ai OR ии OR нейросет*)' },
  { label: 'CRM Developer',          category: 'Автоматизация', searchText: 'crm AND (разработчик OR developer OR интегратор OR внедрен*)' },
  { label: 'Integration Engineer',   category: 'Автоматизация', searchText: '"integration engineer" OR "разработчик интеграций" OR "инженер интеграций"' },
  { label: 'No-Code Developer',      category: 'Автоматизация', searchText: '"no-code" OR nocode OR зерокод* OR n8n' },
  { label: 'Битрикс/amoCRM',         category: 'Автоматизация', searchText: 'битрикс* OR amocrm' },

  // --- Добавлено 4 августа: роли, найденные вручную на hh, но не покрытые запросами выше ---
  { label: 'React/Frontend Developer', category: 'AI и разработка', searchText: 'react OR frontend OR фронтенд' },
  { label: 'AI Product Engineer',    category: 'Автоматизация', searchText: '"продуктовый инженер" OR "ai product" OR "product engineer" OR "ai-product"' },
  { label: 'Vibe coding / AI-assisted', category: 'AI и разработка', searchText: 'вайбкод* OR "vibe coding" OR "ai-assisted"' },
];

export const SETTINGS = {
  area: 113,              // Россия
  maxPagesPerQuery: 4,    // 4 страницы × ~50 вакансий = до ~200 на запрос
  delayMs: 1100,          // базовая пауза между запросами
  delayJitterMs: 700,     // + случайная добавка, чтобы не долбить сайт ровным ритмом
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  netFactor: 0.87,        // перевод gross → net (НДФЛ 13%)
};

import { fileURLToPath } from 'node:url';

// ВАЖНО: new URL(...).pathname отдаёт percent-encoded путь и ломается на кириллице —
// всегда используем fileURLToPath
export const projectPath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export const DB_PATH = projectPath('../data/jobintel.db');
