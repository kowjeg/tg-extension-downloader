// TG Media Downloader — добавляет кнопку скачать под медиа в чате

// Inject downloader into page context so it can reach the TG service worker
const _s = document.createElement('script');
_s.src = chrome.runtime.getURL('downloader.js');
(document.head || document.documentElement).appendChild(_s);
_s.remove();

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'TG_DL_READY') return;
  chrome.runtime.sendMessage({ type: 'TG_DL', url: e.data.url, filename: e.data.filename });
});

const PROCESSED = new WeakSet();

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
    if (timeEl) time = timeEl.textContent.trim();
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
}

processMedia();

const observer = new MutationObserver(() => processMedia());
observer.observe(document.body, { childList: true, subtree: true });
