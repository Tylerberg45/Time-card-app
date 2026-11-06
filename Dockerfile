FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN ./node_modules/.bin/next build
ENV NODE_ENV=production HAZEN_DATA_DIR=/data
CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0"]
