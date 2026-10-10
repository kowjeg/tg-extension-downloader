// Пересылка кружков от своего имени через внутренний API TG Web A.
// Runs in page context (MAIN world, document_start).
//
// TG Web A ходит в Telegram через GramJS в отдельном Web Worker. Протокол:
//   страница → воркер: { payloads: [{ type: 'callMethod', messageId, name, args, withCallback }] }
//   воркер → страница: { payloads: [{ type: 'methodResponse' | 'methodCallback' | 'updates', ... }] }
// Ловим этот воркер и шлём в него свои вызовы (sendMessage с isRoundVideo).

const TARGET_KEY = 'tgdl_fwd_target';
// Методы, по которым узнаём API-воркер среди прочих (rlottie и т.п. тоже шлют callMethod)
const API_METHODS = new Set([
  'fetchChats', 'fetchMessages', 'fetchChat', 'fetchFullChat', 'sendMessage',
  'fetchCurrentUser', 'fetchMessage', 'markMessageListRead', 'fetchFullUser',
]);

let apiWorker = null;
let callSeq = 0;
const pendingCalls = new Map();  // messageId -> { resolve, reject, onCallback }
const updateListeners = new Set();

const origPostMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (data, ...rest) {
  if (!apiWorker && Array.isArray(data?.payloads) && data.payloads.some((p) => (
    p?.type === 'initApi' || (p?.type === 'callMethod' && API_METHODS.has(p.name))
  ))) {
    attachWorker(this);
  }
  return origPostMessage.call(this, data, ...rest);
};

function attachWorker(worker) {
  apiWorker = worker;
  console.log('[TG-FWD] API worker found');
  worker.addEventListener('message', ({ data }) => {
    if (!Array.isArray(data?.payloads)) return;
    data.payloads.forEach((p) => {
      if (p.type === 'updates') {
        p.updates.forEach((u) => updateListeners.forEach((fn) => fn(u)));
        return;
      }
      const call = pendingCalls.get(p.messageId);
      if (!call) return; // не наш вызов — его обработает сам TG
      if (p.type === 'methodCallback') {
        call.onCallback?.(...p.callbackArgs);
      } else if (p.type === 'methodResponse') {
        pendingCalls.delete(p.messageId);
        if (p.error) call.reject(new Error(p.error.message || 'API error'));
        else call.resolve(p.response);
      }
    });
  });
}

function callApi(name, args, onCallback) {
  if (!apiWorker) {
    return Promise.reject(new Error('API TG не найден. Закрой другие вкладки Telegram и перезагрузи эту'));
  }
  const messageId = `tgdl_${Date.now()}_${++callSeq}`;
  return new Promise((resolve, reject) => {
    pendingCalls.set(messageId, { resolve, reject, onCallback });
    // Воркер сам допишет callback последним аргументом, если withCallback
    origPostMessage.call(apiWorker, {
      payloads: [{ type: 'callMethod', messageId, name, args, withCallback: Boolean(onCallback) }],
    });
  });
}

// ---------- Целевой канал ----------

function loadTarget() {
  try { return JSON.parse(localStorage.getItem(TARGET_KEY)); } catch { return null; }
}

function saveTarget(chat) {
  try { localStorage.setItem(TARGET_KEY, JSON.stringify(chat)); } catch {}
  window.postMessage({ type: 'TG_FWD_TARGET', title: chat.title }, window.location.origin);
}

// Куда можно постить: каналы — только где мы владелец/админ с правом публикации
function canPost(chat) {
  if (chat.isForbidden || chat.isRestricted || chat.isNotJoined) return false;
  if (chat.type === 'chatTypeChannel') return Boolean(chat.isOwner || chat.adminRights?.postMessages);
  return true;
}

async function loadChats() {
  const res = await callApi('fetchChats', [{ limit: 100, withPinned: true }]);
  if (!res?.chats) throw new Error('не удалось получить список чатов');
  const userNames = {};
  (res.users || []).forEach((u) => {
    userNames[u.id] = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.usernames?.[0]?.username;
  });
  return res.chats
    .filter(canPost)
    .map((chat) => ({ ...chat, title: chat.title || userNames[chat.id] || chat.id }));
}

const CHAT_TYPE_LABEL = {
  chatTypeChannel: 'канал', chatTypeSuperGroup: 'группа', chatTypeBasicGroup: 'группа', chatTypePrivate: 'личка',
};

