const $ = (id) => document.getElementById(id);

const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
$('themeIcon').textContent = savedTheme === 'dark' ? '\u2600' : '\u263E';

$('themeBtn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    $('themeIcon').textContent = next === 'dark' ? '\u2600' : '\u263E';
});

let currentRunId = null;
let pollTimer = null;
let modelCols = [];
let analyzeResults = [];

const requiredColumns = [
    'query_id',
    'query',
    'GigaChat - Original',
    'GigaChat - castom_max',
    'GigaChat - castom_min',
];

const dropZone = $('dropZone');
const fileInput = $('fileInput');

$('selectFileBtn').addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
});

$('csvTemplateBtn').addEventListener('click', () => {
    const header = ['query_id', 'type', 'turn', 'query', 'GigaChat - Original', 'GigaChat - castom_max', 'GigaChat - castom_min'];
    const row = ['ST-01', 'single', '', 'Пример запроса', 'Ответ original', 'Ответ castom_max', 'Ответ castom_min'];
    const csv = `${header.join(';')}\n${row.join(';')}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'analyze_template.csv';
    link.click();
    URL.revokeObjectURL(link.href);
});

fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) uploadFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]);
});

async function uploadFile(file) {
    if (!file.name.endsWith('.csv')) {
        showValidation('bad', ['Выберите CSV-файл.']);
        return;
    }

    showBanner('running', 'Загрузка CSV', file.name);
    $('runBtn').disabled = true;

    const form = new FormData();
    form.append('file', file);

    try {
        const resp = await fetch('/api/analyze/upload', { method: 'POST', body: form });
        if (!resp.ok) {
            const err = await resp.json();
            showBanner('error', 'Ошибка загрузки', err.detail || 'CSV не принят сервером.');
            showValidation('bad', [err.detail || 'Проверьте формат CSV.']);
            return;
        }
        const data = await resp.json();
        currentRunId = data.run_id;
        modelCols = data.model_cols || [];

        const missing = requiredColumns.filter(c => !(data.columns || []).includes(c));
        if (missing.length) {
            showValidation('bad', missing.map(c => `Не найдена колонка: ${c}`));
            $('runBtn').disabled = true;
        } else {
            showValidation('ok', [
                `Найдено строк: ${data.total_rows}`,
                `Запросов: ${data.total_queries} (single: ${data.single_count}, multi: ${data.multi_count})`,
                `Модели: ${modelCols.join(', ')}`,
            ]);
            $('runBtn').disabled = false;
        }

        $('previewStats').textContent =
            `Всего строк: ${data.total_rows} | Запросов: ${data.total_queries} ` +
            `(single: ${data.single_count}, multi: ${data.multi_count}) | ` +
            `Модели: ${modelCols.join(', ')}`;

        renderPreview(data.columns || [], data.preview || []);
        $('previewSection').style.display = '';
        $('downloadBtn').style.display = 'none';
        $('resultsLayout').style.display = 'none';
        $('runSummary').textContent = `Run ID ${data.run_id}. ${$('testModeCheck').checked ? 'Тестовый прогон: первые 3 запроса.' : 'Полный анализ.'}`;
        showBanner('done', 'Файл загружен', `Run ID ${data.run_id}`);
    } catch (e) {
        showBanner('error', 'Ошибка загрузки', e.message);
    }
}

function renderPreview(columns, rows) {
    const head = $('previewHead');
    const body = $('previewBody');
    head.innerHTML = '<tr>' + columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
    body.innerHTML = '';
    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = columns.map(c => {
            const val = String(row[c] || '');
            return `<td>${esc(shorten(val, 80))}</td>`;
        }).join('');
        body.appendChild(tr);
    }
}

$('testModeCheck').addEventListener('change', () => {
    if (!currentRunId) return;
    $('runSummary').textContent = `Run ID ${currentRunId}. ${$('testModeCheck').checked ? 'Тестовый прогон: первые 3 запроса.' : 'Полный анализ.'}`;
});

$('runBtn').addEventListener('click', async () => {
    if (!currentRunId) return;

    $('runBtn').disabled = true;
    $('downloadBtn').style.display = 'none';
    $('resultsBody').innerHTML = '';
    $('resultsCards').innerHTML = '';
    $('resultsLayout').style.display = 'none';
    $('detailsPanel').innerHTML = '<div class="details-empty">Результаты появятся после первых сравнений.</div>';
    analyzeResults = [];
    setProgress(0);
    showBanner('running', 'Запуск анализа', 'Ожидаем первый статус от сервера...');

    try {
        const testMode = $('testModeCheck').checked;
        const runUrl = `/api/analyze/run/${currentRunId}` + (testMode ? '?test_mode=true' : '');
        const resp = await fetch(runUrl, { method: 'POST' });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.statusText);
        const data = await resp.json();
        const testLabel = testMode ? 'Тест: первые 3 запроса' : 'Полный анализ';
        showBanner('running', `Анализ #${currentRunId}`, `${data.total} вызовов судьи · ${testLabel}`);
        startPolling();
    } catch (e) {
        showBanner('error', 'Ошибка запуска', e.message);
        $('runBtn').disabled = false;
    }
});

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1500);
    pollStatus();
}

