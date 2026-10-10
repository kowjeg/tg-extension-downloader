// TG Media Downloader — добавляет кнопку скачать под медиа в чате

// downloader.js и forward.js подключены в manifest.json в MAIN world (контекст страницы)

const PROCESSED = new WeakSet();

// Войсы: TG играет их через Audio вне DOM, поэтому ссылку ловим в downloader.js
// при запуске воспроизведения и привязываем к войсу, на который только что нажали
const VOICE_URLS = new Map(); // "#чат|id сообщения" -> url
let pendingVoice = null;      // { key, at }

function voiceKey(voiceEl) {
  const msg = voiceEl.closest('[data-message-id]');
  const id = msg && msg.getAttribute('data-message-id');
  return id ? `${location.hash}|${id}` : null;
}

// Отладка войсов (тестовая ветка): все шаги пишутся в консоль с меткой [TG-VOICE]
const vlog = (...args) => console.log('[TG-VOICE]', ...args);

// pointerdown, а не click: TG иногда запускает войс уже на нажатии, раньше click
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest?.('.tg-dl-wrap')) return; // нажатие на наши кнопки — не ▶
  const voiceEl = e.target.closest?.('.message-content.voice');
  const key = voiceEl && voiceKey(voiceEl);
  vlog('press', { key, inVoice: Boolean(voiceEl), target: e.target.className || e.target.tagName });
  if (key) pendingVoice = { key, at: Date.now() };
}, true);

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.type === 'TG_DL_READY') {
    chrome.runtime.sendMessage({ type: 'TG_DL', url: e.data.url, filename: e.data.filename });
  } else if (e.data?.type === 'TG_DL_AUDIO_SRC') {
    // Берём только первый запуск сразу после нажатия (не автопереход к следующему войсу)
    const age = pendingVoice && Date.now() - pendingVoice.at;
    vlog('play', e.data.url, pendingVoice ? `→ ${pendingVoice.key}, ${age} мс после нажатия` : '→ нажатия не было');
    if (!pendingVoice || age > 2000) return;
    VOICE_URLS.set(pendingVoice.key, e.data.url);
    pendingVoice = null;
    processMedia();
  } else if (e.data?.type === 'TG_FWD_STATUS') {
    const btn = FWD_BUTTONS.get(e.data.reqId);
    if (!btn) return;
    btn.textContent = e.data.text;
    btn.dataset.state = e.data.state;
    if (e.data.state !== 'busy') {
      FWD_BUTTONS.delete(e.data.reqId);
      setTimeout(() => { btn.textContent = btn.dataset.label || FWD_LABEL; btn.dataset.state = ''; }, 4000);
    }
  }
});

// Пересылка постов от своего имени (forward.js): медиа вместе с текстом поста, либо только текст
const FWD_LABEL = '↪ Переслать';
const FWD_BUTTONS = new Map(); // reqId -> кнопка, ждущая статуса
let fwdSeq = 0;

// Откуда пересылаем: чат, id сообщения и текст со страницы (запасной вариант без форматирования)
function getPostInfo(el) {
  const msg = el.closest('[data-message-id]');
  const messageId = Number(msg?.getAttribute('data-message-id'));
  const chatId = location.hash.slice(1).split(/[_?]/)[0];
  const textEl = msg?.querySelector('.text-content');
  let domText = '';
  if (textEl) {
    const clone = textEl.cloneNode(true);
    clone.querySelectorAll('.MessageMeta, .tg-dl-wrap').forEach((n) => n.remove());
    domText = clone.innerText.trim();
  }
  return Number.isInteger(messageId) && chatId ? { chatId, messageId, domText } : null;
}

