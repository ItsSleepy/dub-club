FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg unzip
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
