const $ = (id) => document.getElementById(id);

// Theme
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

// State
let currentRunId = null;
let pollTimer = null;
let modelCols = [];

// --- File Upload ---

const dropZone = $('dropZone');
const fileInput = $('fileInput');

$('selectFileBtn').addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
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
        $('statusText').textContent = 'Выберите CSV-файл';
        return;
    }

    $('statusText').textContent = 'Загрузка...';
    $('runBtn').disabled = true;

    const form = new FormData();
    form.append('file', file);

    try {
        const resp = await fetch('/api/analyze/upload', { method: 'POST', body: form });
        if (!resp.ok) {
            const err = await resp.json();
            $('statusText').textContent = `Ошибка: ${err.detail}`;
            return;
        }
        const data = await resp.json();
        currentRunId = data.run_id;
        modelCols = data.model_cols;

        // Show preview
        $('previewStats').textContent =
            `Всего строк: ${data.total_rows} | Запросов: ${data.total_queries} ` +
            `(single: ${data.single_count}, multi: ${data.multi_count}) | ` +
            `Модели: ${data.model_cols.join(', ')}`;

        renderPreview(data.columns, data.preview);
        $('previewSection').style.display = '';
        $('runBtn').disabled = false;
        $('statusText').textContent = `Файл загружен. Run ID: ${data.run_id}`;
        $('downloadBtn').style.display = 'none';
        $('resultsSection').style.display = 'none';
    } catch (e) {
        $('statusText').textContent = `Ошибка: ${e.message}`;
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
            const val = row[c] || '';
            return `<td>${esc(val.length > 80 ? val.slice(0, 80) + '...' : val)}</td>`;
        }).join('');
        body.appendChild(tr);
    }
}

// --- Run Analysis ---

$('runBtn').addEventListener('click', async () => {
    if (!currentRunId) return;

    $('runBtn').disabled = true;
    $('statusText').textContent = 'Запуск анализа...';
    $('progressSection').style.display = '';
    $('progressFill').style.width = '0%';
    $('downloadBtn').style.display = 'none';
    $('resultsBody').innerHTML = '';
    $('resultsSection').style.display = 'none';

    try {
        const testMode = $('testModeCheck').checked;
        const runUrl = `/api/analyze/run/${currentRunId}` + (testMode ? '?test_mode=true' : '');
        const resp = await fetch(runUrl, { method: 'POST' });
        const data = await resp.json();
        const testLabel = $('testModeCheck').checked ? ' [ТЕСТ — первые 3]' : '';
        $('statusText').textContent = `Анализ #${currentRunId} запущен (${data.total} вызовов судьи)${testLabel}`;
        startPolling();
    } catch (e) {
        $('statusText').textContent = `Ошибка: ${e.message}`;
        $('runBtn').disabled = false;
    }
});

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1500);
}

async function pollStatus() {
    if (!currentRunId) return;

    try {
        const resp = await fetch(`/api/analyze/status/${currentRunId}`);
        if (!resp.ok) {
            clearInterval(pollTimer);
            pollTimer = null;
            $('statusText').textContent = 'Run не найден (сервер перезапущен?)';
            $('runBtn').disabled = false;
            return;
        }
        const s = await resp.json();

        const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
        $('progressFill').style.width = pct + '%';

        const phaseLabel = s.phase === 'independent' ? 'Независимая оценка' :
                           s.phase === 'comparison' ? 'Сравнительный анализ' : s.phase;
        $('progressText').textContent = `${phaseLabel}: ${s.completed}/${s.total} — ${s.current}`;

        // Stats panel
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

        if (s.status === 'done') {
            clearInterval(pollTimer);
            pollTimer = null;
            $('progressFill').style.width = '100%';
            const doneTokens = s.stats ? (s.stats.tokens_total || 0).toLocaleString() : '?';
            const doneTime = s.stats ? `${s.stats.elapsed || 0}с` : '';
            $('progressText').textContent = 'Готово!';
            $('statusText').textContent = `Анализ #${currentRunId} завершён — ${doneTokens} токенов, ${doneTime}`;
            $('downloadBtn').style.display = '';
            $('runBtn').disabled = false;
            await loadResults();
        } else if (s.status === 'error') {
            clearInterval(pollTimer);
            pollTimer = null;
            $('statusText').textContent = `Ошибка: ${s.current}`;
            $('runBtn').disabled = false;
        } else if (s.result_count > 0) {
            await loadResults();
        }
    } catch (e) {
        // Network error — keep polling
    }
}

async function loadResults() {
    if (!currentRunId) return;
    try {
        const resp = await fetch(`/api/analyze/results/${currentRunId}`);
        const data = await resp.json();

        const mc = data.model_cols || modelCols;
        $('resultsSection').style.display = '';

        // Build header
        const head = $('resultsHead');
        let headerHtml = '<tr><th>ID</th><th>Тип</th><th>Turns</th><th>Запрос</th>';
        for (const m of mc) {
            headerHtml += `<th>${esc(m)}<br><small>ACC REL DEP EMP LOG USE</small></th>`;
        }
        headerHtml += '<th>Победитель</th><th>Анализ</th></tr>';
        head.innerHTML = headerHtml;

        // Build body
        const body = $('resultsBody');
        body.innerHTML = '';
        for (const r of data.results) {
            const tr = document.createElement('tr');
            let html = `<td class="cell-id">${esc(r.query_id)}</td>`;
            html += `<td class="cell-type">${r.type === 'multi' ? 'MT' : 'ST'}</td>`;
            html += `<td class="cell-type">${r.turns_count || 1}</td>`;
            html += `<td class="cell-query">${esc(r.query)}</td>`;

            for (const m of mc) {
                const model = (r.models || {})[m] || {};
                const score = model.avg_score;
                const scoreText = score != null ? Number(score).toFixed(1) : '—';
                const scores = model.scores || {};
                const metricsLine = ['ACC','REL','DEP','EMP','LOG','USE']
                    .map(k => {
                        const s = scores[k];
                        const v = s && typeof s === 'object' ? s.score : s;
                        return v != null ? v : '·';
                    }).join(' ');
                const reasons = ['ACC','REL','DEP','EMP','LOG','USE']
                    .map(k => {
                        const s = scores[k];
                        const reason = s && typeof s === 'object' ? s.reason : '';
                        const v = s && typeof s === 'object' ? s.score : s;
                        return reason ? `${k}:${v} ${reason}` : '';
                    }).filter(Boolean).join('\n');
                const tooltip = (model.comment || '') + (reasons ? '\n\n' + reasons : '');
                html += `<td class="cell-score ${scoreClass(score)}" title="${esc(tooltip)}">`
                    + `<strong>${scoreText}</strong><br><small class="metrics-line">${metricsLine}</small></td>`;
            }

            const comp = r.comparison || {};
            const winner = comp.winner || '—';
            const analysis = comp.analysis || '';
            html += `<td class="cell-score" style="font-size:12px">${esc(winner)}</td>`;
            html += `<td class="cell-response" style="max-width:300px;font-size:12px">${esc(analysis)}</td>`;

            tr.innerHTML = html;
            body.appendChild(tr);
        }
    } catch (e) {
        // ignore
    }
}

function scoreClass(score) {
    if (score == null) return '';
    if (score >= 4) return 'score-good';
    if (score >= 3) return 'score-ok';
    return 'score-bad';
}

function esc(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = String(text).length > 300 ? String(text).slice(0, 300) + '...' : String(text);
    return d.innerHTML;
}

// Download
$('downloadBtn').addEventListener('click', () => {
    if (!currentRunId) return;
    window.open(`/api/analyze/download/${currentRunId}`, '_blank');
});
