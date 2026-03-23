#!/usr/bin/env python3
"""
Генератор для A/B-тестирования системных промптов GigaChat.

Использование:
  # Прогон single-turn запросов
  python eval_runner.py run -p prompts/original.txt -l original -q queries.csv -o results/run.csv

  # Прогон multi-turn сценариев
  python eval_runner.py run -p prompts/original.txt -l original -q queries_mt.csv --multi-turn -o results/run_mt.csv

  # Оценка через LLM-judge
  python eval_runner.py judge -r results/run.csv -j judge_prompt.txt --rubric rubric.csv -o results/scored.csv

  # Сравнение двух прогонов
  python eval_runner.py compare -a results/scored_A.csv -b results/scored_B.csv -o results/comparison.csv
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
import urllib3
from tqdm import tqdm

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ---------------------------------------------------------------------------
# GigaChat API (переиспользуем логику из main.py)
# ---------------------------------------------------------------------------

GIGACHAT_API_KEY = os.environ.get("GIGACHAT_API_KEY", "")
AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions"
MODEL = "GigaChat-2-Max"

_http = requests.Session()
_http.verify = False
_http.trust_env = False  # игнорировать HTTP_PROXY/HTTPS_PROXY из окружения

_access_token: Optional[str] = None
_token_expires_at: float = 0


import threading as _threading

_token_lock = _threading.Lock()
REQUEST_TIMEOUT = 30  # секунд на один запрос
AUTH_TIMEOUT = 10


def _get_access_token() -> str:
    global _access_token, _token_expires_at
    with _token_lock:
        if _access_token and time.time() < _token_expires_at - 60:
            return _access_token

        for attempt in range(3):
            try:
                resp = _http.post(
                    AUTH_URL,
                    headers={
                        "Authorization": f"Bearer {GIGACHAT_API_KEY}",
                        "RqUID": str(uuid.uuid4()),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data={"scope": "GIGACHAT_API_CORP"},
                    timeout=AUTH_TIMEOUT,
                )
                resp.raise_for_status()
                data = resp.json()
                _access_token = data["access_token"]
                expires_ms = data.get("expires_at", 0)
                _token_expires_at = expires_ms / 1000 if expires_ms else time.time() + 1800
                return _access_token
            except Exception as e:
                if attempt == 2:
                    raise
                time.sleep(2 ** (attempt + 1))
        return ""  # unreachable


# Позволяет main.py подменить функцию получения токена и http-сессию
_get_token_fn = _get_access_token
_http_session_ref = _http


def use_shared_auth(get_token_fn, http_session):
    """Переключает chat_completion на общую авторизацию из main.py."""
    global _get_token_fn, _http_session_ref
    _get_token_fn = get_token_fn
    _http_session_ref = http_session


def chat_completion(messages: list[dict], retries: int = 3) -> str:
    """Отправляет messages в GigaChat, возвращает текст ответа."""
    for attempt in range(retries):
        try:
            token = _get_token_fn()
            resp = _http_session_ref.post(
                CHAT_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={"model": MODEL, "messages": messages},
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except Exception as e:
            if attempt == retries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  [retry {attempt+1}/{retries}] {e} — жду {wait}с...")
            time.sleep(wait)
    return ""  # unreachable


# ---------------------------------------------------------------------------
# CSV helpers
# ---------------------------------------------------------------------------

CSV_PARAMS = dict(delimiter=";", quotechar='"', quoting=csv.QUOTE_MINIMAL)


def read_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f, **CSV_PARAMS))


def write_csv(path: str, rows: list[dict], fieldnames: list[str]):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, **CSV_PARAMS)
        w.writeheader()
        w.writerows(rows)


# ---------------------------------------------------------------------------
# Команда: run
# ---------------------------------------------------------------------------

METRICS_ALL = [
    "STY-01", "STY-02", "STY-03", "STY-04", "STY-05", "STY-06",
    "EMP-01", "EMP-02", "EMP-03",
    "RSN-01", "RSN-02", "RSN-03",
    "SAF-01", "SAF-02", "SAF-03",
    "PRO-01", "FMT-01", "CAL-01", "CUL-01",
]

RUN_FIELDS = [
    "query_id", "scenario_id", "turn", "role",
    "prompt_label", "query", "response", "metrics", "timestamp",
]


def cmd_run(args):
    prompt_text = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    prompt_label = args.prompt_label
    queries = read_csv(args.queries)
    delay = args.delay
    runs = args.runs

    if not GIGACHAT_API_KEY:
        sys.exit("GIGACHAT_API_KEY не задан. Установите переменную окружения.")

    results = []

    if args.multi_turn:
        results = _run_multi_turn(queries, prompt_text, prompt_label, delay, runs)
    else:
        results = _run_single_turn(queries, prompt_text, prompt_label, delay, runs)

    write_csv(args.output, results, RUN_FIELDS)
    print(f"\nГотово: {len(results)} записей → {args.output}")


def _run_single_turn(queries, prompt_text, prompt_label, delay, runs):
    results = []
    total = len(queries) * runs
    with tqdm(total=total, desc="Single-turn") as pbar:
        for q in queries:
            query_id = q.get("id", "")
            query_text = q.get("query", "")
            metrics = q.get("metrics", "")

            for run_idx in range(runs):
                messages = [
                    {"role": "system", "content": prompt_text},
                    {"role": "user", "content": query_text},
                ]
                response = chat_completion(messages)
                results.append({
                    "query_id": f"{query_id}" + (f"_r{run_idx+1}" if runs > 1 else ""),
                    "scenario_id": "",
                    "turn": 1,
                    "role": "assistant",
                    "prompt_label": prompt_label,
                    "query": query_text,
                    "response": response,
                    "metrics": metrics,
                    "timestamp": datetime.now().isoformat(),
                })
                pbar.update(1)
                if delay > 0:
                    time.sleep(delay)
    return results


def _run_multi_turn(queries, prompt_text, prompt_label, delay, runs):
    results = []

    # Группируем по scenario_id
    scenarios = {}
    for row in queries:
        sid = row.get("scenario_id", "")
        if sid not in scenarios:
            scenarios[sid] = []
        scenarios[sid].append(row)

    total = sum(
        len([r for r in turns if r.get("role") == "user"])
        for turns in scenarios.values()
    ) * runs

    with tqdm(total=total, desc="Multi-turn") as pbar:
        for sid, turns in scenarios.items():
            for run_idx in range(runs):
                history = [{"role": "system", "content": prompt_text}]

                for row in turns:
                    role = row.get("role", "").strip()
                    turn_num = row.get("turn", "")
                    metrics = row.get("metrics", "")
                    eval_criteria = row.get("eval_criteria", "")

                    if role == "user":
                        user_msg = row.get("message", "")
                        history.append({"role": "user", "content": user_msg})
                        response = chat_completion(history)
                        history.append({"role": "assistant", "content": response})

                        suffix = f"_r{run_idx+1}" if runs > 1 else ""
                        results.append({
                            "query_id": f"{sid}_t{turn_num}{suffix}",
                            "scenario_id": sid,
                            "turn": turn_num,
                            "role": "assistant",
                            "prompt_label": prompt_label,
                            "query": user_msg,
                            "response": response,
                            "metrics": metrics,
                            "timestamp": datetime.now().isoformat(),
                        })
                        pbar.update(1)
                        if delay > 0:
                            time.sleep(delay)
                    # role=model — пропускаем, это placeholder для ответа

    return results


# ---------------------------------------------------------------------------
# Команда: judge
# ---------------------------------------------------------------------------

SCORE_FIELDS = [
    "query_id", "query_short", "prompt_version", "model_response",
    *METRICS_ALL,
    "avg_score", "llm_judge_comment",
]


def cmd_judge(args):
    results = read_csv(args.results)
    judge_template = Path(args.judge_prompt).read_text(encoding="utf-8-sig").strip()
    prompt_label_for_judge = args.judge_label or "Тестируемый"

    if not GIGACHAT_API_KEY:
        sys.exit("GIGACHAT_API_KEY не задан.")

    scored_rows = []

    for row in tqdm(results, desc="Judging"):
        query_text = row.get("query", "")
        response_text = row.get("response", "")
        prompt_label = row.get("prompt_label", "")

        # Подставляем в шаблон judge-промпта
        judge_prompt = judge_template.replace(
            "{system_prompt_label}", prompt_label_for_judge
        ).replace(
            "{user_query}", query_text
        ).replace(
            "{model_response}", response_text
        )

        messages = [{"role": "user", "content": judge_prompt}]

        try:
            judge_response = chat_completion(messages)
            scores = _parse_judge_json(judge_response)
        except Exception as e:
            print(f"  [error] {row.get('query_id', '?')}: {e}")
            scores = {"_error": str(e), "_raw": ""}

        scored_row = {
            "query_id": row.get("query_id", ""),
            "query_short": query_text[:80],
            "prompt_version": prompt_label,
            "model_response": response_text,
        }

        # Заполняем метрики
        scores_dict = scores.get("scores", {})
        relevant_scores = []
        for m in METRICS_ALL:
            entry = scores_dict.get(m)
            if entry and entry != "N/A":
                if isinstance(entry, dict):
                    val = entry.get("score", "N/A")
                else:
                    val = entry
                scored_row[m] = val
                if isinstance(val, (int, float)):
                    relevant_scores.append(val)
            else:
                scored_row[m] = "N/A"

        scored_row["avg_score"] = (
            round(sum(relevant_scores) / len(relevant_scores), 2)
            if relevant_scores else "N/A"
        )
        scored_row["llm_judge_comment"] = scores.get("overall_comment", "")

        scored_rows.append(scored_row)

        if args.delay > 0:
            time.sleep(args.delay)

    write_csv(args.output, scored_rows, SCORE_FIELDS)
    print(f"\nГотово: {len(scored_rows)} оценок → {args.output}")


def _parse_judge_json(text: str) -> dict:
    """Извлекает JSON из ответа judge'а (может быть обёрнут в markdown)."""
    # Пробуем найти JSON в ```json ... ``` блоке
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        return json.loads(match.group(1))
    # Пробуем найти JSON напрямую
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        return json.loads(match.group(0))
    return {"_raw": text}


