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

// ---- Тема ----
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}
applyTheme(localStorage.getItem('theme') || 'light');

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
const promptCollapseBtn = $('promptCollapseBtn');
const promptPreview  = $('promptPreview');
const chatToast      = $('chatToast');
const backdrop       = $('backdrop');
const sidebar        = document.querySelector('.sidebar');

let isSending = false;
let lastClearedHistory = null;
let toastTimer = null;

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

function applySidebarState(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed && !isMobile());
  if (promptCollapseBtn) {
    promptCollapseBtn.setAttribute('aria-label', collapsed ? 'Развернуть промпт' : 'Свернуть промпт');
    promptCollapseBtn.setAttribute('title', collapsed ? 'Развернуть промпт' : 'Свернуть промпт');
    promptCollapseBtn.querySelector('span').textContent = collapsed ? '›' : '‹';
  }
}

function updatePromptPreview() {
  if (!promptPreview) return;
  const text = systemPromptEl.value.trim();
  promptPreview.textContent = text ? `${text.slice(0, 72)}${text.length > 72 ? '...' : ''}` : 'Промпт пуст';
}

promptToggle.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
backdrop.addEventListener('click', closeSidebar);
if (promptCollapseBtn) {
  promptCollapseBtn.addEventListener('click', () => {
    const next = !sidebar.classList.contains('collapsed');
    localStorage.setItem('prompt_sidebar_collapsed', next ? '1' : '0');
    applySidebarState(next);
  });
}

// ---- Инициализация ----
async function init() {
  try {
    const res = await fetch(`${API}/api/state${qs()}`);
    const data = await res.json();
    systemPromptEl.value = data.system_prompt;
    updatePromptPreview();
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
    updatePromptPreview();
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
    const currentHistory = [...messagesEl.querySelectorAll('.message')].map(node => ({
      role: node.classList.contains('user') ? 'user' : 'assistant',
      content: node.querySelector('.message-bubble')?.textContent || '',
    })).filter(msg => msg.content);
    await fetch(`${API}/api/history${qs()}`, { method: 'DELETE' });
    lastClearedHistory = currentHistory.length ? currentHistory : null;
    renderHistory([]);
    showToast(lastClearedHistory ? 'История очищена' : 'История уже пустая', lastClearedHistory ? 'Отменить' : '');
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

function showToast(message, actionText) {
  if (!chatToast) return;
  clearTimeout(toastTimer);
  chatToast.hidden = false;
  chatToast.innerHTML = actionText
    ? `${message} <button type="button" id="undoClearBtn">${actionText}</button>`
    : message;
  const undoBtn = $('undoClearBtn');
  if (undoBtn) {
    undoBtn.addEventListener('click', async () => {
      if (lastClearedHistory) {
        try {
          const res = await fetch(`${API}/api/history${qs()}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: lastClearedHistory }),
          });
          if (!res.ok) throw new Error('Ошибка сервера');
          const data = await res.json();
          renderHistory(data.history);
        } catch (e) {
          showStatus(`Ошибка: ${e.message}`, true);
        }
      }
      lastClearedHistory = null;
      chatToast.hidden = true;
    });
  }
  toastTimer = setTimeout(() => { chatToast.hidden = true; }, 7000);
}

function autoResizeInput() {
  userInputEl.style.height = 'auto';
  userInputEl.style.height = Math.min(userInputEl.scrollHeight, 160) + 'px';
}

// ---- Обработчики событий ----
sendBtn.addEventListener('click', sendMessage);
applyBtn.addEventListener('click', applyPrompt);
clearBtn.addEventListener('click', clearHistory);
$('themeToggle').addEventListener('click', toggleTheme);

userInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

userInputEl.addEventListener('input', autoResizeInput);
systemPromptEl.addEventListener('input', updatePromptPreview);

// Ctrl+Enter тоже применяет промпт
systemPromptEl.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    applyPrompt();
  }
});

function savedSidebarCollapsed() {
  const saved = localStorage.getItem('prompt_sidebar_collapsed');
  return saved === null ? true : saved === '1';
}

init();
applySidebarState(savedSidebarCollapsed());
window.addEventListener('resize', () => applySidebarState(savedSidebarCollapsed()));
