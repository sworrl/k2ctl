VERSION ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all backend arm web tray clean run

all: web backend arm

web:            ## build the React UI and embed it into the Go binary
	cd web && npm install --no-audit --no-fund && npm run build
	rm -rf internal/api/dist && cp -r web/dist internal/api/dist

backend:        ## native build (for running on the desktop)
	go build -ldflags "$(LDFLAGS)" -o build/k2ctl ./cmd/k2ctl

arm:            ## static ARMv7 build for the K2
	CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "$(LDFLAGS)" -o build/k2ctl-armv7 ./cmd/k2ctl

tray:           ## Qt6 tray app
	cmake -S tray -B tray/build -DCMAKE_BUILD_TYPE=Release && cmake --build tray/build -j

run: backend    ## run the backend on the desktop against the printer
	./build/k2ctl -moonraker http://$(PRINTER):7125 -cxws ws://$(PRINTER):9999 -profiles deploy/profiles.json -web web/dist

clean:
	rm -rf build web/dist tray/build internal/api/dist/assets
