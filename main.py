from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import uuid
import urllib3
import os
from dotenv import load_dotenv
load_dotenv()  # загружает .env в os.environ
import csv
import json
import io
import re
import time
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Dict, Any

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GIGACHAT_API_KEY = os.environ.get("GIGACHAT_API_KEY", "")
AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions"
MODEL = "GigaChat-2-Max"

# Состояние приложения (в памяти)
sessions: Dict[str, Any] = {}  # session_id -> {"system_prompt": str, "history": list}
access_token: Optional[str] = None
token_expires_at: float = 0


def get_session(session_id: str) -> dict:
    if session_id not in sessions:
        sessions[session_id] = {
            "system_prompt": "Ты полезный ассистент.",
            "history": [],
        }
    return sessions[session_id]

http_session = requests.Session()
http_session.verify = False
http_session.trust_env = False  # игнорировать HTTP_PROXY/HTTPS_PROXY


_token_lock = threading.Lock()


def get_access_token() -> str:
    global access_token, token_expires_at
    with _token_lock:
        # Используем кэшированный токен если он ещё действителен (с запасом 60 сек)
        if access_token and time.time() < token_expires_at - 60:
            return access_token

        response = http_session.post(
            AUTH_URL,
            headers={
                "Authorization": f"Bearer {GIGACHAT_API_KEY}",
                "RqUID": str(uuid.uuid4()),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"scope": "GIGACHAT_API_CORP"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        access_token = data["access_token"]
        # expires_at приходит в миллисекундах
        expires_ms = data.get("expires_at", 0)
        token_expires_at = expires_ms / 1000 if expires_ms else time.time() + 1800
        return access_token


# --- Pydantic модели ---

class ChatRequest(BaseModel):
    message: str


class SystemPromptRequest(BaseModel):
    prompt: str
    clear_history: bool = False


# --- API эндпоинты ---

@app.get("/api/state")
async def get_state(session_id: str = Query(...)):
    """Отдаёт текущий системный промпт и историю чата."""
    s = get_session(session_id)
    return {"system_prompt": s["system_prompt"], "history": s["history"]}


@app.post("/api/chat")
async def chat(body: ChatRequest, session_id: str = Query(...)):
    s = get_session(session_id)
    s["history"].append({"role": "user", "content": body.message})

    # Собираем сообщения: сначала system, потом вся история
    messages = []
    if s["system_prompt"]:
        messages.append({"role": "system", "content": s["system_prompt"]})
    messages.extend(s["history"])

    try:
        token = get_access_token()
        response = http_session.post(
            CHAT_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={"model": MODEL, "messages": messages},
        )
        response.raise_for_status()
        answer = response.json()["choices"][0]["message"]["content"]
        s["history"].append({"role": "assistant", "content": answer})
        return {"answer": answer}
    except Exception as e:
        # Откатываем сообщение пользователя если запрос не удался
        s["history"].pop()
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/system-prompt")
async def set_system_prompt(body: SystemPromptRequest, session_id: str = Query(...)):
    s = get_session(session_id)
    s["system_prompt"] = body.prompt
    if body.clear_history:
        s["history"] = []
    return {"system_prompt": s["system_prompt"], "history": s["history"]}


@app.delete("/api/history")
async def clear_history_endpoint(session_id: str = Query(...)):
    s = get_session(session_id)
    s["history"] = []
    return {"history": s["history"]}


# ---------------------------------------------------------------------------
# Eval Runner — загрузка данных и эндпоинты
# ---------------------------------------------------------------------------

from concurrent.futures import ThreadPoolExecutor, as_completed
from eval_runner import chat_completion, _parse_judge_json, METRICS_ALL, AXIS_METRICS, use_shared_auth
use_shared_auth(get_access_token, http_session)  # eval использует тот же токен и сессию

PARALLEL_WORKERS = 2  # параллельные запросы к API

DATA_DIR = Path(__file__).parent / "data"
_eval_single_turn: list[dict] = []
_eval_multi_turn: list[dict] = []
_judge_template: str = ""


def _load_eval_data():
    global _eval_single_turn, _eval_multi_turn, _judge_template
    csv_params = dict(delimiter=";", quotechar='"', quoting=csv.QUOTE_MINIMAL)

    st_path = DATA_DIR / "02_queries_single_turn.csv"
    if st_path.exists():
        with open(st_path, encoding="utf-8-sig") as f:
            _eval_single_turn = list(csv.DictReader(f, **csv_params))

    mt_path = DATA_DIR / "03_queries_multi_turn.csv"
    if mt_path.exists():
        with open(mt_path, encoding="utf-8-sig") as f:
            _eval_multi_turn = list(csv.DictReader(f, **csv_params))

    judge_path = DATA_DIR / "04_llm_judge_prompt.txt"
    if judge_path.exists():
        _judge_template = judge_path.read_text(encoding="utf-8-sig").strip()


_load_eval_data()

# In-memory eval runs
eval_runs: Dict[str, dict] = {}


class EvalRunRequest(BaseModel):
    prompt: str
    label: str = "test"
    with_judge: bool = False


@app.get("/api/eval/queries")
async def eval_queries():
    return {
        "single_turn": len(_eval_single_turn),
        "multi_turn": len(_eval_multi_turn),
        "queries": [
            {"id": q.get("id", ""), "query": q.get("query", "")[:100], "axis": q.get("axis", ""), "metrics": q.get("metrics", "")}
            for q in _eval_single_turn
        ],
        "scenarios": list({r.get("scenario_id", "") for r in _eval_multi_turn}),
    }


@app.post("/api/eval/run")
async def eval_run(body: EvalRunRequest):
    run_id = str(uuid.uuid4())[:8]

    # Подсчитываем общее количество запросов
    st_count = len(_eval_single_turn)
    mt_user_count = sum(1 for r in _eval_multi_turn if r.get("role", "").strip() == "user")
    total = st_count + mt_user_count

    eval_runs[run_id] = {
        "status": "running",
        "phase": "run",
        "total": total,
        "completed": 0,
        "current": "",
        "results": [],
        "prompt_label": body.label,
        "with_judge": body.with_judge,
        "judge_total": 0,
        "judge_completed": 0,
    }

    thread = threading.Thread(
        target=_run_eval_background,
        args=(run_id, body.prompt, body.label, body.with_judge),
        daemon=True,
    )
    thread.start()

    return {"run_id": run_id, "total": total}


def _run_eval_background(run_id: str, prompt_text: str, label: str, with_judge: bool):
    run = eval_runs[run_id]
    def _do_single_turn(q):
        """Один single-turn запрос (вызывается из потока)."""
        query_id = q.get("id", "")
        query_text = q.get("query", "")
        metrics = q.get("metrics", "")
        messages = [
            {"role": "system", "content": prompt_text},
            {"role": "user", "content": query_text},
        ]
        response = chat_completion(messages)
        return {
            "query_id": query_id,
            "type": "single",
            "turn": 1,
            "query": query_text,
            "response": response,
            "metrics": metrics,
            "timestamp": datetime.now().isoformat(),
        }

    def _do_judge(result):
        """Один judge-запрос (вызывается из потока)."""
        judge_prompt = _judge_template.replace(
            "{system_prompt_label}", label
        ).replace(
            "{user_query}", result["query"]
        ).replace(
            "{model_response}", result["response"]
        )
        try:
            judge_response = chat_completion([{"role": "user", "content": judge_prompt}])
            scores = _parse_judge_json(judge_response)
            scores_dict = scores.get("scores", {})
            relevant = []
            metric_scores = {}
            for m in METRICS_ALL:
                entry = scores_dict.get(m)
                if entry and entry != "N/A":
                    val = entry.get("score", "N/A") if isinstance(entry, dict) else entry
                    reason = entry.get("reason", "") if isinstance(entry, dict) else ""
                    metric_scores[m] = {"score": val, "reason": reason}
                    if isinstance(val, (int, float)):
                        relevant.append(val)
                else:
                    metric_scores[m] = None
            return metric_scores, (round(sum(relevant) / len(relevant), 2) if relevant else None), scores.get("overall_comment", "")
        except Exception as e:
            return {}, None, f"Error: {e}"

    try:
        # --- Single-turn (параллельно по 2) ---
        with ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as pool:
            futures = {pool.submit(_do_single_turn, q): q.get("id", "") for q in _eval_single_turn}
            for future in as_completed(futures):
                qid = futures[future]
                try:
                    result = future.result()
                    run["results"].append(result)
                    run["completed"] += 1
                    run["current"] = f"ST: {qid} done"
                except Exception as e:
                    run["results"].append({
                        "query_id": qid, "type": "single", "turn": 1,
                        "query": "", "response": f"ERROR: {e}",
                        "metrics": "", "timestamp": datetime.now().isoformat(),
                    })
                    run["completed"] += 1
                    run["current"] = f"ST: {qid} error"

        # --- Multi-turn (последовательно — нужен контекст) ---
        scenarios = {}
        for row in _eval_multi_turn:
            sid = row.get("scenario_id", "")
            if sid not in scenarios:
                scenarios[sid] = []
            scenarios[sid].append(row)

        for sid, turns in scenarios.items():
            history = [{"role": "system", "content": prompt_text}]
            for row in turns:
                role = row.get("role", "").strip()
                turn_num = row.get("turn", "")
                metrics = row.get("metrics", "")

                if role == "user":
                    user_msg = row.get("message", "")
                    run["current"] = f"MT: {sid} t{turn_num}"
                    history.append({"role": "user", "content": user_msg})
                    try:
                        response = chat_completion(history)
                    except Exception as e:
                        response = f"ERROR: {e}"
                    history.append({"role": "assistant", "content": response})

                    run["results"].append({
                        "query_id": f"{sid}_t{turn_num}",
                        "type": "multi",
                        "turn": turn_num,
                        "query": user_msg,
                        "response": response,
                        "metrics": metrics,
                        "timestamp": datetime.now().isoformat(),
                    })
                    run["completed"] += 1

        # --- Judge (параллельно по 2, если включён) ---
        if with_judge and _judge_template:
            run["phase"] = "judge"
            run["judge_total"] = len(run["results"])
            run["judge_completed"] = 0

            with ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as pool:
                futures = {pool.submit(_do_judge, r): r for r in run["results"]}
                for future in as_completed(futures):
                    result = futures[future]
                    scores, avg, comment = future.result()
                    result["scores"] = scores
                    result["avg_score"] = avg
                    result["judge_comment"] = comment
                    run["judge_completed"] += 1
                    run["current"] = f"Judge: {result['query_id']}"

        run["status"] = "done"
        run["phase"] = "done"
        run["current"] = ""

    except Exception as e:
        run["status"] = "error"
        run["current"] = str(e)


@app.get("/api/eval/status/{run_id}")
async def eval_status(run_id: str):
    run = eval_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "status": run["status"],
        "phase": run["phase"],
        "total": run["total"],
        "completed": run["completed"],
        "current": run["current"],
        "result_count": len(run["results"]),
        "judge_total": run.get("judge_total", 0),
        "judge_completed": run.get("judge_completed", 0),
    }


@app.get("/api/eval/results/{run_id}")
async def eval_results(run_id: str):
    run = eval_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "status": run["status"],
        "prompt_label": run["prompt_label"],
        "results": run["results"],
    }


