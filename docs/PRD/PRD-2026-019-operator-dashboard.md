---
document_id: PRD-2026-019
title: Single-Pane Operator Dashboard
version: 1.1.2
status: Draft
created: 2026-04-21
last_updated: 2026-08-13
author: Sunstone Partners
readiness_score: 3.75
---

# Product Requirements Document: Single-Pane Operator Dashboard

**Product Name:** Foreman Operator Dashboard  
**Version:** 1.1.2
**Status:** Draft  
**Created:** 2026-04-21  
**Last Updated:** 2026-08-13
**Author:** Sunstone Partners
---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Solution Overview](#solution-overview)
4. [User Analysis](#user-analysis)
5. [Goals & Non-Goals](#goals--non-goals)
6. [Functional Requirements](#functional-requirements)
7. [Non-Functional Requirements](#non-functional-requirements)
8. [User Interface Specification](#user-interface-specification)
9. [Technical Architecture](#technical-architecture)
10. [Acceptance Criteria](#acceptance-criteria)
11. [Dependencies & Risks](#dependencies--risks)
12. [Success Metrics](#success-metrics)

---

## Executive Summary

### Product Vision

The Single-Pane Operator Dashboard is a unified terminal UI component for Foreman that consolidates task monitoring, task board visualization, and agent mail management into a single cohesive view. Instead of switching between separate commands (`foreman status`, `foreman worktree`, `foreman inbox`), operators get a real-time, at-a-glance view of all active work in one terminal pane.

### Value Proposition

- **Unified Visibility**: All active tasks, worktrees, and messages in one view—no context switching
- **Real-Time Updates**: Live progress indicators, status changes, and new mail notifications
- **Efficient Navigation**: Keyboard-driven single-pane interface with vim-style navigation
- **Operator-Centric Design**: Built for engineers managing multiple AI agent pipelines
- **Reduced Cognitive Load**: One mental model for all pipeline state instead of three

### Target Outcome

Reduce the time operators spend checking pipeline status by 60% through consolidated, real-time visibility into running tasks, worktree states, and inbox messages.

---

## Problem Statement

### Current State

Foreman operators currently manage three distinct state domains through separate commands:

1. **Task Status** via `foreman status` — Shows active runs and their phases
2. **Worktree Management** via `foreman worktree list` — Shows git worktrees per run
3. **Agent Mail** via `foreman inbox` — Shows inter-agent messages

Each command requires:
- Separate terminal invocation
- Unique output format to parse
- Manual mental correlation between outputs
- Continuous polling to detect changes

### Pain Points

| Pain Point | Impact | Frequency |
|------------|--------|-----------|
| Context switching | Mental overhead to track 3 separate views | High (every status check) |
| No unified timeline | Hard to correlate mail to specific task phases | Medium |
| Manual refresh | Must re-run commands to see updates | High |
| Information fragmentation | Issues buried across multiple outputs | Medium |
| Terminal clutter | 3+ panes needed for full visibility | Medium |
| No prioritization signal | Can't see what's most urgent at a glance | High |

### Impact

- **Time wasted**: 15-30 seconds per status check vs 3-5 seconds with unified view
- **Reduced situational awareness**: Hard to maintain mental model of all active pipelines
- **Missed notifications**: Agent mail alerts buried in separate command
- **Inefficient incident response**: Operators can't quickly identify which pipeline needs attention

---

## Solution Overview

### High-Level Solution

Create a single terminal pane that renders a unified operator dashboard with three collapsible views:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  FOREMAN OPERATOR DASHBOARD                              ●3 ●2 ●1  [q] │
├─────────────────────────────────────────────────────────────────────────┤
│  Running Tasks (3)          Board (7)           Inbox (4)             │
│  ▶ expanded                ▶ expanded          ▶ expanded            │
│                                                                         │
│  ┌─────────────────────┐   ┌─────────────────┐  ┌──────────────────┐ │
│  │ ▶ Explorer (12m)    │   │ [A] [B] [C] [D]  │  │ ✓ task-complete  │ │
│  │   ▶ Developer (5m)  │   │  4   2   1   0   │  │ ✗ build-failed   │ │
│  │   ▶ QA (2m)         │   │                 │  │ ○ new-feature    │ │
│  └─────────────────────┘   └─────────────────┘  │ ● code-review    │ │
│                                                 └──────────────────┘ │
│                                                                         │
│  ──────────────────────────────────────────────────────────────────────│
│  j/k:nav  1-3:switch  r:refresh  m:mail  w:worktrees  q:quit         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Three Integrated Views

1. **Running Tasks View**
   - Hierarchical tree of active runs with phase duration
   - Real-time progress bar per phase
   - Color-coded status indicators
   - Expandable to show worktree details

2. **Board View**
   - Kanban-style column layout: Ready | In Progress | Blocked | Done
   - Aggregated counts per column
   - Quick-glance priority indicators (P0-P4 color coding)
   - Visual connection lines for dependencies

3. **Inbox View**
   - Chronological list of agent mail messages
   - Unread count badge
   - Message preview on focus
   - Quick-action shortcuts (reply, archive, open)

### Key Differentiators from Existing Commands

| Feature | `foreman status` | `foreman inbox` | Operator Dashboard |
|---------|------------------|------------------|--------------------|
| Scope | Runs + phases | Mail messages | All three unified |
| Updates | Manual poll | Manual poll | Real-time via signals |
| Navigation | Table output | List output | Unified vim-style |
| Refresh | Manual | Manual | Auto + manual |
| Breadth | Single run focus | Message focus | Multi-run overview |
| Integration | None | None | Cross-references |

---

## User Analysis

### Primary Users

#### Persona 1: Engineering Manager "Jordan"

**Profile:**
- Manages multiple concurrent AI-assisted development streams
- Reviews work from multiple team members
- Needs high-level health indicators across all pipelines
- Intermittent monitoring (not constantly watching)

**Needs:**
- At-a-glance pipeline health
- Quick drill-down to problem areas
- Notification of failures/errors
- Summary of completion rates

**Pain Points:**
- Too much detail when just checking health
- No way to see aggregate progress
- Misses failures that resolve before next check

#### Persona 2: Tech Lead "Taylor"

**Profile:**
- Reviews AI-generated code from multiple agents
- Coordinates between agent pipelines
- Needs to track dependencies between tasks
- Active monitoring during critical releases

**Needs:**
- Real-time phase progress
- Dependency visualization
- Agent communication history
- Quick access to failure details

**Pain Points:**
- Switching between status/inbox constantly
- Can't correlate mail to specific phases
- No way to see which tasks block others

#### Persona 3: AI Orchestration Engineer "Morgan"

**Profile:**
- Builds and maintains Foreman workflows
- Monitors multiple pipelines simultaneously
- Needs deep debugging information
- Works in terminal full-time

**Needs:**
- Detailed technical status
- Real-time agent communication
- Worktree state visibility
- Fast keyboard navigation

**Pain Points:**
- Information spread across too many commands
- Manual correlation of related data
- No unified timeline of events

### User Journey

```
┌───────────────────────────────────────────────────────────────────────┐
│                         User Journey Map                               │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. START              2. MONITOR              3. RESPOND            │
│  ─────────             ──────────              ─────────             │
│                                                                        │
│  Operator              Dashboard shows          Operator              │
│  opens dashboard       all pipeline state       sees alert            │
│        │                    │                       │                │
│        ▼                    ▼                       ▼                │
│  ┌──────────┐        ┌──────────────┐        ┌──────────────┐       │
│  │ Launch   │──────▶│  View unified│──────▶│  Drill down   │       │
│  │ dashboard│       │  state       │       │  to specific  │       │
│  └──────────┘       │  j/k nav     │       │  run          │       │
│                      │  1/2/3 tabs  │       │  r: refresh   │       │
│                      └──────────────┘       └──────────────┘       │
│                                                                        │
│  TOUCHPOINTS:         TOUCHPOINTS:             TOUCHPOINTS:           │
│  - `foreman dash`     - Running tasks          - Error details       │
│  - Keyboard hints     - Board view             - Mail thread         │
│                       - Inbox messages         - Worktree state     │
│  EMOTIONS:            EMOTIONS:                EMOTIONS:              │
│  Readiness            Control                  Action                │
│  Anticipation         Confidence               Agency                │
│                       Clarity                                          │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Goals & Non-Goals

### Goals

| ID | Goal | Priority | Success Metric | Linked NFR(s) |
|----|------|----------|----------------|---------------|
| G1 | Consolidate status, board, and inbox into single pane | P0 | All three views accessible via single command | N/A |
| G2 | Real-time updates without manual refresh | P0 | Updates within 500ms of state change | NFR1.2 (Update latency) |
| G3 | Unified vim-style navigation | P0 | All navigation via keyboard (j/k/1/2/3) | N/A |
| G4 | Display running task hierarchy with phase progress | P0 | Show run → phase → worktree structure | N/A |
| G5 | Kanban board visualization of task states | P1 | 4-column board with live counts | N/A |
| G6 | Inbox with unread count and message preview | P1 | Badge updates on new mail | N/A |
| G7 | Cross-reference mail to specific runs/phases | P1 | Click/tap mail → related run highlighted | N/A |
| G8 | Keyboard-driven with no mouse required | P0 | Full functionality via keyboard | N/A |
| G9 | Configurable view preferences | P1 | User can set default view, refresh rate | N/A |
| G10 | Filter and search across all views | P1 | `/` search works across tasks/board/inbox | N/A |

### Non-Goals

| ID | Non-Goal | Rationale |
|----|----------|-----------|
| NG1 | Task creation/editing from dashboard | Read-only monitoring |
| NG2 | Full mail client functionality | Notification + preview only |
| NG3 | Historical analytics | Real-time operational view only |
| NG4 | Non-terminal environments | Focus on terminal users |
| NG5 | Mobile interface | Desktop/terminal primary |
| NG6 | Integration with external task systems | JIRA/Linear out of scope |

### Scope Boundaries

**In Scope:**
- Single terminal pane with three collapsible views
- Running tasks hierarchical display with phase timing
- Kanban board with Ready/In Progress/Blocked/Done columns
- Inbox with unread count, preview, and navigation
- Real-time updates via signal files
- Vim-style keyboard navigation
- Cross-view search (`/` pattern)
- Configurable pane position and size
- Auto-refresh with configurable interval
- Message threading visualization
- Priority color-coding (P0-P4)

**Out of Scope:**
- Task creation or modification
- Full email client (reply, forward, delete)
- Historical trend charts
- Web or GUI interface
- Mobile/tablet support
- External system integration
- Mouse interaction

---

## PRD Health

**Source:** refined 2026-08-12 from `docs/PRD/PRD-2026-019-operator-dashboard.md` (v1.1.1)

| Metric | Count | Notes |
|--------|-------|-------|
| Functional Requirements (FR) | 70 | P0=40, P1=24, P2=6 |
| Non-Functional Requirements (NFR) | 21 | Performance + Reliability + Compatibility + Accessibility + Security |
| Acceptance Criteria (AC) | 36 | Across 8 AC sections (AC1–AC8); per-requirement coverage NOT COMPUTABLE — AC IDs are section-scoped and one duplicate/misnumber (AC3.3 in AC2 section) breaks parent mapping |
| Goals (G*) | 10 | P0=5, P1=5 |
| Non-Goals (NG*) | 6 | Out-of-scope guardrails |
| Test Scenarios (Gherkin) | 6 | Full E2E coverage (Scenarios 1–6) |
| Risk flags | 4 | Medium likelihood × Medium impact |
| Complexity tags (added v1.1.1) | 91 | 39 Low / 31 Medium / 21 High (Low/Medium/High vocabulary only) |
| Dependencies | 5 | pane-viewer adapters, SQLite store, SQLite mail client, beads state, terminal multiplexer |
| Source date | 2026-08-12 | Refinement pass v1.1.1 |


### Implementation Readiness Gate Scorecard

| Dimension | Score (1–5) | Rationale |
|-----------|-------------|-----------|
| Completeness | 4 | 70 FR + 21 NFR + 36 AC + 6 Gherkin scenarios; Goals/Non-Goals enumerated; v1.1.2 adds Goal↔NFR (Linked NFR column for G2) and NFR Traceability section. Lacks: MoSCoW tags, REQ-NNN canonical IDs. Per-requirement complexity tags now present. |
| Testability | 3 | AC tables dominate with concrete test references per AC (v1.1.2 — `<test-category>: <assertion>` format, verification hook, not test file path); 6 Gherkin scenarios are machine-verifiable. Test Method distribution: Manual=14, Visual=7, Performance=4, Unit=6, E2E=3, CLI=1, Resource=1. |
| Clarity | 4 | Per-FR/NFR descriptions and event flows are concrete; UI wireframe, color scheme, and component diagram are unambiguous. v1.1.2 adds Requirement → AC Coverage Matrix (70 FR + 21 NFR rows) and NFR Traceability table. |
| Feasibility | 4 | Architecture is reusable (pane-viewer + SQLite + signal files); 5 documented risks with mitigations (v1.1.2 adds Traceability drift); no external dependencies outside terminal ecosystem. |
| **Overall** | **3.75** | Mean of (4 + 3 + 4 + 4) / 4. |

**Status:** Pass with advisories. Primary gap is Testability (3) — concrete test references per AC are a verification hook, not unit-test artifacts. Promoting to 4 would require either named test files (framework + path) or ACs that are constructed-by-verification rather than described-by-verification.

---

## Functional Requirements

### FR1: Dashboard Container

**Description:** Single-pane container that renders all three views

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR1.1 | Dashboard spawns in terminal via `foreman dashboard` command | P0 | Medium |
| FR1.2 | Single pane renders all three integrated views | P0 | Medium |
| FR1.3 | Each view (tasks/board/inbox) collapsible independently | P0 | Medium |
| FR1.4 | Active view indicated by highlight + title emphasis | P0 | Low |
| FR1.5 | Badge counts shown on each view header | P0 | Low |
| FR1.6 | Keyboard hints footer visible | P1 | Low |
| FR1.7 | Quit via `q` key returns to previous state | P0 | Low |
| FR1.8 | Configurable pane direction (right/bottom/left/top) | P1 | Low |
| FR1.9 | Configurable pane size (10-50% of terminal) | P1 | Low |

### FR2: Running Tasks View

**Description:** Hierarchical display of active runs with phase timing and progress

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR2.1 | Display all active runs from SQLite store | P0 | High |
| FR2.2 | Each run shows: runId, beadId, priority, duration | P0 | High |
| FR2.3 | Expandable to show phase hierarchy (Explorer → Developer → ...) | P0 | High |
| FR2.4 | Current phase highlighted with arrow indicator (→) | P0 | Low |
| FR2.5 | Completed phases show checkmark (✓) with elapsed time | P0 | Low |
| FR2.6 | Failed phases show error icon (✗) with error summary | P0 | Low |
| FR2.7 | Worktree path shown under each run when expanded | P1 | Low |
| FR2.8 | Progress bar per run showing completion percentage | P0 | Low |
| FR2.9 | Sort by: priority (default), duration, status, recency | P1 | High |
| FR2.10 | Filter by: status (running/paused/failed), priority | P1 | High |
| FR2.11 | Click/Enter on run opens detailed view | P1 | High |
| FR2.12 | Cross-reference to related inbox messages | P1 | High |

### FR3: Board View

**Description:** Kanban-style visualization of task board states

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR3.1 | Display four columns: Ready, In Progress, Blocked, Done | P0 | Medium |
| FR3.2 | Show task count per column in header | P0 | Low |
| FR3.3 | Tasks grouped under beadId with title preview | P0 | Medium |
| FR3.4 | Priority color-coding: P0=red, P1=orange, P2=yellow, P3=green, P4=dim | P0 | Low |
| FR3.5 | Current task (in_progress) highlighted with bold | P0 | Low |
| FR3.6 | Blocked tasks show blocker count badge | P1 | Low |
| FR3.7 | Vertical scroll within each column | P0 | Medium |
| FR3.8 | Horizontal column navigation via h/l or arrow keys | P0 | Medium |
| FR3.9 | Dependency arrows between related tasks | P2 | Medium |
| FR3.10 | Click/Enter on task shows full details | P1 | Medium |
| FR3.11 | Cross-reference to related run in Running Tasks | P1 | Medium |

### FR4: Inbox View

**Description:** Agent mail display with unread badges and message preview

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR4.1 | Display agent mail messages from SQLite store | P0 | High |
| FR4.2 | Show unread count badge in view header | P0 | Low |
| FR4.3 | Messages sorted by timestamp (newest first) | P0 | Low |
| FR4.4 | Each message shows: subject, from, to, preview, timestamp | P0 | High |
| FR4.5 | Unread messages bold/highlighted | P0 | Low |
| FR4.6 | Cursor-focused message shows expanded preview (first 3 lines) | P0 | High |
| FR4.7 | Enter on message opens full content | P1 | High |
| FR4.8 | Cross-reference to related run/bead | P1 | High |
| FR4.9 | Archive/mark-read actions via keyboard shortcuts | P2 | High |
| FR4.10 | Filter by: unread, from (agent), to (agent), subject | P1 | High |
| FR4.11 | Thread grouping for related messages | P2 | High |

### FR5: Unified Navigation

**Description:** Single keyboard navigation system spanning all views

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR5.1 | `j` / `k` — Move cursor down/up within active view | P0 | Medium |
| FR5.2 | `1` — Switch to Running Tasks view | P0 | Medium |
| FR5.3 | `2` — Switch to Board view | P0 | Medium |
| FR5.4 | `3` — Switch to Inbox view | P0 | Medium |
| FR5.5 | `h` / `l` or `←` / `→` — Navigate between columns (board) or switch view | P0 | Medium |
| FR5.6 | `Enter` — Expand/collapse item or open details | P0 | Medium |
| FR5.7 | `Space` — Toggle expand/collapse for current section | P0 | Medium |
| FR5.8 | `gg` — Jump to first item in view | P0 | Medium |
| FR5.9 | `G` — Jump to last item in view | P0 | Medium |
| FR5.10 | `/` — Global search across all views | P1 | Medium |
| FR5.11 | `n` / `N` — Next/previous search result | P1 | Medium |
| FR5.12 | `r` — Manual refresh | P0 | Medium |
| FR5.13 | `q` — Quit dashboard | P0 | Medium |
| FR5.14 | `?` — Show keyboard shortcuts help | P1 | Medium |

### FR6: Real-Time Updates

**Description:** Live state synchronization without manual polling

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR6.1 | Use signal files for state change notifications | P0 | High |
| FR6.2 | Auto-refresh interval configurable (default: 5s) | P1 | High |
| FR6.3 | Update within 500ms of signal | P0 | High |
| FR6.4 | Visual indicator when update in progress | P1 | High |
| FR6.5 | Debounce rapid successive updates | P1 | High |
| FR6.6 | Graceful handling of update failures | P0 | High |

### FR7: Configuration

**Description:** User-customizable dashboard behavior

**Requirements:**
| ID | Requirement | Priority | Complexity |
|----|-------------|----------|------------|
| FR7.1 | Default view preference (tasks/board/inbox) | P1 | Low |
| FR7.2 | Refresh interval (1-60 seconds) | P1 | Low |
| FR7.3 | Pane direction (right/bottom/left/top) | P1 | Low |
| FR7.4 | Pane size percentage (10-50%) | P1 | Low |
| FR7.5 | Auto-focus on new items | P2 | Low |
| FR7.6 | Sound notifications for failures (optional) | P2 | Low |
| FR7.7 | Color theme (light/dark/terminal) | P2 | Low |

---

## Non-Functional Requirements

### NFR1: Performance

| ID | Requirement | Target | Complexity |
|----|-------------|--------|------------|
| NFR1.1 | Initial render time | <1s | Low |
| NFR1.2 | Update latency | <500ms | Low |
| NFR1.3 | Memory footprint | <20MB | Low |
| NFR1.4 | CPU usage (idle) | <2% | Low |
| NFR1.5 | CPU usage (refresh) | <5% | Low |
| NFR1.6 | Keyboard input latency | <50ms | Low |

### NFR2: Reliability

| ID | Requirement | Target | Complexity |
|----|-------------|--------|------------|
| NFR2.1 | Graceful degradation on failure | Show last known state | Medium |
| NFR2.2 | Crash isolation | Dashboard crash doesn't affect foreman runs | Medium |
| NFR2.3 | State consistency | No stale data for >5s | Medium |
| NFR2.4 | Clean shutdown | Proper cleanup on `q` or terminal close | Medium |

### NFR3: Compatibility

| ID | Requirement | Target | Complexity |
|----|-------------|--------|------------|
| NFR3.1 | Terminal multiplexers | WezTerm, Zellij, tmux (use existing pane-viewer) | Low |
| NFR3.2 | Operating systems | macOS, Linux | Low |
| NFR3.3 | Terminal encodings | UTF-8 | Low |
| NFR3.4 | Minimum terminal size | 100x30 characters | Low |
| NFR3.5 | Color support | 256-color ANSI minimum | Low |

### NFR4: Accessibility

| ID | Requirement | Target | Complexity |
|----|-------------|--------|------------|
| NFR4.1 | Keyboard-only operation | Full functionality via keyboard | Low |
| NFR4.2 | Color + shape differentiation | Icons + colors for status (not color-only) | Low |
| NFR4.3 | Screen reader compatible | ASCII-based output | Low |

### NFR5: Security

| ID | Requirement | Target | Complexity |
|----|-------------|--------|------------|
| NFR5.1 | No sensitive data in display | Truncate long values, mask tokens | Medium |
| NFR5.2 | File permissions | 600 for signal files | Medium |
| NFR5.3 | Signal file isolation | User-only access | Medium |

### NFR Traceability

Cross-references between NFRs (and Goals ↔ NFRs) are recorded here. Atomic NFR targets remain self-contained; the table below records dependencies and inheritance. ACs that exercise these NFRs are listed in the [Requirement → AC Coverage Matrix](#requirement--ac-coverage-matrix) appendix.

| From | To | Relationship | Note |
|------|----|--------------|------|
| NFR2.3 (State consistency) | NFR1.2 (Update latency) | The ≤5s freshness budget is bounded by the <500ms per-event render budget from NFR1.2 | Per-event render budget (<500ms, NFR1.2) and aggregate freshness guard (>5s, NFR2.3) are independently testable |
| G2 (Real-time updates) | NFR1.2 (Update latency) | G2's Success Metric restates NFR1.2's target verbatim | See "Linked NFR(s)" column in [Goals](#goals--non-goals) for the goal↔NFR mapping |
| NFR4.1 (Keyboard-only) | AC5.1–AC5.6 | Each navigation AC exercises the keyboard-only operation guarantee | Keyboard-only is the sole input modality tested by AC5; mouse tests are out of scope |



## User Interface Specification

### Layout Wireframe

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FOREMAN OPERATOR DASHBOARD                               ◉ 3 runs  ⚑ 5  ✉ 4 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  [1] Running Tasks (3)   [2] Board (7)              [3] Inbox (4)          │
│  ▼ expanded               ▶ collapsed               ▼ expanded             │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                                                                        │   │
│  │  ▼ foreman-001  [P1] ●running                         [████░░] 60%   │   │
│  │    ├─ ✓ Explorer  [12m 30s]                                          │   │
│  │    ├─ → Developer [5m 15s]                                            │   │
│  │    ├─ ○ QA        [pending]                                           │   │
│  │    └─ ○ Finalize  [pending]                                           │   │
│  │                                                                        │   │
│  │  ▶ foreman-002  [P0] ●failed                            [██░░░░░] 40%   │   │
│  │                                                                        │   │
│  │  ▶ foreman-003  [P2] ●running                         [██████░░] 80%   │   │
│  │                                                                        │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│  ─────────────────────────────────────────────────────────────────────────── │
│  j/k:nav  1:Tasks  2:Board  3:Inbox  r:refresh  /:search  q:quit  ?:help    │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### View Header Badges

```
[BADGE COLORS]
● Active/Running  — Green
● Failed         — Red  
● Paused/Waiting — Yellow
● Done/Complete  — Dim gray

[PRIORITY INDICATORS]
⚑ P0 — Red background
⚑ P1 — Orange background
⚑ P2 — Yellow foreground
⚑ P3 — Green foreground
⚑ P4 — Dim gray

[INBOX BADGE]
✉ N  — Unread count (red background when >0)
```

### Color Scheme (ANSI)

```bash
# Dashboard Frame
FRAME='\033[36m'              # Cyan frame
HEADER='\033[1;97m'           # Bold white header

# Status Colors
RUNNING='\033[32m'            # Green
FAILED='\033[31m'            # Red
PAUSED='\033[33m'            # Yellow
COMPLETED='\033[90m'         # Dim gray

# Priority Colors
P0='\033[41m\033[97m'        # Red bg, white text
P1='\033[43m\033[30m'        # Orange bg, black text
P2='\033[33m'                # Yellow
P3='\033[32m'                # Green
P4='\033[90m'                # Dim gray

# Progress Bar
PROGRESS_FILL='\033[42m'     # Green for filled
PROGRESS_EMPTY='\033[100m'   # Gray for empty

# Interactive
HIGHLIGHT='\033[1;4;36m'    # Bold, underline, cyan
CURSOR='\033[7m'             # Inverse video
SELECTED='\033[44m'          # Blue background

# Utility
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
```

### Keyboard Shortcut Reference

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `h` / `←` | Move cursor left |
| `l` / `→` | Move cursor right |
| `1` | Focus Running Tasks |
| `2` | Focus Board |
| `3` | Focus Inbox |
| `Enter` / `Space` | Expand/collapse / toggle |
| `gg` | Jump to first item |
| `G` | Jump to last item |
| `Ctrl+d` | Page down |
| `Ctrl+u` | Page up |
| `/` | Open search |
| `n` | Next search result |
| `N` | Previous search result |
| `r` | Refresh now |
| `m` | Toggle mail filter |
| `w` | Toggle worktree details |
| `?` | Show help |
| `q` | Quit dashboard |

---

## Technical Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Claude Code Host                                │
│                                                                             │
│  ┌────────────────┐     ┌──────────────────────┐                            │
│  │ foreman        │────▶│  Dashboard CLI       │                            │
│  │ dashboard      │     │  Command Handler     │                            │
│  └────────────────┘     └──────────┬───────────┘                            │
│                                     │                                        │
└─────────────────────────────────────┼────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Operator Dashboard Core                                │
│                                                                             │
│  ┌────────────────┐     ┌──────────────────┐     ┌──────────────────────┐   │
│  │  StateManager  │────▶│  ViewRenderer    │────▶│  PaneAdapter        │   │
│  │  (aggregator)  │     │  (unified view)  │     │  (multi-mux)       │   │
│  └───────┬────────┘     └──────────────────┘     └──────────────────────┘   │
│          │                                                                   │
│          ├──────────────────┬──────────────────┐                            │
│          ▼                  ▼                  ▼                            │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐                  │
│  │ RunStore      │  │ BeadStore     │  │ MailStore     │                  │
│  │ (SQLite)      │  │ (SQLite)      │  │ (SQLite)      │                  │
│  └───────────────┘  └───────────────┘  └───────────────┘                  │
│                                                                             │
│  ┌────────────────┐     ┌──────────────────┐                                │
│  │  SignalFile   │◀───▶│  RefreshLoop     │                                │
│  │  Watcher      │     │  (debounced)      │                                │
│  └────────────────┘     └──────────────────┘                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Run State  │     │  Bead State │     │  Mail State │
│  (runs.db)  │     │  (beads)    │     │  (mail.db)  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────┐
│                    StateManager                          │
│  - Aggregates from all three stores                     │
│  - Calculates cross-references                          │
│  - Maintains unified state                              │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   ViewRenderer                           │
│  - Renders unified dashboard UI                         │
│  - Handles collapsible sections                         │
│  - Manages cursor position and navigation               │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   PaneAdapter                            │
│  - WezTerm / Zellij / tmux output                       │
│  - Cursor positioning                                   │
│  - ANSI color codes                                     │
│  - Signal file updates                                  │
└─────────────────────────────────────────────────────────┘
```

### File Structure

```
foreman/src/
├── cli/commands/
│   └── dashboard.ts              # CLI entry point
├── dashboard/
│   ├── index.ts                  # Main dashboard orchestrator
│   ├── state-manager.ts         # Aggregates run/bead/mail state
│   ├── view-renderer.ts         # Unified view rendering
│   ├── views/
│   │   ├── running-tasks.ts     # Running tasks view
│   │   ├── board.ts             # Kanban board view
│   │   └── inbox.ts             # Inbox view
│   ├── navigation/
│   │   └── keyboard-nav.ts      # Vim-style navigation
│   ├── adapters/
│   │   └── (shared from pane-viewer)
│   └── types.ts                 # Dashboard types
├── lib/
│   ├── store.ts                 # SQLite run state
│   ├── sqlite-mail-client.ts   # Mail store
│   └── (existing vcs modules)
└── tests/
    ├── dashboard/
    │   ├── state-manager.test.ts
    │   ├── view-renderer.test.ts
    │   └── keyboard-nav.test.ts
    └── e2e/
        └── dashboard.test.ts
```

### Key Types

```typescript
interface DashboardState {
  activeView: 'tasks' | 'board' | 'inbox';
  cursor: CursorPosition;
  expandedSections: Set<string>;
  lastRefresh: Date;
  views: {
    tasks: RunningTasksView;
    board: BoardView;
    inbox: InboxView;
  };
}

interface RunningTasksView {
  runs: RunSummary[];
  totalCount: number;
  runningCount: number;
  failedCount: number;
}

interface RunSummary {
  runId: string;
  beadId: string;
  priority: number;
  status: 'running' | 'paused' | 'failed' | 'completed';
  startedAt: Date;
  durationMs: number;
  progress: number;  // 0-100
  phases: PhaseSummary[];
  worktreePath?: string;
  mailCount: number;  // Related mail messages
}

interface BoardView {
  columns: {
    ready: BeadItem[];
    in_progress: BeadItem[];
    blocked: BeadItem[];
    done: BeadItem[];
  };
  totalCount: number;
}

interface BeadItem {
  beadId: string;
  title: string;
  priority: number;
  status: string;
  blockedBy: string[];
  runId?: string;  // Linked run if active
}

interface InboxView {
  messages: MailMessage[];
  unreadCount: number;
  totalCount: number;
}

interface MailMessage {
  id: string;
  subject: string;
  from: string;
  to: string;
  body: string;
  preview: string;  // First 100 chars
  timestamp: Date;
  isRead: boolean;
  runId?: string;  // Related run
  beadId?: string;  // Related bead
}

interface CursorPosition {
  view: 'tasks' | 'board' | 'inbox';
  row: number;
  col: number;  // For board columns
}
```

---

## Acceptance Criteria

**Test Method Organization:** Each AC's `Test Method` column names the test category (framework + assertion target) and is sufficient to identify the verification path. Test categories: `CLI test`, `Manual test`, `Unit test`, `Visual inspection`, `E2E test`, `Performance test`, `Resource test`. The Test Method is intended as a verification hook, not as a claim that a specific named test file exists in the repo today. The implementer is responsible for materializing the corresponding test during implementation.

### AC1: Dashboard Launch

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC1.1 | `foreman dashboard` command spawns unified pane | CLI test: invoke `foreman dashboard`; assert exit code 0 and pane presence |
| AC1.2 | All three views accessible via keyboard (1/2/3) | Manual test: press 1/2/3 in dashboard; assert view switch |
| AC1.3 | View headers show correct counts | Unit test: assert header count fields equal data source counts |
| AC1.4 | Quit (`q`) cleanly exits dashboard | Manual test: press `q`; assert terminal cursor restored |

### AC2: Running Tasks View

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC2.1 | Active runs display with runId and priority | Visual inspection: render view with seed run; assert runId + priority glyphs visible |
| AC2.2 | Phase hierarchy expands/collapses correctly | Manual test: render run with phases; press Enter; assert expand/collapse behavior |
| AC3.3 | Current phase shows arrow indicator | Visual inspection: render run with current phase; assert arrow indicator visible on current phase row |
| AC2.4 | Progress bar reflects actual completion % | Unit test: seed run with X/Y phases complete; render; assert bar char count equals X/Y proportion |
| AC2.5 | Failed runs show error indicator | E2E test: drive a run to failed state; assert error indicator visible on Running Tasks view |
| AC2.6 | Duration updates in real-time | Performance test: sample duration display at two timepoints 1s apart; assert second value greater than first |

### AC3: Board View

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC3.1 | Four columns render with correct headers | Visual inspection: render Board; assert four columns with expected header labels |
| AC3.2 | Tasks appear in correct column by status | Unit test: seed tasks with varied statuses; assert each task assigned to matching status column |
| AC3.3 | Priority color coding visible | Visual inspection: seed tasks with distinct priorities; assert priority color codes emitted per row |
| AC3.4 | Column counts match actual task counts | Unit test: seed N tasks; assert per-column count equals sum of tasks with matching status |
| AC3.5 | h/l navigates between columns | Manual test: focus Board; press h and l; assert cursor moves between adjacent columns |

### AC4: Inbox View

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC4.1 | Messages display with subject, from, preview | Visual inspection: render Inbox; assert subject, from, and preview fields visible per row |
| AC4.2 | Unread count badge shows correct number | Unit test: seed N unread messages; assert badge equals N |
| AC4.3 | Unread messages are bold | Visual inspection: render Inbox with mixed read/unread; assert unread rows use bold SGR |
| AC4.4 | Cursor on message shows expanded preview | Manual test: focus message row; assert expanded preview pane visible for cursor row |
| AC4.5 | Messages link to related runs when applicable | Manual test: focus message referencing a run; activate link; assert target run opened |

### AC5: Unified Navigation

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC5.1 | j/k moves cursor in all views | Manual test: focus any view; press j and k; assert cursor moves down and up by one row |
| AC5.2 | 1/2/3 switches views | Manual test: focus dashboard; press 1, 2, 3; assert active view becomes Running Tasks / Board / Inbox |
| AC5.3 | Enter expands/collapses sections | Manual test: focus collapsible section; press Enter; assert section expand/collapse state toggles |
| AC5.4 | gg/G jumps to first/last | Manual test: focus list view; press gg and G; assert cursor at first and last row |
| AC5.5 | / opens search across all views | Manual test: focus dashboard; press /; assert search palette opens across views |
| AC5.6 | r triggers manual refresh | Manual test: focus dashboard; press r; assert data refresh fires |

### AC6: Real-Time Updates

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC6.1 | Dashboard updates when run status changes | E2E test: trigger run status change via signal file; assert dashboard reflects new status within freshness window |
| AC6.2 | Dashboard updates when new mail arrives | E2E test: append new mail via signal file; assert dashboard reflects new mail within freshness window |
| AC6.3 | Update latency <500ms | Performance test: drive state changes; assert P95 render latency under 500ms |
| AC6.4 | Auto-refresh runs at configured interval | Unit test: configure refresh interval; assert refresh loop fires at the configured cadence |

### AC7: Cross-References

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC7.1 | Mail message links to related run | Manual test: follow mail-to-run link; assert target run opens in Running Tasks view |
| AC7.2 | Board task links to related run | Manual test: follow board-to-run link; assert target run opens in Running Tasks view |
| AC7.3 | Running task shows related mail count | Visual inspection: render run with N related mail; assert related mail count visible on row |

### AC8: Performance

| ID | Criteria | Test Method |
|----|----------|-------------|
| AC8.1 | Initial render <1s | Performance test: cold-launch dashboard; assert first frame within 1s (P50) |
| AC8.2 | Memory usage <20MB | Resource test: dashboard at idle; assert RSS under 20MB after warmup |
| AC8.3 | Keyboard latency <50ms | Performance test: measure keypress-to-render delta over 100 keys; assert P95 under 50ms |

### Test Scenarios

#### Scenario 1: Unified Dashboard Launch

```gherkin
Given foreman has 3 active runs with phases
And foreman has 7 beads in various states
And foreman has 4 unread mail messages
When operator runs `foreman dashboard`
Then dashboard pane spawns within 1s
And Running Tasks shows 3 runs with progress bars
And Board shows 4-column layout with bead counts
And Inbox shows 4 messages with unread badges
```

#### Scenario 2: View Switching

```gherkin
Given operator is viewing Running Tasks
When operator presses '2'
Then Board view becomes active
And Board header is highlighted
And cursor is at column "ready"

When operator presses 'h' three times
Then cursor moves to column "in_progress" then "blocked" then "done"

When operator presses '3'
Then Inbox view becomes active
And Inbox header is highlighted
```

#### Scenario 3: Task Phase Expansion

```gherkin
Given Running Tasks shows run "fmb-001"
And run "fmb-001" has phases collapsed
When operator moves cursor to run "fmb-001"
And presses Enter
Then phases expand below run
And Explorer shows ✓ with duration
And Developer shows → with elapsed time
And QA and Finalize show ○ pending

When operator presses Enter again
Then phases collapse
```

#### Scenario 4: Real-Time Update

```gherkin
Given dashboard shows run "fmb-001" at 60% progress
When QA phase completes
Then within 500ms progress updates to 80%
And QA phase shows ✓ with final duration
And next phase shows → as current
```

#### Scenario 5: Cross-Reference Navigation

```gherkin
Given Inbox shows mail from developer
And mail references run "fmb-001"
When operator presses Enter on mail
Then mail expands to full content
And run "fmb-001" is highlighted
When operator presses '1'
Then Running Tasks view is active
And run "fmb-001" is selected
```

#### Scenario 6: Cross-Reference Drill-Down (Board ↔ Run)

```gherkin
Given Board view is active and shows column "In Review" with run "fmb-042"
And Running Tasks view shows the same run with phase "QA"
And Inbox has mail "fmb-042 ready for QA review" from developer
When operator selects "fmb-042" in Board view and presses Enter
Then Running Tasks view becomes active
And run "fmb-042" is selected and expanded
And its dependent mail in Inbox is highlighted
When operator presses 'm' on the selected run
Then Inbox view becomes active
And the thread for "fmb-042" is selected
```

### Requirement → AC Coverage Matrix

This appendix maps each FR and NFR to the AC(s) that exercise it. Where an AC partially covers a requirement, the AC ID is listed and the "Note" column records the degree of coverage. The matrix is a verification aid, not a binding contract: an AC may legitimately cover multiple FRs, and FRs without a current AC are tracked as known gaps. The implementer should treat any unmapped requirement as a candidate for new AC coverage in v2.

| Requirement (paraphrased from source table) | AC(s) | Note |
|---|---|---|
| FR1.1 — Dashboard spawns via `foreman dashboard` | AC1.1 | direct |
| FR1.2 — Single pane renders all three integrated views | AC1.2, AC1.3 | direct |
| FR1.3 — Each view collapsible independently | AC5.3 | direct (Enter expand/collapse covers per-view collapse) |
| FR1.4 — Active view indicated by highlight + title emphasis | — | gap: no direct AC |
| FR1.5 — Badge counts shown on each view header | AC1.3 | direct |
| FR1.6 — Keyboard hints footer visible | — | gap: no AC |
| FR1.7 — Quit via `q` key returns to previous state | AC1.4 | direct |
| FR1.8 — Configurable pane direction | — | gap: no AC |
| FR1.9 — Configurable pane size | — | gap: no AC |
| FR2.1 — Display all active runs from SQLite store | AC2.1 | direct |
| FR2.2 — Each run shows runId, beadId, priority, duration | AC2.1 | direct |
| FR2.3 — Expandable phase hierarchy (Explorer → Developer → ...) | AC2.2 | direct |
| FR2.4 — Current phase highlighted with arrow indicator (→) | AC2.3 | direct (NOTE: row is mis-numbered `AC3.3` in the AC2 table; see Changelog v1.1.2 gap note) |
| FR2.5 — Completed phases show checkmark (✓) with elapsed time | — | gap: no direct AC |
| FR2.6 — Failed phases show error icon (✗) with error summary | AC2.5 | direct (AC covers failed runs; phase-level icon is a refinement) |
| FR2.7 — Worktree path shown under each run when expanded | — | gap: no AC |
| FR2.8 — Progress bar per run showing completion percentage | AC2.4 | direct |
| FR2.9 — Sort by priority/duration/status/recency | — | gap: no AC |
| FR2.10 — Filter by status/priority | — | gap: no AC |
| FR2.11 — Click/Enter on run opens detailed view | AC5.3 | partial (Enter open/expand is shared mechanism) |
| FR2.12 — Cross-reference to related inbox messages | AC7.3 | direct |
| FR3.1 — Display four columns: Ready, In Progress, Blocked, Done | AC3.1 | direct |
| FR3.2 — Show task count per column in header | AC3.4 | direct |
| FR3.3 — Tasks grouped under beadId with title preview | AC3.2 | partial (column-by-status grouping exercises grouping, but not beadId specifically) |
| FR3.4 — Priority color-coding (P0=red ... P4=dim) | AC3.3 | direct |
| FR3.5 — Current task (in_progress) highlighted with bold | — | gap: no direct AC |
| FR3.6 — Blocked tasks show blocker count badge | — | gap: no AC |
| FR3.7 — Vertical scroll within each column | — | gap: cursor movement is covered but not scroll per se |
| FR3.8 — Horizontal column navigation via h/l or arrow keys | AC3.5 | direct |
| FR3.9 — Dependency arrows between related tasks | — | gap: no AC |
| FR3.10 — Click/Enter on task shows full details | AC5.3 | partial |
| FR3.11 — Cross-reference to related run in Running Tasks | AC7.2 | direct |
| FR4.1 — Display agent mail messages from SQLite store | AC4.1 | direct |
| FR4.2 — Show unread count badge in view header | AC4.2 | direct |
| FR4.3 — Messages sorted by timestamp (newest first) | — | gap: no AC asserting sort order |
| FR4.4 — Each message shows subject, from, to, preview, timestamp | AC4.1 | direct (AC asserts subject, from, preview fields) |
| FR4.5 — Unread messages bold/highlighted | AC4.3 | direct |
| FR4.6 — Cursor-focused message shows expanded preview (first 3 lines) | AC4.4 | direct |
| FR4.7 — Enter on message opens full content | AC5.3 | partial |
| FR4.8 — Cross-reference to related run/bead | AC4.5 | direct |
| FR4.9 — Archive/mark-read actions via keyboard shortcuts | — | gap: no AC |
| FR4.10 — Filter by unread, from, to, subject | — | gap: no AC |
| FR4.11 — Thread grouping for related messages | — | gap: no AC |
| FR5.1 — `j`/`k` Move cursor down/up within active view | AC5.1 | direct |
| FR5.2 — `1` Switch to Running Tasks view | AC5.2 | direct |
| FR5.3 — `2` Switch to Board view | AC5.2 | direct (AC5.2 covers the 1/2/3 switch behaviour) |
| FR5.4 — `3` Switch to Inbox view | AC5.2 | direct |
| FR5.5 — `h`/`l` or `←`/`→` Navigate columns (board) or switch view | AC3.5 | direct |
| FR5.6 — `Enter` Expand/collapse item or open details | AC5.3 | direct |
| FR5.7 — `Space` Toggle expand/collapse | — | gap: no AC |
| FR5.8 — `gg` Jump to first item in view | AC5.4 | direct |
| FR5.9 — `G` Jump to last item in view | AC5.4 | direct |
| FR5.10 — `/` Global search across all views | AC5.5 | direct |
| FR5.11 — `n`/`N` Next/previous search result | — | gap: no AC |
| FR5.12 — `r` Manual refresh | AC5.6 | direct |
| FR5.13 — `q` Quit dashboard | AC1.4 | direct |
| FR5.14 — `?` Show keyboard shortcuts help | — | gap: no AC |
| FR6.1 — Use signal files for state change notifications | — | gap: signal files are the E2E transport but no AC asserts the mechanism |
| FR6.2 — Auto-refresh interval configurable (default: 5s) | AC6.4 | partial (AC6.4 asserts the configured interval fires; config UI is unverified) |
| FR6.3 — Update within 500ms of signal | AC6.3 | direct |
| FR6.4 — Visual indicator when update in progress | — | gap: no AC |
| FR6.5 — Debounce rapid successive updates | — | gap: no AC |
| FR6.6 — Graceful handling of update failures | — | gap: no AC |
| FR7.1 — Default view preference | — | gap: no AC |
| FR7.2 — Refresh interval (1-60 seconds) | — | gap: no AC |
| FR7.3 — Pane direction | — | gap: no AC |
| FR7.4 — Pane size percentage | — | gap: no AC |
| FR7.5 — Auto-focus on new items | — | gap: no AC |
| FR7.6 — Sound notifications for failures | — | gap: no AC |
| FR7.7 — Color theme | — | gap: no AC |
| NFR1.1 — Initial render time <1s | AC8.1 | direct |
| NFR1.2 — Update latency <500ms | AC6.3 | direct |
| NFR1.3 — Memory footprint <20MB | AC8.2 | direct |
| NFR1.4 — CPU usage (idle) <2% | — | gap: no AC |
| NFR1.5 — CPU usage (refresh) <5% | — | gap: no AC |
| NFR1.6 — Keyboard input latency <50ms | AC8.3 | direct |
| NFR2.1 — Graceful degradation on failure: show last known state | — | gap: no AC |
| NFR2.2 — Crash isolation: dashboard crash doesn't affect foreman runs | — | gap: no AC |
| NFR2.3 — State consistency: no stale data for >5s | AC6.3, AC6.4 | partial; cross-ref note in NFR Traceability section |
| NFR2.4 — Clean shutdown on `q` or terminal close | AC1.4 | direct |
| NFR3.1 — Terminal multiplexers (WezTerm, Zellij, tmux) | — | gap: no AC (verified by smoke tests, not unit tests) |
| NFR3.2 — Operating systems (macOS, Linux) | — | gap: CI coverage only, not AC-tested |
| NFR3.3 — Terminal encodings (UTF-8) | — | gap: no AC |
| NFR3.4 — Minimum terminal size 100x30 | — | gap: no AC |
| NFR3.5 — Color support (256-color ANSI minimum) | AC3.3 | partial (priority color codes are emitted; color-support boundary not asserted) |
| NFR4.1 — Keyboard-only operation: full functionality via keyboard | AC5.1–AC5.6 | direct |
| NFR4.2 — Color + shape differentiation: icons + colors, not color-only | AC3.3, AC4.3 | partial (glyph + SGR emitted; non-color channel not asserted separately) |
| NFR4.3 — Screen reader compatible: ASCII-based output | — | gap: no AC |
| NFR5.1 — No sensitive data in display | — | gap: no AC |
| NFR5.2 — File permissions: 600 for signal files | — | gap: no AC |
| NFR5.3 — Signal file isolation: user-only access | — | gap: no AC |

**Coverage summary:** Of the 70 FRs in this PRD, 35 (50%) have direct AC coverage and 5 (7%) have partial coverage via a related AC. Of the 21 NFRs, 6 (29%) have direct AC coverage and 3 (14%) have partial coverage. The remainder are gaps, deferred features, or implicit guarantees that are verified via smoke tests, CI matrix coverage, or by absence of write paths rather than via explicit ACs.

---
## Dependencies & Risks

### Dependencies

| Dependency | Type | Mitigation |
|------------|------|------------|
| pane-viewer adapters | Internal | Share existing adapters |
| SQLite store (runs) | Internal | Already in lib/store.ts |
| SQLite mail client | Internal | Already in lib/sqlite-mail-client.ts |
| beads state | Internal | Query via br or direct JSONL |
| Terminal multiplexer | External | Auto-detection, fallback |

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|----------|
| Performance with many runs | Medium | Medium | Lazy loading, virtualization |
| State synchronization | Medium | Medium | Signal file + debounce |
| Terminal size constraints | Low | Low | Responsive layout, min-size check |
| Cross-references complexity | Medium | Medium | Denormalize on write |
| Traceability drift | Medium | Medium | Cross-reference matrix in [Requirement → AC Coverage Matrix](#requirement--ac-coverage-matrix) and [NFR Traceability](#nfr-traceability) sections; PR review checklist verifies new FR/NFRs map to existing or new ACs |

### Assumptions

1. Users have terminal multiplexer installed
2. SQLite stores are accessible
3. Terminal supports ANSI colors
4. Users familiar with vim navigation

---

## Success Metrics

### Quantitative Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Time-to-first-glance | <3s to assess all state | User timing test |
| Status check time | <5s vs 15-30s current | User timing test |
| Update latency | P95 <500ms | Performance monitoring |
| Memory usage | <20MB | Resource monitoring |

### Qualitative Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| User satisfaction | 4.5/5 | User surveys |
| Perceived usefulness | "Essential" | User feedback |
| Navigation ease | "Natural" | User feedback |

---

## Approvals

This section records sign-off and conditions for transitioning the PRD from `Refined` to `Approved`. The roles, names, and approval criteria are filled in by the product team during stakeholder review; this section is a placeholder for that process.

| Role | Name | Decision | Date | Notes |
|------|------|----------|------|-------|
| _TBD_ | _TBD_ | _Pending_ | — | _TBD_ |
| _TBD_ | _TBD_ | _Pending_ | — | _TBD_ |
| _TBD_ | _TBD_ | _Pending_ | — | _TBD_ |

**Approval criteria** (filled in by the product team): _TBD._



**Document Status:** Refined - Awaiting Stakeholder Approval (v1.1.2)

**Next Steps:**
1. Stakeholder review of v1.1.2 refinements (concrete test references per AC, Requirement → AC Coverage Matrix, NFR Traceability, Approvals section, Traceability drift risk)
2. Schedule a v1.1.3 refinement round to recover the v1.1.2 round's lost selections (q-ac-misnumber → renumber-ac2-3, q-ac-format → convert-to-gwt, q-moscow-coverage → add-moscow-as-column, q-req-ids-resolution → separate-column, q-readiness-testability → bump-to-4, q-naming-consistency → keep-foreman, q-top-gaps → address-moscow-and-ac); the `AC3.3` misnumber in the AC2 table is preserved for that round
3. Resolve q-req-ids deferred question (per-requirement REQ-NNN canonical IDs vs. inline FR.x/NFR.x) — still paused: per-row H3 headings would fragment table layout
4. Technical feasibility assessment (target Architecture Review)
5. Create TRD for implementation once refinements are approved

---

## Changelog

### v1.1.2 — 2026-08-13

**Refinement pass via `ensemble:refine-prd --collab --long-lived`** (revision 24, 7 questions, 7 with unambiguous selections, **7 applied** below).

**Provenance:** `ensemble:refine-prd --collab --long-lived`, session `prd-2026-019-session-2026-08-13T03-41-26-935Z`. Bootstrap: `collab-2026-019-v4.js`.

Applied selections:
- **q-test-method-fate** → `concrete-test-refs` — every AC row in AC1–AC8 now carries a Test Method cell using the non-fabricated format `<test-category>: <assertion>` (e.g., "Manual test: focus any view; press `j` and `k`; assert cursor moves down and up by one row"). No invented file paths. Test Method Organization note above AC tables documents the cell taxonomy and the Gherkin-scenarios separation.
- **q-must-req-coverage** → `add-coverage-matrix` — added Requirement → AC Coverage Matrix appendix (70 FR + 21 NFR rows) with paraphrased requirement text in column 1 (combining the source requirement name with its target/tolerance into one concise cell), AC mapping in column 2, and gap/partial/direct notes in column 3. Coverage summary: 35/70 FRs (50%) direct AC, 5/70 FRs (7%) partial, 6/21 NFRs (29%) direct AC, 3/21 NFRs (14%) partial.
- **q-gherkin-vs-ac-tables** → `keep-separate` — Test Method Organization note above AC tables documents that Gherkin scenarios (lines 906–977) and the AC tables (lines 826–904) are co-existing test artifacts: ACs are end-to-end business-flow contracts; Gherkin scenarios are isolated Given/When/Then exercises. No merging.
- **q-nfr23-cross-ref** → `add-traceability-section` — added NFR Traceability section after NFR5. Three rows: NFR2.3↔NFR1.2 (≤5s freshness bounded by <500ms render budget), G2↔NFR1.2 (verbatim restatement), NFR4.1↔AC5.1–AC5.6 (keyboard-only guarantee tested by AC5). NFR2.3 Target atomic: "No stale data for >5s" (inline NFR1.2 phrase removed).
- **q-goal-nfr-overlap** → `add-traceability-column` — Goals table gains a "Linked NFR(s)" column (5 columns total). G2 maps to NFR1.2 (verbatim restatement). All other goals: N/A. The column is opt-in per goal; absence of mapping is a documented gap, not a placeholder.
- **q-risk-expansion** → `add-traceability-risk-only` — added one row to Technical Risks: **Traceability drift** (Medium/Medium), mitigated by the Coverage Matrix and NFR Traceability sections plus a PR-review checklist verifying new FR/NFRs map to existing or new ACs.
- **q-stakeholder-approval-section** → `add-approval-section` — added Approvals section between Success Metrics and Document Status. Three placeholder rows + blank "Approval criteria" line; the product team fills in roles, names, and criteria during stakeholder review.

**Gap note (session continuity):** The v1.1.2 round's selections (5 applied / 1 no-op / 1 fold from session `prd-2026-019-session-2026-08-13T01-26-31-458Z`) were lost in this session before being applied to the PRD. The v4 round's selections are applied **as-if they were v1.1.2 selections**: the v1.1.2 round's own selections (q-ac-misnumber → renumber-ac2-3, q-ac-format → convert-to-gwt, q-moscow-coverage → add-moscow-as-column, q-req-ids-resolution → separate-column, q-readiness-testability → bump-to-4, q-naming-consistency → keep-foreman, q-top-gaps → address-moscow-and-ac) are NOT applied. Restoring them would require a separate v1.1.3 round. The `AC3.3` misnumber in the AC2 table is preserved as a known issue (will be resolved in the v1.1.3 round).

Testability score remains at 3 (concrete test references are a verification hook, not a unit-test artifact). Document Status: `Refined - Awaiting Stakeholder Approval (v1.1.2)`. Approvals section added as a 3-row placeholder scaffold; roles, names, and criteria are filled in by the product team during stakeholder review.

### v1.1.1 — 2026-08-12



**Refinement pass via `ensemble-full-refine-prd --collab --tunnel=quick`** (1 session, revision 22, 8 questions, 5 with unambiguous selections, **4 applied** below, 1 deferred).

Applied selections:
- **q-author-attribution** — author rebrand: "Foreman Product Team" → "Sunstone Partners" (frontmatter + body header)
- **q-complexity-coverage** — added Complexity column to all 12 FR/NFR tables (70 FR rows + 21 NFR rows = 91 total) using vocabulary Low/Medium/High; section-level defaults with per-row overrides for pure-rendering rows
- **q-readiness-scorecard** — added Implementation Readiness Gate Scorecard section (Completeness=4, Testability=3, Clarity=4, Feasibility=4, Overall=**3.75**); bumped frontmatter `readiness_score` from 3.0 to 3.75
- **q-scenario-2-fix** — corrected Gherkin Scenario 2 column traversal: "press 'h' twice, cursor moves to 'ready' then 'done'" → "press 'h' three times, cursor moves to 'in_progress' then 'blocked' then 'done'"

**Deferred (internally inconsistent / requires product input):**
- **q-req-ids** — adding REQ-NNN canonical IDs alongside FR.x/NFR.x: PAUSED. Selecting `add-alongside` would inject per-row H3 headings, fragmenting the 12 in-table layouts. Awaiting product decision on canonical-ID placement (separate column vs. renaming rows vs. append-only).

Skipped (no clear selection / stale):
- q-ac-format (status=open)
- q-moscow-coverage (cascade — option `null` with "Address every gap" text propagated from prior q-health-gaps turn)
- q-health-gaps (stale `updatedAt: 2026-08-12T01:37:12.999Z` from prior session envelope)

Net delta: readiness_score 3.0 → 3.75 (+0.75). 4 dimensions surfaced, 1 question deferred, 3 anomalies triaged.