async function pollStatus() {
    if (!currentRunId) return;

    try {
        const resp = await fetch(`/api/analyze/status/${currentRunId}`);
        if (!resp.ok) {
            stopPolling();
            showBanner('error', 'Run не найден', 'Сервер мог быть перезапущен.');
            $('runBtn').disabled = false;
            return;
        }
        const s = await resp.json();

        const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
        setProgress(pct);

        const phaseLabel = s.phase === 'pairwise' ? 'Попарное сравнение' :
                           s.phase === 'independent' ? 'Независимая оценка' :
                           s.phase === 'comparison' ? 'Сравнительный анализ' : s.phase;
        showBanner('running', phaseLabel, `${s.completed}/${s.total} · ${s.current || ''}`);

        renderStats(s);

        if (s.status === 'done') {
            stopPolling();
            setProgress(100);
            const doneTokens = s.stats ? (s.stats.tokens_total || 0).toLocaleString() : '?';
            const doneTime = s.stats ? `${s.stats.elapsed || 0}с` : '';
            showBanner('done', `Анализ #${currentRunId} завершен`, `${doneTokens} токенов · ${doneTime}`);
            $('downloadBtn').style.display = '';
            $('runBtn').disabled = false;
            await loadResults();
        } else if (s.status === 'error') {
            stopPolling();
            showBanner('error', 'Ошибка анализа', s.current || 'Неизвестная ошибка');
            $('runBtn').disabled = false;
        } else if (s.result_count > 0) {
            await loadResults();
        }
    } catch (e) {
        showBanner('warning', 'Связь с сервером нестабильна', 'Продолжаю опрашивать статус...');
    }
}

