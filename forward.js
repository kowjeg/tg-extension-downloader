// Пересылка постов (кружки, фото, войсы, текст) от своего имени через внутренний API TG Web A.
// Runs in page context (MAIN world, document_start).
//
// TG Web A ходит в Telegram через GramJS в отдельном Web Worker. Протокол:
//   страница → воркер: { payloads: [{ type: 'callMethod', messageId, name, args, withCallback }] }
//   воркер → страница: { payloads: [{ type: 'methodResponse' | 'methodCallback' | 'updates', ... }] }
// Ловим этот воркер и шлём в него свои вызовы (sendMessage с вложением).

const RECENT_KEY = 'tgdl_fwd_recent';
const RECENT_LIMIT = 5;
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
        p.updates.forEach((u) => {
          rememberFromUpdate(u);
          updateListeners.forEach((fn) => fn(u));
        });
        return;
      }
      if (p.type === 'methodResponse') rememberFromResponse(p.response);
      const call = pendingCalls.get(p.messageId);
      if (!call) return; // не наш вызов — его обработает сам TG
      if (p.type === 'methodCallback') {
        call.onCallback?.(...p.callbackArgs);
      } else if (p.type === 'methodResponse') {
        console.log('[TG-FWD] response', p.messageId, p.error || p.response);
        pendingCalls.delete(p.messageId);
        if (p.error) call.reject(new Error(p.error.message || 'API error'));
        else call.resolve(p.response);
      }
    });
  });
}

// ---------- Кэш чатов и текстов постов ----------
// Всё, что TG Web A загружает для показа (чаты с accessHash, сообщения с форматированием),
// проходит через воркер — запоминаем по дороге, чтобы не запрашивать заново

const CHATS = new Map();  // chatId -> ApiChat
const TEXTS = new Map();  // "chatId|messageId" -> { text, entities }
const TEXTS_LIMIT = 5000;

function rememberChat(chat) {
  if (!chat?.id || !chat.accessHash) return;
  CHATS.set(chat.id, { ...CHATS.get(chat.id), ...chat });
}

function rememberMessage(chatId, id, message) {
  const text = message?.content?.text;
  if (!chatId || !Number.isInteger(id) || !text?.text) return;
  const key = `${chatId}|${id}`;
  TEXTS.delete(key); // переставляем в конец, чтобы старые вытеснялись первыми
  TEXTS.set(key, { text: text.text, entities: text.entities });
  if (TEXTS.size > TEXTS_LIMIT) TEXTS.delete(TEXTS.keys().next().value);
}

function rememberFromResponse(res) {
  if (!res || typeof res !== 'object') return;
  if (Array.isArray(res.chats)) res.chats.forEach(rememberChat);
  if (res.chat) rememberChat(res.chat);
  if (Array.isArray(res.messages)) res.messages.forEach((m) => rememberMessage(m?.chatId, m?.id, m));
  if (res.message) rememberMessage(res.message.chatId, res.message.id, res.message);
}

function rememberFromUpdate(u) {
  if (u.chat) rememberChat(u.chat);
  if (u.message) rememberMessage(u.chatId || u.message.chatId, u.id ?? u.message.id, u.message);
}

