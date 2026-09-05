FROM node:20-slim

# System deps for the document-understanding pipeline (scripts/ocr_pipeline.py):
# - tesseract-ocr: OCR engine pytesseract shells out to
# - tesseract-ocr-hin: Hindi trained data — most Indian ID docs (Aadhaar, PAN,
#   Voter ID, etc.) are printed bilingually, and the pipeline OCRs with
#   "eng+hin" so it can read both scripts in one pass
# - libreoffice: converts legacy .doc/.xls to .docx/.xlsx before parsing
# - libgl1 / libglib2.0-0: runtime libs opencv-python-headless needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    tesseract-ocr \
    tesseract-ocr-hin \
    libreoffice \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first so this layer is cached unless package*.json changes.
COPY package*.json ./
RUN npm ci --omit=dev

# Install Python deps for the OCR pipeline subprocess.
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Now copy the rest of the app (routes, models, eng.traineddata, scripts, etc.)
COPY . .

ENV NODE_ENV=production
# Render sets $PORT itself; server.js already reads process.env.PORT.
EXPOSE 3000

CMD ["node", "server.js"]