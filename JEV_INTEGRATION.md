# Jev integration recommendation

Status: proposed experiment. Do not enable Jev as the default router until the shadow evaluation passes.

## Why Jev belongs here

`acp-team` already recommends models from task text, configured profiles, observed ratings, success rate, latency, cost, and budget state. The fuzzy part is currently `inferProfile(task)` in `src/usage/usage-manager.js`; it maps a few keywords to `cheap`, `standard`, or `premium`.

Jev should replace only that fuzzy classification step. Existing code must keep ownership of candidate allowlists, disabled models, budgets, authorization tokens, execution modes, and every other hard constraint.

```text
task text + permitted candidate metadata
                  |
                  v
          Jev routing advice
          - profile
          - complexity
          - clarification need
          - optional candidate choice
                  |
                  v
       deterministic acp-team rules
       - authorization
       - budget
       - disabled models
       - configured profiles
                  |
                  v
             recommendation
```

Jev advises. It never grants permission.

## First session task

Start with a live smoke test that sends synthetic task descriptions only. Confirm the API contract, response shape, latency, and error behavior with `TYPESAFE_API_KEY`; never print or persist the key.

Use at least these cases:

1. Fix a typo in `README.md` with no source change.
2. Add a limited feature with unit tests in one subsystem.
3. Plan and execute a compatibility-sensitive architecture migration.
4. Explain existing code without modifying files.

Ask the same atomic questions for every case:

| Answer | Jev primitive | Values |
| --- | --- | --- |
| `profile` | choice | `cheap`, `standard`, `premium` |
| `requires_write` | noul | probability from 0 to 1 |
| `complexity` | score | mechanical, normal, cross-cutting/high-risk |
| `needs_clarification` | noul | probability from 0 to 1 |

Record the answer, probability distribution, confidence when supplied, request latency, and token usage. Do not wire the result into `model_recommend` during this first task.

## Proposed runtime modes

Add an explicit mode with a safe default:

```text
ACP_TEAM_ROUTING_PROVIDER=heuristic
ACP_TEAM_ROUTING_PROVIDER=jev-shadow
ACP_TEAM_ROUTING_PROVIDER=jev
```

- `heuristic`: current behavior, with no TypeSafe request.
- `jev-shadow`: run both routers, return the current heuristic result, and record a sanitized comparison.
- `jev`: use Jev advice when confidence and policy thresholds pass; otherwise return the heuristic result.

Do not silently infer the mode from the presence of `TYPESAFE_API_KEY`.

## Smallest implementation shape

Keep the provider boundary narrow. A suitable interface is:

```ts
type RoutingAdvice = {
  profile: 'cheap' | 'standard' | 'premium';
  profileConfidence: number | null;
  requiresWrite: number;
  complexity: number;
  needsClarification: number;
  provider: 'heuristic' | 'jev';
};
```

Suggested ownership:

- a small Jev adapter handles the TypeSafe request and response validation;
- `usage-manager.js` keeps candidate filtering, ratings, budget checks, and final ranking;
- the current `inferProfile()` remains the fallback;
- callers receive the same public response shape unless a separately reviewed API change is needed.

Inject the adapter into `createUsageManager` so unit tests never require network access. Avoid a process-wide singleton.

## Shadow evaluation

Create a fixture corpus of roughly 40 labeled coding tasks, covering trivial edits, ordinary fixes, investigations, large migrations, ambiguous requests, and read-only questions. Labels need human review before they become expected results.

Measure:

- profile accuracy and confusion matrix;
- false `cheap` classifications, since under-routing carries more risk than over-routing;
- whether low confidence predicts mistakes;
- p50 and p95 latency;
- cost per recommendation;
- fallback frequency and failure behavior.

Shadow telemetry must not store full prompts by default. Store a task hash, expected and predicted labels, confidence, timing, provider, and error category. If a debugging mode stores text, make that mode explicit and document the privacy cost.

## Activation rules

Do not activate `jev` mode until all conditions below hold:

- the fixture corpus is checked into the repository;
- network-free unit tests cover success, timeout, malformed response, missing key, authentication failure, and rate limiting;
- a Jev outage returns the current recommendation rather than failing the caller;
- low-confidence results fall back to the heuristic;
- the evaluation shows fewer meaningful routing errors than `inferProfile()`;
- no authorization or budget decision depends on model output.

Start with a conservative confidence threshold. Tune it from observed errors rather than choosing a permanent number in advance.

## Explicit non-goals

The first version must not:

- authorize write-capable agent modes;
- choose from models outside the configured candidate set;
- change budget or subscription policy;
- send repository contents, diffs, secrets, or command output to TypeSafe;
- replace model ratings and observed performance data;
- create a shared TypeSafe package for other repositories.

Build the `acp-team` experiment locally first. Extract shared code only after a second project proves that the interface is genuinely shared.

## Done condition for the first implementation session

Stop after the smoke test, injectable adapter, shadow mode, fixture-based tests, and a short evaluation report work. Do not enable active routing in the same session.
