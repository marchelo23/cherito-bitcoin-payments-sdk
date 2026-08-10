FROM node:22-alpine
WORKDIR /app
COPY receiver.mjs ./receiver.mjs
USER node
EXPOSE 4000
CMD ["node", "receiver.mjs"]
