import assert from "node:assert/strict";
import test from "node:test";
import { validateInstallPlan } from "./installer-command.js";

const valid = {
  sourceType: "official",
  packageName: "@example/cli",
  publisher: "Example Inc.",
  version: "1.2.3",
  officialUrl: "https://example.com/cli",
  sourceUrl: "https://example.com/docs/install",
  evidence: ["https://example.com/docs/install"],
  install: { program: "npm", args: ["install", "-g", "@example/cli@1.2.3"] },
  verify: { program: "example-cli", args: ["--version"] }
};

test("accepts structured package-manager plans", () => assert.equal(validateInstallPlan(valid), valid));
test("rejects shell composition and unofficial sources", () => {
  assert.throws(() => validateInstallPlan({ ...valid, sourceType: "community" }), /not marked official/);
  assert.throws(() => validateInstallPlan({ ...valid, install: { program: "npm", args: ["install", "x;whoami"] } }), /Unsafe/);
  assert.throws(() => validateInstallPlan({ ...valid, install: { program: "curl", args: ["https://example.com"] } }), /Unsupported/);
  assert.throws(() => validateInstallPlan({ ...valid, version: "latest", install: { program: "npm", args: ["install", "-g", "@example/cli@latest"] } }), /non-floating version/);
  assert.throws(() => validateInstallPlan({ ...valid, evidence: ["https://attacker.example/proof"] }), /official domain/);
});