// sourceEl — элемент внутри исходного сообщения, по нему находим пост в момент нажатия.
// getItems — для альбома: собирает [{ url, kind }] в момент нажатия
function addForwardButton(wrap, url, kind, sourceEl, getItems) {
  const btn = document.createElement('button');
  btn.className = 'tg-dl-btn tg-fwd-btn';
  btn.textContent = FWD_LABEL;
  btn.title = 'Переслать в канал, группу или личку';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const reqId = ++fwdSeq;
    FWD_BUTTONS.set(reqId, btn);
    let items;
    if (getItems) {
      items = getItems();
      if (items.error) {
        btn.textContent = items.error;
        btn.dataset.state = 'error';
        setTimeout(() => { btn.textContent = btn.dataset.label || FWD_LABEL; btn.dataset.state = ''; }, 4000);
        return;
      }
    }
    btn.dataset.state = 'busy';
    window.dispatchEvent(new CustomEvent('tg-fwd-request', {
      detail: { url, kind, items, reqId, post: getPostInfo(sourceEl) },
    }));
  });

  wrap.append(btn);
}

function makeWrap(extraClass = '') {
  const wrap = document.createElement('div');
  wrap.className = `tg-dl-wrap ${extraClass}`.trim();
  ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
    wrap.addEventListener(type, (e) => e.stopPropagation());
  });
  return wrap;
}

function makeButton(url, filename) {
  const wrap = makeWrap();

  const btn = document.createElement('a');
  btn.className = 'tg-dl-btn';
  btn.href = url;
  btn.download = filename;
  btn.textContent = '⬇ Скачать';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('tg-dl-request', { detail: { url, filename } }));
  });

  wrap.appendChild(btn);
  return wrap;
}

function isValidSrc(src) {
  return src && (src.startsWith('blob:') || src.startsWith('https://'));
}

