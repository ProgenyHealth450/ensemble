---
name: ensemble-configure-team
description: Analyze TRD complexity and auto-configure team roles, agent assignments, and marketplace plugins (Codex skill for /ensemble:configure-team)
user-invocable: true
argument-hint: '[trd-path] [--team] [--no-team]'
model: gpt-5.1-codex
---

# Ensemble Command: /ensemble:configure-team

This Codex skill mirrors the Ensemble slash command `/ensemble:configure-team`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from configure-team.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Analyze a Technical Requirements Document (TRD) for complexity and automatically configure
team mode. Performs agent and skill discovery, marketplace gap analysis, and injects a
## Team Configuration section into the TRD when warranted by project complexity.
Reads the TRD Master Task List to determine team tier (Simple, Medium, Complex) and
selects appropriate agents for each detected technical domain.

## Workflow

### Phase 1: TRD Ingestion

**1. Read TRD Document**
   Read and parse the TRD file from the provided path

   - Read TRD file from path specified in $ARGUMENTS
   - Validate TRD has a Master Task List section
   - Validate tasks use TRD-NNN ID format
   - Extract document frontmatter (Document ID, PRD reference)

**2. Extract Task List**
   Parse the Master Task List into structured task data, accepting BOTH the canonical
(checkbox, co-located description) and actual (nested-description, IDs without
checkboxes) task shapes. The actual shape is the form used in published TRDs such as
TRD-2026-6af02293 and is the more permissive input shape for downstream complexity
analysis. Task shape detection and per-task extraction happen in a single pass.


   - Format detection: scan the Master Task List once to identify which task shapes are present. Accept either of the two patterns: (1) CANONICAL = '- [ ] **TRD-XXX** description (Nh) [annotations]' where the description is the text between the bold ID and the '(Nh)' estimate; (2) ACTUAL = '- **TRD-XXX** (Nh) [annotations]' on the ID line with the task description as a nested bullet block immediately after the ID line, terminating at the next sibling task entry or any non-indented line. Both shapes may coexist in the same Master Task List. Record per-task format_tag (canonical | actual). Skip and emit a one-line WARN for lines matching neither shape.
   - Extract per task: task_id (TRD-NNN or TRD-NNN-TEST), estimated_hours (from '(Nh)', default 2h when absent), description (canonical: text between ID and '(Nh)'; actual: first nested bullet block after the ID line), annotations (any '[...]' segments on the ID line: satisfies / depends / verifies), format_tag (canonical | actual), and dependencies parsed from '[depends: TRD-NNN[, TRD-MMM]]' annotations (support both colon form 'depends:' and bracket form 'depends' for older TRDs).
   - Build structured task registry TASKS: List of {task_id, estimated_hours, description, annotations, format_tag, dependencies}.
   - If TASKS is empty, print error and halt: 'No TRD-NNN tasks found in Master Task List'.

### Phase 2: Complexity Analysis

**1. CLI Flag Parsing**
   Parse $ARGUMENTS for --team and --no-team flags before complexity analysis

   - Parse $ARGUMENTS for presence of --team flag; if found set FORCE_TEAM=true
   - Parse $ARGUMENTS for presence of --no-team flag; if found set FORCE_NO_TEAM=true
   - If both flags present, print ERROR: --team and --no-team are mutually exclusive, and HALT
   - Store flag values in FORCE_TEAM and FORCE_NO_TEAM variables for use within this command

**2. Task Counter and Hour Estimator**
   Count tasks and total estimated hours from the TASKS registry built in Phase 1 Step 2.
The registry is the authoritative source after format-aware extraction — do not re-grep
the TRD here. Both canonical and actual format tasks are already counted and have
estimated_hours populated.


   - Count entries in the TASKS registry (TASK_COUNT). Both canonical and actual format tasks are present; do NOT re-match the '- [ ] **TRD-' regex here — that pattern misses actual-format tasks.
   - Sum the estimated_hours field across all TASKS entries to compute ESTIMATED_HOURS
   - Store {task_count: TASK_COUNT, estimated_hours: ESTIMATED_HOURS} in COMPLEXITY_METRICS

