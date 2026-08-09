/**
 * Serialize work that targets the same agent session.
 *
 * Agent sessions are conversations, not request pools: configuration changes
 * and prompts must arrive in order. Different session keys still run in
 * parallel.
 */
export function createSessionQueue() {
  const tails = new Map();

  function run(key, task) {
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    tails.set(key, current);

    return previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        release();
        if (tails.get(key) === current) tails.delete(key);
      });
  }

  return { run, size: () => tails.size };
}
