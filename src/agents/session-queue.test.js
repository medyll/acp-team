import assert from "node:assert/strict";
import test from "node:test";
import { createSessionQueue } from "./session-queue.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("serializes work for one session", async () => {
  const queue = createSessionQueue();
  const events = [];

  const first = queue.run("session-a", async () => {
    events.push("first:start");
    await delay(25);
    events.push("first:end");
  });
  const second = queue.run("session-a", async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(queue.size(), 0);
});

test("allows separate sessions to proceed concurrently", async () => {
  const queue = createSessionQueue();
  let secondStarted = false;
  let releaseFirst;
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run("session-a", () => firstRelease);
  const second = queue.run("session-b", async () => {
    secondStarted = true;
  });

  await second;
  assert.equal(secondStarted, true);
  releaseFirst();
  await first;
});

test("releases a session after a failed turn", async () => {
  const queue = createSessionQueue();
  await assert.rejects(queue.run("session-a", async () => {
    throw new Error("expected failure");
  }), /expected failure/);

  const result = await queue.run("session-a", async () => "recovered");
  assert.equal(result, "recovered");
  assert.equal(queue.size(), 0);
});