@app.get("/api/eval/download/{run_id}")
async def eval_download(run_id: str):
    run = eval_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    out_path = Path("results") / f"eval_{run['prompt_label']}_{run_id}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = ["query_id", "type", "turn", "query", "response", "metrics", "avg_score", "judge_comment", "timestamp"]
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";", quotechar='"', extrasaction="ignore")
        w.writeheader()
        w.writerows(run["results"])

    return FileResponse(str(out_path), filename=out_path.name, media_type="text/csv")


# Eval page
@app.get("/eval")
async def eval_page():
    return FileResponse("frontend/eval.html")


# ---------------------------------------------------------------------------
# Analyze — загрузка CSV с ответами трёх моделей и анализ LLM-судьёй
# ---------------------------------------------------------------------------

ANALYZE_MODELS = ["GigaChat - Original", "GigaChat - castom_max", "GigaChat - castom_min"]
ANALYZE_METRICS = ["ACC", "REL", "DEP", "EMP", "LOG", "USE"]

# In-memory analyze runs
analyze_runs: Dict[str, dict] = {}

# --- OhMyLama judge client ---
from openai import OpenAI as _OpenAI

OHMYLAMA_API_KEY = os.environ.get("OHMYLAMA_API_KEY", "")
JUDGE_MODEL = "gemini-3-flash-preview"

