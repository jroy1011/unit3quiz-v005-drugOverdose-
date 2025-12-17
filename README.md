# US Drug Overdose Dashboard

This is a small Vite + React site that loads a CSV and renders an interactive time-series chart that can be **segmented by drug**.

## Load your CSV (2 options)

### Option A (recommended): Upload in the UI
- Start the dev server and open the site.
- Click **Upload CSV** and select your file (for example from `C:\Users\joyar\Downloads\`).

### Option B: Auto-load from `public/`
- Copy/rename your CSV to: `public/data/overdose.csv`
- Refresh the page; it will auto-load at startup.

## Notes
- The app tries to **auto-detect** the `Drug`, `Date`, and `Deaths/Count` columns.
- If auto-detection is wrong, use the dropdowns to pick the correct columns.
- The app includes a **Jurisdiction** selector and defaults to **United States** when present.
