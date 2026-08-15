/** Helpers every tool module shares: identical output shape, identical wiring. */

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

export function render({ agent, result, includeThoughts }) {
  const body = result.text.trim() || `(${agent} returned no text)`;
  const tools = result.toolCalls.length
    ? `\n\n---\n${agent} tool calls:\n${result.toolCalls.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`
    : "";
  const thoughts = includeThoughts && result.thoughts ? `\n\n---\n${agent} thoughts:\n${result.thoughts}` : "";
  return `${body}${tools}${thoughts}\n\n(agent: ${agent}, session: ${result.sessionId}, stop: ${result.stopReason})`;
}

/**
 * Bridge adapter events onto MCP progress notifications when the caller asked
 * for them. Without a progress token there is nowhere to send them, so the
 * reporter becomes a no-op rather than an error.
 */
export function progressReporter(extra, log) {
  const progressToken = extra?._meta?.progressToken;
  let progress = 0;
  return (event) => {
    if (progressToken === undefined) return;
    const message = [event.type, event.title, event.status].filter(Boolean).join(" — ");
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message }
      })
      .catch((error) => log?.warn?.("progress notification failed", { error: error.message }));
  };
}