_judge_client: Optional[_OpenAI] = None
if OHMYLAMA_API_KEY:
    _judge_client = _OpenAI(
        base_url="https://ohmylama.ru/v1",
        api_key=OHMYLAMA_API_KEY,
        max_retries=3,
        timeout=60.0,
    )

JUDGE_MAX_ATTEMPTS = 3
JUDGE_RETRY_BASE_DELAY = 2  # секунды, exponential backoff: 2, 4, 8...


def judge_llm_call(messages: list[dict]) -> tuple[str, dict]:
    """Вызов LLM-судьи через OhMyLama (OpenAI-совместимый API).

    Возвращает (content, usage_dict).
    usage_dict: {"prompt_tokens": N, "completion_tokens": N, "total_tokens": N}
    """
    empty_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    if not _judge_client:
        return json.dumps({
            "scores": {},
            "overall_comment": "OHMYLAMA_API_KEY не задан — судья недоступен.",
            "average_score": None
        }), empty_usage

    last_err = None
    for attempt in range(JUDGE_MAX_ATTEMPTS):
        try:
            response = _judge_client.chat.completions.create(
                model=JUDGE_MODEL,
                messages=messages,
                temperature=0.6,
                extra_body={"reasoning": {"enabled": True}},
            )
            usage = empty_usage
            if response.usage:
                usage = {
                    "prompt_tokens": response.usage.prompt_tokens or 0,
                    "completion_tokens": response.usage.completion_tokens or 0,
                    "total_tokens": response.usage.total_tokens or 0,
                }
            return response.choices[0].message.content, usage
        except Exception as e:
            last_err = e
            if attempt < JUDGE_MAX_ATTEMPTS - 1:
                time.sleep(JUDGE_RETRY_BASE_DELAY * (2 ** attempt))

    return json.dumps({
        "scores": {},
        "overall_comment": f"Ошибка судьи после {JUDGE_MAX_ATTEMPTS} попыток: {last_err}",
        "average_score": None
    }), empty_usage


