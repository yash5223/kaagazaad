#!/usr/bin/env python3
"""
ocr_engine.py

Runs OCR on one or more image files using pytesseract (a Python wrapper
around the Tesseract engine) and prints a single JSON object to stdout.

This replaces the previous tesseract.js-based OCR step. It is invoked
as a short-lived subprocess, once per /scan-receipt request, from
routes/scanReceipt.js via child_process.

Usage:
    python3 ocr_engine.py <tessdata_dir> <image1> [image2 ...]

- <tessdata_dir> is the directory containing eng.traineddata (the repo
  root, same file that was already committed for tesseract.js).
- Each <imageN> should already be preprocessed (deskewed, grayscale,
  normalized) — that work still happens in Node via sharp, this script
  only performs recognition.

Output (stdout, exit code 0 on success):
{
  "text": "combined text across all pages, blank-line separated",
  "confidence": 87.4,                // average confidence across pages
  "words": [
    {"text": "ABC123", "x0": 0.12, "y0": 0.05, "x1": 0.30, "y1": 0.09},
    ...
  ]                                    // bbox coords normalized 0-1 per page
}

On failure, prints {"error": "<message>"} to stdout and exits with code 1.
Node should check the exit code rather than relying on stderr.
"""
import json
import sys

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: ocr_engine.py <tessdata_dir> <image1> [image2 ...]"}))
        sys.exit(1)

    tessdata_dir = sys.argv[1]
    image_paths = sys.argv[2:]

    try:
        import pytesseract
        from pytesseract import Output
        from PIL import Image
    except ImportError as exc:
        print(json.dumps({"error": f"missing python dependency: {exc}"}))
        sys.exit(1)

    tess_config = f'--tessdata-dir "{tessdata_dir}"'

    combined_text_parts = []
    confidence_sum = 0.0
    pages_with_text = 0
    words = []

    for image_path in image_paths:
        try:
            with Image.open(image_path) as img:
                img.load()
                width, height = img.size

                data = pytesseract.image_to_data(
                    img,
                    lang="eng",
                    config=tess_config,
                    output_type=Output.DICT,
                )
        except Exception as exc:
            print(json.dumps({"error": f"failed to OCR {image_path}: {exc}"}))
            sys.exit(1)

        n = len(data.get("text", []))
        page_text_pieces = []
        page_confidences = []

        for i in range(n):
            raw_text = (data["text"][i] or "").strip()
            try:
                conf = float(data["conf"][i])
            except (TypeError, ValueError):
                conf = -1.0

            if not raw_text:
                continue

            page_text_pieces.append(raw_text)
            if conf >= 0:
                page_confidences.append(conf)

            if conf >= 0 and width > 0 and height > 0:
                left = data["left"][i]
                top = data["top"][i]
                w = data["width"][i]
                h = data["height"][i]
                words.append({
                    "text": raw_text,
                    "x0": left / width,
                    "y0": top / height,
                    "x1": (left + w) / width,
                    "y1": (top + h) / height,
                })

        page_text = " ".join(page_text_pieces).strip()
        if page_text:
            combined_text_parts.append(page_text)
            if page_confidences:
                confidence_sum += sum(page_confidences) / len(page_confidences)
                pages_with_text += 1

    result = {
        "text": "\n\n".join(combined_text_parts),
        "confidence": (confidence_sum / pages_with_text) if pages_with_text else 0,
        "words": words,
    }
    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