// Текст поста с форматированием: из кэша, иначе запросом к API, иначе голый текст со страницы
async function getPostText({ chatId, messageId, domText }) {
  const cached = TEXTS.get(`${chatId}|${messageId}`);
  if (cached) return cached;

  const chat = CHATS.get(chatId);
  if (chat) {
    try {
      const res = await callApi('fetchMessage', [{ chat, messageId }]);
      const text = res?.message?.content?.text;
      if (text?.text) return { text: text.text, entities: text.entities };
      if (res?.message) return null; // пост есть, текста у него нет
    } catch (err) {
      console.warn('[TG-FWD] fetchMessage failed:', err);
    }
  }
  console.log('[TG-FWD] text from page (formatting lost)', chatId, messageId);
  return domText ? { text: domText } : null;
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

// ---------- Выбор чата ----------

// Последние чаты, куда пересылали, — показываем их первыми
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

function saveRecent(chat) {
  const recent = [chat, ...loadRecent().filter((c) => c.id !== chat.id)].slice(0, RECENT_LIMIT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
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
        <div class="tg-fwd-head">Куда переслать</div>
        <input class="tg-fwd-search" placeholder="Поиск или @username + Enter">
        <div class="tg-fwd-list"></div>
        <button class="tg-fwd-cancel">Отмена</button>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.tg-fwd-search');
    const list = overlay.querySelector('.tg-fwd-list');
    const recent = loadRecent();
    let chats = null; // null — ещё грузятся
    let loadError = null;

    const close = (chat) => {
      overlay.remove();
      if (chat) saveRecent(chat);
      resolve(chat || null);
    };

    const addSection = (title) => {
      const head = document.createElement('div');
      head.className = 'tg-fwd-section';
      head.textContent = title;
      list.appendChild(head);
    };

    const render = () => {
      const q = input.value.trim().toLowerCase();
      const match = (c) => !q || c.title.toLowerCase().includes(q);
      const recentIds = new Set(recent.map((c) => c.id));
      const shownRecent = recent.filter(match);
      const shownAll = (chats || []).filter((c) => !recentIds.has(c.id) && match(c));

      list.textContent = '';
      if (shownRecent.length) {
        addSection('Недавние');
        shownRecent.forEach(addRow);
      }
      if (shownAll.length) {
        if (shownRecent.length) addSection('Все чаты');
        shownAll.forEach(addRow);
      }
      if (loadError) addSection('Ошибка: ' + loadError);
      else if (!chats) addSection('Загрузка…');
      else if (!shownRecent.length && !shownAll.length) addSection('Ничего не найдено');
    };

    function addRow(chat) {
      const row = document.createElement('div');
      row.className = 'tg-fwd-row';
      row.textContent = chat.title;
      const type = document.createElement('span');
      type.className = 'tg-fwd-type';
      type.textContent = CHAT_TYPE_LABEL[chat.type] || '';
      row.appendChild(type);
      row.addEventListener('click', () => close(chat));
      list.appendChild(row);
    }

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
    render();

    loadChats()
      .then((res) => { chats = res; render(); })
      .catch((err) => { loadError = err.message; render(); });
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
    console.log('[TG-FWD] update', u['@type'], u.id ?? u.localId, u.error || '');
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

// Размеры фото
function readImageMeta(blobUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('не удалось прочитать фото'));
    img.src = blobUrl;
  });
}

// Длительность и волна войса (63 точки 0–255, как отправляет сам TG Web A)
const WAVEFORM_POINTS = 63;
const STALL_TIMEOUT = 60 * 1000;
async function readVoiceMeta(blob) {
  const ctx = new OfflineAudioContext(1, 1, 8000);
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / WAVEFORM_POINTS));
    const peaks = Array.from({ length: WAVEFORM_POINTS }, (_, i) => {
      let peak = 0;
      for (let j = i * step, end = Math.min(j + step, data.length); j < end; j++) {
        peak = Math.max(peak, Math.abs(data[j]));
      }
      return peak;
    });
    const max = Math.max(...peaks) || 1;
    return {
      duration: Math.max(1, Math.round(audio.duration)),
      waveform: peaks.map((p) => Math.round((p / max) * 255)),
    };
  } catch (err) {
    // Не смогли декодировать — длительность из <audio>, волна ровная
    console.warn('[TG-FWD] voice decode failed:', err);
    const duration = await new Promise((resolve) => {
      const el = new Audio();
      el.onloadedmetadata = () => resolve(el.duration);
      el.onerror = () => resolve(1);
      el.src = URL.createObjectURL(blob);
    });
    return {
      duration: Math.max(1, Math.round(Number.isFinite(duration) ? duration : 1)),
      waveform: Array(WAVEFORM_POINTS).fill(128),
    };
  }
}