def _parse_csv_upload(content: str) -> dict:
    """Парсит CSV и группирует записи по query_id."""
    reader = csv.DictReader(io.StringIO(content), delimiter=",")
    rows = list(reader)

    if not rows:
        raise ValueError("CSV файл пуст")

    required = {"query", "query_id"}
    missing = required - set(rows[0].keys())
    if missing:
        raise ValueError(f"Отсутствуют обязательные колонки: {', '.join(missing)}")

    # Определяем какие колонки моделей присутствуют
    model_cols = [c for c in ANALYZE_MODELS if c in rows[0].keys()]
    if not model_cols:
        raise ValueError(f"Не найдены колонки моделей. Ожидаются: {', '.join(ANALYZE_MODELS)}")

    # Группируем по query_id (для multi-turn: MT-01_t1 -> группа MT-01)
    groups: Dict[str, list] = {}
    for row in rows:
        raw_qid = row.get("query_id", "").strip()
        if not raw_qid:
            continue
        # Извлекаем группу: "MT-01_t3" -> "MT-01", "ST-05" -> "ST-05"
        group_id = re.sub(r"_t\d+$", "", raw_qid)
        if group_id not in groups:
            groups[group_id] = []
        groups[group_id].append(row)

    # Сортируем turns внутри каждой группы
    def _extract_turn_num(r):
        raw = r.get("query_id", "")
        m = re.search(r"_t(\d+)$", raw)
        if m:
            return int(m.group(1))
        return int(r.get("turn", "1") or "1")

    queries = []
    for qid, group_rows in groups.items():
        group_rows.sort(key=_extract_turn_num)
        qtype = group_rows[0].get("type", "single").strip()
        is_multi = qtype == "multi" or len(group_rows) > 1

        queries.append({
            "query_id": qid,
            "type": "multi" if is_multi else "single",
            "turns": group_rows,
            "model_cols": model_cols,
        })

    single_count = sum(1 for q in queries if q["type"] == "single")
    multi_count = sum(1 for q in queries if q["type"] == "multi")

    return {
        "queries": queries,
        "model_cols": model_cols,
        "total_rows": len(rows),
        "total_queries": len(queries),
        "single_count": single_count,
        "multi_count": multi_count,
        "preview_rows": rows[:5],
        "columns": list(rows[0].keys()),
    }


