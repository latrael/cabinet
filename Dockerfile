# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS whisper-build
ARG WHISPER_VERSION=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp.git /src/whisper \
    && cmake -S /src/whisper -B /src/whisper/build \
       -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
       -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF \
       -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build /src/whisper/build --config Release --target whisper-cli -j 2

FROM node:26-bookworm-slim AS app-build
ENV CI=true
WORKDIR /app
RUN npm install --global pnpm@10.32.1
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm install --prod --frozen-lockfile

FROM node:26-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /models && chown node:node /data /models
WORKDIR /app
COPY --from=app-build /app /app
COPY --from=whisper-build /src/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /src/whisper/LICENSE /usr/local/share/licenses/whisper.cpp/LICENSE
ENV NODE_ENV=production \
    CABINET_LIBRARY=/data/Cabinet \
    CABINET_APP_CONFIG=/data/app.json \
    CABINET_WHISPER_MODEL=/models/ggml-base.bin
USER node
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4747/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "apps/cli/src/main.ts"]
CMD ["start", "--host", "0.0.0.0"]
