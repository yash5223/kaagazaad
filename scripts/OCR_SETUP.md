# OCR setup (Python-based)

OCR now runs via `scripts/ocr_engine.py` (pytesseract) instead of the old
`tesseract.js` Node package. `routes/scanReceipt.js` spawns this script as a
subprocess for every `/scan-receipt` request.

## Requirements on the server / container

1. **Tesseract binary** (pytesseract just wraps it):
   ```bash
   apt-get update && apt-get install -y tesseract-ocr
   ```
2. **Python packages**:
   ```bash
   pip install -r requirements.txt
   ```
3. **`python3` on PATH.** If your deployment uses a different interpreter
   name/path, set the `PYTHON_BIN` env var (e.g. `PYTHON_BIN=/usr/bin/python3.11`).

## What stays the same

- `eng.traineddata` is still read from the repo root — same file, same
  location as before. `ocr_engine.py` is pointed at it via
  `--tessdata-dir`, so nothing needs to be re-downloaded or moved.
- Image preprocessing (deskew, grayscale, contrast, sharpen) still happens
  in Node via `sharp`, exactly as before — only the recognition step moved
  to Python.
- The JSON shape returned to the rest of the route (`text`, `confidence`,
  `words[]` with normalized `x0/y0/x1/y1`) is unchanged, so template
  matching (`utils/ocrTemplates.js`) and all the field parsers work as-is.

## Quick manual test

```bash
python3 scripts/ocr_engine.py . /path/to/some/preprocessed/image.png
```

Should print a single line of JSON: `{"text": "...", "confidence": NN, "words": [...]}`.