@app.get("/analyze")
async def analyze_page():
    return FileResponse("frontend/analyze.html")


@app.post("/api/analyze/upload")
async def analyze_upload(file: UploadFile = File(...)):
    content = (await file.read()).decode("utf-8-sig")
    try:
        parsed = _parse_csv_upload(content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    run_id = str(uuid.uuid4())[:8]
    analyze_runs[run_id] = {
        "status": "uploaded",
        "phase": "uploaded",
        "parsed": parsed,
        "results": [],
        "total": 0,
        "completed": 0,
        "current": "",
    }

    return {
        "run_id": run_id,
        "total_rows": parsed["total_rows"],
        "total_queries": parsed["total_queries"],
        "single_count": parsed["single_count"],
        "multi_count": parsed["multi_count"],
        "model_cols": parsed["model_cols"],
        "columns": parsed["columns"],
        "preview": parsed["preview_rows"],
    }


@app.post("/api/analyze/run/{run_id}")
async def analyze_run(run_id: str, test_mode: bool = Query(False)):
    run = analyze_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] == "running":
        raise HTTPException(status_code=409, detail="Already running")

    queries = run["parsed"]["queries"]
    model_cols = run["parsed"]["model_cols"]
    run["test_mode"] = test_mode
    # В тестовом режиме — только первые 3 запроса
    effective_queries = queries[:3] if test_mode else queries
    total_calls = len(effective_queries) * (len(model_cols) + 1)
    run["status"] = "running"
    run["phase"] = "independent"
    run["total"] = total_calls
    run["completed"] = 0
    run["results"] = []

    thread = threading.Thread(
        target=_run_analyze_background,
        args=(run_id,),
        daemon=True,
    )
    thread.start()

    return {"run_id": run_id, "total": total_calls}


def _turn_num_from_row(row: dict) -> str:
    """Извлекает номер turn из query_id (MT-01_t3 -> 3), колонку turn игнорируем."""
    m = re.search(r"_t(\d+)$", row.get("query_id", ""))
    return m.group(1) if m else "1"


def _build_query_text(query_data: dict) -> str:
    """Собирает текст запроса из turns (для single — одна строка, для multi — диалог)."""
    turns = query_data["turns"]
    if len(turns) == 1:
        return turns[0].get("query", "")
    parts = []
    for t in turns:
        parts.append(f"[Turn {_turn_num_from_row(t)}] {t.get('query', '')}")
    return "\n".join(parts)


