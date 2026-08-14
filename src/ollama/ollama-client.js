const DEFAULT_HOST = "http://127.0.0.1:11434";

export function createOllamaClient({ host = process.env.OLLAMA_HOST || DEFAULT_HOST, apiKey = process.env.OLLAMA_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Ollama client requires fetch");
  const baseUrl = normalizeHost(host);

  async function request(endpoint, { method = "GET", body, signal } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/${endpoint}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(`Cannot reach Ollama at ${baseUrl}: ${error.message}`);
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) throw new Error(`Ollama ${endpoint} failed (${response.status}): ${payload.error ?? payload.message ?? response.statusText}`);
    return payload;
  }

  return {
    host: baseUrl,
    version: ({ signal } = {}) => request("version", { signal }),
    list: ({ signal } = {}) => request("tags", { signal }),
    ps: ({ signal } = {}) => request("ps", { signal }),
    show: ({ model, signal }) => request("show", { method: "POST", body: { model, verbose: false }, signal }),
    pull: ({ model, signal }) => request("pull", { method: "POST", body: { model, stream: false }, signal }),
    chat: ({ model, messages, think, options, signal }) => request("chat", {
      method: "POST",
      body: { model, messages, stream: false, ...(think === undefined ? {} : { think }), ...(options ? { options } : {}) },
      signal
    })
  };
}

function normalizeHost(host) {
  const url = new URL(host);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("OLLAMA_HOST must use HTTP or HTTPS");
  return url.href.replace(/\/$/, "").replace(/\/api$/, "");
}
