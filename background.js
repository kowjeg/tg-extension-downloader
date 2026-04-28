chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'TG_DL') return;
  chrome.downloads.download({ url: msg.url, filename: msg.filename }, () => {
    if (chrome.runtime.lastError) console.error('[TG-DL bg]', chrome.runtime.lastError.message);
  });
});