def _build_model_response_text(query_data: dict, model_col: str) -> str:
    """Собирает ответ модели из turns."""
    turns = query_data["turns"]
    if len(turns) == 1:
        return turns[0].get(model_col, "")
    parts = []
    for t in turns:
        parts.append(f"[Turn {_turn_num_from_row(t)}] {t.get(model_col, '')}")
    return "\n".join(parts)


def _run_analyze_background(run_id: str):
    run = analyze_runs[run_id]
    all_queries = run["parsed"]["queries"]
    model_cols = run["parsed"]["model_cols"]
    test_mode = run.get("test_mode", False)
    queries = all_queries[:3] if test_mode else all_queries

    # Статистика
    run["stats"] = {
        "started_at": time.time(),
        "tokens_prompt": 0,
        "tokens_completion": 0,
        "tokens_total": 0,
        "api_calls": 0,
        "errors": 0,
        "elapsed": 0,
    }
    run["log"] = []  # последние события

    def _log(msg: str):
        run["log"].append({"t": round(time.time() - run["stats"]["started_at"], 1), "msg": msg})
        if len(run["log"]) > 30:
            run["log"] = run["log"][-30:]

    def _track_usage(usage: dict):
        run["stats"]["tokens_prompt"] += usage.get("prompt_tokens", 0)
        run["stats"]["tokens_completion"] += usage.get("completion_tokens", 0)
        run["stats"]["tokens_total"] += usage.get("total_tokens", 0)
        run["stats"]["api_calls"] += 1
        run["stats"]["elapsed"] = round(time.time() - run["stats"]["started_at"], 1)

    try:
        _log(f"Старт: {len(queries)} запросов, {len(model_cols)} моделей")

        # Этап 1 — Независимая оценка каждой модели
        run["phase"] = "independent"
        for q in queries:
            qid = q["query_id"]
            query_text = _build_query_text(q)
            turns_count = len(q["turns"])
            result_entry = {
                "query_id": qid,
                "type": q["type"],
                "turns_count": turns_count,
                "query": query_text,
                "models": {},
                "comparison": None,
            }

            for model_col in model_cols:
                response_text = _build_model_response_text(q, model_col)
                run["current"] = f"Gemini оценивает [{model_col}] → {qid}"
                _log(f"→ {model_col}: {qid} ({turns_count} turns)")

                judge_prompt = (
                    f"Ты — строгий эксперт-оценщик ИИ-ассистентов. Оцени ответ модели по 6 метрикам.\n\n"
                    f"## Запрос пользователя\n{query_text}\n\n"
                    f"## Ответ модели ({model_col})\n{response_text}\n\n"
                    f"## Шкала: 1-5\n"
                    f"1 = провал, 2 = плохо, 3 = приемлемо, 4 = хорошо, 5 = отлично\n\n"
                    f"## Метрики и критерии\n\n"
                    f"**ACC (Точность)**\n"
                    f"5: все факты верны, нет выдумок\n"
                    f"3: есть неточности, но суть верна\n"
                    f"1: грубые ошибки, галлюцинации, выдуманные факты\n"
                    f"Снижай за: выдуманные цифры, несуществующие термины, ложные утверждения\n\n"
                    f"**REL (Релевантность)**\n"
                    f"5: отвечает ровно на то, что спросили, без лишнего\n"
                    f"3: по теме, но уходит в сторону или упускает часть вопроса\n"
                    f"1: не отвечает на вопрос, подменяет тему\n"
                    f"Снижай за: игнорирование части вопроса, ненужные отступления, шаблонные вступления\n\n"
                    f"**DEP (Глубина)**\n"
                    f"5: раскрывает нюансы, даёт примеры, учитывает контекст\n"
                    f"3: отвечает поверхностно, но по делу\n"
                    f"1: отписка, общие фразы без конкретики\n"
                    f"Снижай за: «вода», повторение вопроса своими словами, отсутствие примеров там где нужны\n\n"
                    f"**EMP (Эмпатия)**\n"
                    f"5: считывает настроение, адаптирует тон, тактичен в сложных темах\n"
                    f"3: нейтрален, не раздражает, но и не адаптируется\n"
                    f"1: грубый, холодный, неуместный тон, игнорирует эмоции пользователя\n"
                    f"Снижай за: менторский тон, игнорирование тревоги/просьбы, неуместный юмор\n\n"
                    f"**LOG (Логика)**\n"
                    f"5: чёткая структура, выводы следуют из аргументов, нет противоречий\n"
                    f"3: в целом логично, но есть скачки или слабые места\n"
                    f"1: противоречит себе, нарушена причинно-следственная связь\n"
                    f"Снижай за: взаимоисключающие утверждения, немотивированные выводы, круговую аргументацию\n\n"
                    f"**USE (Польза)**\n"
                    f"5: ответ можно сразу применить, есть конкретные шаги/рекомендации\n"
                    f"3: полезен частично, нужна доработка\n"
                    f"1: бесполезен, нельзя ничего взять из ответа\n"
                    f"Снижай за: абстрактные советы без конкретики, «обратитесь к специалисту» вместо помощи\n\n"
                    f"## Формат ответа\n"
                    f"В reason ОБЯЗАТЕЛЬНО укажи конкретную причину оценки — что именно хорошо или плохо.\n"
                    f"Верни ТОЛЬКО JSON без markdown-обёртки:\n"
                    f'{{"scores":{{"ACC":{{"score":N,"reason":"что именно верно/неверно"}},'
                    f'"REL":{{"score":N,"reason":"на что ответил/не ответил"}},'
                    f'"DEP":{{"score":N,"reason":"что раскрыл/упустил"}},'
                    f'"EMP":{{"score":N,"reason":"как адаптировал тон"}},'
                    f'"LOG":{{"score":N,"reason":"где логика сильна/слаба"}},'
                    f'"USE":{{"score":N,"reason":"что можно/нельзя применить"}}}},'
                    f'"overall_comment":"1-2 предложения: главная сила и слабость ответа",'
                    f'"average_score":N.N}}'
                )
                raw, usage = judge_llm_call([{"role": "user", "content": judge_prompt}])
                _track_usage(usage)
                _log(f"✓ {model_col}: {qid} — {usage.get('total_tokens', 0)} tok")

                # Убираем markdown-обёртку если есть
                clean = raw.strip()
                if clean.startswith("```"):
                    clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
                try:
                    parsed = json.loads(clean)
                except json.JSONDecodeError:
                    parsed = {"scores": {}, "overall_comment": raw, "average_score": None}
                    run["stats"]["errors"] += 1
                    _log(f"⚠ {model_col}: {qid} — JSON parse error")

                result_entry["models"][model_col] = {
                    "response": response_text,
                    "scores": parsed.get("scores", {}),
                    "avg_score": parsed.get("average_score"),
                    "comment": parsed.get("overall_comment", ""),
                }
                run["completed"] += 1

            run["results"].append(result_entry)

        # Этап 2 — Сравнительный анализ
        run["phase"] = "comparison"
        _log("Этап 2: сравнительный анализ")
        for i, q in enumerate(queries):
            qid = q["query_id"]
            query_text = _build_query_text(q)
            run["current"] = f"Сравнение: {qid}"
            _log(f"→ Сравнение: {qid}")

            responses_block = ""
            scores_block = ""
            result_entry = run["results"][i]
            for model_col in model_cols:
                resp_text = _build_model_response_text(q, model_col)
                responses_block += f"\n### {model_col}\n{resp_text}\n"
                # Собираем независимые оценки для передачи в сравнение
                model_data = result_entry.get("models", {}).get(model_col, {})
                avg = model_data.get("avg_score", "N/A")
                comment = model_data.get("comment", "")
                scores = model_data.get("scores", {})
                scores_line = ", ".join(
                    f"{k}:{v.get('score','?')}" if isinstance(v, dict) else f"{k}:{v}"
                    for k, v in scores.items()
                ) if scores else "нет данных"
                scores_block += f"\n**{model_col}** — avg: {avg} [{scores_line}]\n{comment}\n"

            compare_prompt = (
                f"Сравни ответы моделей на один запрос. У тебя есть независимые оценки каждой модели — "
                f"учти их, но сделай собственный вывод.\n\n"
                f"## Запрос\n{query_text}\n\n"
                f"## Ответы моделей\n{responses_block}\n\n"
                f"## Независимые оценки (этап 1)\n{scores_block}\n\n"
                f"Задача: сравни модели между собой, учитывая и тексты ответов, и независимые оценки.\n"
                f"Если оценки расходятся с твоим впечатлением — объясни почему.\n\n"
                f"Верни ТОЛЬКО JSON без markdown-обёртки:\n"
                f'{{"ranking":["лучшая","...","худшая"],'
                f'"winner":"точное имя модели из списка",'
                f'"analysis":"2-3 предложения: ключевые различия, за счёт чего победитель лучше"}}'
            )
            raw, usage = judge_llm_call([{"role": "user", "content": compare_prompt}])
            _track_usage(usage)
            _log(f"✓ Сравнение: {qid} — {usage.get('total_tokens', 0)} tok")

            clean = raw.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            try:
                parsed = json.loads(clean)
            except json.JSONDecodeError:
                parsed = {"ranking": [], "winner": "N/A", "analysis": raw}
                run["stats"]["errors"] += 1

            run["results"][i]["comparison"] = parsed
            run["completed"] += 1

        run["stats"]["elapsed"] = round(time.time() - run["stats"]["started_at"], 1)
        run["status"] = "done"
        run["phase"] = "done"
        run["current"] = ""
        _log(f"Готово! Токенов: {run['stats']['tokens_total']}, время: {run['stats']['elapsed']}с")

    except Exception as e:
        run["status"] = "error"
        run["current"] = str(e)
        _log(f"ОШИБКА: {e}")


