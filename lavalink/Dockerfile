# Official Lavalink v4.2.2 container image
FROM ghcr.io/lavalink-devs/lavalink:4.2.2

# Set working directory to Lavalink installation root
WORKDIR /opt/Lavalink

# Copy custom application configuration into Lavalink directory
COPY application.yml /opt/Lavalink/application.yml

# Ensure plugins directory exists for runtime downloads
RUN mkdir -p /opt/Lavalink/plugins

# Expose default Lavalink WebSocket/REST port
EXPOSE 2333
