import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "./registry.js";
import { validateAgentDefinition } from "./declarative-adapter.js";
import { runtimeFromEnvironment } from "../config/runtime-config.js";

test("adds a validated declarative ACP agent to the registry", () => {
  const runtime = runtimeFromEnvironment({ runtime: {
    enabledAgents: ["vendor"],
    customAgents: [{ id: "vendor", transport: "acp", command: "vendor-cli", args: ["acp"], mode: "plan" }]
  } }, {});
  const registry = createRegistry({ log: () => {}, runtime });
  assert.deepEqual(registry.ids, ["vendor"]);
  assert.equal(registry.get("vendor").description, "Declarative ACP agent vendor");
});

test("keeps new custom agents disabled until explicitly enabled", () => {
  const runtime = runtimeFromEnvironment({ runtime: {
    customAgents: [{ id: "vendor", transport: "acp", command: "vendor-cli", args: ["acp"], mode: "plan" }]
  } }, {});
  const registry = createRegistry({ log: () => {}, runtime });
  assert.equal(registry.ids.includes("vendor"), false);
});

test("rejects shell composition and unsupported transports", () => {
  assert.throws(() => validateAgentDefinition({ id: "bad", transport: "acp", command: "tool;whoami" }), /unsafe command/);
  assert.throws(() => validateAgentDefinition({ id: "bad", transport: "shell", command: "tool" }), /must use the acp transport/);
});
