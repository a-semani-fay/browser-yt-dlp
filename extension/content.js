// Carries messages between a page and the extension's background worker.
// It does nothing until a page speaks first, and the background worker only
// answers origins the user has enabled.

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.data?.source !== 'browser-yt-dlp-page') return;
  const { id, type, request } = event.data;
  let reply;
  try {
    const message = { type };
    if (request) message.request = { ...request, body: request.body ? toBase64(request.body) : null };
    reply = (await chrome.runtime.sendMessage(message)) ?? { error: 'No answer from the extension' };
    if (reply.bodyB64 !== undefined) {
      reply.body = fromBase64(reply.bodyB64);
      delete reply.bodyB64;
    }
  } catch (err) {
    // Typically "Extension context invalidated" after the extension was reloaded
    reply = { error: `${err?.message ?? err} (try reloading the page)` };
  }
  window.postMessage(
    { source: 'browser-yt-dlp-extension', id, ...reply },
    location.origin,
    reply.body ? [reply.body] : [],
  );
});
