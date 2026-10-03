// TG Media Downloader — добавляет кнопку скачать под медиа в чате

// Inject downloader into page context so it can reach the TG service worker
const _s = document.createElement('script');
_s.src = chrome.runtime.getURL('downloader.js');
(document.head || document.documentElement).appendChild(_s);
_s.remove();

const PROCESSED = new WeakSet();

// Войсы: TG играет их через Audio вне DOM, поэтому ссылку ловим в downloader.js
// при нажатии ▶ и привязываем к войсу, по которому только что кликнули
const VOICE_URLS = new Map(); // "#чат|id сообщения" -> url
let pendingVoice = null;      // { key, at }

function voiceKey(voiceEl) {
  const msg = voiceEl.closest('[data-message-id]');
  const id = msg && msg.getAttribute('data-message-id');
  return id ? `${location.hash}|${id}` : null;
}

document.addEventListener('click', (e) => {
  const voiceEl = e.target.closest?.('.message-content.voice');
  const key = voiceEl && voiceKey(voiceEl);
  if (key) pendingVoice = { key, at: Date.now() };
}, true);

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.type === 'TG_DL_READY') {
    chrome.runtime.sendMessage({ type: 'TG_DL', url: e.data.url, filename: e.data.filename });
  } else if (e.data?.type === 'TG_DL_AUDIO_SRC') {
    // Берём только ссылку, пришедшую сразу после клика (не автопереход к следующему войсу)
    if (!pendingVoice || Date.now() - pendingVoice.at > 5000) return;
    VOICE_URLS.set(pendingVoice.key, e.data.url);
    pendingVoice = null;
    processMedia();
  }
});

function makeButton(url, filename) {
  const wrap = document.createElement('div');
  wrap.className = 'tg-dl-wrap';

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

    // Берём ближайший медиа-контейнер и вставляем кнопку ПОСЛЕ него (не внутрь),
    // чтобы overflow:hidden не обрезал кнопку
    const mediaContainer = img.closest('.media-photo, .album-item') || img.parentElement;
    const btn = makeButton(src, `${getMediaName(img, 'photo')}.jpg`);
    mediaContainer.insertAdjacentElement('afterend', btn);
  });

  // Видео — обычные и кружочки (.media-round)
  const videos = chatRoot.querySelectorAll('video');
  videos.forEach((vid) => {
    if (PROCESSED.has(vid)) return;
    const src = vid.src || vid.currentSrc;
    if (!isValidSrc(src)) return;

    PROCESSED.add(vid);

    const mediaContainer = vid.closest('.RoundVideo, .media-round, .media-video') || vid.parentElement;
    const isCircle = !!vid.closest('.RoundVideo, .media-round');
    const prefix = isCircle ? 'circle' : 'video';
    const btn = makeButton(src, `${getMediaName(vid, prefix)}.mp4`);
    mediaContainer.insertAdjacentElement('afterend', btn);
  });

  // Войсы — кнопка появляется после первого ▶ (когда известна ссылка)
  const voices = chatRoot.querySelectorAll('.message-content.voice');
  voices.forEach((voiceEl) => {
    if (voiceEl.querySelector('.tg-dl-wrap')) return;
    const key = voiceKey(voiceEl);
    const url = key && VOICE_URLS.get(key);
    if (!url) return;

    const anchor = voiceEl.querySelector('.Audio') || voiceEl.firstElementChild;
    if (!anchor) return;
    const btn = makeButton(url, `${getMediaName(voiceEl, 'voice')}.ogg`);
    anchor.insertAdjacentElement('afterend', btn);
  });
}

processMedia();

const observer = new MutationObserver(() => processMedia());
observer.observe(document.body, { childList: true, subtree: true });
