// Runs in page context (MAIN world, document_start) — has access to the TG service worker

// Voice messages are played through a detached Audio element (not in DOM),
// so catch its src when TG starts playing it and pass it to content.js.
// Hook play(), not the src setter: TG prefetches the next voice by setting src
// on another element, and reuses an already prefetched element without setting src again
const _play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
  const src = this.getAttribute('src') || this.currentSrc;
  if (this.tagName === 'AUDIO' && src && (src.startsWith('https://') || src.startsWith('blob:'))) {
    window.postMessage({ type: 'TG_DL_AUDIO_SRC', url: new URL(src, location.href).href }, window.location.origin);
  }
  return _play.apply(this, args);
};

const EXT_BY_TYPE = [
  ['webm', 'webm'], ['jpeg', 'jpg'], ['jpg', 'jpg'], ['png', 'png'],
  ['ogg', 'ogg'], ['opus', 'ogg'], ['mpeg', 'mp3'], ['mp4', 'mp4'],
];

// Скачивает медиа через service worker TG кусками (Range), отдаёт { blob, contentType }.
// Используется и для скачивания, и для пересылки (forward.js)
async function fetchMedia(url, onProgress) {
  const probe = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: { Range: 'bytes=0-' } });
  if (!probe.ok && probe.status !== 206) throw new Error('bad status: ' + probe.status);

  const ct = probe.headers.get('Content-Type') || '';
  const contentRange = probe.headers.get('Content-Range');
  const firstChunk = await probe.arrayBuffer();
  const chunks = [firstChunk];

  if (contentRange) {
    const totalSize = parseInt(contentRange.split('/')[1], 10);
    const chunkSize = firstChunk.byteLength;
    console.log('[TG-DL] total:', totalSize, 'chunk:', chunkSize);
    let offset = chunkSize;
    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize - 1, totalSize - 1);
      const r = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: { Range: `bytes=${offset}-${end}` } });
      if (!r.ok && r.status !== 206) throw new Error('chunk failed: ' + r.status);
      chunks.push(await r.arrayBuffer());
      offset = end + 1;
      const percent = Math.round(offset / totalSize * 100);
      console.log('[TG-DL] progress:', percent + '%');
      onProgress?.(percent);
    }
  }

  return { blob: new Blob(chunks, { type: ct || 'application/octet-stream' }), contentType: ct };
}

window.addEventListener('tg-dl-request', async (e) => {
  const { url, filename } = e.detail;
  console.log('[TG-DL] starting:', url);

  try {
    const { blob, contentType } = await fetchMedia(url);
    const origExt = (filename.match(/\.([^.]+)$/) || [])[1] || 'mp4';
    const ext = (EXT_BY_TYPE.find(([k]) => contentType.includes(k)) || [, origExt])[1];
    const finalName = filename.replace(/\.[^.]+$/, '') + '.' + ext;

    const objUrl = URL.createObjectURL(blob);
    console.log('[TG-DL] done, size:', blob.size, 'name:', finalName);
    window.postMessage({ type: 'TG_DL_READY', url: objUrl, filename: finalName }, window.location.origin);
  } catch (err) {
    console.error('[TG-DL] error:', err);
  }
});
