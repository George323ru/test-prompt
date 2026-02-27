# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

GigaChat Prompt Tester — веб-приложение для тестирования системных промптов с GigaChat API (Сбербанк). FastAPI-бэкенд + ванильный JS фронтенд.

## Setup

```bash
# Скопировать и заполнить переменные окружения
cp .env.example .env
# Вписать GIGACHAT_API_KEY в .env

# Установить зависимости
pip install -r requirements.txt
```

## Running

```bash
# Локальный запуск (сервер на http://localhost:8000)
uvicorn main:app --reload

# Docker
docker-compose up --build
```

## Architecture

Всё приложение — два файла:

- **`main.py`** — FastAPI-сервер. Хранит сессии в памяти (`sessions: Dict`). Получает OAuth-токен GigaChat через `GIGACHAT_API_KEY`, кэширует его до истечения. Раздаёт фронтенд как статику (`/`).
- **`frontend/app.js`** — весь клиентский код. Сессия пользователя хранится в `localStorage` (ключ `session_id`). Передаётся во все запросы как query-параметр `?session_id=...`.

### API endpoints

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/state?session_id=` | Текущий system prompt и история |
| POST | `/api/chat?session_id=` | Отправить сообщение |
| PUT | `/api/system-prompt?session_id=` | Установить system prompt (опционально очистить историю) |
| DELETE | `/api/history?session_id=` | Очистить историю чата |

### Key details

- Состояние хранится только в памяти — при перезапуске сервера теряется.
- GigaChat OAuth-токен обновляется автоматически с запасом 60 секунд до истечения.
- SSL-верификация отключена (`verify=False`) — требование GigaChat API Сбербанка.
- Модель: `GigaChat-2-Max` (константа `MODEL` в `main.py`).
- Мобильный sidebar открывается кнопкой «Промпт» — toggle через CSS-класс `.open`.
