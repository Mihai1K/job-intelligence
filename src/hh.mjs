import { SETTINGS } from './config.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const politePause = () => sleep(SETTINGS.delayMs + Math.floor(Math.random() * SETTINGS.delayJitterMs));

export async function fetchHtml(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': SETTINGS.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
      });
      if (res.status === 404) return { status: 404, html: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, html: await res.text() };
    } catch (err) {
      if (i === attempts) throw err;
      await sleep(2000 * i);
    }
  }
}

// Декод HTML-сущностей: числовые (&#34; &#x22;) и именованные. Порядок важен: &amp; — последним.
export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Вытаскивает JSON из <template id="HH-Lux-InitialState">…</template>.
// HH с 2026 HTML-экранирует содержимое (&#34; вместо "), поэтому декодируем перед парсингом.
export function parseInitialState(html) {
  const anchor = html.indexOf('id="HH-Lux-InitialState"');
  if (anchor < 0) return null;
  const start = html.indexOf('>', anchor) + 1;
  const end = html.indexOf('</template>', start);
  if (end < 0) return null;
  const raw = html.slice(start, end);
  try {
    return JSON.parse(raw);                 // на случай, если HH вернёт сырой JSON
  } catch {
    try {
      return JSON.parse(decodeEntities(raw)); // экранированный вариант (текущий)
    } catch {
      return null;
    }
  }
}

// Описание вакансии приходит как HTML, экранированный сущностями — декодируем и убираем теги
export function htmlToText(escaped) {
  if (!escaped) return '';
  return decodeEntities(escaped)
    .replace(/<(br|\/p|\/li|\/ul|\/ol|\/div)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

// Нормализует вакансию из поисковой выдачи в плоскую запись для БД
export function normalizeVacancy(v, collectedAt) {
  const comp = v.compensation || {};
  const formats = (v.workFormats || [])
    .flatMap((f) => f.workFormatsElement || [])
    .filter((x, i, a) => a.indexOf(x) === i);
  return {
    id: v.vacancyId,
    title: v.name,
    companyId: v.company?.id ?? null,
    salaryFrom: comp.perModeFrom ?? comp.from ?? null,
    salaryTo: comp.perModeTo ?? comp.to ?? null,
    currency: comp.currencyCode ?? null,
    gross: comp.gross ? 1 : 0,
    salaryMode: comp.mode ?? null,
    experience: v.workExperience ?? null,
    employmentForm: v.employmentForm ?? null,
    remote: formats.includes('REMOTE') ? 1 : 0,
    workFormats: formats.join(','),
    area: v.area?.name ?? null,
    url: v.links?.desktop ?? `https://hh.ru/vacancy/${v.vacancyId}`,
    publishedAt: v.publicationTime?.$ ?? null,
    collectedAt,
    company: v.company
      ? {
          id: v.company.id,
          name: v.company.visibleName || v.company.name,
          trusted: v.company['@trusted'] ?? null,
          accreditedIT: v.company.accreditedITEmployer ?? null,
          rating: v.company.employerReviews?.totalRating ? Number(v.company.employerReviews.totalRating) : null,
          reviewsCount: v.company.employerReviews?.reviewsCount ?? null,
        }
      : null,
  };
}
