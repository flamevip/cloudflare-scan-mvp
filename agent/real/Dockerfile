FROM golang:1.24-alpine AS tools

ARG SUBFINDER_VERSION=v2.7.1
ARG HTTPX_VERSION=v1.6.10
ARG NUCLEI_VERSION=v3.3.8
ARG NUCLEI_TEMPLATES_COMMIT=0f569c3724b966c2ba357c1d26a0aa6c041a6af5

RUN apk add --no-cache ca-certificates git \
  && GOBIN=/tools go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@${SUBFINDER_VERSION} \
  && GOBIN=/tools go install github.com/projectdiscovery/httpx/cmd/httpx@${HTTPX_VERSION} \
  && GOBIN=/tools go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION} \
  && sha256sum /tools/subfinder /tools/httpx /tools/nuclei > /tools/toolchain-sha256.txt

FROM node:24-alpine

ARG SUBFINDER_VERSION=v2.7.1
ARG HTTPX_VERSION=v1.6.10
ARG NUCLEI_VERSION=v3.3.8
ARG NUCLEI_TEMPLATES_COMMIT=0f569c3724b966c2ba357c1d26a0aa6c041a6af5

LABEL org.opencontainers.image.title="scan-agent" \
  org.opencontainers.image.description="Cloudflare Scan MVP agent" \
  org.opencontainers.image.vendor="cloudflare-scan-mvp" \
  scan.projectdiscovery.subfinder.version="${SUBFINDER_VERSION}" \
  scan.projectdiscovery.httpx.version="${HTTPX_VERSION}" \
  scan.projectdiscovery.nuclei.version="${NUCLEI_VERSION}"

WORKDIR /app
RUN apk add --no-cache ca-certificates bind-tools
COPY --from=tools /tools/subfinder /usr/local/bin/subfinder
COPY --from=tools /tools/httpx /usr/local/bin/httpx
COPY --from=tools /tools/nuclei /usr/local/bin/nuclei
RUN mkdir -p /usr/local/share/scan-agent
COPY --from=tools /tools/toolchain-sha256.txt /usr/local/share/scan-agent/toolchain-sha256.txt
COPY toolchain.json /usr/local/share/scan-agent/toolchain.json
RUN apk add --no-cache --virtual .template-fetch git \
  && git init /usr/local/share/nuclei-templates \
  && git -C /usr/local/share/nuclei-templates remote add origin https://github.com/projectdiscovery/nuclei-templates.git \
  && git -C /usr/local/share/nuclei-templates fetch --depth 1 origin "${NUCLEI_TEMPLATES_COMMIT}" \
  && git -C /usr/local/share/nuclei-templates checkout --detach FETCH_HEAD \
  && printf '%s\n' "${NUCLEI_TEMPLATES_COMMIT}" > /usr/local/share/nuclei-templates.commit \
  && rm -rf /usr/local/share/nuclei-templates/.git \
  && apk del .template-fetch
COPY package.json ./package.json
COPY src ./src

ENV SCAN_MODE=mock
ENV RATE_LIMIT=50
ENV TIMEOUT_MINUTES=30
ENV TOOLCHAIN_MANIFEST_PATH=/usr/local/share/scan-agent/toolchain.json
ENV TOOLCHAIN_SHA256_PATH=/usr/local/share/scan-agent/toolchain-sha256.txt
ENV NUCLEI_TEMPLATES=/usr/local/share/nuclei-templates
CMD ["node", "src/scan-agent.js"]
