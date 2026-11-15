// Словарь технологий для извлечения навыков из текста описаний.
// name — каноническое имя, re — как искать в тексте (границы слова важны).
const t = (name, re) => ({ name, re });

export const SKILLS_DICT = [
  // Языки
  t('Python', /\bpython\b/i),
  t('JavaScript', /\bjavascript\b|\bjs\b(?!\w)/i),
  t('TypeScript', /\btypescript\b|\bts\b(?=[\s,./)])/i),
  t('Java', /\bjava\b(?!\s*script)/i),
  t('Go', /\bgolang\b|\bgo\b(?=[\s,./)]*(?:разработ|developer|engineer))/i),
  t('C#', /c#|\bcsharp\b/i),
  t('C++', /c\+\+/i),
  t('PHP', /\bphp\b/i),
  t('Kotlin', /\bkotlin\b/i),
  t('Swift', /\bswift\b/i),
  t('1С', /\b1с[\s:.,]|\b1c[\s:.,]/i),
  t('SQL', /\bsql\b/i),

  // Backend-фреймворки
  t('FastAPI', /\bfastapi\b/i),
  t('Django', /\bdjango\b/i),
  t('Flask', /\bflask\b/i),
  t('Node.js', /\bnode\.?js\b|\bнода\b/i),
  t('NestJS', /\bnestjs\b|\bnest\.js\b/i),
  t('Express', /\bexpress\.?js\b/i),
  t('Spring', /\bspring\b/i),
  t('Laravel', /\blaravel\b/i),
  t('.NET', /\.net\b|\bdotnet\b/i),

  // Frontend
  t('React', /\breact\b/i),
  t('Next.js', /\bnext\.?js\b/i),
  t('Vue', /\bvue\b/i),
  t('Angular', /\bangular\b/i),
  t('Svelte', /\bsvelte\b/i),
  t('Tailwind', /\btailwind\b/i),
  t('HTML/CSS', /\bhtml\b|\bcss\b/i),

  // Базы данных
  t('PostgreSQL', /\bpostgres(?:ql)?\b/i),
  t('SQLite', /\bsqlite\b/i),
  t('Prisma', /\bprisma\b/i),
  t('MySQL', /\bmysql\b/i),
  t('MongoDB', /\bmongo(?:db)?\b/i),
  t('Redis', /\bredis\b/i),
  t('ClickHouse', /\bclickhouse\b/i),
  t('Elasticsearch', /\belastic(?:search)?\b/i),
  t('MS SQL', /\bms\s?sql\b|\bsql\s?server\b/i),
  t('Oracle', /\boracle\b/i),

  // Очереди и шины
  t('Kafka', /\bkafka\b/i),
  t('RabbitMQ', /\brabbitmq\b/i),

  // Инфраструктура
  t('Docker', /\bdocker\b/i),
  t('Kubernetes', /\bkubernetes\b|\bk8s\b/i),
  t('CI/CD', /\bci\s?\/?\s?cd\b/i),
  t('Git', /\bgit\b(?!hub|lab)/i),
  t('GitHub', /\bgithub\b/i),
  t('GitLab', /\bgitlab\b/i),
  t('Linux', /\blinux\b/i),
  t('Nginx', /\bnginx\b/i),
  t('Terraform', /\bterraform\b/i),
  t('Ansible', /\bansible\b/i),

  // Облака
  t('AWS', /\baws\b|\bamazon web services\b/i),
  t('Yandex Cloud', /\byandex\.?\s?cloud\b|\bяндекс[\s.]облак/i),
  t('Azure', /\bazure\b/i),
  t('GCP', /\bgcp\b|\bgoogle cloud\b/i),

  // API и протоколы
  t('REST API', /\brest(?:ful)?\b|\brest api\b/i),
  t('OAuth', /\boauth\s?2?(?:\.0)?\b|\bавторизац\w* по токен\w*/i),
  t('GraphQL', /\bgraphql\b/i),
  t('gRPC', /\bgrpc\b/i),
  t('WebSocket', /\bwebsocket/i),

  // AI / ML
  t('LLM', /\bllm\b|большие языковые модели/i),
  t('ChatGPT/OpenAI', /\bchatgpt\b|\bopenai\b|\bgpt-?[45o]/i),
  t('Claude/Anthropic', /\bclaude\b|\banthropic\b/i),
  t('LangChain', /\blangchain\b/i),
  t('RAG', /\brag\b/i),
  t('Prompt Engineering', /\bprompt\b|промпт/i),
  t('PyTorch', /\bpytorch\b|\btorch\b/i),
  t('TensorFlow', /\btensorflow\b/i),
  t('Machine Learning', /\bmachine learning\b|\bml\b|машинн\w+ обучени/i),
  t('Computer Vision', /\bcomputer vision\b|\bcv\b(?=[\s,./)])/i),
  t('NLP', /\bnlp\b/i),
  t('AI-агенты', /\bai[\s-]?agent|аи[\s-]?агент|ии[\s-]?агент|автономн\w+ агент/i),

  // Автоматизация / no-code / CRM
  t('n8n', /\bn8n\b/i),
  t('Make (Integromat)', /\bmake\.com\b|\bintegromat\b/i),
  t('Zapier', /\bzapier\b/i),
  t('Битрикс24', /\bбитрикс\s?24\b|\bbitrix\s?24\b/i),
  t('1С-Битрикс', /1с[-\s]битрикс|bitrix(?!\s?24)/i),
  t('amoCRM', /\bamocrm\b|\bамосрм\b|\bамо\s?crm\b/i),
  t('Telegram Bot', /\btelegram\b.{0,20}\bбот|\bбот\w*\b.{0,20}telegram|\btelegram bot\b|\baiogram\b/i),
  t('Airflow', /\bairflow\b/i),

  // Тестирование
  t('pytest', /\bpytest\b/i),
  t('Jest', /\bjest\b/i),
  t('Selenium', /\bselenium\b/i),
  t('Playwright', /\bplaywright\b/i),

  // Аналитика и процессы
  t('Grafana', /\bgrafana\b/i),
  t('Prometheus', /\bprometheus\b/i),
  t('Jira', /\bjira\b/i),
  t('Agile/Scrum', /\bagile\b|\bscrum\b|\bkanban\b/i),
  t('Figma', /\bfigma\b/i),
  t('Power BI', /\bpower\s?bi\b/i),
  t('Excel', /\bexcel\b/i),
  t('API-интеграции', /интеграци/i),
];

