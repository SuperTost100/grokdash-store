FROM node:24-alpine
WORKDIR /app
COPY index.mjs .
# The adapter keeps its read positions in /data. A named volume copies this folder's owner on first use.
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "index.mjs"]
