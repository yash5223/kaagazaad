FROM node:20-slim

# tesseract-ocr is the system binary pytesseract shells out to.
# python3/pip are needed to run scripts/ocr_engine.py.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first so this layer is cached unless package*.json changes.
COPY package*.json ./
RUN npm ci --omit=dev

# Install Python deps for the OCR subprocess.
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Now copy the rest of the app (routes, models, eng.traineddata, scripts, etc.)
COPY . .

ENV NODE_ENV=production
# Render sets $PORT itself; server.js already reads process.env.PORT.
EXPOSE 3000

CMD ["node", "server.js"]