// Модалка выбора чата. Резолвит выбранный ApiChat или null
function pickTarget() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'tg-fwd-overlay';
    overlay.innerHTML = `
      <div class="tg-fwd-modal">
        <div class="tg-fwd-head">Куда пересылать кружки</div>
        <input class="tg-fwd-search" placeholder="Поиск или @username + Enter">
        <div class="tg-fwd-list">Загрузка…</div>
        <button class="tg-fwd-cancel">Отмена</button>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.tg-fwd-search');
    const list = overlay.querySelector('.tg-fwd-list');
    let chats = [];

    const close = (chat) => {
      overlay.remove();
      if (chat) saveTarget(chat);
      resolve(chat || null);
    };

    const render = () => {
      const q = input.value.trim().toLowerCase();
      const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q));
      list.textContent = shown.length ? '' : 'Ничего не найдено';
      shown.forEach((chat) => {
        const row = document.createElement('div');
        row.className = 'tg-fwd-row';
        row.textContent = chat.title;
        const type = document.createElement('span');
        type.className = 'tg-fwd-type';
        type.textContent = CHAT_TYPE_LABEL[chat.type] || '';
        row.appendChild(type);
        row.addEventListener('click', () => close(chat));
        list.appendChild(row);
      });
    };

    input.addEventListener('input', render);
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') close(null);
      const username = input.value.trim().match(/^(?:@|https?:\/\/t\.me\/)([\w]{4,})$/)?.[1];
      if (e.key !== 'Enter' || !username) return;
      list.textContent = 'Ищу…';
      try {
        const res = await callApi('getChatByUsername', [username]);
        if (!res?.chat) throw new Error('не найдено');
        close(res.chat);
      } catch (err) {
        list.textContent = 'Не найдено: ' + err.message;
      }
    });
    overlay.querySelector('.tg-fwd-cancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    input.focus();

    loadChats()
      .then((res) => { chats = res; render(); })
      .catch((err) => { list.textContent = 'Ошибка: ' + err.message; });
  });
}

// ---------- Отправка ----------

// Размеры, длительность и превью (jpeg первого кадра) из скачанного видео
function readVideoMeta(blobUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    const timer = setTimeout(() => reject(new Error('не удалось прочитать видео')), 15000);

    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(0.1, video.duration / 2 || 0);
    }, { once: true });
    video.addEventListener('seeked', () => {
      clearTimeout(timer);
      const meta = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      const size = Math.min(320, video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(video, 0, 0, size, size);
      canvas.toBlob((thumb) => {
        meta.previewBlobUrl = thumb ? URL.createObjectURL(thumb) : undefined;
        resolve(meta);
      }, 'image/jpeg', 0.8);
    }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('не удалось прочитать видео')); }, { once: true });
    video.src = blobUrl;
  });
}

// Ждём от воркера итог отправки нашего сообщения в чат chatId.
// Локальное (ещё не отправленное) сообщение TG создаёт с дробным id
function watchSendResult(chatId) {
  let localId = null;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const listener = (u) => {
    if (u.chatId !== chatId) return;
    if (u['@type'] === 'newMessage' && localId === null && !Number.isInteger(u.id)) {
      localId = u.id;
    } else if (u['@type'] === 'updateMessageSendSucceeded' && u.localId === localId) {
      settle('ok');
    } else if (u['@type'] === 'updateMessageSendFailed' && u.localId === localId) {
      settle(u.error || 'ошибка отправки');
    }
  };
  updateListeners.add(listener);
  return {
    // Итог может прийти чуть позже ответа на sendMessage — ждём немного
    result: (timeoutMs) => Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs, null))]),
    stop() { updateListeners.delete(listener); },
  };
}

async function forwardCircle(url, onStatus) {
  const target = loadTarget() || await pickTarget();
  if (!target) { onStatus('Отменено', 'idle'); return; }

  onStatus('Скачиваю…');
  const { blob } = await fetchMedia(url, (p) => onStatus(`Скачиваю ${p}%`));
  const blobUrl = URL.createObjectURL(new Blob([blob], { type: 'video/mp4' }));

  let meta;
  try {
    meta = await readVideoMeta(blobUrl);

    const attachment = {
      blobUrl,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      size: blob.size,
      quick: { width: meta.width, height: meta.height, duration: meta.duration },
      previewBlobUrl: meta.previewBlobUrl,
      uniqueId: `tgdl_${Date.now()}`,
      isRoundVideo: true,
    };

    onStatus('Отправляю…');
    const watch = watchSendResult(target.id);
    let result;
    try {
      await callApi('sendMessage', [{ chat: target, attachment }], (progress) => {
        if (typeof progress === 'number') onStatus(`Отправляю ${Math.round(progress * 100)}%`);
      });
      result = await watch.result(5000);
    } finally {
      watch.stop();
    }

    if (result === 'ok') onStatus(`✓ В «${target.title}»`, 'done');
    else throw new Error(result || 'загрузка не удалась');
  } finally {
    // Воркер уже всё прочитал — освобождаем память
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      if (meta?.previewBlobUrl) URL.revokeObjectURL(meta.previewBlobUrl);
    }, 10000);
  }
}

window.addEventListener('tg-fwd-request', async (e) => {
  const { url, reqId } = e.detail;
  const onStatus = (text, state = 'busy') => {
    window.postMessage({ type: 'TG_FWD_STATUS', reqId, text, state }, window.location.origin);
  };
  try {
    await forwardCircle(url, onStatus);
  } catch (err) {
    console.error('[TG-FWD] error:', err);
    onStatus('Ошибка: ' + err.message, 'error');
  }
});

window.addEventListener('tg-fwd-pick', () => { pickTarget(); });

// Сообщаем content.js текущую цель, чтобы показать её на кнопках
window.addEventListener('tg-fwd-hello', () => {
  const target = loadTarget();
  if (target) window.postMessage({ type: 'TG_FWD_TARGET', title: target.title }, window.location.origin);
});
