# Vite+ Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the JavaScript build, test, lint, format, and type-check entry points under Vite+ without changing Microlith runtime behavior.

**Architecture:** Add one root Vite+ configuration for Oxfmt, Oxlint, Vitest, TypeScript checks, and the Obsidian CommonJS library build. Keep Wrangler and Secretlint as external tools because Vite+ does not replace either responsibility.

**Tech Stack:** Vite+ 0.3, Vite 8, Vitest 4, Oxlint, Oxfmt, TypeScript, Secretlint, Wrangler

**Spec:** Conversation decision to adopt Vite+ incrementally while preserving the existing `tsc` check until parity is proven.

## Global Constraints

- Preserve the existing Wrangler development and deployment flow.
- Preserve standalone and live-server integration test entry points.
- Keep Secretlint in the full check.
- Keep changes minimal and use existing repository naming and scripts.

---

### Task 1: Consolidate configuration and commands

**Files:**

- Create: `vite.config.mts`
- Modify: `package.json`
- Delete: `.oxfmtrc.json`
- Delete: `packages/blade/rolldown.config.mjs`

**Interfaces:**

- Consumes: existing TypeScript projects, Vitest test files, and `packages/blade/src/main.ts`
- Produces: `vp check`, `vp test`, and `vp build` command paths

- [x] **Step 1: Establish the current baseline**

Run: `npm run check && npm run build:blade`

Expected: both commands exit successfully before migration.

- [x] **Step 2: Add the minimum Vite+ configuration**

Configure `lint`, `fmt`, `test`, and a CommonJS library build whose entry is `packages/blade/src/main.ts`, output is `packages/blade/main.js`, and externals are `obsidian` and `electron`.

- [x] **Step 3: Route scripts through Vite+**

Use `vp check`, `vp test`, and `vp build`. Keep `wrangler`, `secretlint`, and the explicit integration-test scripts.

- [x] **Step 4: Verify the migrated commands**

Run: `npm run check && npm run build:blade`

Expected: formatting, lint, both TypeScript projects, registry tests, and the Blade build exit successfully.

### Task 2: Minimize dependencies and verify installation

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: the Vite+ configuration from Task 1
- Produces: a reproducible npm installation with no direct Rolldown, Vitest, Oxlint, or Oxfmt dependency

- [x] **Step 1: Replace direct tool dependencies with `vite-plus`**

Install `vite-plus@0.3.0`; remove direct `rolldown`, `vitest`, `oxlint`, and `oxfmt` declarations. Retain `typescript` until Vite+ and `tsc` agree on both projects.

- [x] **Step 2: Verify a clean dependency graph**

Run: `npm install --package-lock-only --ignore-scripts && npm ls vite-plus vite vitest rolldown oxlint oxfmt`

Expected: npm exits successfully and the removed tools are only present transitively through Vite+ where required.

- [x] **Step 3: Run the complete local gate**

Run: `npm run check && npm run build:blade && node --check packages/blade/main.js && git diff --check`

Expected: every command exits successfully with no warnings or whitespace errors.
