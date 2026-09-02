# OCR setup (Python-based)

OCR now runs via `scripts/ocr_engine.py` (pytesseract) instead of the old
`tesseract.js` Node package. `routes/scanReceipt.js` spawns this script as a
subprocess for every `/scan-receipt` request.

## ⚠️ Render deployment: you MUST use the Docker runtime

Render's **native** (non-Docker) runtimes do **not** allow `apt-get install`,
and they don't ship the `tesseract-ocr` system binary — only `python3-pip`.
Since `pytesseract` shells out to that binary, the native runtime will throw
`TesseractNotFoundError` at request time even though `pip install` succeeds.

A `Dockerfile` is included in this repo that installs `tesseract-ocr` +
`python3` + the pip packages. On Render:

1. Go to your service → **Settings** → **Build & Deploy**.
2. Under **Source**, click **Edit** and change **Runtime** to **Docker**.
3. Leave build/start command blank (the Dockerfile's `CMD` handles it).
4. Deploy. Render will build the image using the `Dockerfile` at the repo
   root, which installs Tesseract + Python before installing Node deps.
5. Free plan works fine with Docker — same resource limits as native, just
   allows the extra system packages.

If you'd rather not switch to Docker, the alternative is going back to a
pure-JS/WASM OCR engine (like the previous `tesseract.js`), since that
doesn't need a system binary at all — happy to help with that instead if
Docker isn't an option for you.

## Requirements on the server / container (handled by the Dockerfile)

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
