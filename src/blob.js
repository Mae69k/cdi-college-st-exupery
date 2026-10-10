const { del } = require('@vercel/blob');

function hasToken() {
  // OIDC (BLOB_STORE_ID) ou token statique
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

async function removeBlob(url) {
  if (!url || !hasToken()) return;
  if (!/^https?:\/\//.test(url)) return; // ignore les anciens chemins locaux
  try {
    await del(url);
  } catch (err) {
    console.warn('[blob] suppression impossible:', err.message);
  }
}

async function removeBlobs(urls) {
  await Promise.all(urls.filter(Boolean).map((u) => removeBlob(u)));
}

module.exports = { removeBlob, removeBlobs, hasToken };
