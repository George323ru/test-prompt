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
let lastResultCount = 0;
let currentDataset = 'standard';
let queryData = null;
let evalResults = [];

const datasetLabels = {
    standard: 'Стандартная',
    thinking: 'Мышление',
    v2: 'Тест v2',
    test50: '50 доменов',
};

$('datasetSelect').addEventListener('change', () => {
    currentDataset = $('datasetSelect').value;
    updateQueryInfo();
    updateRunSummary();
    $('singleOnlyRow').style.display = (['thinking', 'v2', 'test50'].includes(currentDataset)) ? 'none' : '';
    updateTableHeaders();
});
$('singleOnlyCheck').addEventListener('change', updateRunSummary);
$('judgeCheck').addEventListener('change', updateRunSummary);
$('labelInput').addEventListener('input', updateRunSummary);
$('promptInput').addEventListener('input', updateRunSummary);
document.querySelectorAll('[data-preset]').forEach(button => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
});

function applyPreset(preset) {
    document.querySelectorAll('[data-preset]').forEach(button => {
        button.classList.toggle('active', button.dataset.preset === preset);
    });
    if (preset === 'quick') {
        $('datasetSelect').value = 'standard';
        currentDataset = 'standard';
        $('singleOnlyCheck').checked = true;
        $('judgeCheck').checked = false;
    } else if (preset === 'full') {
        $('datasetSelect').value = 'standard';
        currentDataset = 'standard';
        $('singleOnlyCheck').checked = false;
        $('judgeCheck').checked = false;
    } else if (preset === 'judge') {
        $('datasetSelect').value = 'standard';
        currentDataset = 'standard';
        $('singleOnlyCheck').checked = false;
        $('judgeCheck').checked = true;
    }
    $('singleOnlyRow').style.display = '';
    updateQueryInfo();
    updateRunSummary();
    updateTableHeaders();
}

function datasetCountText() {
    if (!queryData) return 'Загрузка выборок...';
    if (currentDataset === 'thinking') return `${queryData.thinking || 0} задач на мышление`;
    if (currentDataset === 'v2') return `${queryData.v2 || 0} запросов (тест v2)`;
    if (currentDataset === 'test50') return `${queryData.test50 || 0} запросов (домены)`;
    return `${queryData.single_turn || 0} single-turn + ${(queryData.scenarios || []).length} multi-turn сценариев`;
}

function updateQueryInfo() {
    $('queryInfo').textContent = datasetCountText();
}

function updateRunSummary() {
    const promptReady = $('promptInput').value.trim() ? 'промпт готов' : 'нет промпта';
    const label = $('labelInput').value.trim() || 'test';
    const judge = $('judgeCheck').checked ? 'с judge' : 'без judge';
    const singleOnly = $('singleOnlyCheck').checked && currentDataset === 'standard' ? ', только ST' : '';
    $('runSummary').textContent = `${datasetLabels[currentDataset] || currentDataset}: ${datasetCountText()}${singleOnly}, ${judge}, метка ${label}, ${promptReady}`;
}

function updateTableHeaders() {
    const thead = document.querySelector('#resultsTable thead tr');
    if (currentDataset === 'thinking') {
        thead.innerHTML = `
            <th>ID</th>
            <th>Категория</th>
            <th>Запрос</th>
            <th>Ответ модели</th>
            <th>Правильный ответ</th>
            <th>Балл</th>
            <th></th>
        `;
    } else {
        thead.innerHTML = `
            <th>ID</th>
            <th>Тип</th>
            <th>Запрос</th>
            <th>Ответ</th>
            <th>Балл</th>
            <th></th>
        `;
    }
}

async function loadQueryInfo() {
    try {
        const resp = await fetch('/api/eval/queries');
        queryData = await resp.json();
        updateQueryInfo();
        updateRunSummary();
    } catch (e) {
        $('queryInfo').textContent = 'Не удалось загрузить инфо о запросах';
        updateRunSummary();
    }
}
loadQueryInfo();

$('runBtn').addEventListener('click', async () => {
    const prompt = $('promptInput').value.trim();
    if (!prompt) {
        showBanner('error', 'Нужен промпт', 'Вставьте системный промпт перед запуском.');
        return;
    }

    const label = $('labelInput').value.trim() || 'test';
    const withJudge = $('judgeCheck').checked;
    const singleOnly = $('singleOnlyCheck').checked;
    const dataset = $('datasetSelect').value;

    $('runBtn').disabled = true;
    $('downloadBtn').style.display = 'none';
    $('resultsBody').innerHTML = '';
    $('resultsCards').innerHTML = '';
    $('detailsPanel').innerHTML = '<div class="details-empty">Результаты появятся после первых обработанных запросов.</div>';
    evalResults = [];
    lastResultCount = 0;
    currentDataset = dataset;
    updateTableHeaders();
    setProgress(0);
    showBanner('running', 'Запуск прогона', 'Ожидаем первый статус от сервера...');

    try {
        const resp = await fetch('/api/eval/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, label, with_judge: withJudge, single_only: singleOnly, dataset }),
        });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.statusText);
        const data = await resp.json();
        currentRunId = data.run_id;
        showBanner('running', `Прогон #${currentRunId}`, `${data.total} запросов поставлено в очередь.`);
        startPolling();
    } catch (e) {
        showBanner('error', 'Ошибка запуска', e.message);
        $('runBtn').disabled = false;
    }
});

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 2000);
    pollStatus();
}

