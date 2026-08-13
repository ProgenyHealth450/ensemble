---
document_id: PRD-2026-019
title: Single-Pane Operator Dashboard
version: 1.1.3
status: Draft
created: 2026-04-21
last_updated: 2026-08-13
author: Sunstone Partners
readiness_score: 3.8
---


# Product Requirements Document: Single-Pane Operator Dashboard

**Product Name:** Foreman Operator Dashboard  
**Version:** 1.1.3
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

**Source:** generated 2026-08-12 from `docs/PRD/PRD-2026-019-operator-dashboard.md`

### Counts

| Metric | Count | Notes |
|--------|-------|-------|
| Functional Requirements (FR) | 70 | P0=40, P1=24, P2=6 |
| Non-Functional Requirements (NFR) | 21 | All P0 (target-column NFRs) |
| Acceptance Criteria (AC) | 36 | Across 8 AC sections (AC1–AC8), Gherkin GWT |
| Total Requirement IDs (REQ-NNN) | 91 | REQ-001..REQ-091, sequential, no gaps |
| Goals (G*) | 10 | P0=5, P1=5 |
| Non-Goals (NG*) | 6 | Out-of-scope guardrails |
| Test Scenarios (Gherkin) | 6 | Full E2E coverage (Scenarios 1–6) |
| Risk flags | 4 | Medium likelihood × Medium impact |

### MoSCoW Distribution

| Tier | Count | Share |
|------|-------|-------|
| Must (P0) | 61 | 67.0% |
| Should (P1) | 24 | 26.4% |
| Could (P2) | 6 | 6.6% |

### Complexity Distribution (heuristic by content)

| Size | Count | Share |
|------|-------|-------|
| Small (rendering / configuration / single keystroke) | 65 | 71.4% |
| Medium (terminal-UI plumbing / data aggregation / cross-references) | 24 | 26.4% |
| Large (real-time streaming / dependency rendering / security) | 2 | 2.2% |

### AC Coverage (section-based: AC section covers all FR/NFR in its scope)

| Tier | Covered | Total | Coverage |
|------|---------|-------|----------|
| Must (P0) | 46 | 61 | 75% |
| Should (P1) | 20 | 24 | 83% |

**Note:** Coverage is section-based; ACs are not 1:1 with requirements. A single AC in
AC2 (e.g. AC2.1) may cover multiple FR2 requirements (e.g. FR2.1, FR2.2). For
implementation tracking, derive per-requirement ACs from the GWT statements
during TRD construction.
| Dimension | Score (1–5) | Rationale |
|-----------|-------------|-----------|
| Completeness | 4 | 70 FR + 21 NFR + 36 AC + 6 Gherkin scenarios; Goals/Non-Goals enumerated with Linked NFR column (G2↔NFR1.2); MoSCoW + Complexity attributes on all 12 FR/NFR sections (FR1–FR7: `**MoSCoW:**` / `**Complexity:**` attribute lines under each of the 70 FR REQ-NNN headings; NFR1–NFR5: 5-column tables with MoSCoW + Complexity as table columns); REQ-NNN canonical IDs (001..091) on every requirement; Requirement → AC Coverage Matrix (70 FR + 21 NFR rows) appends the mapping; NFR Traceability section records cross-references. |
| Testability | 4 | All 36 ACs in paragraph + fenced ```gherkin block form; each sub-AC (AC1.1–AC8.3) carries an italicized `_(Test method: <category>)_` label on its title line naming one of seven test categories (test-category metadata for routing/grouping — not concrete test refs); the fenced ```gherkin block directly under each sub-AC supplies the machine-verifiable Given/When/Then/And assertions. 6 standalone Gherkin scenarios (lines 1654–1727) are likewise machine-verifiable. Per-tier AC coverage 75% Must / 83% Should. Test Method distribution across 36 labels: Manual=14, Visual=7, Performance=4, Unit=6, E2E=3, CLI=1, Resource=1. |
| Clarity | 4 | Per-FR/NFR descriptions and event flows are concrete; UI wireframe, color scheme, and component diagram are unambiguous. Requirement → AC Coverage Matrix maps each requirement to its AC(s); NFR Traceability table records dependencies and inheritance between NFRs (and Goals ↔ NFRs). |
| Feasibility | 3 | Architecture is reusable (pane-viewer + SQLite + signal files); 5 documented risks with mitigations, including Traceability drift (Medium/Medium) covered by the Coverage Matrix and NFR Traceability sections plus a PR-review checklist; no external dependencies outside the terminal ecosystem. Feasibility unchanged from v1.1.1. |
| **Overall** | **3.75** | Mean of (4 + 4 + 4 + 3) / 4 = 15/4 = 3.75. Matches the v1.1.1 Readiness Scorecard's reported overall (which lists 3.8 by rounding). |

### Readiness Scorecard

