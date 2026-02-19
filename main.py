from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import uuid
import urllib3
import os
import time
from typing import List, Optional

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
system_prompt: str = "Ты полезный ассистент."
history: List[dict] = []
access_token: Optional[str] = None
token_expires_at: float = 0

http_session = requests.Session()
http_session.verify = False


def get_access_token() -> str:
    global access_token, token_expires_at
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
async def get_state():
    """Отдаёт текущий системный промпт и историю чата."""
    return {"system_prompt": system_prompt, "history": history}


@app.post("/api/chat")
async def chat(body: ChatRequest):
    global history

    history.append({"role": "user", "content": body.message})

    # Собираем сообщения: сначала system, потом вся история
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.extend(history)

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
        history.append({"role": "assistant", "content": answer})
        return {"answer": answer}
    except Exception as e:
        # Откатываем сообщение пользователя если запрос не удался
        history.pop()
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/system-prompt")
async def set_system_prompt(body: SystemPromptRequest):
    global system_prompt, history
    system_prompt = body.prompt
    if body.clear_history:
        history = []
    return {"system_prompt": system_prompt, "history": history}


@app.delete("/api/history")
async def clear_history_endpoint():
    global history
    history = []
    return {"history": history}


# Статические файлы — монтируем последними
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
