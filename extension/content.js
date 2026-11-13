// Carries messages between a page and the extension's background worker.
// It does nothing until a page speaks first, and the background worker only
// answers origins the user has enabled.
//
// Only plain JSON crosses in either direction (binary bodies travel as base64
// text, encoded and decoded by the page). Firefox walls a content script off
// from objects that belong to the page, so touching a page's ArrayBuffer here
// fails with "Permission denied to access property".

const api = globalThis.browser ?? chrome;

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  let text;
  try {
    if (event.data?.source !== 'browser-yt-dlp-page') return;
    text = event.data.json;
  } catch {
    return; // not ours, and not readable from here
  }
  if (typeof text !== 'string') return;

  const { id, type, request } = JSON.parse(text);
  let reply;
  try {
    reply = (await api.runtime.sendMessage({ type, request })) ?? { error: 'No answer from the extension' };
  } catch (err) {
    // Typically "Extension context invalidated" after the extension was reloaded
    reply = { error: `${err?.message ?? err} (try reloading the page)` };
  }
  window.postMessage({ source: 'browser-yt-dlp-extension', json: JSON.stringify({ id, ...reply }) }, location.origin);
});