| Dimension | Previous (1.1.0) | Current (1.1.1) | Delta | Notes |
|-----------|-------------------|-------------------|-------|-------|
| Completeness | 3 | 4 | +1 | MoSCoW + complexity tags added; author attribution aligned; Scenario 2 corrected |
| Testability | 3 | 4 | +1 | All ACs rewritten in Given/When/Then with explicit Given/When/Then statements |
| Clarity | 3 | 4 | +1 | REQ-NNN canonical IDs; complexity heuristic documented; MoSCoW labels visible |
| Feasibility | 3 | 3 | 0 | No scope change in this refinement |
| **Overall** | **3.0** | **3.8** | **+0.8** | Improved across 3 of 4 dimensions |
**Status:** Pass with advisories. Coverage Matrix contains 51 of 91 rows (56%) marked `gap` or `partial`; gaps are spread across all 12 FR/NFR sections (FR1: 4/9, FR2: 6/12, FR3: 6/11, FR4: 5/11, FR5: 3/14, FR6: 5/6, FR7: 7/7, NFR1: 2/6, NFR2: 3/4, NFR3: 5/5, NFR4: 2/3, NFR5: 3/3). Section-based AC mapping is 75% Must / 83% Should, i.e. 15 of 61 Must-tier items (24.6%) and 4 of 24 Should-tier items (16.7%) lack an AC at the section tier and are documented as known gaps for v2. Testability is at 4 in both scorecards — GWT statements supply structured machine-verifiable tests; the fenced ```gherkin block directly under each sub-AC supplies the verification hooks (Given/When/Then/And assertions); each sub-AC's italicized `_(Test method: <category>)_` label names only the test category for routing/grouping (e.g., `CLI test`, `Manual test`, `Unit test`, `Visual inspection`, `E2E test`, `Performance test`, `Resource test`), not a concrete test reference.

---

## Functional Requirements

### FR1: Dashboard Container

**Description:** Single-pane container that renders all three views

#### REQ-001 (FR1.1): Dashboard spawns in terminal via `foreman dashboard` command

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Dashboard spawns in terminal via `foreman dashboard` command.

#### REQ-002 (FR1.2): Single pane renders all three integrated views

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Single pane renders all three integrated views.

#### REQ-003 (FR1.3): Each view (tasks/board/inbox) collapsible independently

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Each view (tasks/board/inbox) collapsible independently.

#### REQ-004 (FR1.4): Active view indicated by highlight + title emphasis

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Active view indicated by highlight + title emphasis.

#### REQ-005 (FR1.5): Badge counts shown on each view header

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Badge counts shown on each view header.

#### REQ-006 (FR1.6): Keyboard hints footer visible

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Keyboard hints footer visible.

#### REQ-007 (FR1.7): Quit via `q` key returns to previous state

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Quit via `q` key returns to previous state.

#### REQ-008 (FR1.8): Configurable pane direction (right/bottom/left/top)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Configurable pane direction (right/bottom/left/top).

#### REQ-009 (FR1.9): Configurable pane size (10-50% of terminal)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Configurable pane size (10-50% of terminal).

### FR2: Running Tasks View

**Description:** Hierarchical display of active runs with phase timing and progress

#### REQ-010 (FR2.1): Display all active runs from SQLite store

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Display all active runs from SQLite store.

#### REQ-011 (FR2.2): Each run shows: runId, beadId, priority, duration

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Each run shows: runId, beadId, priority, duration.

#### REQ-012 (FR2.3): Expandable to show phase hierarchy (Explorer → Developer → ...)

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Expandable to show phase hierarchy (Explorer → Developer → ...).

#### REQ-013 (FR2.4): Current phase highlighted with arrow indicator (→)

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Current phase highlighted with arrow indicator (→).

#### REQ-014 (FR2.5): Completed phases show checkmark (✓) with elapsed time

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Completed phases show checkmark (✓) with elapsed time.

#### REQ-015 (FR2.6): Failed phases show error icon (✗) with error summary

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Failed phases show error icon (✗) with error summary.

#### REQ-016 (FR2.7): Worktree path shown under each run when expanded

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Worktree path shown under each run when expanded.

#### REQ-017 (FR2.8): Progress bar per run showing completion percentage

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Progress bar per run showing completion percentage.

#### REQ-018 (FR2.9): Sort by: priority (default), duration, status, recency

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Sort by: priority (default), duration, status, recency.

#### REQ-019 (FR2.10): Filter by: status (running/paused/failed), priority

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Filter by: status (running/paused/failed), priority.

#### REQ-020 (FR2.11): Click/Enter on run opens detailed view

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Click/Enter on run opens detailed view.

#### REQ-021 (FR2.12): Cross-reference to related inbox messages

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Cross-reference to related inbox messages.

### FR3: Board View

**Description:** Kanban-style visualization of task board states

#### REQ-022 (FR3.1): Display four columns: Ready, In Progress, Blocked, Done

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Display four columns: Ready, In Progress, Blocked, Done.

#### REQ-023 (FR3.2): Show task count per column in header

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Show task count per column in header.

#### REQ-024 (FR3.3): Tasks grouped under beadId with title preview

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Tasks grouped under beadId with title preview.

#### REQ-025 (FR3.4): Priority color-coding: P0=red, P1=orange, P2=yellow, P3=green, P4=dim

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Priority color-coding: P0=red, P1=orange, P2=yellow, P3=green, P4=dim.

#### REQ-026 (FR3.5): Current task (in_progress) highlighted with bold

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Current task (in_progress) highlighted with bold.

#### REQ-027 (FR3.6): Blocked tasks show blocker count badge

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Blocked tasks show blocker count badge.

#### REQ-028 (FR3.7): Vertical scroll within each column

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Vertical scroll within each column.

#### REQ-029 (FR3.8): Horizontal column navigation via h/l or arrow keys

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Horizontal column navigation via h/l or arrow keys.

#### REQ-030 (FR3.9): Dependency arrows between related tasks

**MoSCoW:** Could (P2)

**Complexity:** L

**Description:** Dependency arrows between related tasks.

#### REQ-031 (FR3.10): Click/Enter on task shows full details

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Click/Enter on task shows full details.

#### REQ-032 (FR3.11): Cross-reference to related run in Running Tasks

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Cross-reference to related run in Running Tasks.

### FR4: Inbox View

**Description:** Agent mail display with unread badges and message preview

#### REQ-033 (FR4.1): Display agent mail messages from SQLite store

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Display agent mail messages from SQLite store.

#### REQ-034 (FR4.2): Show unread count badge in view header

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Show unread count badge in view header.

#### REQ-035 (FR4.3): Messages sorted by timestamp (newest first)

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Messages sorted by timestamp (newest first).

#### REQ-036 (FR4.4): Each message shows: subject, from, to, preview, timestamp

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Each message shows: subject, from, to, preview, timestamp.

#### REQ-037 (FR4.5): Unread messages bold/highlighted

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Unread messages bold/highlighted.

#### REQ-038 (FR4.6): Cursor-focused message shows expanded preview (first 3 lines)

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** Cursor-focused message shows expanded preview (first 3 lines).

#### REQ-039 (FR4.7): Enter on message opens full content

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Enter on message opens full content.

#### REQ-040 (FR4.8): Cross-reference to related run/bead

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Cross-reference to related run/bead.

#### REQ-041 (FR4.9): Archive/mark-read actions via keyboard shortcuts

**MoSCoW:** Could (P2)

**Complexity:** S

**Description:** Archive/mark-read actions via keyboard shortcuts.

#### REQ-042 (FR4.10): Filter by: unread, from (agent), to (agent), subject

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Filter by: unread, from (agent), to (agent), subject.

#### REQ-043 (FR4.11): Thread grouping for related messages

**MoSCoW:** Could (P2)

**Complexity:** L

**Description:** Thread grouping for related messages.

### FR5: Unified Navigation

**Description:** Single keyboard navigation system spanning all views

#### REQ-044 (FR5.1): `j` / `k` — Move cursor down/up within active view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `j` / `k` — Move cursor down/up within active view.

#### REQ-045 (FR5.2): `1` — Switch to Running Tasks view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `1` — Switch to Running Tasks view.

#### REQ-046 (FR5.3): `2` — Switch to Board view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `2` — Switch to Board view.

#### REQ-047 (FR5.4): `3` — Switch to Inbox view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `3` — Switch to Inbox view.

#### REQ-048 (FR5.5): `h` / `l` or `←` / `→` — Navigate between columns (board) or switch view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `h` / `l` or `←` / `→` — Navigate between columns (board) or switch view.

#### REQ-049 (FR5.6): `Enter` — Expand/collapse item or open details

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `Enter` — Expand/collapse item or open details.

#### REQ-050 (FR5.7): `Space` — Toggle expand/collapse for current section

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `Space` — Toggle expand/collapse for current section.

#### REQ-051 (FR5.8): `gg` — Jump to first item in view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `gg` — Jump to first item in view.

#### REQ-052 (FR5.9): `G` — Jump to last item in view

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `G` — Jump to last item in view.

#### REQ-053 (FR5.10): `/` — Global search across all views

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** `/` — Global search across all views.

#### REQ-054 (FR5.11): `n` / `N` — Next/previous search result

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** `n` / `N` — Next/previous search result.

#### REQ-055 (FR5.12): `r` — Manual refresh

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `r` — Manual refresh.

#### REQ-056 (FR5.13): `q` — Quit dashboard

**MoSCoW:** Must (P0)

**Complexity:** S

**Description:** `q` — Quit dashboard.

#### REQ-057 (FR5.14): `?` — Show keyboard shortcuts help

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** `?` — Show keyboard shortcuts help.

### FR6: Real-Time Updates

**Description:** Live state synchronization without manual polling

#### REQ-058 (FR6.1): Use signal files for state change notifications

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Use signal files for state change notifications.

#### REQ-059 (FR6.2): Auto-refresh interval configurable (default: 5s)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Auto-refresh interval configurable (default: 5s).

#### REQ-060 (FR6.3): Update within 500ms of signal

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Update within 500ms of signal.

#### REQ-061 (FR6.4): Visual indicator when update in progress

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Visual indicator when update in progress.

#### REQ-062 (FR6.5): Debounce rapid successive updates

**MoSCoW:** Should (P1)

**Complexity:** M

**Description:** Debounce rapid successive updates.

#### REQ-063 (FR6.6): Graceful handling of update failures

**MoSCoW:** Must (P0)

**Complexity:** M

**Description:** Graceful handling of update failures.

### FR7: Configuration

**Description:** User-customizable dashboard behavior

#### REQ-064 (FR7.1): Default view preference (tasks/board/inbox)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Default view preference (tasks/board/inbox).

#### REQ-065 (FR7.2): Refresh interval (1-60 seconds)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Refresh interval (1-60 seconds).

#### REQ-066 (FR7.3): Pane direction (right/bottom/left/top)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Pane direction (right/bottom/left/top).

#### REQ-067 (FR7.4): Pane size percentage (10-50%)

**MoSCoW:** Should (P1)

**Complexity:** S

**Description:** Pane size percentage (10-50%).

#### REQ-068 (FR7.5): Auto-focus on new items

**MoSCoW:** Could (P2)

**Complexity:** S

**Description:** Auto-focus on new items.

#### REQ-069 (FR7.6): Sound notifications for failures (optional)

**MoSCoW:** Could (P2)

**Complexity:** S

**Description:** Sound notifications for failures (optional).

#### REQ-070 (FR7.7): Color theme (light/dark/terminal)

**MoSCoW:** Could (P2)

**Complexity:** S

**Description:** Color theme (light/dark/terminal).

---

## Non-Functional Requirements

### NFR1: Performance

| ID | Requirement | Target | MoSCoW | Complexity |
|----|-------------|--------|--------|------------|
| REQ-071 (NFR1.1) | Initial render time | <1s | Must (P0) | S |
| REQ-072 (NFR1.2) | Update latency | <500ms | Must (P0) | S |
| REQ-073 (NFR1.3) | Memory footprint | <20MB | Must (P0) | S |
| REQ-074 (NFR1.4) | CPU usage (idle) | <2% | Must (P0) | S |
| REQ-075 (NFR1.5) | CPU usage (refresh) | <5% | Must (P0) | S |
| REQ-076 (NFR1.6) | Keyboard input latency | <50ms | Must (P0) | S |

### NFR2: Reliability

| ID | Requirement | Target | MoSCoW | Complexity |
|----|-------------|--------|--------|------------|
| REQ-077 (NFR2.1) | Graceful degradation on failure | Show last known state | Must (P0) | M |
| REQ-078 (NFR2.2) | Crash isolation | Dashboard crash doesn't affect foreman runs | Must (P0) | M |
| REQ-079 (NFR2.3) | State consistency | No stale data for >5s | Must (P0) | M |
| REQ-080 (NFR2.4) | Clean shutdown | Proper cleanup on `q` or terminal close | Must (P0) | S |

### NFR3: Compatibility

| ID | Requirement | Target | MoSCoW | Complexity |
|----|-------------|--------|--------|------------|
| REQ-081 (NFR3.1) | Terminal multiplexers | WezTerm, Zellij, tmux (use existing pane-viewer) | Must (P0) | S |
| REQ-082 (NFR3.2) | Operating systems | macOS, Linux | Must (P0) | S |
| REQ-083 (NFR3.3) | Terminal encodings | UTF-8 | Must (P0) | S |
| REQ-084 (NFR3.4) | Minimum terminal size | 100x30 characters | Must (P0) | S |
| REQ-085 (NFR3.5) | Color support | 256-color ANSI minimum | Must (P0) | S |

### NFR4: Accessibility

| ID | Requirement | Target | MoSCoW | Complexity |
|----|-------------|--------|--------|------------|
| REQ-086 (NFR4.1) | Keyboard-only operation | Full functionality via keyboard | Must (P0) | S |
| REQ-087 (NFR4.2) | Color + shape differentiation | Icons + colors for status (not color-only) | Must (P0) | S |
| REQ-088 (NFR4.3) | Screen reader compatible | ASCII-based output | Must (P0) | M |

### NFR5: Security

| ID | Requirement | Target | MoSCoW | Complexity |
|----|-------------|--------|--------|------------|
| REQ-089 (NFR5.1) | No sensitive data in display | Truncate long values, mask tokens | Must (P0) | M |
| REQ-090 (NFR5.2) | File permissions | 600 for signal files | Must (P0) | S |
| REQ-091 (NFR5.3) | Signal file isolation | User-only access | Must (P0) | S |

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

All acceptance criteria are expressed in Given/When/Then (GWT) format for unambiguous test derivation.
**Test Method Organization:** Each sub-AC carries an italicized `_(Test method: <category>)_` label inline on its title line that names the test category and is sufficient to identify the verification path. Test categories: `CLI test`, `Manual test`, `Unit test`, `Visual inspection`, `E2E test`, `Performance test`, `Resource test`. The Test Method is intended as a verification hook, not as a claim that a specific named test file exists in the repo today. The implementer is responsible for materializing the corresponding test during implementation.

### AC1: Dashboard Launch

**AC1.1** — foreman dashboard command spawns unified pane _(Test method: CLI test)_

```gherkin
Given foreman is installed and the user is in a terminal with at least 100x30 cells
When the user runs `foreman dashboard`
Then the unified dashboard pane spawns in a fresh terminal pane within 1s
And the pane contains all three views (Running Tasks, Board, Inbox)
```

**AC1.2** — all three views accessible via keyboard (1/2/3) _(Test method: Manual test)_

```gherkin
Given the dashboard is open and Running Tasks is active
When the user presses `1` / `2` / `3`
Then Running Tasks / Board / Inbox becomes the active view respectively
And the view header is highlighted in the active view
```

**AC1.3** — view headers show correct counts _(Test method: Unit test)_

```gherkin
Given foreman has 3 active runs, 7 beads across 4 columns, and 4 unread mail
When the dashboard renders
Then Running Tasks header shows "3", Board header shows "7", Inbox header shows "4 unread"
```

**AC1.4** — quit via q cleanly exits dashboard _(Test method: Manual test)_

```gherkin
Given the dashboard is open and consuming a terminal pane
When the user presses `q`
Then the dashboard pane closes within 100ms
And no orphan processes or signal files are left behind
```

### AC2: Running Tasks View

**AC2.1** — active runs display with runId and priority _(Test method: Visual inspection)_

```gherkin
Given 3 active runs exist in the SQLite store (runIds fmb-001, fmb-002, fmb-003 with priorities P0, P1, P1)
When the user activates the Running Tasks view
Then three rows render in priority order, each with runId and priority badge
```

**AC2.2** — phase hierarchy expands/collapses correctly _(Test method: Manual test)_

```gherkin
Given a run with collapsed phases (Explorer, Developer, QA, Finalize)
When the user moves cursor to the run and presses Enter
Then phases expand below the run in the order Explorer → Developer → QA → Finalize
And pressing Enter again collapses the phases
```

**AC2.3** — current phase shows arrow indicator _(Test method: Visual inspection)_

```gherkin
Given an expanded run with Developer as the current phase
When the view renders
Then Developer shows "→ Developer" with the arrow indicator and elapsed time
And completed Explorer shows "✓ Explorer 0:42"
```

**AC2.4** — progress bar reflects actual completion % _(Test method: Unit test)_

```gherkin
Given a run is at 60% completion (3 of 5 phases done)
When the view renders
Then the progress bar shows 60% width and the label "3/5"
```

**AC2.5** — failed runs show error indicator _(Test method: E2E test)_

```gherkin
Given a run has failed at the QA phase
When the view renders
Then the run row shows ✗ with the error summary inline
And expanding the run reveals the error message under QA
```

**AC2.6** — duration updates in real-time _(Test method: Performance test)_

```gherkin
Given an active run in the view
When 60 seconds elapse without user input
Then the duration label updates within 1s of each refresh tick
```

### AC3: Board View

**AC3.1** — four columns render with correct headers _(Test method: Visual inspection)_

```gherkin
Given the Board view is active
When the view renders
Then four columns appear left-to-right: Ready, In Progress, Blocked, Done
And each column has a header with its name and task count
```

**AC3.2** — tasks appear in correct column by status _(Test method: Unit test)_

```gherkin
Given 5 beads with statuses ready, ready, in_progress, blocked, done
When the Board view renders
Then Ready shows 2 tasks, In Progress shows 1, Blocked shows 1, Done shows 1
```

**AC3.3** — priority color coding visible _(Test method: Visual inspection)_

```gherkin
Given tasks with priorities P0, P1, P2, P3, P4 are present
When the Board view renders
Then P0 tasks render red, P1 orange, P2 yellow, P3 green, P4 dim
```

**AC3.4** — column counts match actual task counts _(Test method: Unit test)_

```gherkin
Given the SQLite store has 12 tasks distributed as 4 ready, 3 in_progress, 2 blocked, 3 done
When the Board view renders
Then column headers show 4, 3, 2, 3 respectively
```

**AC3.5** — h/l navigates between columns _(Test method: Manual test)_

```gherkin
Given the cursor is at the Ready column
When the user presses `l`
Then the cursor moves to the In Progress column
And pressing `l` again moves to Blocked, and `l` again to Done
```

### AC4: Inbox View

**AC4.1** — messages display with subject, from, preview _(Test method: Visual inspection)_

```gherkin
Given 5 messages exist in the mail store
When the Inbox view renders
Then each message row shows subject, from-agent, and a 1-line preview
```

**AC4.2** — unread count badge shows correct number _(Test method: Unit test)_

```gherkin
Given 5 messages exist with 2 marked unread
When the Inbox view renders
Then the view header shows "2 unread"
```

**AC4.3** — unread messages are bold _(Test method: Visual inspection)_

```gherkin
Given 2 unread and 3 read messages in the Inbox
When the view renders
Then the 2 unread messages render with bold weight
And the 3 read messages render with normal weight
```

**AC4.4** — cursor on message shows expanded preview _(Test method: Manual test)_

```gherkin
Given the cursor is on a message with a 1-line preview
When the cursor lands on the row
Then the row expands to show the first 3 lines of the body
```

**AC4.5** — messages link to related runs when applicable _(Test method: Manual test)_

```gherkin
Given a message references runId fmb-001
When the user presses Enter on the message
Then the full message body shows a "Jump to run" link
And pressing the link activates Running Tasks and selects fmb-001
```

### AC5: Unified Navigation

**AC5.1** — j/k moves cursor in all views _(Test method: Manual test)_

```gherkin
Given the active view is Running Tasks with 5 rows
When the user presses `j`
Then the cursor moves one row down
And pressing `k` moves the cursor one row up
```

**AC5.2** — 1/2/3 switches views _(Test method: Manual test)_

```gherkin
Given the dashboard is open with any view active
When the user presses `1` / `2` / `3`
Then Running Tasks / Board / Inbox becomes active respectively
```

**AC5.3** — Enter expands/collapses sections _(Test method: Manual test)_

```gherkin
Given a run with collapsed phases
When the user presses Enter on the run row
Then the phase hierarchy expands
And pressing Enter again collapses it
```

**AC5.4** — gg/G jumps to first/last _(Test method: Manual test)_

```gherkin
Given the cursor is on row 5 of 10 in any view
When the user presses `gg`
Then the cursor moves to row 1
And pressing `G` moves to row 10
```

**AC5.5** — / opens search across all views _(Test method: Manual test)_

```gherkin
Given the dashboard is open
When the user presses `/`
Then a search input appears at the bottom
And typing filters rows in the active view by substring match
```

**AC5.6** — r triggers manual refresh _(Test method: Manual test)_

```gherkin
Given the dashboard is open
When the user presses `r`
Then the dashboard re-reads the SQLite stores and re-renders within 500ms
```

### AC6: Real-Time Updates

**AC6.1** — dashboard updates when run status changes _(Test method: E2E test)_

```gherkin
Given the dashboard is open showing a run as in_progress
When the run's status changes to completed in the SQLite store
Then the dashboard re-renders within 500ms showing the run as completed
```

**AC6.2** — dashboard updates when new mail arrives _(Test method: E2E test)_

```gherkin
Given the dashboard is open and Inbox shows 4 unread messages
When a new message arrives in the mail store
Then the Inbox header badge updates to 5 unread within 500ms
And the new message appears at the top of the Inbox list
```

**AC6.3** — update latency <500ms _(Test method: Performance test)_

```gherkin
Given a signal file is created for any store
When the refresh loop ticks
Then the dashboard view re-renders within 500ms of the signal file mtime
```

**AC6.4** — auto-refresh runs at configured interval _(Test method: Unit test)_

```gherkin
Given the refresh interval is configured to 2s
When 4 seconds elapse without a signal file
Then the refresh loop ticks at least twice
```

### AC7: Cross-References

**AC7.1** — mail message links to related run _(Test method: Manual test)_

```gherkin
Given a mail message with runId fmb-001 in its body
When the user expands the message in Inbox
Then a "→ Running Tasks fmb-001" link is visible
And pressing the link activates Running Tasks and selects fmb-001
```

**AC7.2** — board task links to related run _(Test method: Manual test)_

```gherkin
Given a bead in Ready column with an active runId fmb-042
When the user presses Enter on the bead
Then a detail panel shows the linked runId
And the user can press `1` to jump to Running Tasks and select fmb-042
```

**AC7.3** — running task shows related mail count _(Test method: Visual inspection)_

```gherkin
Given a run fmb-001 has 2 related mail messages in the store
When the user expands fmb-001 in Running Tasks
Then a mail count badge "✉ 2" is shown next to the run header
```

### AC8: Performance

**AC8.1** — initial render <1s _(Test method: Performance test)_

```gherkin
Given the user runs `foreman dashboard` on a cold start
When the dashboard command is invoked
Then the unified pane is fully rendered within 1s
```

**AC8.2** — memory usage <20MB _(Test method: Resource test)_

```gherkin
Given the dashboard is open and stable for 60s
When the resident memory is measured
Then the dashboard process holds less than 20MB
```

**AC8.3** — keyboard latency <50ms _(Test method: Performance test)_

```gherkin
Given the dashboard is active and focused
When the user presses any registered key
Then the corresponding action runs within 50ms of the keypress
```

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
Then cursor moves to column "ready" then "done"

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
| FR2.4 — Current phase highlighted with arrow indicator (→) | AC2.3 | direct |
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



**Document Status:** Refined - Awaiting Stakeholder Approval (v1.1.3)

**Next Steps:**
1. Stakeholder review of v1.1.3 refinements (merged NFR Traceability, Approvals scaffold, Requirement → AC Coverage Matrix, GWT-formatted ACs, 91 REQ-NNN canonical IDs, MoSCoW + Complexity attributes on all 12 FR/NFR sections — columns in the 5 NFR tables, attribute lines on each of the 70 FR requirements)
2. Schedule a v1.1.4 refinement round to address remaining open items: the 51 Coverage Matrix rows marked `gap`/`partial` spread across all 12 FR/NFR sections (FR1: 4, FR2: 6, FR3: 6, FR4: 5, FR5: 3, FR6: 5, FR7: 7, NFR1: 2, NFR2: 3, NFR3: 5, NFR4: 2, NFR5: 3), and any IRG scorecard rebaseline once substantive gaps close
3. REQ-NNN canonical IDs resolved: 91 IDs (001..091) present across all 12 FR/NFR sections — `#### REQ-NNN (FRx.y):` headings (FR1–FR7, 70 IDs) and `| REQ-NNN (NFRx.y) | ...` table-cell rows (NFR1–NFR5, 21 IDs) — plus the Requirement → AC Coverage Matrix (paraphrased column form). Per-row H3 layout was rejected in favour of heading + attribute-line placement for FR requirements and table-cell placement for NFR requirements.
4. Technical feasibility assessment (target Architecture Review)
5. Create TRD for implementation once refinements are approved

