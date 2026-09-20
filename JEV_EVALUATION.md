# Jev routing evaluation

Status: shadow implementation ready; active routing disabled.

The checked-in corpus contains 40 synthetic coding tasks across cheap, standard
and premium work, including read-only requests and ambiguous prompts. Its labels
have `needs-human-review` status, so no result from this corpus can activate Jev
until a person reviews them.

## Current evidence

Network-free tests cover successful advice, missing credentials, timeout,
malformed output, authentication failure and rate limiting. Usage-manager tests
also prove that shadow advice cannot alter the returned recommendation, explicit
profiles skip Jev, and stored comparisons omit task text and provider messages.

Re-run the checks with:

```powershell
$env:TYPESAFE_API_KEY = "..."
pnpm test:smoke:jev
pnpm eval:jev
```

Against the provisional labels, `inferProfile()` currently matches 27 of 40
cases (67.5%). It sends six cheap cases and seven premium cases to `standard`;
none of the non-cheap cases are classified as `cheap`. Treat that baseline as
diagnostic only until the labels receive human review.

## Live run: 20 September 2026

The four-case smoke test passed against `jev-1.13.0`. Profile choices matched
all four provisional labels, latency ranged from 308 to 783 ms, and each request
used 675 to 678 tokens. `needs_clarification` ranged from 0.61 to 0.95, including
the typo and explanation cases; this was the first sign that the question and
the provisional label policy disagree.

The 40-case run completed without a provider fallback. Jev matched 37 labels
(92.5%), compared with 27 (67.5%) for `inferProfile()`. Its p50 latency was 296 ms
and p95 was 387 ms, with 588.55 average input tokens and 91 output tokens.

Three standard cases were classified as cheap:

- `standard-endpoint`, confidence 0.50
- `standard-readme-example`, confidence 0.61
- `standard-schema-field`, confidence 0.44

All three fall at or below 0.61 confidence, but one run is not enough to choose
a permanent threshold. The other provisional dimension scores were 100% for
`requires_write`, 87.5% for rounded complexity, and 10% for
`needs_clarification` at a 0.5 cutoff.

The smoke command sends four synthetic descriptions. The corpus command compares
`inferProfile()` and Jev, reporting profile accuracy, the confusion matrix,
false-cheap classifications, low-confidence mistakes, p50 and p95 latency,
token use and fallback frequency. The current TypeSafe response exposes token
counts but no price field, so reported cost per recommendation remains `null`
until a documented price source is added.

## Activation block

Keep `ACP_TEAM_ROUTING_PROVIDER=heuristic` in normal use. `jev-shadow` is for
measurement only, while `jev` exits during startup. Active routing still needs
human-reviewed labels, live results better than `inferProfile()`, a chosen
confidence threshold based on observed errors, and a separate review that confirms
no authorization or budget rule depends on Jev output.

The current run does not pass that gate: false-cheap classifications remain, and
the clarification dimension needs human relabeling and question review.