function getMediaName(el, prefix) {
  const msg = el.closest('.Message, [data-message-id]') || el.closest('.message');
  let author = '';
  let time = '';

  if (msg) {
    const authorEl = msg.querySelector('.peer-title, .sender-title, .ContactName');
    if (authorEl) author = authorEl.textContent.trim();

    const timeEl = msg.querySelector('.message-time');
    // Текст бывает "edited 20:40" — берём только время
    if (timeEl) time = (timeEl.textContent.match(/\d{1,2}:\d{2}/) || [''])[0];
  }

  // Sanitize for filename
  const clean = (s) => s.replace(/[\\/:*?"<>|]/g, '').trim();
  const parts = [prefix, clean(author), time.replace(':', '-')].filter(Boolean);
  return parts.join('_');
}

function processMedia() {
  const chatRoot = document.querySelector(
    '.bubbles-inner, .bubbles, .messages-container, #column-center'
  ) || document.body;

  // Фото — в TG Web A img лежит внутри .media-photo
  const imgs = chatRoot.querySelectorAll(
    '.media-photo img, .media-album img, .album-item img, img.full-media'
  );

  imgs.forEach((img) => {
    if (PROCESSED.has(img)) return;
    const src = img.src || img.currentSrc;
    if (!isValidSrc(src)) return;
    if (img.closest('.reactions, .reaction, .message-reactions, .reaction-list, .emoji-status, .sticker-emoji')) return;

    PROCESSED.add(img);
    if (img.closest('.Album')) return;

    // Берём ближайший медиа-контейнер и вставляем кнопку ПОСЛЕ него (не внутрь),
    // чтобы overflow:hidden не обрезал кнопку
    const mediaContainer = img.closest('.media-photo, .album-item') || img.parentElement;
    const btn = makeButton(src, `${getMediaName(img, 'photo')}.jpg`);
    addForwardButton(btn, src, 'photo', img);
    mediaContainer.insertAdjacentElement('afterend', btn);
  });

  // Видео — обычные и кружочки (.media-round)
  const videos = chatRoot.querySelectorAll('video');
  videos.forEach((vid) => {
    if (PROCESSED.has(vid)) return;
    const src = vid.src || vid.currentSrc;
    if (!isValidSrc(src)) return;

    PROCESSED.add(vid);
    if (vid.closest('.Album')) return;

    const mediaContainer = vid.closest('.RoundVideo, .media-round, .media-video') || vid.parentElement;
    const isCircle = !!vid.closest('.RoundVideo, .media-round');
    const prefix = isCircle ? 'circle' : 'video';
    const btn = makeButton(src, `${getMediaName(vid, prefix)}.mp4`);
    addForwardButton(btn, src, isCircle ? 'circle' : 'video', vid);
    mediaContainer.insertAdjacentElement('afterend', btn);
  });

  // Войсы — кнопка появляется после первого ▶ (когда известна ссылка)
  const voices = chatRoot.querySelectorAll('.message-content.voice');
  voices.forEach((voiceEl) => {
    const key = voiceKey(voiceEl);
    const url = key && VOICE_URLS.get(key);
    if (!url) return;
    // Кнопки уже есть с этой ссылкой — ничего не делаем; с другой — пересоздаём
    const existing = voiceEl.querySelector('.tg-dl-wrap');
    if (existing?.dataset.url === url) return;
    existing?.remove();

    const anchor = voiceEl.querySelector('.Audio') || voiceEl.firstElementChild;
    vlog('buttons', key, anchor ? 'добавляю' : 'НЕТ места для кнопок', existing ? '(пересоздаю)' : '');
    if (!anchor) return;
    const btn = makeButton(url, `${getMediaName(voiceEl, 'voice')}.ogg`);
    btn.dataset.url = url;
    addForwardButton(btn, url, 'voice', voiceEl);
    anchor.insertAdjacentElement('afterend', btn);
  });

  // Альбомы — одна строка кнопок под альбомом: скачать все / переслать альбомом
  chatRoot.querySelectorAll('.Album').forEach((album) => {
    if (PROCESSED.has(album)) return;
    PROCESSED.add(album);

    const wrap = makeWrap();
    const dl = document.createElement('button');
    dl.className = 'tg-dl-btn';
    dl.textContent = '⬇ Скачать все';
    dl.addEventListener('click', () => {
      const items = getAlbumItems(album);
      if (items.error) { dl.textContent = items.error; return; }
      const name = getMediaName(album, 'album');
      items.forEach((item, i) => {
        const filename = `${name}_${i + 1}.${item.kind === 'video' ? 'mp4' : 'jpg'}`;
        window.dispatchEvent(new CustomEvent('tg-dl-request', { detail: { url: item.url, filename } }));
      });
    });
    wrap.appendChild(dl);
    addForwardButton(wrap, null, 'album', album, () => getAlbumItems(album));
    const fwdBtn = wrap.querySelector('.tg-fwd-btn');
    fwdBtn.textContent = fwdBtn.dataset.label = FWD_ALBUM_LABEL;
    album.insertAdjacentElement('afterend', wrap);
  });

  // Посты только с текстом — кнопка пересылки (видна при наведении)
  const texts = chatRoot.querySelectorAll('.message-content .text-content');
  texts.forEach((textEl) => {
    if (PROCESSED.has(textEl)) return;
    PROCESSED.add(textEl);
    const content = textEl.closest('.message-content');
    if (content.classList.contains('voice') || content.querySelector(TEXT_SKIP_MEDIA)) return;
    if (content.querySelector(':scope > .tg-fwd-text-wrap')) return;

    const wrap = makeWrap('tg-fwd-text-wrap');
    addForwardButton(wrap, null, 'text', textEl);
    content.appendChild(wrap);
  });
}

const FWD_ALBUM_LABEL = '↪ Переслать альбом';

// Элементы альбома по порядку. Видео без загруженного src (не автоплей) пока не умеем
function getAlbumItems(album) {
  const items = [];
  for (const item of album.querySelectorAll('.album-item')) {
    const video = item.querySelector('video');
    const videoSrc = video && (video.src || video.currentSrc);
    const img = item.querySelector('img.full-media');
    const imgSrc = img && (img.src || img.currentSrc);
    if (isValidSrc(videoSrc)) items.push({ url: videoSrc, kind: 'video' });
    else if (item.querySelector('.message-media-duration')) return { error: 'Видео не загружено' };
    else if (isValidSrc(imgSrc)) items.push({ url: imgSrc, kind: 'photo' });
    else return { error: 'Фото не загружено' };
  }
  return items.length ? items : { error: 'Альбом пуст' };
}

// Сообщения с медиа (в т.ч. неподдерживаемыми) не считаем текстовыми
const TEXT_SKIP_MEDIA = '.media-inner, .Album, .File, .Audio, .Poll, .RoundVideo, video, img.full-media';

processMedia();

const observer = new MutationObserver(() => processMedia());
observer.observe(document.body, { childList: true, subtree: true });
