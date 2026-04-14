FROM nodered/node-red:latest

WORKDIR /data/node_modules/node-red-contrib-performance-monitor

COPY --chown=node-red:node-red package.json package-lock.json ./
RUN npm install --omit=dev

COPY --chown=node-red:node-red . .

WORKDIR /usr/src/node-red