# ---------------------------------------------------------------------------
# Команда: compare
# ---------------------------------------------------------------------------

AXIS_METRICS = {
    "style": ["STY-01", "STY-02", "STY-03", "STY-04", "STY-05", "STY-06"],
    "empathy": ["EMP-01", "EMP-02", "EMP-03"],
    "reasoning": ["RSN-01", "RSN-02", "RSN-03"],
    "safety": ["SAF-01", "SAF-02", "SAF-03"],
    "proactivity": ["PRO-01"],
    "formatting": ["FMT-01"],
    "calibration": ["CAL-01"],
    "culture": ["CUL-01"],
}


def cmd_compare(args):
    scored_a = read_csv(args.scored_a)
    scored_b = read_csv(args.scored_b)

    def _axis_avg(rows, metrics):
        vals = []
        for r in rows:
            for m in metrics:
                v = r.get(m, "N/A")
                if v not in ("N/A", "", None):
                    try:
                        vals.append(float(v))
                    except ValueError:
                        pass
        return round(sum(vals) / len(vals), 2) if vals else None

    label_a = scored_a[0]["prompt_version"] if scored_a else "A"
    label_b = scored_b[0]["prompt_version"] if scored_b else "B"

    print(f"\n{'Ось':<16} {label_a:>10} {label_b:>10} {'Δ':>8} {'Результат':>12}")
    print("-" * 60)

    compare_rows = []
    for axis, metrics in AXIS_METRICS.items():
        avg_a = _axis_avg(scored_a, metrics)
        avg_b = _axis_avg(scored_b, metrics)
        if avg_a is not None and avg_b is not None:
            delta = round(avg_b - avg_a, 2)
            verdict = "улучшение" if delta > 0.3 else ("регрессия" if delta < -0.3 else "≈")
        else:
            delta = None
            verdict = "нет данных"

        avg_a_s = f"{avg_a:.2f}" if avg_a is not None else "—"
        avg_b_s = f"{avg_b:.2f}" if avg_b is not None else "—"
        delta_s = f"{delta:+.2f}" if delta is not None else "—"

        print(f"{axis:<16} {avg_a_s:>10} {avg_b_s:>10} {delta_s:>8} {verdict:>12}")

        compare_rows.append({
            "axis": axis,
            f"avg_{label_a}": avg_a_s,
            f"avg_{label_b}": avg_b_s,
            "delta": delta_s,
            "verdict": verdict,
        })

    # Общий средний
    all_a = [float(r.get("avg_score", 0)) for r in scored_a if r.get("avg_score", "N/A") != "N/A"]
    all_b = [float(r.get("avg_score", 0)) for r in scored_b if r.get("avg_score", "N/A") != "N/A"]
    overall_a = round(sum(all_a) / len(all_a), 2) if all_a else None
    overall_b = round(sum(all_b) / len(all_b), 2) if all_b else None

    print("-" * 60)
    oa = f"{overall_a:.2f}" if overall_a is not None else "—"
    ob = f"{overall_b:.2f}" if overall_b is not None else "—"
    od = f"{overall_b - overall_a:+.2f}" if overall_a and overall_b else "—"
    print(f"{'OVERALL':<16} {oa:>10} {ob:>10} {od:>8}")

    if args.output:
        fieldnames = ["axis", f"avg_{label_a}", f"avg_{label_b}", "delta", "verdict"]
        write_csv(args.output, compare_rows, fieldnames)
        print(f"\nТаблица сравнения → {args.output}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="A/B-тестирование системных промптов GigaChat"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # --- run ---
    p_run = sub.add_parser("run", help="Прогнать запросы через GigaChat")
    p_run.add_argument("-p", "--prompt-file", required=True, help="Файл с системным промптом")
    p_run.add_argument("-l", "--prompt-label", required=True, help="Метка промпта (original, new_v1, ...)")
    p_run.add_argument("-q", "--queries", required=True, help="CSV с запросами")
    p_run.add_argument("-o", "--output", required=True, help="Путь для результатов CSV")
    p_run.add_argument("--multi-turn", action="store_true", help="Режим мультитурн-сценариев")
    p_run.add_argument("--delay", type=float, default=1.0, help="Пауза между запросами, сек (default: 1)")
    p_run.add_argument("--runs", type=int, default=1, help="Количество прогонов каждого запроса (default: 1)")

    # --- judge ---
    p_judge = sub.add_parser("judge", help="Оценить ответы через LLM-judge")
    p_judge.add_argument("-r", "--results", required=True, help="CSV с ответами из run")
    p_judge.add_argument("-j", "--judge-prompt", required=True, help="Файл с промптом для judge")
    p_judge.add_argument("--rubric", help="CSV с rubric (для справки)")
    p_judge.add_argument("-o", "--output", required=True, help="Путь для scored CSV")
    p_judge.add_argument("--judge-label", default=None, help="Метка промпта для judge (подставляется в {system_prompt_label})")
    p_judge.add_argument("--delay", type=float, default=1.0, help="Пауза между запросами, сек (default: 1)")

    # --- compare ---
    p_compare = sub.add_parser("compare", help="Сравнить два scored CSV")
    p_compare.add_argument("-a", "--scored-a", required=True, help="Scored CSV промпта A")
    p_compare.add_argument("-b", "--scored-b", required=True, help="Scored CSV промпта B")
    p_compare.add_argument("-o", "--output", default=None, help="Путь для comparison CSV")

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args)
    elif args.command == "judge":
        cmd_judge(args)
    elif args.command == "compare":
        cmd_compare(args)


if __name__ == "__main__":
    main()
