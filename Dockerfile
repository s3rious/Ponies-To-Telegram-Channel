FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/logs /app/tmp && chown -R node:node /app
USER node

CMD ["node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "src/app.ts"]
