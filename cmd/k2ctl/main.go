// k2ctl is a small control service for the Creality K2 (F021): it merges the
// Moonraker API and Creality's device socket into one status model, exposes a
// JSON/WebSocket API, serves the web dashboard, and programs CFS slots from a
// filament profile catalog. It is meant to run on the printer itself.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/sworrl/k2ctl/internal/api"
	"github.com/sworrl/k2ctl/internal/cxws"
	"github.com/sworrl/k2ctl/internal/moonraker"
	"github.com/sworrl/k2ctl/internal/profiles"
	"github.com/sworrl/k2ctl/internal/state"
)

var version = "dev"

func main() {
	listen := flag.String("listen", ":8085", "HTTP listen address")
	moon := flag.String("moonraker", "http://127.0.0.1:7125", "Moonraker base URL")
	cx := flag.String("cxws", "ws://127.0.0.1:9999", "Creality device WebSocket URL")
	prof := flag.String("profiles", "profiles.json", "filament profile catalog (JSON)")
	webDir := flag.String("web", "", "serve the web UI from this directory instead of the embedded build")
	poll := flag.Duration("poll", 2*time.Second, "Moonraker poll interval")
	tlsListen := flag.String("tls-listen", "", "also serve HTTPS on this address, e.g. :8443 (needs -tls-cert and -tls-key)")
	tlsCert := flag.String("tls-cert", "", "PEM certificate chain for -tls-listen")
	tlsKey := flag.String("tls-key", "", "PEM private key for -tls-listen")
	flag.Parse()

	logger := log.New(os.Stderr, "k2ctl ", log.LstdFlags)
	logger.Printf("version %s listen=%s moonraker=%s cxws=%s", version, *listen, *moon, *cx)

	cat, err := profiles.Load(*prof)
	if err != nil {
		logger.Fatalf("profiles: %v", err)
	}
	logger.Printf("profiles: %d loaded from %s", len(cat.All()), *prof)

	bays := profiles.LoadBays(filepath.Join(filepath.Dir(*prof), "bays.json"))

	store := state.New()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	cxc := cxws.New(*cx, store, logger)
	mc := moonraker.New(*moon, store, logger)
	go cxc.Run(ctx)
	go mc.Run(ctx, *poll)

	srv := &http.Server{
		Addr:              *listen,
		Handler:           (&api.Server{Store: store, CX: cxc, Moon: mc, Catalog: cat, Bays: bays, WebDir: *webDir, Version: version, Log: logger}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	var tlsSrv *http.Server
	if *tlsListen != "" {
		if *tlsCert == "" || *tlsKey == "" {
			logger.Fatalf("-tls-listen needs -tls-cert and -tls-key")
		}
		tlsSrv = &http.Server{Addr: *tlsListen, Handler: srv.Handler, ReadHeaderTimeout: 10 * time.Second}
		go func() {
			logger.Printf("https: listening on %s (cert %s)", *tlsListen, *tlsCert)
			if err := tlsSrv.ListenAndServeTLS(*tlsCert, *tlsKey); err != nil && err != http.ErrServerClosed {
				logger.Fatalf("https: %v", err)
			}
		}()
	}
	go func() {
		<-ctx.Done()
		shutdown, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		_ = srv.Shutdown(shutdown)
		if tlsSrv != nil {
			_ = tlsSrv.Shutdown(shutdown)
		}
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Fatalf("http: %v", err)
	}
}
