# node-agent — build & cross-compile
#
#   make build            # build for the host
#   make linux            # static linux/amd64 + linux/arm64 into dist/
#   make run              # run locally against $NATS_URL (defaults to localhost)

BINARY := node-agent
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w

.PHONY: build linux run tidy vet clean

build:
	go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY) .

linux:
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-linux-amd64 .
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-linux-arm64 .

run:
	go run .

tidy:
	go mod tidy

vet:
	go vet ./...

clean:
	rm -rf bin dist
