FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build && cp -r src/ui/public dist/ui/public
EXPOSE 3456
ENV HOST=0.0.0.0 PORT=3456
CMD ["node", "dist/ui/server.js"]
