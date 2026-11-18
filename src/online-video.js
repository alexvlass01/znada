'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const NETWORK_IDLE_MS = 30000;

async function fetchVideo(item, headers, { signal, range, fetchImpl = fetch } = {}) {
  // A fetch must not follow a provider redirect to a host outside the URL registry.
  const requestHeaders = { ...headers, 'Accept-Encoding': 'identity' };
  if (range) requestHeaders.Range = range;
  const timeout = new AbortController();
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(), NETWORK_IDLE_MS);
    timer.unref();
  };
  refresh();
  try {
    const response = await fetchImpl(item.full, {
      headers: requestHeaders,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    });
    if (response.status !== (range ? 206 : 200)
        || (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() !== 'video/' + item.format
        || !response.body
        || !['', 'identity'].includes(response.headers.get('content-encoding') || '')) {
      await response.body?.cancel();
      throw new Error('Invalid video response');
    }
    // Restart the deadline only while waiting for upstream, including when the
    // decoder has paused and stopped reading our socket for an extended period.
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    clearTimeout(timer);
    const reader = response.body.getReader();
    async function* chunks() {
      try {
        while (true) {
          refresh();
          const { value, done } = await reader.read();
          clearTimeout(timer);
          if (done) return;
          yield value;
        }
      } finally {
        clearTimeout(timer);
        await reader.cancel().catch(() => {});
      }
    }
    return {
      contentLength, contentRange,
      body: Readable.from(chunks(), { objectMode: false }),
      cancel: () => timeout.abort(),
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// mpv gets a single opaque loopback URL. It never receives provider URLs,
// Referers, redirects or renderer-supplied headers. The decoder may seek by
// opening another bounded-lifetime request for the same authorized file.
async function openVideoStream(item, headers, { signal, fetchImpl } = {}) {
  const route = '/' + randomBytes(24).toString('hex');
  const pending = new Set();
  const server = http.createServer(async (req, res) => {
    const range = req.headers.range;
    if (req.method !== 'GET' || req.url !== route || req.headers.host !== '127.0.0.1:' + server.address()?.port) {
      res.writeHead(404).end();
      return;
    }
    if (range && !/^bytes=\d+-\d*$/.test(range)) {
      res.writeHead(416).end();
      return;
    }
    if (pending.size >= 4) {
      res.writeHead(503).end();
      return;
    }
    const upstream = new AbortController();
    pending.add(upstream);
    res.on('close', () => upstream.abort());
    let transfer;
    try {
      transfer = await fetchVideo(item, headers, { range, signal: upstream.signal, fetchImpl });
      const { contentLength, contentRange, body } = transfer;
      const forwarded = { 'Content-Type': 'video/' + item.format, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (contentLength !== null) forwarded['Content-Length'] = contentLength;
      if (range) {
        const requested = /^bytes=(\d+)-(\d*)$/.exec(range);
        const received = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
        if (!received || received[1] !== requested[1] || Number(received[2]) < Number(received[1])
            || Number(received[2]) >= Number(received[3])
            || (requested[2] && Number(received[2]) > Number(requested[2]))
            || Number(contentLength) !== Number(received[2]) - Number(received[1]) + 1) {
          throw new Error('Invalid video range');
        }
        forwarded['Content-Range'] = contentRange;
      }
      res.writeHead(range ? 206 : 200, forwarded);
      await pipeline(body, res, { signal: upstream.signal });
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
      else res.destroy();
    } finally {
      transfer?.cancel();
      pending.delete(upstream);
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const controller of pending) controller.abort();
    server.close();
    server.closeAllConnections();
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  if (signal?.aborted) {
    close();
    signal.throwIfAborted();
  }
  signal?.addEventListener('abort', close, { once: true });
  server.unref();
  return { url: 'http://127.0.0.1:' + server.address().port + route, close };
}

module.exports = { fetchVideo, openVideoStream };
