FROM nodered/node-red:latest

# Copy the performance monitor plugin
COPY --chown=node-red:node-red . /data/node_modules/node-red-contrib-performance-monitor/
