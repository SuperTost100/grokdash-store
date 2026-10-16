FROM node:24-alpine
WORKDIR /app
COPY index.mjs .
# The adapter keeps its state in /data. A new named volume copies this folder's owner, so node can write there.
RUN mkdir /data && chown node /data
USER node
CMD ["node", "index.mjs"]