// Собирает ApiAttachment для sendMessage. Возвращает { attachment, cleanup }
async function buildAttachment(kind, blob, contentType) {
  const urls = [];
  const makeUrl = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const base = { size: blob.size, uniqueId: `tgdl_${Date.now()}` };
  let attachment;

  if (kind === 'circle') {
    const blobUrl = makeUrl(new Blob([blob], { type: 'video/mp4' }));
    const meta = await readVideoMeta(blobUrl);
    if (meta.previewBlobUrl) urls.push(meta.previewBlobUrl);
    attachment = {
      ...base,
      blobUrl,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      quick: { width: meta.width, height: meta.height, duration: meta.duration },
      previewBlobUrl: meta.previewBlobUrl,
      isRoundVideo: true,
    };
  } else if (kind === 'photo') {
    // Фото TG принимает как фото только в jpeg/png, остальное — файлом
    const mimeType = /png/.test(contentType) ? 'image/png' : /jpe?g/.test(contentType) || !contentType ? 'image/jpeg' : contentType;
    const blobUrl = makeUrl(new Blob([blob], { type: mimeType }));
    const asPhoto = mimeType === 'image/jpeg' || mimeType === 'image/png';
    attachment = {
      ...base,
      blobUrl,
      filename: mimeType === 'image/png' ? 'photo.png' : 'photo.jpg',
      mimeType,
      ...(asPhoto ? { quick: await readImageMeta(blobUrl) } : { shouldSendAsFile: true }),
    };
  } else if (kind === 'voice') {
    const blobUrl = makeUrl(new Blob([blob], { type: 'audio/ogg' }));
    attachment = {
      ...base,
      blobUrl,
      filename: 'voice.ogg',
      mimeType: 'audio/ogg',
      voice: await readVoiceMeta(blob),
    };
  } else {
    throw new Error('неизвестный тип: ' + kind);
  }

  // Воркер читает blob-ссылки во время загрузки — освобождаем с запасом
  const cleanup = () => setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 10000);
  return { attachment, cleanup };
}

// Отправляет одно сообщение (params для sendMessage без chat) и ждёт подтверждения
async function sendOne(target, params, onStatus) {
  onStatus('Отправляю…');
  console.log('[TG-FWD] sending to', target.id, params);
  const watch = watchSendResult(target.id);
  // Если от TG долго нет ни прогресса, ни ответа — считаем, что зависло
  let stallTimer;
  let armStall;
  const stalled = new Promise((_, reject) => {
    armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => reject(new Error('TG не отвечает (таймаут)')), STALL_TIMEOUT);
    };
  });
  armStall();
  let lastLogged = -1;
  let result;
  try {
    await Promise.race([
      callApi('sendMessage', [{ chat: target, ...params }], (progress) => {
        armStall();
        if (typeof progress !== 'number') return;
        const percent = Math.round(progress * 100);
        if (percent !== lastLogged && percent % 10 === 9) console.log('[TG-FWD] progress', progress);
        lastLogged = percent;
        onStatus(`Отправляю ${percent}%`);
      }),
      stalled,
    ]);
    result = await watch.result(5000);
  } finally {
    clearTimeout(stallTimer);
    watch.stop();
  }

  if (result !== 'ok') throw new Error(result || 'загрузка не удалась');
}

// Подпись к медиа без Premium — до 1024 символов, длиннее шлём отдельным сообщением
const CAPTION_LIMIT = 1024;

// kind: 'circle' | 'photo' | 'voice' | 'text'. post — { chatId, messageId, domText } исходного поста
async function forward({ url, kind, post }, onStatus) {
  const target = await pickTarget();
  if (!target) { onStatus('Отменено', 'idle'); return; }

  // У кружков подписи не бывает
  const text = kind === 'circle' || !post ? null : await getPostText(post);

  if (kind === 'text') {
    if (!text) throw new Error('не нашёл текст поста');
    await sendOne(target, { text: text.text, entities: text.entities }, onStatus);
    onStatus(`✓ В «${target.title}»`, 'done');
    return;
  }

  onStatus('Скачиваю…');
  const { blob, contentType } = await fetchMedia(url, (p) => onStatus(`Скачиваю ${p}%`));
  const { attachment, cleanup } = await buildAttachment(kind, blob, contentType);

  const asCaption = text && text.text.length <= CAPTION_LIMIT;
  try {
    await sendOne(target, {
      attachment,
      ...(asCaption && { text: text.text, entities: text.entities }),
    }, onStatus);
  } finally {
    cleanup();
  }
  if (text && !asCaption) {
    await sendOne(target, { text: text.text, entities: text.entities }, onStatus);
  }
  onStatus(`✓ В «${target.title}»`, 'done');
}

window.addEventListener('tg-fwd-request', async (e) => {
  const { reqId } = e.detail;
  const onStatus = (text, state = 'busy') => {
    window.postMessage({ type: 'TG_FWD_STATUS', reqId, text, state }, window.location.origin);
  };
  try {
    await forward(e.detail, onStatus);
  } catch (err) {
    console.error('[TG-FWD] error:', err);
    onStatus('Ошибка: ' + err.message, 'error');
  }
});