async function pollStatus() {
    if (!currentRunId) return;

    try {
        const resp = await fetch(`/api/eval/status/${currentRunId}`);
        if (!resp.ok) {
            stopPolling();
            currentRunId = null;
            showBanner('error', 'Прогон не найден', 'Сервер мог быть перезапущен.');
            $('runBtn').disabled = false;
            return;
        }
        const s = await resp.json();

        if (s.phase === 'run') {
            const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
            setProgress(pct);
            showBanner('running', 'Прогон модели', `${s.completed}/${s.total} · ${s.current || ''}`);
        } else if (s.phase === 'judge') {
            const pct = s.judge_total > 0 ? Math.round((s.judge_completed / s.judge_total) * 100) : 0;
            setProgress(pct);
            showBanner('running', 'Оценка LLM-judge', `${s.judge_completed}/${s.judge_total} · ${s.current || ''}`);
        }

        if (s.result_count > lastResultCount) await loadResults();

        if (s.status === 'done') {
            stopPolling();
            setProgress(100);
            showBanner('done', `Прогон #${currentRunId} завершен`, `${s.result_count || lastResultCount} результатов готовы к скачиванию.`);
            $('downloadBtn').style.display = '';
            $('runBtn').disabled = false;
            await loadResults();
        } else if (s.status === 'error') {
            stopPolling();
            showBanner('error', 'Ошибка прогона', s.current || 'Неизвестная ошибка');
            $('runBtn').disabled = false;
        }
    } catch (e) {
        showBanner('warning', 'Связь с сервером нестабильна', 'Продолжаю опрашивать статус...');
    }
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

async function loadResults() {
    if (!currentRunId) return;
    try {
        const resp = await fetch(`/api/eval/results/${currentRunId}`);
        const data = await resp.json();
        evalResults = data.results || [];

        const tbody = $('resultsBody');
        const cards = $('resultsCards');
        tbody.innerHTML = '';
        cards.innerHTML = '';

        evalResults.forEach((r, index) => {
            tbody.appendChild(renderResultRow(r, index));
            cards.appendChild(renderResultCard(r, index));
        });
        lastResultCount = evalResults.length;
    } catch (e) {
        showBanner('warning', 'Не удалось обновить результаты', e.message);
    }
}

function renderResultRow(r, index) {
    const tr = document.createElement('tr');
    const scoreCell = r.avg_score != null ? Number(r.avg_score).toFixed(1) : '\u2014';
    const detailsButton = `<button class="btn btn-ghost btn-small" data-result-index="${index}">Детали</button>`;

    if (r.type === 'thinking') {
        tr.innerHTML = `
            <td class="cell-id">${esc(r.query_id)}</td>
            <td class="cell-type">${esc(r.category || '')}</td>
            <td class="cell-query">${esc(shorten(r.query, 180))}</td>
            <td class="cell-response">${esc(shorten(r.response, 220))}</td>
            <td class="cell-response">${esc(shorten(r.correct_answer || '', 180))}</td>
            <td class="cell-score ${scoreClass(r.avg_score)}">${scoreCell}</td>
            <td>${detailsButton}</td>
        `;
    } else {
        const typeLabel = r.type === 'multi' ? `MT t${r.turn}` : 'ST';
        tr.innerHTML = `
            <td class="cell-id">${esc(r.query_id)}</td>
            <td class="cell-type">${typeLabel}</td>
            <td class="cell-query">${esc(shorten(r.query, 180))}</td>
            <td class="cell-response">${esc(shorten(r.response, 240))}</td>
            <td class="cell-score ${scoreClass(r.avg_score)}">${scoreCell}</td>
            <td>${detailsButton}</td>
        `;
    }
    return tr;
}

function renderResultCard(r, index) {
    const scoreCell = r.avg_score != null ? Number(r.avg_score).toFixed(1) : '\u2014';
    const typeLabel = r.type === 'multi' ? `MT t${r.turn}` : (r.type === 'thinking' ? (r.category || 'thinking') : 'ST');
    const card = document.createElement('article');
    card.className = 'result-card';
    card.innerHTML = `
        <div class="result-card-top">
            <strong>${esc(r.query_id)}</strong>
            <span class="score-chip ${scoreClass(r.avg_score)}">${scoreCell}</span>
        </div>
        <div class="result-card-meta">${esc(typeLabel)}</div>
        <p>${esc(shorten(r.query, 170))}</p>
        <button class="btn btn-ghost btn-small" data-result-index="${index}">Детали</button>
    `;
    return card;
}

function showEvalDetails(index) {
    const r = evalResults[index];
    if (!r) return;
    const scoreCell = r.avg_score != null ? Number(r.avg_score).toFixed(1) : '\u2014';
    const metrics = r.metrics ? `<div class="detail-block"><h3>Метрики</h3><pre>${esc(formatValue(r.metrics))}</pre></div>` : '';
    const correct = r.correct_answer ? `<div class="detail-block"><h3>Правильный ответ</h3><p>${esc(r.correct_answer)}</p></div>` : '';
    $('detailsPanel').innerHTML = `
        <div class="details-header">
            <div>
                <span class="step-kicker">${esc(r.type || 'result')}</span>
                <h2>${esc(r.query_id)}</h2>
            </div>
            <span class="score-chip ${scoreClass(r.avg_score)}">${scoreCell}</span>
        </div>
        <div class="detail-block"><h3>Запрос</h3><p>${esc(r.query)}</p></div>
        <div class="detail-block"><h3>Ответ модели</h3><p>${esc(r.response)}</p></div>
        ${correct}
        ${metrics}
    `;
}

document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-result-index]');
    if (!target) return;
    showEvalDetails(Number(target.dataset.resultIndex));
});

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

function formatValue(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

$('downloadBtn').addEventListener('click', () => {
    if (!currentRunId) return;
    window.location.href = `/api/eval/download/${currentRunId}`;
});

updateTableHeaders();
updateRunSummary();
