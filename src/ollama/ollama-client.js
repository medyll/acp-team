import { deadlineSignal, readJsonResponse } from "../resilience.js";

const DEFAULT_HOST = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 10 * 60_000;

export function createOllamaClient({ host = process.env.OLLAMA_HOST || DEFAULT_HOST, apiKey = process.env.OLLAMA_API_KEY, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Ollama client requires fetch");
  const baseUrl = normalizeHost(host);

  if (apiKey && new URL(baseUrl).protocol !== "https:" && !isLoopback(new URL(baseUrl).hostname)) {
    throw new Error("OLLAMA_API_KEY requires HTTPS for non-local hosts");
  }

  async function request(endpoint, { method = "GET", body, signal, requestTimeoutMs = timeoutMs } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response;
    const deadline = deadlineSignal(signal, requestTimeoutMs, `Ollama ${endpoint}`);
    try {
      try {
        response = await fetchImpl(`${baseUrl}/api/${endpoint}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: deadline.signal,
          redirect: "error"
        });
      } catch (error) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        throw new Error(`Cannot reach Ollama at ${baseUrl}: ${error.message}`);
      }
      const payload = await readJsonResponse(response, { maxBytes: maxResponseBytes, label: `Ollama ${endpoint} response` });
      if (!response.ok) throw new Error(`Ollama ${endpoint} failed (${response.status}): ${payload.error ?? payload.message ?? response.statusText}`);
      return payload;
    } finally {
      deadline.cleanup();
    }
  }

  return {
    host: baseUrl,
    version: ({ signal } = {}) => request("version", { signal }),
    list: ({ signal } = {}) => request("tags", { signal }),
    ps: ({ signal } = {}) => request("ps", { signal }),
    show: ({ model, signal }) => request("show", { method: "POST", body: { model, verbose: false }, signal }),
    pull: ({ model, signal }) => request("pull", { method: "POST", body: { model, stream: false }, signal, requestTimeoutMs: LONG_TIMEOUT_MS }),
    chat: ({ model, messages, think, options, signal }) => request("chat", {
      method: "POST",
      body: { model, messages, stream: false, ...(think === undefined ? {} : { think }), ...(options ? { options } : {}) },
      signal,
      requestTimeoutMs: LONG_TIMEOUT_MS
    })
  };
}

function normalizeHost(host) {
  const url = new URL(host);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("OLLAMA_HOST must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("OLLAMA_HOST must not contain credentials, a query, or a fragment");
  return url.href.replace(/\/$/, "").replace(/\/api$/, "");
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}
