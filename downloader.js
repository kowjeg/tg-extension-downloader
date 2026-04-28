// Runs in page context — has access to the TG service worker
window.addEventListener('tg-dl-request', async (e) => {
  const { url, filename } = e.detail;
  console.log('[TG-DL] starting:', url);

  try {
    const probe = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: { Range: 'bytes=0-' } });
    if (!probe.ok && probe.status !== 206) throw new Error('bad status: ' + probe.status);

    const ct = probe.headers.get('Content-Type') || 'video/mp4';
    const ext = ct.includes('webm') ? 'webm' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('png') ? 'png' : 'mp4';
    const base = filename.replace(/\.[^.]+$/, '');
    const finalName = base + '.' + ext;

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
        console.log('[TG-DL] progress:', Math.round(offset / totalSize * 100) + '%');
      }
    }

    const blob = new Blob(chunks, { type: ct });
    const objUrl = URL.createObjectURL(blob);
    console.log('[TG-DL] done, size:', blob.size, 'name:', finalName);
    window.postMessage({ type: 'TG_DL_READY', url: objUrl, filename: finalName }, window.location.origin);
  } catch (err) {
    console.error('[TG-DL] error:', err);
  }
});
