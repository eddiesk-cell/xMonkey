// Wire helpers shared by every HTTP provider adapter.
// No dependencies: node's global fetch + ReadableStream are all we need.

/**
 * Read an SSE stream and hand each `data:` payload to a callback.
 * Robust to CRLF, multi-line data fields, comment lines, and a missing
 * trailing newline at EOF (servers do all of these).
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {(payload: string) => void | Promise<void>} onData
 * @param {(rawLine: string) => void} [onEventLine]
 */
export async function readSSE(body, onData, onEventLine) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (onEventLine) onEventLine(line);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trimStart();
          if (payload) await onData(payload);
        }
      }
    }
    // Flush any trailing buffer that lacked a newline.
    const tail = (buf + decoder.decode()).trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trimStart();
      if (payload) await onData(payload);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already closed */ }
  }
}

/** GET/POST JSON with a timeout and a useful error on non-2xx. */
export async function jsonRequest(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 600_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    let res;
    try {
      res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      // A bare "fetch failed" tells a user nothing. Say which endpoint failed and
      // what usually causes it.
      // undici wraps the real reason one or two levels down; walk the cause chain
      // instead of reporting the unhelpful "fetch failed".
      let cause = err;
      let code = '';
      let reason = '';
      for (let i = 0; i < 4 && cause; i++) {
        if (cause.code) { code = cause.code; break; }
        // Some undici failures carry only a message ("bad port", "socket hang up").
        if (cause.message && cause.message !== 'fetch failed') reason = cause.message;
        cause = cause.cause;
      }
      if (!code) code = err.name === 'AbortError' ? 'ABORTED' : reason;
      const hint = code === 'ECONNREFUSED'
        ? 'nothing is listening there — is the server running and the baseUrl right?'
        : code === 'ENOTFOUND'
          ? 'the host name did not resolve — check the baseUrl.'
          : /bad port/i.test(code)
            ? 'that port is blocked for fetch (browsers block a small set of "bad ports"). Use a normal service port.'
            : code === 'ABORTED'
              ? 'the request was aborted.'
          : code === 'ETIMEDOUT' || err.name === 'TimeoutError'
            ? 'the endpoint did not answer in time.'
            : 'check the baseUrl and that the server is up.';
      throw Object.assign(new Error(`cannot reach ${url}: ${code || err.message}. ${hint}`), { cause: err });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${method} ${url} -> HTTP ${res.status}: ${truncate(text, 800)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Streaming request; returns the raw Response so the caller can read SSE. */
export async function streamRequest(url, { method = 'POST', headers = {}, body, signal, timeoutMs = 600_000 } = {}) {
  const res = await jsonRequest(url, {
    method,
    headers: { accept: 'text/event-stream', ...headers },
    body,
    signal,
    timeoutMs,
  });
  return res;
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n) + `… [${s.length - n} chars truncated]`;
}

/** Retry with exponential backoff + jitter. Only retries things worth retrying. */
export async function withRetry(fn, { attempts = 3, baseMs = 700, maxMs = 20_000, signal, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const delay = Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5);
      if (onRetry) onRetry({ attempt: i + 1, attempts, delay, error: err });
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err.retryable === true) return true;
  const st = err.status;
  if (st === 429 || st === 408 || st === 409) return true;
  if (typeof st === 'number' && st >= 500 && st < 600) return true;
  // Connection-level failures from undici / node.
  const code = err.cause?.code ?? err.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