function renderStats(s) {
    if (s.stats) {
        $('statsPanel').style.display = '';
        $('statCalls').textContent = `API: ${s.stats.api_calls || 0}`;
        $('statTokens').textContent = `Токены: ${(s.stats.tokens_total || 0).toLocaleString()} (↑${(s.stats.tokens_prompt || 0).toLocaleString()} ↓${(s.stats.tokens_completion || 0).toLocaleString()})`;
        $('statElapsed').textContent = `Время: ${s.stats.elapsed || 0}с`;
        $('statErrors').textContent = s.stats.errors ? `Ошибки: ${s.stats.errors}` : '';
        $('statErrors').className = s.stats.errors ? 'stat-err' : '';
    }
    if (s.log && s.log.length) {
        const logEl = $('statsLog');
        logEl.textContent = s.log.map(e => `[${e.t}s] ${e.msg}`).join('\n');
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

async function loadResults() {
    if (!currentRunId) return;
    try {
        const resp = await fetch(`/api/analyze/results/${currentRunId}`);
        const data = await resp.json();

        const mc = data.model_cols || modelCols;
        analyzeResults = data.results || [];
        $('resultsLayout').style.display = '';

        const head = $('resultsHead');
        let headerHtml = '<tr><th>ID</th><th>Тип</th><th>Turns</th><th>Запрос</th>';
        for (const m of mc) {
            headerHtml += `<th>${esc(m)}<br><small>победы в парах</small></th>`;
        }
        headerHtml += '<th>Победитель</th><th></th></tr>';
        head.innerHTML = headerHtml;

        const body = $('resultsBody');
        const cards = $('resultsCards');
        body.innerHTML = '';
        cards.innerHTML = '';
        analyzeResults.forEach((r, index) => {
            body.appendChild(renderAnalyzeRow(r, mc, index));
            cards.appendChild(renderAnalyzeCard(r, index));
        });
    } catch (e) {
        showBanner('warning', 'Не удалось обновить результаты', e.message);
    }
}

function renderAnalyzeRow(r, mc, index) {
    const tr = document.createElement('tr');
    let html = `<td class="cell-id">${esc(r.query_id)}</td>`;
    html += `<td class="cell-type">${r.type === 'multi' ? 'MT' : 'ST'}</td>`;
    html += `<td class="cell-type">${r.turns_count || 1}</td>`;
    html += `<td class="cell-query">${esc(shorten(r.query, 180))}</td>`;

    for (const m of mc) {
        const model = (r.models || {})[m] || {};
        const wins = model.wins != null ? model.wins : 0;
        const response = model.response || '';
        html += `<td class="cell-score ${wins ? 'score-good' : ''}" title="${esc(response)}">`
            + `<strong>${wins}</strong><br><small class="metrics-line">${esc(shorten(response, 80))}</small></td>`;
    }

    const winner = (r.comparison || {}).winner || '\u2014';
    html += `<td class="cell-score" style="font-size:12px">${esc(winner)}</td>`;
    html += `<td><button class="btn btn-ghost btn-small" data-analyze-index="${index}">Детали</button></td>`;
    tr.innerHTML = html;
    return tr;
}

function renderAnalyzeCard(r, index) {
    const winner = (r.comparison || {}).winner || '\u2014';
    const card = document.createElement('article');
    card.className = 'result-card';
    card.innerHTML = `
        <div class="result-card-top">
            <strong>${esc(r.query_id)}</strong>
            <span class="score-chip score-good">${esc(winner)}</span>
        </div>
        <div class="result-card-meta">${r.type === 'multi' ? 'MT' : 'ST'} · ${r.turns_count || 1} turns</div>
        <p>${esc(shorten(r.query, 170))}</p>
        <button class="btn btn-ghost btn-small" data-analyze-index="${index}">Детали</button>
    `;
    return card;
}

function showAnalyzeDetails(index) {
    const r = analyzeResults[index];
    if (!r) return;
    const comp = r.comparison || {};
    const pairDetails = (comp.pairs || []).map(p => {
        const criteria = (p.criteria || []).join(', ');
        return `${p.model_1} vs ${p.model_2}: ${p.winner} (${p.winner_code})\ncriteria: [${criteria}]`;
    }).join('\n\n') || comp.analysis || '';

    const modelBlocks = Object.entries(r.models || {}).map(([name, model]) => `
        <div class="detail-block">
            <h3>${esc(name)} · победы: ${esc(model.wins != null ? model.wins : 0)}</h3>
            <p>${esc(model.response || '')}</p>
        </div>
    `).join('');

    $('detailsPanel').innerHTML = `
        <div class="details-header">
            <div>
                <span class="step-kicker">${r.type === 'multi' ? 'multi-turn' : 'single-turn'}</span>
                <h2>${esc(r.query_id)}</h2>
            </div>
            <span class="score-chip score-good">${esc(comp.winner || '\u2014')}</span>
        </div>
        <div class="detail-block"><h3>Запрос</h3><p>${esc(r.query)}</p></div>
        ${modelBlocks}
        <div class="detail-block"><h3>Попарные сравнения</h3><pre>${esc(pairDetails)}</pre></div>
    `;
}

document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-analyze-index]');
    if (!target) return;
    showAnalyzeDetails(Number(target.dataset.analyzeIndex));
});

function showValidation(kind, items) {
    $('uploadValidation').className = `validation-list ${kind}`;
    $('uploadValidation').innerHTML = items.map(item => `<span>${esc(item)}</span>`).join('');
}

function setProgress(pct) {
    $('progressFill').style.width = `${pct}%`;
}

function showBanner(kind, title, message) {
    const banner = $('runBanner');
    banner.hidden = false;
    banner.className = `run-banner ${kind}`;
    $('runBannerTitle').textContent = title;
    $('progressText').textContent = message;
    $('statusText').textContent = title;
}

function scoreClass(score) {
    if (score == null) return '';
    if (score >= 4) return 'score-good';
    if (score >= 3) return 'score-ok';
    return 'score-bad';
}

function shorten(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max)}...` : value;
}

function esc(text) {
    const d = document.createElement('div');
    d.textContent = String(text || '');
    return d.innerHTML;
}

$('downloadBtn').addEventListener('click', () => {
    if (!currentRunId) return;
    window.open(`/api/analyze/download/${currentRunId}`, '_blank');
});
