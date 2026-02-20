const API = '';  // пустой = тот же хост

// ---- Сессия ----
function getSessionId() {
  let id = localStorage.getItem('session_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('session_id', id);
  }
  return id;
}
const SESSION_ID = getSessionId();
function qs() { return `?session_id=${SESSION_ID}`; }

const $ = id => document.getElementById(id);

const systemPromptEl = $('systemPrompt');
const messagesEl     = $('messages');
const userInputEl    = $('userInput');
const sendBtn        = $('sendBtn');
const applyBtn       = $('applyBtn');
const clearBtn       = $('clearBtn');
const clearOnApply   = $('clearOnApply');
const promptStatus   = $('promptStatus');
const promptBadge    = $('promptBadge');
const promptToggle   = $('promptToggle');
const backdrop       = $('backdrop');
const sidebar        = document.querySelector('.sidebar');

let isSending = false;

// ---- Мобильный сайдбар ----
function openSidebar() {
  sidebar.classList.add('open');
  backdrop.classList.add('visible');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  backdrop.classList.remove('visible');
}
function isMobile() {
  return window.innerWidth <= 680;
}

promptToggle.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
backdrop.addEventListener('click', closeSidebar);

// ---- Инициализация ----
async function init() {
  try {
    const res = await fetch(`${API}/api/state${qs()}`);
    const data = await res.json();
    systemPromptEl.value = data.system_prompt;
    renderHistory(data.history);
  } catch (e) {
    showStatus('Не удалось загрузить состояние', true);
  }
}

// ---- Рендер истории ----
function renderHistory(history) {
  messagesEl.innerHTML = '';
  if (!history.length) {
    messagesEl.innerHTML = '<div class="empty-state">Задайте системный промпт и начните диалог</div>';
    return;
  }
  history.forEach(msg => appendMessage(msg.role, msg.content, false));
  scrollToBottom();
}

// ---- Добавить сообщение в DOM ----
function appendMessage(role, content, animate = true) {
  // Убираем empty-state если есть
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  if (!animate) wrap.style.animation = 'none';

  const roleLabel = document.createElement('div');
  roleLabel.className = 'message-role';
  roleLabel.textContent = role === 'user' ? 'Вы' : 'GigaChat';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = content;

  wrap.appendChild(roleLabel);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

// ---- Индикатор печати ----
function showTyping() {
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  wrap.id = 'typing';

  const roleLabel = document.createElement('div');
  roleLabel.className = 'message-role';
  roleLabel.textContent = 'GigaChat';

  const bubble = document.createElement('div');
  bubble.className = 'typing-bubble';
  bubble.innerHTML = '<span></span><span></span><span></span>';

  wrap.appendChild(roleLabel);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function hideTyping() {
  const t = $('typing');
  if (t) t.remove();
}

// ---- Отправка сообщения ----
async function sendMessage() {
  const text = userInputEl.value.trim();
  if (!text || isSending) return;

  isSending = true;
  sendBtn.disabled = true;
  userInputEl.value = '';
  autoResizeInput();

  appendMessage('user', text);
  showTyping();

  try {
    const res = await fetch(`${API}/api/chat${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || 'Ошибка сервера');
    }

    const data = await res.json();
    hideTyping();
    appendMessage('assistant', data.answer);
  } catch (e) {
    hideTyping();
    appendMessage('assistant', `Ошибка: ${e.message}`);
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    userInputEl.focus();
  }
}

// ---- Применить системный промпт ----
async function applyPrompt() {
  const prompt = systemPromptEl.value.trim();
  const doClear = clearOnApply.checked;

  applyBtn.disabled = true;
  try {
    const res = await fetch(`${API}/api/system-prompt${qs()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, clear_history: doClear }),
    });

    if (!res.ok) throw new Error('Ошибка сервера');

    const data = await res.json();
    if (doClear) renderHistory(data.history);
    showStatus('Промпт применён', false);
    if (isMobile()) closeSidebar();
  } catch (e) {
    showStatus(`Ошибка: ${e.message}`, true);
  } finally {
    applyBtn.disabled = false;
  }
}

// ---- Очистить историю ----
async function clearHistory() {
  try {
    await fetch(`${API}/api/history${qs()}`, { method: 'DELETE' });
    renderHistory([]);
  } catch (e) {
    showStatus(`Ошибка: ${e.message}`, true);
  }
}

// ---- Утилиты ----
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function showStatus(msg, isError) {
  promptStatus.textContent = msg;
  promptStatus.style.color = isError ? '#e05555' : '#4caf50';
  clearTimeout(promptStatus._timer);
  promptStatus._timer = setTimeout(() => { promptStatus.textContent = ''; }, 3000);
}

function autoResizeInput() {
  userInputEl.style.height = 'auto';
  userInputEl.style.height = Math.min(userInputEl.scrollHeight, 160) + 'px';
}

// ---- Обработчики событий ----
sendBtn.addEventListener('click', sendMessage);
applyBtn.addEventListener('click', applyPrompt);
clearBtn.addEventListener('click', clearHistory);

userInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

userInputEl.addEventListener('input', autoResizeInput);

// Ctrl+Enter тоже применяет промпт
systemPromptEl.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    applyPrompt();
  }
});

init();
