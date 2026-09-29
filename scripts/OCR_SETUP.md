# OCR / document-understanding setup

OCR now runs entirely through `scripts/ocr_pipeline.py` — a single Python
script that does image preprocessing, OCR (via pytesseract, with an
**adaptive, parallel multi-model ensemble pass**), document classification,
**DB-assisted compulsory-field extraction**, and fuzzy "low-tier" value
matching/learning in one process. `routes/scanReceipt.js` spawns it as a
subprocess for every `/scan-receipt` request and parses its JSON stdout —
there's no separate Node-side preprocessing, PDF/DOCX/XLS parsing, or
hand-written regex field parser anymore (that logic used to live in
`scanReceipt.js`; it's now all in the Python script, keyed against the same
taxonomy as `config/fieldLabels.js`).

## Speed: adaptive OCR fast path

Every image/PDF page is run through a "primary" tesseract pass first. If
that pass is already clean and confident (avg confidence ≥ 78, ≥ 8 words),
the pipeline stops there instead of running the other 3 models — this is
the common case for clear phone scans and skips ~75% of the OCR work.
Harder documents (blurry, skewed, low-light) still fall through to the full
4-model ensemble, run **concurrently** via a thread pool (each pytesseract
call shells out to the `tesseract` binary as its own subprocess, so this is
real parallelism, not limited by the GIL) with a word-level majority vote
across models. Pass `--thorough` to always force the full ensemble.

## Compulsory fields: DB-assisted auto-fill + auto-learn

Compulsory fields (`document_understanding.compulsory_fields`) are now
filled through three layers, in order:
1. **Direct OCR read** — label regex match, or value found on the line
   right after a standalone label.
2. **Fallback pattern** — type-aware regex (name/date/amount/etc.) when no
   labelled value is present.
3. **Learned DB history** (`matched_by: "db_history"`) — if neither of the
   above found anything, the pipeline looks up the most frequently-seen
   value ever recorded for that exact (document type, field) pair in
   `low_tier_value_store.json` and uses it to auto-fill the field, as long
   as it's been seen at least twice before. The response marks this clearly
   (`source: "db_history"`, `db_occurrences: N`) so the UI can show it as a
   suggestion rather than an OCR-confirmed fact.

Every value that *is* read straight off a document (layer 1 or 2) is
written back into that same DB, so the pipeline's auto-fill suggestions get
better the more documents of a given type it processes — this is the
"auto learn" loop. A stronger, human-verified version of the same loop runs
through `POST /confirm-extraction`: when the frontend sends back the
confirmed `documentType` and (optionally) `rawText`/`fields` after a user
reviews a scan, the corrected classification is logged for the next
`--train` run and the confirmed field values are written into the DB with
extra weight (`ocr_pipeline.py --confirm-fields`), so a human correction
quickly outranks noisy OCR guesses for future auto-fill.

This replaces the previous `scripts/ocr_engine.py` (bare pytesseract
wrapper) + Node `sharp` preprocessing + per-document-type JS regex parsers.

## ⚠️ Render deployment: you MUST use the Docker runtime

Render's **native** (non-Docker) runtimes do **not** allow `apt-get install`,
so they can't provide the `tesseract-ocr` binary, OpenCV's system libraries
(`libgl1`, `libglib2.0-0`), or `libreoffice` (needed to read legacy `.doc`/
`.xls` files). All of these are required by `ocr_pipeline.py`.

The included `Dockerfile` installs all of the above plus the Python
dependencies. On Render:

1. Go to your service → **Settings** → **Build & Deploy**.
2. Under **Source**, click **Edit** and change **Runtime** to **Docker**.
3. Leave build/start command blank (the Dockerfile's `CMD` handles it).
4. Deploy. Render will build the image using the `Dockerfile` at the repo
   root.
5. Free plan works fine with Docker — same resource limits as native, just
   allows the extra system packages.

## Requirements on the server / container (handled by the Dockerfile)

1. **Tesseract binary**:
   ```bash
   apt-get install -y tesseract-ocr
   ```
2. **LibreOffice** (only needed for legacy `.doc`/`.xls` uploads — the
   pipeline shells out to `soffice --headless --convert-to` to turn them
   into `.docx`/`.xlsx` first):
   ```bash
   apt-get install -y libreoffice
   ```
3. **OpenCV runtime libs**:
   ```bash
   apt-get install -y libgl1 libglib2.0-0
   ```
4. **Python packages**:
   ```bash
   pip install -r requirements.txt
   ```
5. **`python3` on PATH.** If your deployment uses a different interpreter
   name/path, set the `PYTHON_BIN` env var (e.g. `PYTHON_BIN=/usr/bin/python3.11`).

## What each file is for

- `scripts/ocr_pipeline.py` — the pipeline itself. Also usable directly from
  the command line for debugging/training (see `--help`).
- `scripts/low_tier_value_store.json` — the fuzzy-match "learning DB" the
  pipeline reads from and writes to on every extraction (per field, per
  document type). **This file is app state, not a static asset** — if your
  hosting platform's filesystem is ephemeral (e.g. Render's default disk),
  it will reset on every deploy/restart and the app loses everything it has
  learned. Mount a persistent disk at this path, or point `--low-tier-db`
  (passed by `scanReceipt.js` via `OCR_LOW_TIER_DB_PATH`) at one, if you
  want learned values to survive deploys.
- `scripts/classifier_model.joblib` / `scripts/training_data.jsonl` —
  optional ML classifier + its feedback log, created the first time you run
  `ocr_pipeline.py --train`. Same persistence caveat applies. Without these
  present, the pipeline still works fine using its keyword-based classifier.

## Quick manual test

```bash
python3 scripts/ocr_pipeline.py /path/to/some/document.jpg
```

Should print a structured JSON result to stdout (`ocr`, `document_understanding`
with `fields`/`compulsory_fields`/`low_tier_fields`, etc.) and a
human-readable summary to stderr. See `python3 scripts/ocr_pipeline.py --help`
for training, correction, and low-tier-DB inspection flags.
