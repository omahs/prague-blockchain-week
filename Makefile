.PHONY: all build

all: test build

mirror: test build-mirror

test:
	deno test --unstable --allow-read utils/test.js

link-check:
	lychee spec/**/*.yaml

format:
	deno fmt utils/*.js README.md

fmt: format

build:
	deno run --unstable --allow-read --allow-write utils/exec.js build

build-mirror:
	deno run --unstable --allow-read --allow-write utils/mirror.js

event-sync:
	deno run --unstable --allow-read --allow-write --allow-net utils/eventSync.js $(event)

search:
	deno run --unstable --allow-read --allow-write --allow-net utils/meilisearch.js