FROM registry:3.1.2

ENV OTEL_TRACES_EXPORTER=none
COPY registry/dockerhub.yml /etc/distribution/config.yml
COPY registry/ghcr.yml /etc/distribution/ghcr.yml
