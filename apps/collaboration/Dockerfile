FROM node:24-bookworm-slim
# TeX Live for browser builds. WRITER_TEX=0 builds a smaller image without compilation.
ARG WRITER_TEX=1
RUN if [ "$WRITER_TEX" = "1" ]; then \
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
        texlive-science texlive-bibtex-extra biber texlive-xetex texlive-luatex \
        texlive-lang-chinese fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*; \
    fi
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/writing/package.json ./packages/writing/package.json
COPY apps/collaboration/package.json ./apps/collaboration/package.json
RUN pnpm install --frozen-lockfile --filter @lmms-lab/writer-collaboration...
COPY packages/writing ./packages/writing
COPY apps/collaboration ./apps/collaboration
COPY LICENSE NOTICE ./
COPY LICENSES ./LICENSES
RUN pnpm --filter @lmms-lab/writer-collaboration build
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production WRITER_HOST=0.0.0.0 WRITER_PORT=8787 WRITER_DATA_DIR=/data \
    WRITER_TEXMFVAR=/data/texmf-var
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm","--filter","@lmms-lab/writer-collaboration","start"]
