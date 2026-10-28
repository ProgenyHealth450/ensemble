# PRD-2026-001: Slugify Helper

## Problem
Teams hand-roll URL slugs inconsistently.

## Goal
Provide a tiny `slugify(text)` JavaScript function in `src/slugify.js`.

## Requirements
- R1: lowercases input, replaces runs of non-alphanumerics with a single `-`.
- R2: trims leading/trailing `-`.
- R3: returns an empty string for empty or non-string input.

## Acceptance Criteria
- AC1: `slugify("Hello, World!")` returns `hello-world`.
- AC2: `slugify("")` returns `""`.
- AC3: unit tests cover R1-R3.

## Non-goals
Unicode transliteration.