@app.get("/api/analyze/status/{run_id}")
async def analyze_status(run_id: str):
    run = analyze_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "status": run["status"],
        "phase": run["phase"],
        "total": run.get("total", 0),
        "completed": run.get("completed", 0),
        "current": run.get("current", ""),
        "result_count": len(run.get("results", [])),
        "stats": run.get("stats", {}),
        "log": run.get("log", []),
    }


@app.get("/api/analyze/results/{run_id}")
async def analyze_results(run_id: str):
    run = analyze_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "status": run["status"],
        "model_cols": run["parsed"]["model_cols"],
        "results": run.get("results", []),
    }


@app.get("/api/analyze/download/{run_id}")
async def analyze_download(run_id: str):
    run = analyze_runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    results = run.get("results", [])
    model_cols = run["parsed"]["model_cols"]

    out_path = Path("results") / f"analyze_{run_id}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = ["query_id", "type", "query"]
    for mc in model_cols:
        fieldnames.extend([f"{mc} — avg_score", f"{mc} — comment"])
    fieldnames.extend(["winner", "comparison_analysis"])

    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, delimiter=",", quotechar='"', extrasaction="ignore")
        w.writeheader()
        for r in results:
            row = {
                "query_id": r["query_id"],
                "type": r["type"],
                "query": r["query"][:200],
            }
            for mc in model_cols:
                m = r.get("models", {}).get(mc, {})
                row[f"{mc} — avg_score"] = m.get("avg_score", "")
                row[f"{mc} — comment"] = m.get("comment", "")
            comp = r.get("comparison") or {}
            row["winner"] = comp.get("winner", "")
            row["comparison_analysis"] = comp.get("analysis", "")
            w.writerow(row)

    return FileResponse(str(out_path), filename=out_path.name, media_type="text/csv")


# Статические файлы — монтируем последними
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
