FROM node:18
# Running as root (security issue)
WORKDIR /app
COPY . .
RUN npm install
# Exposing debug port
EXPOSE 3000 9229
# No health check
CMD ["node", "src/index.js"]