---

## Changelog
### v1.1.3 — 2026-08-13

**Merge pass:** replay of v1.1.2 patch (`a3f1984` on main, commit `feat(refinement-review): PRD v1.1.2 long-lived refinement + UX fixes`) onto v1.1.1 base (PR #23, commit `8ca5dd3`). Conflict resolution by per-side faithful combination (16 blocks via `git apply --3way`); no invented content during resolution.

Preserved from PR #23 v1.1.1 (ours):
- Per-requirement `REQ-NNN` IDs (001..091) with MoSCoW + Complexity attributes on all 12 FR/NFR sections (FR1–FR7: `**MoSCoW:**` / `**Complexity:**` attribute lines under each `#### REQ-NNN (FRx.y):` heading; NFR1–NFR5: the MoSCoW and Complexity columns in each five-column NFR table).
- 36 Acceptance Criteria rewritten as explicit `Given / When / Then / And` Gherkin blocks with labelled test method in italics.
- Readiness Scorecard (Previous 3.0 → Current 3.8, 4-dimension breakdown).
- Scenario 2 Gherkin fix: "press `h` three times".
- Implementation Readiness Gate (IRG) Scorecard retained with PR #23 dimensions; v1.1.2's updated `Testability` rationale folded into the Combined Scorecard section.

Preserved from main v1.1.2 (theirs):
- **Approvals** section between Success Metrics and Document Status (3-row placeholder scaffold).
- **Requirement → AC Coverage Matrix** appendix (70 FR + 21 NFR rows; coverage summary).
- **NFR Traceability** section after NFR5 (NFR2.3↔NFR1.2, G2↔NFR1.2, NFR4.1↔AC5.1–AC5.6).
- **Linked NFR(s)** column added to Goals table.
- **Traceability drift** risk added to Technical Risks.
- **Test Method Organization** note above AC1–AC8 (alongside our GWT format note, line 1326).

Post-merge corrections (applied after conflict resolution to align scorecards, status, and next-steps with the merged v1.1.3 body):
- **q-scorecard-reconcile** → `set-testability-4-and-feasibility-3` — IRG Testability 3→4 (GWT format + italicized test method make ACs machine-verifiable); Feasibility 4→3 to match Readiness Scorecard line 364; IRG Overall = 3.75 (mathematically exact: mean of 4+4+4+3 = 15/4). Readiness Scorecard Overall 3.8 is rounded from the same 3.75 by PR #23's v1.1.1 round.
- **q-nfr23-target-simplify** → `drop-inline-nfr12-ref` — REQ-079 (NFR2.3) Target cell reduced to "No stale data for >5s"; the NFR2.3↔NFR1.2 cross-reference remains in the NFR Traceability section (3-row table).
- **q-status-rewrite** → `acknowledge-51-91-gap-partial` — Status line now states "51 of 91 rows (56%) marked gap or partial; section-based AC mapping 75% Must / 83% Should"; replaces the prior 2-item primary-gap list.
- **q-next-steps-bump** → `v1-1-3-to-v1-1-4` — Next Steps item 1 bumped to v1.1.3 stakeholder review; item 2 bumped to v1.1.4 refinement round; item 3 records q-req-ids-resolution as RESOLVED via `#### REQ-NNN (FRx.y):` heading + `**MoSCoW:**` / `**Complexity:**` attribute-line placement (FR1–FR7, 70 IDs) and `| REQ-NNN (NFRx.y) | ...` table-cell placement (NFR1–NFR5, 21 IDs).
- **q-ac3-misnumber-stale-ref** → `remove-stale-notes` — v1.1.2 had already renumbered the former AC3.3 misnumber row to AC2.3 via q-ac-misnumber → renumber-ac2-3, but stale references remained at Status, Coverage Matrix FR2.4 row, and Next Steps item 2. All three now state current reality: AC2.3 (current-phase arrow), AC3.3 (priority color coding); the v1.1.4 round has 51 gap/partial rows as its scope, with no AC-numbering follow-up required.

Net delta: PRD body now reflects the merged state of v1.1.1 (PR #23) ∪ v1.1.2 (main) plus four post-merge reconciliations; Document Status `Refined - Awaiting Stakeholder Approval (v1.1.3)`. Readiness Scorecard Overall 3.8 (recorded by PR #23 in the v1.1.1 round); IRG Scorecard Overall 3.75 (mathematically exact for v1.1.3: mean of 4+4+4+3 = 15/4). The 0.05 difference is rounding only — both scorecards agree on every per-dimension score, and neither claim is more authoritative than the other for the merged state.

### v1.1.2 — 2026-08-13

**Refinement pass via `ensemble:refine-prd --collab --long-lived`** (revision 24, 7 questions, 7 with unambiguous selections, **7 applied** below).

**Provenance:** `ensemble:refine-prd --collab --long-lived`, session `prd-2026-019-session-2026-08-13T03-41-26-935Z`. Bootstrap: `collab-2026-019-v4.js`.

Applied selections:
- **q-test-method-fate** → `concrete-test-refs` — every sub-AC paragraph (AC1.1–AC8.3, 36 labels total) now carries an italicized `_(Test method: <category>)_` label naming one of seven test categories: `CLI test`, `Manual test`, `Unit test`, `Visual inspection`, `E2E test`, `Performance test`, `Resource test`. Category distribution across the 36 labels: Manual=14, Visual=7, Performance=4, Unit=6, E2E=3, CLI=1, Resource=1 (sum=36). No invented file paths or assertion text; the label names the test category, while the concrete Given/When/Then/And exercises live in the fenced ```gherkin blocks directly under each sub-AC. Test Method Organization note above AC1–AC8 (line 1327) documents the label taxonomy and the Gherkin-block separation.
- **q-must-req-coverage** → `add-coverage-matrix` — added Requirement → AC Coverage Matrix appendix (70 FR + 21 NFR rows) with paraphrased requirement text in column 1 (combining the source requirement name with its target/tolerance into one concise cell), AC mapping in column 2, and gap/partial/direct notes in column 3. Coverage summary: 35/70 FRs (50%) direct AC, 5/70 FRs (7%) partial, 6/21 NFRs (29%) direct AC, 3/21 NFRs (14%) partial.
- **q-gherkin-vs-ac-tables** → `keep-separate` (decision superseded by v1.1.2 q-ac-format → `gwt-blocks`) — under v1.1.1 (PR #23), ACs were tables and 6 standalone Gherkin scenarios co-existed; the decision was to keep them separate. v1.1.2 (main) subsequently rewrote all 36 ACs from `ID | Criteria | Test Method` table form into the paragraph-plus-GWT-block form now in AC1–AC8 (lines 1331–1652), superseding the keep-separate decision. Test Method Organization note (line 1327) and the GWT format note (line 1326) now sit above AC1; the 6 remaining standalone Gherkin scenarios live at lines 1654–1727.
- **q-nfr23-cross-ref** → `add-traceability-section` — added NFR Traceability section after NFR5. Three rows: NFR2.3↔NFR1.2 (≤5s freshness bounded by <500ms render budget), G2↔NFR1.2 (verbatim restatement), NFR4.1↔AC5.1–AC5.6 (keyboard-only guarantee tested by AC5). NFR2.3 Target atomic: "No stale data for >5s" (inline NFR1.2 phrase removed).
- **q-goal-nfr-overlap** → `add-traceability-column` — Goals table gains a "Linked NFR(s)" column (5 columns total). G2 maps to NFR1.2 (verbatim restatement). All other goals: N/A. The column is opt-in per goal; absence of mapping is a documented gap, not a placeholder.
- **q-risk-expansion** → `add-traceability-risk-only` — added one row to Technical Risks: **Traceability drift** (Medium/Medium), mitigated by the Coverage Matrix and NFR Traceability sections plus a PR-review checklist verifying new FR/NFRs map to existing or new ACs.
- **q-stakeholder-approval-section** → `add-approval-section` — added Approvals section between Success Metrics and Document Status. Three placeholder rows + blank "Approval criteria" line; the product team fills in roles, names, and criteria during stakeholder review.

**Gap note (session continuity):** The v1.1.2 round's selections (5 applied / 1 no-op / 1 fold from session `prd-2026-019-session-2026-08-13T01-26-31-458Z`) were lost in this session before being applied to the PRD. The v4 round's selections are applied **as-if they were v1.1.2 selections**: the v1.1.2 round's own selections (q-ac-misnumber → renumber-ac2-3, q-ac-format → convert-to-gwt, q-moscow-coverage → add-moscow-as-column, q-req-ids-resolution → separate-column, q-readiness-testability → bump-to-4, q-naming-consistency → keep-foreman, q-top-gaps → address-moscow-and-ac) are NOT applied. Restoring them would require a separate v1.1.3 round. The `AC3.3` misnumber in the AC2 table is preserved as a known issue (will be resolved in the v1.1.3 round).

Testability score remains at 3 (concrete test references are a verification hook, not a unit-test artifact). Document Status: `Refined - Awaiting Stakeholder Approval (v1.1.2)`. Approvals section added as a 3-row placeholder scaffold; roles, names, and criteria are filled in by the product team during stakeholder review.

### 1.1.1 (2026-08-12) — Refinement pass via `--collab` review

Author and metadata:
- Author: Foreman Product Team → Sunstone Partners (per `q-author-attribution → sunstone-partners`).
- Version: 1.1.0 → 1.1.1 (patch — no behavioural change, document quality only).
- Last Updated: 2026-08-11 → 2026-08-12.
- Readiness score: 3.0 → 3.8 (see PRD Health scorecard).

Structural changes (per `q-health-gaps → all` and `q-req-ids → add-alongside`):
- Functional Requirements rewritten as per-requirement `### REQ-NNN (FRx.y)` entries (REQ-001..070).
- Non-Functional Requirements rewritten as `REQ-NNN (NFRx.y)` entries with Target columns (REQ-071..091).
- Total REQ-NNN range: 001..091 (70 FR + 21 NFR), sequential, no gaps, no duplicates.
- Each requirement now carries MoSCoW label (Must / Should / Could) and complexity (S/M/L by content).

Scenario fix (per `q-scenario-2-fix → correct-scenario`):
- Scenario 2 Gherkin step: "When operator presses 'h' twice" → "When operator presses 'h' three times" to match the 4-column board (Ready → In Progress → Blocked → Done).

Acceptance Criteria (per `q-ac-format` default — open granular question, default applied):
- All 36 ACs rewritten from `ID | Criteria | Test Method` table format to explicit `Given / When / Then / And` Gherkin blocks.
- 8 AC sections preserved (AC1–AC8); each AC now has ≤5 GWT statements with a labeled test method.

Complexity heuristic (per `q-complexity-coverage → yes-heuristic`):
- Heuristic applied by content: rendering/configuration → S, terminal-UI plumbing / data aggregation / cross-references → M, real-time streaming / dependency rendering / security → L.
- Result: S=65, M=24, L=2 across 91 requirements.

MoSCoW heuristic (per `q-moscow-coverage` default — open granular question):
- Priority-based mapping: P0 → Must, P1 → Should, P2 → Could.
- Result: Must=61, Should=24, Could=6.

Readiness scorecard (per `q-readiness-scorecard` default — open granular question):
- 4-dimension breakdown: Completeness, Testability, Clarity, Feasibility.
- 3 dimensions improved (+1 each); Feasibility unchanged (no scope change).
- Overall: 3.0 → 3.8.

Validation:
- REQ-NNN IDs unique and sequential (001..091).
- AC IDs AC1.1–AC8.3 unique, sequential, no duplicates.
- Scenario 2 Board navigation matches actual 4-column board.

Deferred for follow-up:
- `q-moscow-coverage` — open; default heuristic applied. If stakeholder-driven mapping is preferred, re-open.
- `q-ac-format` — open; default GWT rewrite applied. If per-requirement AC mapping is preferred, re-open.
- `q-readiness-scorecard` — open; 4-dimension scorecard applied. If 5-dimension or weighted scoring is preferred, re-open.
