## Repository layout

- **Published site**: `src/` holds the page, its stylesheet and script, and
  `photos.json`; `static/` is copied as is. `npm run build` writes `dist/`,
  which is what DigitalOcean publishes. See `README.md`.
- **Photographs are never committed.** The build fetches the originals from S3
  and writes derivatives to `dist/i/`. Add one by adding an entry to
  `src/photos.json`.
- **The page must stay inside its byte budget.** The build fails if the
  compressed document passes 13 kB, because past that it no longer arrives in
  the first round trip. Do not raise the budget to make a change fit.

## Agent skills

### Issue tracker

Issues, specs, and Wayfinder maps use local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical Matt Pocock triage-label vocabulary is used unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
