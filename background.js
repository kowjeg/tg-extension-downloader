// chrome.downloads ignores `filename` for blob: URLs created in the page,
// so remember the wanted name by URL and apply it in onDeterminingFilename
const PENDING_NAMES = new Map(); // url -> filename

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'TG_DL') return;
  PENDING_NAMES.set(msg.url, msg.filename);
  chrome.downloads.download({ url: msg.url, filename: msg.filename }, () => {
    if (chrome.runtime.lastError) {
      console.error('[TG-DL bg]', chrome.runtime.lastError.message);
      PENDING_NAMES.delete(msg.url);
    }
  });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const name = PENDING_NAMES.get(item.url) || PENDING_NAMES.get(item.finalUrl);
  if (!name) return; // не наше скачивание — Chrome выберет имя сам
  PENDING_NAMES.delete(item.url);
  PENDING_NAMES.delete(item.finalUrl);
  // Chrome rejects names with control chars, reserved symbols or leading/trailing dots
  const safe = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|~]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');
  suggest({ filename: safe || 'tg_media', conflictAction: 'uniquify' });
});
