export async function checkCompatibility({ registry, cwd = process.cwd(), agents, live = false, timeoutMs = 30_000 } = {}) {
  const requested = agents?.length ? agents : registry.ids;
  const results = [];
  for (const id of requested) {
    const adapter = registry.get(id);
    try {
      const status = await deadline(adapter.status(), timeoutMs, `${id} status`);
      const result = { agent: id, status: "available", details: status };
      if (live) {
        const reply = await deadline(adapter.ask({
          prompt: "Compatibility probe: reply with ACP_TEAM_OK without using tools.",
          cwd,
          mode: "plan",
          newSession: true
        }), timeoutMs, `${id} probe`);
        result.probe = /ACP_TEAM_OK/.test(reply.text ?? "") ? "passed" : "unexpected-response";
      }
      results.push(result);
    } catch (error) {
      results.push({ agent: id, status: "unavailable", error: error.message });
    }
  }
  registry.stopAll();
  return { live, checkedAt: new Date().toISOString(), results };
}

async function deadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); timer.unref?.(); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