**3. Domain Detection**
   Scan task titles and descriptions against domain_keywords to detect technical domains

   - For each task entry extract title and description text (case-insensitive)
   - Match text against domain_keywords from team_configuration block
   - A task may belong to multiple domains; record all matches
   - Count distinct domains detected (DOMAIN_COUNT)
   - Count cross-cutting tasks (tasks matching 2 or more distinct domains)
   - Parse [depends: TRD-XXX] annotations to build dependency graph; compute longest path (DEPENDENCY_DEPTH)
   - Add domain_count, domains_list, cross_cutting_count, and dependency_depth to COMPLEXITY_METRICS

**4. Team Mode Heuristic**
   Apply three-tier complexity classification to determine team mode

   - If FORCE_NO_TEAM=true, set TEAM_TIER=None and skip remaining phases
   - If FORCE_TEAM=true, set TEAM_TIER=Complex and proceed to agent discovery
   - Complex if ANY: task_count > 25 OR domain_count >= 3 OR estimated_hours > 60
   - Medium if ANY: task_count >= 10 OR domain_count >= 2 OR estimated_hours >= 20 (and no Complex condition)
   - Simple if ALL: task_count < 10 AND domain_count = 1 AND estimated_hours < 20
   - If TEAM_TIER=Simple, print 'Team configuration: skipped (Simple tier -- pass --team to force)' and stop
   - Store TEAM_TIER in COMPLEXITY_METRICS

### Phase 3: Agent and Skill Discovery

**1. Agent Auto-Discovery**
   Build AGENT_REGISTRY from BOTH source packages/*/agents/*.yaml AND the runtime-visible
Task agent registry exposed by installed plugins. The runtime fallback is critical when
this command runs from a consumer repo (e.g. a project that does not vendor the ensemble
monorepo) — without it, only the project's local agents (typically a tiny set like
planner/reviewer/worker) are visible, and the full team roster (tech-lead-orchestrator,
code-reviewer, qa-orchestrator, test-runner, etc.) is incorrectly absent.


   - Step 1a — Source packages scan: Use Glob tool to scan packages/*/agents/*.yaml relative to CWD. For each discovered YAML file use Read tool to extract name and description fields from front matter. Also extract the '## Mission' section body text (first paragraph after heading).
   - Step 1b — Runtime plugin agent fallback (REQUIRED): Use Glob tool to scan BOTH '~/.omp/plugins/node_modules/@*/*/agents/*.md' (scoped npm packages, e.g. @fortium/ensemble-pi/agents/*.md) AND '~/.omp/plugins/node_modules/*/agents/*.md' (unscoped fallback). The two-pattern glob is required because the @*/agents/*.md shorthand misses the package segment; without it only the project's local agents are visible and the full team roster (tech-lead-orchestrator, code-reviewer, qa-orchestrator, test-runner, etc.) is incorrectly absent. SYMLINK FALLBACK (REQUIRED): OMP's Glob does not always traverse plugin directory symlinks (live install at ~/.omp/plugins/node_modules/@fortium/ensemble-pi is a symlink). If Glob returns zero matches OR fewer than 4 plugin agents are discovered, run via Bash: 'find -L ~/.omp/plugins/node_modules -path "*/agents/*.md" -type f' and treat each returned absolute path as an agent file. PATH PARSING: derive <plugin> by stripping the trailing '/agents/<basename>' from the file's absolute path (e.g. '/Users/ldangelo/.omp/plugins/node_modules/@fortium/ensemble-pi/agents/deep-debugger.md' → strip '/agents/deep-debugger.md' → '/Users/ldangelo/.omp/plugins/node_modules/@fortium/ensemble-pi' → <plugin> = '@fortium/ensemble-pi'). Derive <agent_name> from the file basename without the .md extension (e.g. 'deep-debugger'). Do NOT use the file's parent directory (that is 'agents'); use dirname(dirname(file)) to reach the plugin root reliably for both scoped ('@scope/pkg') and unscoped ('pkg') layouts. Merge these into AGENT_REGISTRY before proceeding. For each discovered agent markdown file (whether via Glob or find -L), derive a runtime agent identifier of the form '<plugin>:<agent_name>' by combining the plugin directory name (e.g. ensemble-pi -> 'ensemble-full' when the plugin's marketplace name is ensemble-full, otherwise the raw plugin directory name) with the basename without .md extension. Also include the unqualified basename as an alias. This ensures AGENT_REGISTRY reflects agents the Task tool can actually invoke in the current runtime, not just agents vendored in the consumer repo's source tree.
   - Step 1c — Router-rules overlay: If .claude/router-rules.json exists in CWD, read it and merge any custom agent names defined there into AGENT_REGISTRY (these are user-defined aliases the runtime resolves).
   - Step 1d — Dedupe and freeze: Build AGENT_REGISTRY as Map of agent_name to {description, mission_keywords, source_file, runtime_id, source}. When the same agent_name appears in both source packages and runtime plugins, prefer the runtime entry (it carries the most accurate description and the runtime_id the Task tool consumes). Sort AGENT_REGISTRY keys alphabetically for deterministic downstream behavior.
   - Step 1e — Capability keywords: Extract capability keywords from description and mission text (tokenize, lowercase). Used by Step 3 (Builder Agent Matching) for keyword-overlap ranking.

**2. Skill Auto-Discovery**
   Scan packages/*/skills/ AND the runtime-visible skill directories exposed by installed
