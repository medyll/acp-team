export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function deadlineSignal(signal, timeoutMs, label = "Operation") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal, cleanup() {} };
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error(`${label} timed out after ${timeoutMs}ms`));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}

export async function readJsonResponse(response, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, label = "Response" } = {}) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }

  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      text = chunks.join("");
    } finally {
      reader.releaseLock?.();
    }
  } else if (typeof response.text === "function") {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  } else {
    const payload = await response.json();
    text = JSON.stringify(payload);
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }

  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export function appendLimited(current, chunk, maxBytes, label = "Process output") {
  const next = current + chunk;
  if (Buffer.byteLength(next) > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  return next;
}

export async function fetchWithRetry(fetchImpl, url, options, {
  attempts = 3,
  baseDelayMs = 200,
  maxDelayMs = 2_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (!isRetryableStatus(response.status) || attempt === attempts) return response;
      await response.body?.cancel?.();
      const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"));
      await sleep(Math.min(maxDelayMs, retryAfterMs ?? baseDelayMs * (2 ** (attempt - 1)) * random()));
    } catch (error) {
      if (options.signal?.aborted || attempt === attempts) throw error;
      lastError = error;
      await sleep(Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)) * random()));
    }
  }
  throw lastError;
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
