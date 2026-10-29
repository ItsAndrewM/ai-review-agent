FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.0.0

WORKDIR /workspace

CMD ["sh", "-c", "while :; do sleep 3600 & wait; done"]