// Нормализация ключевых навыков от hh (их пишут работодатели как попало)
const HH_SKILL_ALIASES = new Map([
  ['postgres', 'PostgreSQL'], ['postgresql', 'PostgreSQL'],
  ['js', 'JavaScript'], ['javascript', 'JavaScript'],
  ['ts', 'TypeScript'], ['typescript', 'TypeScript'],
  ['nodejs', 'Node.js'], ['node.js', 'Node.js'], ['node js', 'Node.js'],
  ['react.js', 'React'], ['reactjs', 'React'], ['react', 'React'],
  ['golang', 'Go'],
  ['докер', 'Docker'], ['docker', 'Docker'],
  ['гит', 'Git'], ['git', 'Git'],
  ['python', 'Python'],
  ['sql', 'SQL'],
  ['битрикс24', 'Битрикс24'], ['bitrix24', 'Битрикс24'],
  ['amocrm', 'amoCRM'], ['амосрм', 'amoCRM'],
  ['rest', 'REST API'], ['rest api', 'REST API'], ['api', 'REST API'],
  ['sqlite', 'SQLite'], ['prisma', 'Prisma'],
  ['oauth', 'OAuth'], ['oauth2', 'OAuth'], ['oauth 2.0', 'OAuth'],
  ['next.js', 'Next.js'], ['nextjs', 'Next.js'],
  ['nginx', 'Nginx'], ['енджиникс', 'Nginx'],
  ['express', 'Express'], ['expressjs', 'Express'],
  ['ci/cd', 'CI/CD'], ['cicd', 'CI/CD'],
  ['k8s', 'Kubernetes'], ['kubernetes', 'Kubernetes'],
]);

export function normalizeHHSkill(raw) {
  const key = raw.trim().toLowerCase();
  return HH_SKILL_ALIASES.get(key) ?? raw.trim();
}

export function extractSkillsFromText(text) {
  const found = [];
  for (const { name, re } of SKILLS_DICT) {
    if (re.test(text)) found.push(name);
  }
  return found;
}
