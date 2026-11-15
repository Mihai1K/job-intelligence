// Job Intelligence — content-script для страницы вакансии hh.ru.
// Только читает страницу и обращается к локальному кокпиту (127.0.0.1:8899).
// Ничего не отправляет и не кликает на hh.ru за пользователя — см. ROADMAP_EXTENSION.md.
(function () {
  const COCKPIT = 'http://127.0.0.1:8899';
  const CAT_ICON = { green: '🟢', yellow: '🟡', red: '🔴' };

  function vacancyIdFromUrl() {
    const m = location.pathname.match(/\/vacancy\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function readVacancy() {
    const title = document.querySelector('h1[data-qa="vacancy-title"]')?.textContent.trim() || '';
    const description = document.querySelector('[data-qa="vacancy-description"]')?.textContent.trim() || '';
    const company = document.querySelector('[data-qa="vacancy-company-name"]')?.textContent.trim() || '';
    const skills = [...document.querySelectorAll('[data-qa="skills-element"]')].map((el) => el.textContent.trim());
    return { title, description, company, skills };
  }

  function el(tag, attrs = {}, html) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (html != null) node.innerHTML = html;
    return node;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildPanel() {
    const panel = el('div', { id: 'ji-panel' });
    panel.appendChild(el('button', { class: 'ji-close', title: 'Скрыть' }, '✕'));
    panel.querySelector('.ji-close').onclick = () => panel.remove();
    const body = el('div', { id: 'ji-body' }, 'Считаю совпадение…');
    panel.appendChild(body);
    document.body.appendChild(panel);
    return body;
  }

  async function api(path, opts) {
    const res = await fetch(COCKPIT + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function renderError(body, msg) {
    body.innerHTML = `<h2>Job Intelligence</h2><div class="ji-error">${esc(msg)}</div>`;
  }

  function renderScore(body, vac, vacancyId, score, letter) {
    const cat = CAT_ICON[score.category] || '🟡';
    const matched = score.matched.map((s) => `<span class="ji-pill ok">✓ ${esc(s)}</span>`).join('');
    const missing = score.missing.slice(0, 6).map((s) => `<span class="ji-pill no">✗ ${esc(s)}</span>`).join('');
    const flags = score.redFlags.length
      ? score.redFlags.map((f) => `<span class="ji-flag">❌ ${esc(f)}</span>`).join('')
      : '';
    body.innerHTML = `
      <h2>${cat} Job Intelligence</h2>
      <div class="ji-score">${score.skillScore != null ? score.skillScore + '%' : '—'}</div>
      <div class="ji-sub">совпадение по навыкам с твоим профилем</div>
      ${flags}
      <div>${matched}${missing}</div>
      <details open>
        <summary>Сопроводительное письмо (черновик)</summary>
        <textarea id="ji-letter">${esc(letter)}</textarea>
      </details>
      <div class="ji-actions">
        <button class="ji-primary" id="ji-copy">📋 Скопировать письмо</button>
      </div>
      <div class="ji-actions">
        <button id="ji-sent">✓ Отправлено</button>
        <button id="ji-skip">✗ Пропустить</button>
      </div>
      <div class="ji-note">Отклик на hh отправляешь ты сам. Расширение только готовит письмо и ведёт учёт в кокпите.</div>
    `;
    body.querySelector('#ji-copy').onclick = (e) => {
      const ta = body.querySelector('#ji-letter');
      navigator.clipboard.writeText(ta.value);
      e.target.textContent = 'Скопировано ✓';
      setTimeout(() => { e.target.textContent = '📋 Скопировать письмо'; }, 1500);
    };
    const mark = async (status, btn) => {
      btn.disabled = true;
      try {
        await api('/api/applied', {
          method: 'POST',
          body: JSON.stringify({ vacancyId, title: vac.title, url: location.href, company: vac.company, status }),
        });
        btn.textContent = status === 'sent' ? 'Отмечено ✓' : 'Пропущено';
      } catch {
        btn.textContent = 'Ошибка записи';
        btn.disabled = false;
      }
    };
    body.querySelector('#ji-sent').onclick = (e) => mark('sent', e.target);
    body.querySelector('#ji-skip').onclick = (e) => mark('skipped', e.target);
  }

  async function run() {
    const vacancyId = vacancyIdFromUrl();
    if (!vacancyId) return;
    const body = buildPanel();
    const vac = readVacancy();
    if (!vac.title) {
      renderError(body, 'Не смог разобрать страницу вакансии (изменилась вёрстка hh.ru). Пользуйся кокпитом напрямую: localhost:8899');
      return;
    }
    let score;
    try {
      score = await api('/api/score', { method: 'POST', body: JSON.stringify(vac) });
    } catch {
      renderError(body, 'Кокпит недоступен. Запусти его: npm run cockpit (или проверь launchd-агент com.jobintelligence.cockpit).');
      return;
    }
    let letter = '';
    try {
      const r = await api('/api/letter', {
        method: 'POST',
        body: JSON.stringify({ title: vac.title, company: vac.company, matched: score.matched, learnable: [] }),
      });
      letter = r.letter;
    } catch {
      letter = '(не удалось сгенерировать письмо — открой кокпит и скопируй оттуда)';
    }
    renderScore(body, vac, vacancyId, score, letter);
  }

  run();
})();
