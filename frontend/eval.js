const $ = (id) => document.getElementById(id);

// Theme (shared with main app)
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
let lastResultCount = 0;

// Load query info on start
async function loadQueryInfo() {
    try {
        const resp = await fetch('/api/eval/queries');
        const data = await resp.json();
        $('queryInfo').textContent = `${data.single_turn} single-turn + ${data.scenarios.length} multi-turn \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0435\u0432`;
    } catch (e) {
        $('queryInfo').textContent = '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0438\u043D\u0444\u043E \u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0430\u0445';
    }
}
loadQueryInfo();

// Run
$('runBtn').addEventListener('click', async () => {
    const prompt = $('promptInput').value.trim();
    if (!prompt) {
        $('statusText').textContent = '\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043F\u0440\u043E\u043C\u043F\u0442!';
        return;
    }

    const label = $('labelInput').value.trim() || 'test';
    const withJudge = $('judgeCheck').checked;

    $('runBtn').disabled = true;
    $('statusText').textContent = '\u0417\u0430\u043F\u0443\u0441\u043A...';
    $('progressSection').style.display = '';
    $('progressFill').style.width = '0%';
    $('downloadBtn').style.display = 'none';
    $('resultsBody').innerHTML = '';
    lastResultCount = 0;

    try {
        const resp = await fetch('/api/eval/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, label, with_judge: withJudge }),
        });
        const data = await resp.json();
        currentRunId = data.run_id;
        $('statusText').textContent = `\u041F\u0440\u043E\u0433\u043E\u043D #${currentRunId} \u0437\u0430\u043F\u0443\u0449\u0435\u043D (${data.total} \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432)`;
        startPolling();
    } catch (e) {
        $('statusText').textContent = `\u041E\u0448\u0438\u0431\u043A\u0430: ${e.message}`;
        $('runBtn').disabled = false;
    }
});

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 2000);
}

async function pollStatus() {
    if (!currentRunId) return;

    try {
        const resp = await fetch(`/api/eval/status/${currentRunId}`);
        if (!resp.ok) {
            clearInterval(pollTimer);
            pollTimer = null;
            currentRunId = null;
            $('statusText').textContent = 'Прогон не найден (сервер перезапущен?)';
            $('runBtn').disabled = false;
            return;
        }
        const s = await resp.json();

        // Progress
        if (s.phase === 'run') {
            const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
            $('progressFill').style.width = pct + '%';
            $('progressText').textContent = `\u041F\u0440\u043E\u0433\u043E\u043D: ${s.completed}/${s.total} \u2014 ${s.current}`;
        } else if (s.phase === 'judge') {
            const pct = s.judge_total > 0 ? Math.round((s.judge_completed / s.judge_total) * 100) : 0;
            $('progressFill').style.width = pct + '%';
            $('progressText').textContent = `Judge: ${s.judge_completed}/${s.judge_total} \u2014 ${s.current}`;
        }

        // Load new results incrementally
        if (s.result_count > lastResultCount) {
            await loadResults();
        }

        // Done
        if (s.status === 'done') {
            clearInterval(pollTimer);
            pollTimer = null;
            $('progressFill').style.width = '100%';
            $('progressText').textContent = '\u0413\u043E\u0442\u043E\u0432\u043E!';
            $('statusText').textContent = `\u041F\u0440\u043E\u0433\u043E\u043D #${currentRunId} \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D`;
            $('downloadBtn').style.display = '';
            $('runBtn').disabled = false;
            await loadResults();
        } else if (s.status === 'error') {
            clearInterval(pollTimer);
            pollTimer = null;
            $('statusText').textContent = `\u041E\u0448\u0438\u0431\u043A\u0430: ${s.current}`;
            $('runBtn').disabled = false;
        }
    } catch (e) {
        // Network error, keep polling
    }
}

async function loadResults() {
    if (!currentRunId) return;
    try {
        const resp = await fetch(`/api/eval/results/${currentRunId}`);
        const data = await resp.json();

        const tbody = $('resultsBody');
        tbody.innerHTML = '';

        for (const r of data.results) {
            const tr = document.createElement('tr');
            const scoreCell = r.avg_score != null ? r.avg_score.toFixed(1) : '\u2014';
            const typeLabel = r.type === 'multi' ? `MT t${r.turn}` : 'ST';
            tr.innerHTML = `
                <td class="cell-id">${esc(r.query_id)}</td>
                <td class="cell-type">${typeLabel}</td>
                <td class="cell-query">${esc(r.query)}</td>
                <td class="cell-response">${esc(r.response)}</td>
                <td class="cell-score ${scoreClass(r.avg_score)}">${scoreCell}</td>
            `;
            tbody.appendChild(tr);
        }
        lastResultCount = data.results.length;
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
    d.textContent = text.length > 300 ? text.slice(0, 300) + '...' : text;
    return d.innerHTML;
}

// Download
$('downloadBtn').addEventListener('click', () => {
    if (!currentRunId) return;
    window.open(`/api/eval/download/${currentRunId}`, '_blank');
});
