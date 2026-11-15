# Job Intelligence

A personal job-search tool: collects IT vacancies from hh.ru every day, ranks them against a candidate profile, drafts cover letters and resume variants, and tracks the application funnel.

## Problem

Manual job search means re-reading the same listings, missing new ones, and writing each cover letter from scratch. Market questions ("which skills are actually in demand for my target roles?") have no quick answer.

## Solution

A daily pipeline stores vacancies as events in SQLite, enriches them with descriptions and extracted skills, and scores them against a profile. A local web "cockpit" shows the ranked list and the funnel; a static dashboard shows the market view.

```
Daily (launchd):
Collector (hh.ru) -> events (new / salary_changed / closed) -> SQLite
   -> enrich new -> verify closed -> history snapshots -> dashboard (HTML)
```

## Features

- Vacancy collection for a configurable list of search queries (`src/config.mjs`)
- Change tracking: new vacancies, salary changes, closures
- Skill extraction with a technology dictionary
- Profile matching: skill weights, categories, flags, priority
- Cover letter and resume adaptation generators
- Application cockpit: a local web UI for the funnel
- "Market today" dashboard: demand by role and skill, trends from snapshots
- Daily orchestrator with an emergency stop
- Chrome extension (Manifest V3) that shows hints on vacancy pages

## Tech stack

Node.js (ESM), **zero external dependencies**: `node:sqlite`, `node:http`, `node:crypto`, `node:fs`. The HTTP server is written by hand, SQL is used directly.

## Layout

```
src/
  collect.mjs, hh.mjs     collection and HTML state parsing
  enrich.mjs              descriptions and skills for new vacancies
  match.mjs, scoring.mjs  ranking against the profile
  letters.mjs, resume.mjs text generators
  cockpit.mjs             application cockpit (local web UI)
  report.mjs              market dashboard
  run-daily.mjs           daily orchestrator
  db.mjs, config.mjs      storage and settings
extension/                Chrome extension
docs/                     calibration notes and known limitations
```

## Run locally

Requires Node.js 22.5+.

```bash
cp profile.example.json profile.json   # fill in your own profile
npm run collect
npm run enrich
npm run match
npm run report
npm run cockpit
```

All scripts are listed in `package.json`.

## Status and limitations

- A single-user tool that I use for my own job search. No tests.
- Collection reads public vacancy pages and depends on the site's markup; it can break when the markup changes. Use it only for personal analysis and within the site's terms. The multi-user version ([job-intelligence-saas](https://github.com/Mihai1K/job-intelligence-saas)) is designed around the official OAuth API instead.
- My profile, the database and generated letters are not part of this repository.
- See `docs/KNOWN_LIMITATIONS.md`.

## How this was built

I defined the pipeline, the scoring rules and the calibration, and I use the tool daily. The code was written together with an AI coding agent (Claude Code) under my specifications and review.