OMP plugins at ~/.omp/plugins/node_modules/<pkg>/skills/<skill>/SKILL.md. The runtime
fallback is critical when this command runs from a consumer repo (e.g. a project that
does not vendor the ensemble monorepo) — without it only the project's local skills
(typically empty) are visible, and the full skill catalog (foreman-workflow-pipeline,
foreman-doc-gate, foreman-safe-recovery, etc.) is incorrectly absent.


   - Step 2a — Source packages scan: Use Glob tool to scan packages/*/skills/ relative to CWD.
   - Step 2b — Runtime plugin skill fallback (REQUIRED): Use Glob tool to scan BOTH '~/.omp/plugins/node_modules/@*/*/skills/*/SKILL.md' (scoped npm packages, e.g. @fortium/ensemble-pi/skills/<skill>/SKILL.md) AND '~/.omp/plugins/node_modules/*/skills/*/SKILL.md' (unscoped fallback). The two-pattern glob is required to match the directory-per-skill layout used by OMP plugins. SYMLINK FALLBACK (REQUIRED): OMP's Glob does not always traverse plugin directory symlinks. If Glob returns zero matches OR fewer than 5 plugin SKILL.md files are discovered, run via Bash: 'find -L ~/.omp/plugins/node_modules -path "*/skills/*/SKILL.md" -type f' and treat each returned absolute path as a skill file. PATH PARSING: derive <skill_name> by stripping '/SKILL.md' from the file's basename path (e.g. for '/Users/ldangelo/.omp/plugins/node_modules/@fortium/ensemble-pi/skills/writing-playwright-tests/SKILL.md' → match the regex /\/skills\/([^/]+)\/SKILL\.md$/ → skill_name = 'writing-playwright-tests'). Derive <plugin> by stripping the trailing '/skills/<skill_name>/SKILL.md' from the file's absolute path (e.g. dirname(dirname(dirname(file))) → '/Users/ldangelo/.omp/plugins/node_modules/@fortium/ensemble-pi' → <plugin> = '@fortium/ensemble-pi'). Do NOT confuse the skill directory (parent of SKILL.md) or the 'skills' directory (grandparent) with the plugin root (great-grandparent). The plugin root is three dirname() levels above the SKILL.md file for both scoped ('@scope/pkg') and unscoped ('pkg') layouts. Merge these into SKILL_REGISTRY before proceeding. For each discovered SKILL.md, read its frontmatter to extract name and description; record the plugin directory as the source. Also include the unqualified <skill-name> as an alias so downstream gap analysis can match by short name.
   - Step 2c — Dedupe and freeze: Build SKILL_REGISTRY as Map of skill_name to {description, source_plugin, source_file, runtime_path}. When the same skill_name appears in both source packages and runtime plugins, prefer the runtime entry (it carries the live SKILL.md path). Sort SKILL_REGISTRY keys alphabetically for deterministic downstream behavior.
   - Registry is used by marketplace gap analysis to detect skill gaps

**3. Builder Agent Matching**
   Select the best builder agents for each detected domain

   - Check for .claude/router-rules.json in project root; if present parse ROUTER_OVERRIDES (domain to agent)
   - For each domain in COMPLEXITY_METRICS.domains_list select builder agent by priority
   - Priority 1: Router rules override for this domain (from .claude/router-rules.json)
   - Priority 2: Keyword match -- compare domain keywords against AGENT_REGISTRY descriptions and missions; select agent with highest keyword overlap
   - Priority 3: Default fallback from team_configuration.default_agents mapping
   - Build BUILDER_AGENTS list; deduplicate (one agent covering multiple domains listed once with all owned domains)

**4. Agent Existence Validation**
   Validate all selected team agents exist in the discovered registry

   - For every agent in BUILDER_AGENTS list verify presence in AGENT_REGISTRY
   - Validate lead agent (tech-lead-orchestrator) exists in AGENT_REGISTRY
   - Validate reviewer agent (code-reviewer) exists in AGENT_REGISTRY
   - Validate QA agent -- qa-orchestrator first; fall back to test-runner if missing
   - If any selected agent is absent from registry log warning and substitute with nearest available or default

### Phase 4: Marketplace Gap Analysis

**1. Read Marketplace Catalog**
   Load and parse marketplace.json for available plugins

   - Use Read tool to load marketplace.json from repository root
   - If missing or malformed: log 'marketplace.json not found or invalid -- skipping gap analysis' and skip remaining steps in this phase
   - Parse plugin entries into MARKETPLACE_CATALOG; exclude ensemble-full
   - Set MARKETPLACE_AVAILABLE=true

**2. Installed Plugin Detection**
   Determine which marketplace plugins are already installed locally

   - For each plugin in MARKETPLACE_CATALOG derive local path from source field
   - Use Glob to check packages/<name>/ directory existence
   - Build INSTALLED_PLUGINS set of currently available plugins
   - Note which installed plugins provide agents vs skills

**3. Gap Analysis**
   Identify agent and skill gaps, match to marketplace plugins

   - Identify agent gaps (domain default agent absent from AGENT_REGISTRY)
   - Identify skill gaps (framework keywords present in tasks but corresponding skills/ directory absent)
   - Three-tier matching: high-weight domain-to-tag, medium-weight keyword-to-tag, low-weight keyword-to-description
   - Context-aware filtering: generic 'test' keyword alone must NOT trigger testing framework suggestions; require framework-specific keywords
   - Consolidate multiple gaps pointing to same plugin into single suggestion with combined rationale
   - Sort by relevance (agent gaps before skill gaps, then by task_count_benefiting descending)
   - Build SUGGESTIONS list with plugin_name, description, gap_category, rationale, agents_provided, skills_provided, task_count_benefiting

**4. Suggestion Presentation and Installation**
   Present plugin suggestions to user and install approved plugins

   - Check if AskUserQuestion tool is available; if not set NON_INTERACTIVE=true
   - If NON_INTERACTIVE: log each suggestion as [INFO] and add all to DECLINED_PLUGINS
   - If interactive: for each suggestion present yes/no prompt with plugin name, description, rationale
   - Track APPROVED_PLUGINS and DECLINED_PLUGINS; do not re-prompt declined plugins
   - For each approved plugin: run 'claude plugin install <name>' via Bash; track INSTALLED_DURING_RUN and FAILED_INSTALLS
   - If plugins were installed, refresh AGENT_REGISTRY and SKILL_REGISTRY by re-running Phase 3 Step 1 in full (Steps 1a + 1b + 1c + 1d) AND Phase 3 Step 2 in full (Steps 2a + 2b + 2c): re-glob packages/*/agents/*.yaml, re-glob '~/.omp/plugins/node_modules/@*/*/agents/*.md' AND '~/.omp/plugins/node_modules/*/agents/*.md', re-glob '~/.omp/plugins/node_modules/@*/*/skills/*/SKILL.md' AND '~/.omp/plugins/node_modules/*/skills/*/SKILL.md', re-merge .claude/router-rules.json, and re-dedupe. ALSO re-run the symlink-safe find -L fallbacks ('find -L ~/.omp/plugins/node_modules -path "*/agents/*.md"' and 'find -L ~/.omp/plugins/node_modules -path "*/skills/*/SKILL.md"') so newly installed plugin symlinks are traversed even if OMP Glob refuses to cross them. Newly installed plugins expose runtime agent identifiers and skills that source-only scanning cannot see.
   - Log summary: 'Marketplace analysis: N gaps identified, M plugins suggested, A approved, D declined, F failed'

### Phase 5: Team Configuration Injection

**1. Generate Team Configuration Section**
   Build the Team Configuration YAML block for injection into the TRD

   - Build TEAM_CONFIG_HEADER with blockquote notice and complexity metrics (task count, hours, domain count, domains, cross-cutting count, dependency depth, tier)
   - Build TEAM_CONFIG_YAML conforming to the implement-trd-beads team roles schema
   - Always include lead role: agent: tech-lead-orchestrator, owns: [task-selection, architecture-review, final-approval]
   - Always include builder role: agents from BUILDER_AGENTS list, owns: [implementation]
   - If Complex: include reviewer role (code-reviewer) and qa role (qa-orchestrator or test-runner fallback)
   - If Medium: omit reviewer and qa roles
   - If plugins were installed, build MARKETPLACE_NOTE listing installed plugins with agents/skills provided

**2. Inject into TRD Document**
   Insert the Team Configuration section into the TRD file

   - Compose full section from TEAM_CONFIG_HEADER + MARKETPLACE_NOTE (if any) + TEAM_CONFIG_YAML in yaml code fence
   - Inject section into TRD after Master Task List section and before Quality Requirements or Appendix
   - Save updated TRD file
   - Print summary: 'Team configuration injected -- TEAM_TIER tier, N builder agent(s) -- agent_list'

**3. Summary and Next Steps**
   Print configuration summary and suggest next command

   - Display the complexity metrics (task count, hours, domains, tier)
   - List all assigned agents by role (lead, builders, reviewer, qa)
   - List any marketplace plugins that were installed
   - Print: 'Review the ## Team Configuration section and edit agent assignments if needed'
   - Suggest: '/ensemble:implement-trd-beads docs/TRD/TRD-YYYY-NNN-slug.md'

## Expected Output

**Format:** Technical Requirements Document (TRD) with Team Configuration

**Structure:**
- **Team Configuration Section**: Injected section with complexity metrics, agent assignments by role, and YAML config block
- **Complexity Metrics**: Task count, estimated hours, domain count, domains list, cross-cutting count, dependency depth, tier
- **Agent Assignments**: Lead, builder, reviewer, and QA agent mappings with owned responsibilities
- **Marketplace Notes**: List of plugins installed during gap analysis with agents and skills provided

## Usage

```
/ensemble:configure-team [trd-path] [--team] [--no-team]
```
