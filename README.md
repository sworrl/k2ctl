<p align="center">
  <img src="assets/k2ctl-icon-256.png" width="160" height="160" alt="k2ctl icon">
</p>

<h1 align="center">k2ctl</h1>

<p align="center">
  Dashboard, tray app, print cost tracking and a filament catalog for the Creality K2 and its CFS.<br>
  Runs on the printer itself. Written for our own K2, "The Means". Not a Creality product.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/printer-Creality%20K2%20(F021)-1a1a2e?style=flat-square" alt="Creality K2 (F021)">
  <img src="https://img.shields.io/badge/backend-Go%201.22%2B-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go 1.22+">
  <img src="https://img.shields.io/badge/dashboard-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React + Vite">
  <img src="https://img.shields.io/badge/tray-Qt%206-41CD52?style=flat-square&logo=qt&logoColor=white" alt="Qt 6">
  <img src="https://img.shields.io/badge/desktop-Linux%20(apt)-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux desktop">
  <img src="https://img.shields.io/badge/network-LAN%20ONLY-d73a49?style=flat-square" alt="LAN only">
</p>

> [!CAUTION]
> ## Do NOT put this on the internet
>
> **k2ctl has no login and no password.** Anyone who can reach it can cancel your print,
> run any gcode, set the heaters and fans, and watch your camera. That is fine on your
> home network and it is a bad day anywhere else.
>
> - **Do NOT forward ports to it** (8085, 443, 7125, 9999, or anything else on the printer).
> - **Do NOT put it behind a public reverse proxy or tunnel** (Cloudflare Tunnel, ngrok and the like).
> - **Away from home?** Use a VPN back to your house (WireGuard, Tailscale, your router's VPN),
>   or just wait until you get home.
>
> The same goes for the printer itself: Creality's own ports have no real protection either.

## Contents

- [What you get](#what-you-get)
- [Screenshots](#screenshots)
- [Install](#install)
- [Print costs](#print-costs)
- [Pricing a file before you print it](#pricing-a-file-before-you-print-it)
- [Updating and removing](#updating-and-removing)
- [Building by hand](#building-by-hand)
- [API](#api)
- [What it touches on the printer](#what-it-touches-on-the-printer)
- [Troubleshooting](#troubleshooting)
- [Repo layout](#repo-layout)
- [Contact](#contact)

## What you get

- **Dashboard** at `http://<printer-ip>:8085`: live camera, the current job with a progress
  ring and finish time, temperature histograms, print controls, fans, chamber climate, a 3D
  view of the sliced toolpath that follows the nozzle, the CFS bays with per-bay filament
  assignment, the raw sensors, and the print library.
- **Print library**: every job the printer has run, with its thumbnail, the filament it
  used by material, the electricity, and what both cost. Old jobs are filled in from the
  printer's history the first time k2ctl starts.
- **Tray app** (Qt 6): status, pause/resume/cancel, filament bay swaps, fans, a webcam window,
  a sensors window, and a print cost estimator for files you have not printed yet.
- **Filament catalog**: third-party spools with the right temperatures, rainbow spools, and a
  warning before you put something in the CFS that doesn't belong there (TPU and the like).
- **JSON API** for all of the above, listed [below](#api).

## Screenshots

<table>
  <tr>
    <td width="36%" valign="top"><img src="docs/screenshots/phone.jpg" alt="Dashboard on a phone: live camera, job progress and temperatures"></td>
    <td valign="top">
      <img src="docs/screenshots/model-viewer.jpg" alt="3D view of the sliced toolpath">
      <br><br>
      <img src="docs/screenshots/filament-bays.png" alt="CFS bays and the external spool">
    </td>
  </tr>
</table>

The print library, with what each job cost:

![Print library](docs/screenshots/print-library.jpg)

<table>
  <tr>
    <td valign="top"><img src="docs/screenshots/job-detail.png" alt="One job: filament, electricity, how the power was worked out"></td>
    <td valign="top"><img src="docs/screenshots/prices.png" alt="Prices and power settings"></td>
  </tr>
  <tr>
    <td>One job, opened from the library.</td>
    <td>Spool prices, electricity price and the heater wattages. Saving reprices every job.</td>
  </tr>
</table>

The tray app's cost estimator, pricing a sliced gcode and an unsliced Creality Print project:

<img src="docs/screenshots/tray-cost.png" width="520" alt="Tray print cost estimator">

## Install

You need a Creality K2 with the root account turned on, a Linux desktop (Ubuntu, KDE neon,
Debian, anything that uses apt), and both on the same home network.

1. On the printer's touchscreen go to **Settings > Root account** and turn it on. Write down
   the password it shows you.
2. Find the printer's IP address under **Settings > Network** on the touchscreen.
3. Open a terminal on the desktop and paste this:

   ```
   gh repo clone sworrl/k2ctl ~/k2ctl && ~/k2ctl/install.sh
   ```

   The repo is private for now, so this uses the GitHub CLI (`gh auth login` first if you
   have never used it). Once it is public the one-liner works too:

   ```
   curl -fsSL https://raw.githubusercontent.com/sworrl/k2ctl/master/get.sh | bash
   ```

4. It asks for the printer's IP and the root password, installs the build tools it needs
   (sudo asks for YOUR password once for that), builds everything, copies the printer part
   over, and puts a K2 icon in your system tray. The first run takes a few minutes.

When it is done:

- Dashboard: `http://<printer-ip>:8085` in any browser on your home network.
- Tray icon: click it for the dashboard, right-click for the menu. It starts with your
  desktop from now on.
- On the printer, k2ctl starts on its own at every boot. It does not touch Klipper's config.

> [!WARNING]
> Keep it on your LAN. No port forwards, no public tunnels. VPN home if you want it while
> you are out. See the [warning at the top](#do-not-put-this-on-the-internet).

## Print costs

Every job gets a filament cost and an electricity cost, stored on the printer in
`/mnt/UDISK/k2ctl/jobs.json`. Jobs from before k2ctl was installed are filled in from
Moonraker's history.

**Filament** is the most accurate part:

- The length is what Klipper actually pushed through the extruder for that job, so purges,
  color-change flushes and cancelled prints count as they happened.
- The grams use each filament's density from the slicer footer of the gcode. A multicolor
  job is split between spools by the slicer's per-spool lengths.
- The price per kg comes from the table under **Prices** in the library. Put in what you
  actually pay. The defaults are rough US prices, only a starting point.

**Electricity** is a closer estimate than a flat wattage, but still an estimate:

- While k2ctl runs, it reads the bed and hotend heater duty from Klipper every 4 seconds and
  multiplies by the heater wattage, plus a base load for the board, motors, fans and CFS.
- Jobs (or parts of jobs) k2ctl did not watch are estimated from the bed and nozzle
  temperatures, with holding rates learned from the jobs it did watch. The job detail says
  how much of each job was metered.
- The hotend is 70 W (Creality's spec). Creality does not publish the K2's bed wattage, so
  700 W is a guess. If you have a plug-in power meter, run a print, compare, and fix the bed
  and base numbers under **Prices**. Every job reprices when you save.

## Pricing a file before you print it

Tray menu > **Estimate print cost…**, then pick one or more files, or drop them on the
window. You can also right-click a file in your file manager and open it with **K2 print
cost** (`k2ctl-tray --cost FILE...` from a terminal).

- `.gcode` from Creality Print or Orca: priced as is.
- `.3mf` Creality Print project: if it was saved after slicing, the gcode inside is used.
  If not, it is sliced headless with the Creality Print command line first (about 20
  seconds), one result per plate. The command line cannot slice multicolor projects; for
  those, slice in Creality Print, export the plate gcode, and pick that.
- `.stl` is not supported. It needs slicer settings to mean anything, so slice it first.

The estimate uses the same prices as the library, and scales the slicer's time by how long
this printer really takes against the slicer's number (the median over your completed jobs,
usually a few percent over). On the duct from the wind tunnel project the estimate said
257 g, 9h 50m and $5.11. The real print used 258 g over 9h 31m and cost $5.10.

## Updating and removing

- Update: run the install line again. It pulls, rebuilds and redeploys.
- Remove from the desktop: `~/k2ctl/install.sh --uninstall`
- Remove from the printer as well: `~/k2ctl/install.sh --uninstall --printer <ip>`

## Building by hand

Needs Go 1.22+, Node 18+, cmake, a C++ compiler, Qt 6 (Widgets, Network, and WebEngine for
the webcam window), `unzip` and Creality Print for the cost estimator's `.3mf` support, and
sshpass if you don't have an SSH key on the printer.

```
make web backend      # dashboard + a binary you can run on the desktop
make arm              # static ARMv7 binary for the printer
deploy/deploy.sh IP   # copy it over, install the init script, start it
make tray             # Qt tray app; cmake --install tray/build --prefix ~/.local
make run PRINTER=IP   # run the backend on the desktop against the printer instead
```

`install.sh` does all of that in order and takes `--desktop-only`, `--printer-only`,
`--no-autostart` and `--uninstall`. `./install.sh --help` lists them.

## API

Everything the dashboard and tray do goes through this. No auth, which is why it stays on
the LAN.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/status` | Merged printer state (Moonraker plus Creality's device socket) |
| GET | `/api/ws` | The same, pushed live over a WebSocket |
| GET | `/api/sensors` | Raw Klipper sensor objects and device socket fields |
| GET | `/api/temps/history` | Last hour of temperatures, 2 s steps |
| GET | `/api/profiles` | Filament catalog |
| POST | `/api/cfs/{box}/{slot}/material` | Set a CFS bay's filament |
| POST | `/api/print/{pause\|resume\|cancel}` | Job control (cancel needs `{"confirm":true}`) |
| POST | `/api/light`, `/api/fans`, `/api/chamber` | Light, fans, exhaust threshold |
| POST | `/api/gcode` | Run gcode |
| GET | `/api/files`, `/api/files/gcode` | Gcode files on the printer, and one file's contents |
| GET | `/api/jobs` | Print library: every job with grams, kWh and cost, plus totals |
| GET | `/api/jobs/{id}/thumb` | A job's slicer thumbnail |
| GET, POST | `/api/costs/settings` | Prices and wattages; POST reprices every job |
| POST | `/api/costs/estimate` | Price a sliced gcode: `{"name", "head", "tail"}` (first ~600 kB, last ~80 kB) |
| GET | `/api/history`, `/api/version` | Moonraker's raw history, k2ctl version |

## What it touches on the printer

- `/mnt/UDISK/k2ctl/`: the binary, `profiles.json`, `bays.json` (rainbow bay colors),
  `jobs.json` (the print library), `thumbs/` (job thumbnails, about 20 kB each), and
  backups of anything else we change.
- `/etc/init.d/k2ctl`: procd service, enabled, listens on 8085. `deploy/deploy.sh` puts
  it there and `install.sh --uninstall --printer IP` removes both.
- Optional, not done by the installer: `deploy/install-443.sh` moves Creality's own HTTPS
  from 443 to 8443 so k2ctl can serve a real certificate on 443
  (`deploy/PORT-443-NOTES.md` says how and why), `deploy/push-cert.sh` copies a Let's
  Encrypt cert over, and `deploy/printer-ui-logo.sh` puts our icon in the touchscreen's
  top bar. Each has `--revert`, and a firmware update undoes all three anyway. A real
  certificate is for your LAN browser. It does not make k2ctl safe to expose.

k2ctl talks to Moonraker on 7125 and Creality's device socket on 9999, both on the printer
itself. It does not use the Creality cloud and it never restarts Klipper.

## Troubleshooting

- **Dashboard does not load.** Check the IP, then `ssh root@<ip> 'logread | grep k2ctl | tail -30'`.
  `/mnt/UDISK` mounts late at boot; the init script waits up to two minutes for it.
- **Progress or layer count looks wrong.** The device socket sometimes reports numbers for
  a job it did not start (prints started from Moonraker or Fluidd). k2ctl checks them
  against Moonraker's file position and uses that instead when they disagree; the layer
  count is hidden then.
- **Library prices look off.** Set your spool prices under **Prices**. A job with its type
  "guessed from the filename" had no slicer footer; its grams are still Klipper's real
  length at the density for that type.
- **A `.3mf` will not price.** It is probably multicolor. Slice it in Creality Print,
  export the plate gcode, and pick that.
- **Scrolling is slow on an old machine.** The 3D view pauses while you scroll and stops
  drawing when it is off screen. If it is still slow, turn on "reduce motion" in your OS,
  which also turns off the background particles.

## Repo layout

- `cmd/k2ctl`, `internal/`: the Go backend (api, jobs, moonraker, cxws, profiles, state).
- `web/`: the dashboard (React, Vite). `make web` embeds the build into the Go binary.
- `tray/`: the Qt 6 tray app and the cost estimator window.
- `tools/filaments/`: the catalog and preset generator.
- `deploy/`: printer install, init script, cert push, port 443 shim, touchscreen icon.
- `docs/`: `printer-api.md` (what the K2 exposes on the LAN, mapped by hand),
  `touchscreen-ui.md` (how the stock screen app works and the plan to replace it),
  `filaments.md`, and `screenshots/`.
- `re/`: reverse engineering notes and tools for the touchscreen UI.

Read `docs/` before touching the printer side. The watchdog and port notes are there
because we hit them.

## Contact

Questions, bugs, or a K2 variant it does not handle: github@falcontechnix.com

<p align="center">
  <a href="https://falcontechnix.com"><img src="assets/ft-logo-full.png" width="180" alt="Falcon Technix"></a><br>
  <sub>a Falcon Technix tool</sub>
</p>
