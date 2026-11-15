// Логика ранжирования вакансий под профиль: веса навыков, категории, флаги, звёзды.
// Вынесено отдельно, чтобы match.mjs остался коротким.

// Вес навыка = насколько он важен для целевой роли (Node.js Backend, июль 2026).
// Механика: совпавшие навыки добавляют вес, требуемые-но-отсутствующие вычитают.
// Отсюда три группы:
//   1) есть у кандидата и нужны для цели → высокий вес (бустят backend-вакансии);
//   2) НЕТ у кандидата (Python, Java, Go…) → высокий вес (штрафуют чужие стеки);
//   3) есть, но НЕ целевые (Битрикс24, n8n, no-code) → низкий вес, иначе CRM-вакансии
//      набивают балл на профильных совпадениях и вытесняют разработку из топа.
export const SKILL_WEIGHTS = {
  // 1) целевое backend-ядро
  'Node.js': 15, 'TypeScript': 13, 'JavaScript': 12, 'PostgreSQL': 10,
  'REST API': 9, 'SQL': 9, 'Docker': 8, 'React': 8,
  'Express': 7, 'Next.js': 7, 'Prisma': 7, 'NestJS': 7,
  'SQLite': 6, 'Nginx': 6, 'OAuth': 6, 'Git': 5, 'Redis': 5, 'Kafka': 5,

  // 2) чужие стеки — высокий вес, чтобы такие вакансии уходили вниз
  'Python': 15, 'Java': 15, 'Go': 15, 'Scala': 14, 'C#': 14, 'C++': 14,
  'Kotlin': 13, 'Swift': 13, 'PHP': 12, '.NET': 12, '1С': 12,
  'Machine Learning': 12, 'Computer Vision': 11, 'NLP': 11, 'Kubernetes': 8, 'FastAPI': 8,

  // 3) непрофильные для цели, но имеющиеся — намеренно низкий вес
  'LLM': 6, 'AI-агенты': 5, 'Prompt Engineering': 5,
  'Claude/Anthropic': 4, 'ChatGPT/OpenAI': 4, 'RAG': 4, 'LangChain': 4,
  'API-интеграции': 4, 'Telegram Bot': 3,
  'n8n': 2, 'No-code': 2, 'Битрикс24': 1, 'amoCRM': 1,
};
export const weightOf = (name) => SKILL_WEIGHTS[name] ?? 3;

// Языки программирования как «ядро роли». Если вакансия их требует, а у кандидата нет —
// это красный флаг и, как правило, роль не для него.
export const CORE_LANGS = ['Python', 'Java', 'Go', 'C#', 'C++', 'PHP', 'Node.js', 'TypeScript', 'Kotlin', 'Swift', 'Scala'];

// Часы на освоение (оценка модели, помечается в UI как оценка).
export const LEARN_HOURS = {
  'Docker': 40, 'FastAPI': 30, 'PostgreSQL': 25, 'RAG': 20, 'LangChain': 20,
  'Redis': 15, 'Kubernetes': 60, 'REST API': 8, 'Zapier': 4, 'Make (Integromat)': 4,
  'Airflow': 20, 'GraphQL': 10, 'Kafka': 20, 'PyTorch': 60, 'TensorFlow': 60,
};

// Категория вакансии по названию: 🟢 идеально / 🟡 можно пробовать / 🔴 не рекомендую.
// 🔴 чужие стеки и роли, из которых кандидат уходит (продажи, поддержка, бизнес-анализ).
// backend/бэкенд убраны из красного — теперь это ЦЕЛЬ, а не антицель.
const RED_TITLE = /(python[\s-]*(разработчик|developer|dev)|java(?!script)|golang|\bgo[\s-]*(developer|разработчик)|scala|\bphp\b|\.net|c\+\+|c#|ml[\s-]*engineer|machine learning|data scientist|дата[\s-]*саентист|devops|sre|системный администратор|qa[\s-]*(automation|инженер)|автотест|инженер[\s-]*тестиров|embedded|1с[\s-]*разработ|менеджер[\s-]*по[\s-]*продаж|sales[\s-]*manager|специалист[\s-]*по[\s-]*продаж|аналитик|analyst|руководител|директор|техподдержк)/i;

// 🟢 цель: Node.js / backend / fullstack на JS-стеке + AI-автоматизация как второе направление
const GREEN_TITLE = /(node\.?\s?js|бэкенд|backend|back-end|fullstack|full[\s-]*stack|фулстек|javascript|\bjs\b|typescript|\bts\b|react|next\.?js|веб[\s-]*разработчик|web[\s-]*developer|разработчик[\s-]*интеграц|integration[\s-]*engineer|ai[\s-]*automation|ии[\s-]*автоматизац|автоматизатор|no[\s-]?code|nocode|зерокод|prompt|промпт|ai[\s-]*интегратор|ии[\s-]*интегратор|ai[\s-]*специалист|ии[\s-]*специалист|внедрени[ею][\s-]*(ии|ai|нейросет)|\bn8n\b)/i;

// 🟡 смежное: CRM-интеграции и общая «разработка» без указания стека
const YELLOW_TITLE = /(битрикс|bitrix|amocrm|амосрм|амо[\s-]?crm|\bcrm\b|интегратор|разработчик|developer|программист)/i;

export function categorize(title, missingCore) {
  if (RED_TITLE.test(title) || missingCore.length) return 'red';
  if (GREEN_TITLE.test(title)) return 'green';
  if (YELLOW_TITLE.test(title)) return 'yellow';
  return 'yellow'; // неопознанное — «можно пробовать»
}

export const CATEGORY = {
  green: { icon: '🟢', label: 'Идеально', order: 0 },
  yellow: { icon: '🟡', label: 'Можно пробовать', order: 1 },
  red: { icon: '🔴', label: 'Не рекомендую', order: 2 },
};
