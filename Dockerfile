FROM node:26-slim
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
COPY package*.json ./
RUN npm ci --omit=dev
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY . .
RUN mkdir -p /app/uploads \
    && chown -R node:node /app/uploads /app/scripts \
    && mkdir -p /home/node \
    && chown -R node:node /home/node
ENV NODE_ENV=production \
    HOME=/home/node \
    PYTHONDONTWRITEBYTECODE=1
USER node
EXPOSE 3000
CMD ["node", "server.js"]
