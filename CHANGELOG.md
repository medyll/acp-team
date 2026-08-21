# Changelog

## [1.0.9] - 2026-08-21
**Features:**
- default to core tool surface
- summarize synchronous agent runs

**Bug Fixes:**
- scope clients to working directory



## [1.0.8] - 2026-08-21
**Bug Fixes:**
- keep the authorization store with the bridge (#3)



## [1.0.7] - 2026-08-17
**Features:**
- let agent_watch wait for a run to finish
- add governed LLM operations
- bound usage ledger and configuration history growth
- bound agent concurrency and journal run lifecycle
- harden agent transports and add an explicit security policy
- add extensible LLM control CLI

**Bug Fixes:**
- use complete Windows package
- record the token counters codex actually reports
- lock authorization store
- consume fan-out authorization as one transaction
- authorize a whole fan-out before starting any of it
- refuse prototype-chain keys on every configuration path
- remove unsandboxed agent mode

**Refactoring:**
- split the tool surface and add fan-out delegation

**Tests:**
- keep unref timeout cases alive
- keep timeout test alive
- cover the adapter, registry and terminal layers, and add linting



## [Unreleased]
**Features:**
- `agent_watch` accepts `until: "terminal"` to wait for a run to finish instead of returning on every event

## [1.0.6] - 2026-08-16
**Other:**
- Fix Codex Windows sandbox package resolution (#1)

## [1.0.5] - 2026-08-10
**Features:**
- add usage budget controls



## [1.0.4] - 2026-08-10
**Features:**
- add OpenCode agent support



## [1.0.3] - 2026-08-10
**Features:**
- add supervised agent runs



## [1.0.2] - 2026-08-09
**CI/CD:**
- bump pnpm/action-setup to v6



## [1.0.1] - 2026-08-09
**Features:**
- publishable npm package, usable from any project
- MCP bridge delegating work to Kimi and Codex

**Bug Fixes:**
- use a project-relative path for the bridge server

**Documentation:**
- rewrite the README around installing and using it

**CI/CD:**
- add CI and npm release workflows, switch to pnpm


