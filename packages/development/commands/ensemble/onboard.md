---
name: "ensemble:onboard"
description: "Onboard onto an existing (brownfield) codebase - architecture overview, exact build/test/lint commands, hotspots, optional debt backlog"
version: "1.0.0"
category: "analysis"
last-updated: "2026-10-20"
argument-hint: "[path]"
model: "opus"
---
<!-- DO NOT EDIT - Generated from onboard.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Build a verified mental model of an unfamiliar codebase and leave a durable, reviewable record of it.

## Workflow

### Phase 1: Survey

**1. Map the Repository**
   Gather facts with parallel read-only exploration (Explore-style subagents per top-level module, LSP for symbols and references, file reads for configuration)

- Read manifests and tool config (package.json, Makefile, justfile, pyproject.toml, go.mod, mix.exs, *.csproj, Cargo.toml, CI workflow files, Dockerfile, docker-compose, IaC) to find the EXACT commands to build, test, lint, format and run. Copy them verbatim, including per-package variants in monorepos
- Identify entry points (mains, servers, CLIs, workers, handlers) and the module/package map with one line of responsibility each
- Identify data stores (databases, caches, queues, migrations directories) and external integrations (HTTP clients, SDKs, env var names for credentials - names only, never values)
- Identify deployment shape from CI/CD, container, and infrastructure files

**2. Find Hotspots**
   Combine git churn with file size to rank the riskiest files

- Run: git log --since=6.months --name-only --pretty=format: | sort | uniq -c | sort -rn | head -20 (drop blank lines, lockfiles, generated and vendored paths)
- For each remaining file get its line count (wc -l) and, where cheap, a complexity signal (function count or deepest nesting via LSP symbols)
- Rank by churn x line count; list the top 10 with churn, lines and one-line reason it is risky

### Phase 2: Record

**1. Write the Architecture Overview**
   Write docs/architecture/overview.md (create docs/architecture/ if missing) with these sections

- Sections: Purpose, Entry Points, Module Map, Data Stores, External Integrations, Build/Test/Lint/Run (exact commands), Deployment Shape, Hotspots, Unknowns and Open Questions
- Keep it factual and under about 300 lines; link to files with relative paths rather than quoting code

**2. Propose Agent Instructions**
   Print a ready-to-paste build/test/lint/run commands block for the project's CLAUDE.md or AGENTS.md

- Show the block and the target file; if the file already contains equivalent commands, show only the differences
- Ask the user whether to append it. Write to CLAUDE.md/AGENTS.md ONLY after an explicit yes; never overwrite existing content

### Phase 3: Follow-ups

**1. Offer Debt Backlog**
   Offer to seed a debt backlog as beads

- Propose up to 10 debt items drawn from hotspots and unknowns, each with title, the files involved, and why it matters
- Create nothing until the user approves; then for each approved item run: br create "<title>" --description "<files and rationale>" --labels debt (check br create --help for the exact flag spelling first). Print created IDs

**2. Offer Next Commands**
   Print the next steps

- Offer /ensemble:discover-standards to extract coding conventions into standards/index.yml and /ensemble:inject-standards to apply them to a task
- List every file written, and every proposal the user declined or has not yet answered

## Expected Output

**Format:** docs/architecture/overview.md plus proposals (CLAUDE.md/AGENTS.md commands block, debt beads) awaiting user approval

**Structure:**
- **docs/architecture/overview.md**: Entry points, module map, data stores, external integrations, exact build/test/lint/run commands, deployment shape, hotspots, unknowns

## Usage

```
/ensemble:onboard [path]
```
