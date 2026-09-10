# Creality K2 (F021): what the printer exposes on the LAN

Mapped 2026-09-09 against firmware with Klipper `09faed31-dirty`, CFS unit
firmware 1.5.0, printer model code `F021`, hostname `K2-3EA5` ("The Means"),
IP 192.168.13.215. Everything below is what `k2ctl` builds on.

## Ports

| Port | Service | Notes |
|---|---|---|
| 22 | dropbear SSH | root; password is generated when "Root account" is enabled on the touchscreen |
| 80 | nginx (Creality UI) | `/` is 404; hosts the printer's own web pages |
| 4408 | Fluidd | full Klipper UI |
| 7125 | Moonraker | REST + WebSocket, no auth on LAN |
| 8000 | video service | WebRTC signaling at `/call/webrtc_local` (POST); every other path answers 200 with an empty body |
| 9999 | Creality device socket | JSON WebSocket, the protocol Creality Print's device page uses |
| 8080 | (closed) | K1-series MJPEG port; not present on the K2 |

## Moonraker (7125)

Standard Moonraker API. Useful objects (`GET /printer/objects/query?a&b`):

- `extruder`, `heater_bed`, `temperature_sensor chamber_temp`, `temperature_fan chamber_fan`,
  `heater_fan hotend_fan`, `temperature_sensor mcu_temp`
- `print_stats` (state `standby|printing|paused|complete|cancelled|error`, filename, durations, `info.current_layer/total_layer`),
  `display_status.progress`, `virtual_sdcard`, `toolhead.position`, `gcode_move.speed_factor/extrude_factor`, `fan.speed`
- `output_pin fan0|fan1|fan2|LED|board_dissipation_fan|...`, `filament_switch_sensor filament_sensor`, `system_stats`, `mcu`, `mcu nozzle_mcu`, `mcu rpi`
- **`box`**: Creality's CFS object. Per unit `T1..T4`: `state`, `filament` (bay letter feeding), `temperature`,
  `dry_and_humidity`, `sn`, `version`, `material_type[4]`, `color_value[4]`, `vender[4]`, `remain_len[4]`;
  plus `map` (gcode tool `T1A` -> physical bay, per current job), `same_material`, `auto_refill`, `filament_useup`.
- `filament_rack` (external spool holder).

Print control: `POST /printer/print/pause|resume|cancel`. Macros of interest: `BOX_INFO_REFRESH`,
`BOX_LOAD_MATERIAL`, `BOX_QUIT_MATERIAL`, `LOAD_MATERIAL`, `QUIT_MATERIAL`.
`GET /server/webcams/list` is empty: the camera is not registered with Moonraker.

## Creality device socket (9999)

Plain WebSocket, JSON text frames, no auth. On connect the printer streams a full state object, then
partial updates (often just `{"nozzleTemp":..,"bedTemp0":..}`).

Client -> printer:

```json
{"method":"get","params":{"boxsInfo":1,"boxConfig":1,"reqMaterials":1,"reqGcodeFile":1,"getToken":1,"cfsList":1,"nozzleList":1}}
{"method":"set","params":{ ...one of the keys below... }}
```

`set` keys seen in the stock UI: `gcodeCmd`, `feedInOrOut`, `feedOption`, `opGcodeFile`, `modifyMaterial`,
`setPosition`, `errorHandling`, `stop`, `pause`, `cleanErr`, `autohome`, `repoPlrStatus`, `deleteHistory`,
`ctrlVideoFiles`, `boxConfig`, `colorMatch`, `loadNozzle`, `videoElapse`, `speedMode`, `modelFanPct`,
`lightSw`, `fanCase`, `fanAuxiliary`, `fan`, `excludeObjects`.

State fields (selection): `state` (0 standby, 1 printing, 5 seen after a finished job; Moonraker's
`print_stats.state` is the reliable one), `deviceState`, `nozzleTemp`/`targetNozzleTemp`/`maxNozzleTemp`,
`bedTemp0`/`targetBedTemp0`/`maxBedTemp`, `boxTemp`/`targetBoxTemp`/`maxBoxTemp` (chamber),
`printFileName`, `printProgress`, `printLeftTime`, `printJobTime`, `printStartTime`, `layer`, `TotalLayer`,
`lightSw`, `modelFanPct`, `caseFanPct`, `auxiliaryFanPct`, `curFeedratePct`, `curFlowratePct`,
`realTimeSpeed`, `realTimeFlow`, `curPosition`, `usedMaterialLength`, `pressureAdvance`, `cfsConnect`,
`materialStatus`, `hostname`, `deviceName`, `model` (`F021`), `modelVersion`, `err {errcode,key}`,
`video`, `webrtcSupport`, `videoElapse*`.

### CFS inventory (`boxsInfo`)

```json
{"boxsInfo":{"enable":1,"colorMatch":[{"id":"T1A","boxId":1,"materialId":1}],
 "same_material":[["009001","0ffffff",[{"boxId":1,"materialId":0}],"PLA"], ...],
 "materialBoxs":[
  {"id":0,"type":1,"state":0,"materials":[{"id":0,"vendor":"Creality","type":"PLA","name":"Hyper PLA","rfid":"01001","color":"#0ffffff",
     "minTemp":190,"maxTemp":240,"pressure":0.04,"percent":100,"selected":0,"editStatus":1,"state":1}]},
  {"id":1,"type":0,"materialBoxName":"MF003","sn":"1000...","temp":28.0,"humidity":27.0,"state":1,
   "materials":[{"id":0,...},{"id":1,...},{"id":2,...},{"id":3,...}]}]}}
```

- `type` 1 = external spool holder (`id` 0), `type` 0 = CFS unit; bays `id` 0..3 = A..D, so box 1 bay 0 is `T1A`.
- `rfid` is Creality's material-database id (same ids as `materialList.json` in Creality Print:
  `01001` Hyper PLA, `06001` CR-PETG, `07002` Hyper PC, `09001` EN-PLA+, ...). Moonraker's `box.material_type`
  is the same id with a leading `0`.
- Colors are `#0RRGGBB` (a leading zero nibble).

### Writing a bay (`modifyMaterial`)

```json
{"method":"set","params":{"modifyMaterial":{"boxId":1,"boxType":0,"id":0,"rfid":"","type":"PC",
  "vendor":"Polymaker","name":"PolyLite PC Clear","color":"#0ffffff","minTemp":250.00000001,"maxTemp":270.00000001,"pressure":0.03}}}
```

The stock UI adds `1e-8` to the temperatures to force floats. Observed behavior: `vendor`, `name`,
`type`, color, temperatures and PA are stored as sent; `rfid` is kept only for Creality-branded
entries the printer knows, otherwise it is stored as `"0"` and `box.material_type` becomes `"0"`
(harmless, but `same_material` grouping and the slicer's "sync from CFS" then fall back to type-only
matching). Reset a bay with all-empty strings and zero temperatures.

`colorMatch` is per-gcode-file: `{"colorMatch":{"path":"<gcode path>","list":[{"id":"T1A","boxId":1,"materialId":0},...]}}`.
The slicer sets it when sending a job; do not change it while a job is running.

## Fans

Mapped 2026-09-10 on the K2 (F021), printer idle. Three controllable fans; the printer's
own naming in the socket state is `modelFanPct` / `auxiliaryFanPct` / `caseFanPct` (0..100)
plus the on/off flags `fan` / `fanAuxiliary` / `fanCase`.

| k2ctl key | Creality name | Klipper pin | M106 index | socket on/off key |
|---|---|---|---|---|
| `part` | model fan | `output_pin fan0` (nozzle_mcu PB15) + `fan0_en` | `P0` | `fan` |
| `aux` | auxiliary (side) fan | `output_pin fan2` (`multi_pin:heater_fan2`) | `P2` | `fanAuxiliary` |
| `chamber` | case fan | `output_pin fan1` (`multi_pin:chassis_fan`) | `P1` | `fanCase` |

(`temperature_fan chamber_fan` on `multi_pin:filter_fan` is the temperature-controlled
filter fan with a 35 °C target; it is not user-set and k2ctl leaves it alone.)

What works (verified by watching both the socket state and the Klipper pins):

- **Percentages: only via g-code.** `M106 P<idx> S<0..255>` through Moonraker
  (`POST /printer/gcode/script`) sets the fan; `M107 P<idx>` turns it off (a bare `M107`
  only clears fan0 and fan2, never the case fan). The socket `set` keys `modelFanPct`,
  `auxiliaryFanPct`, `caseFanPct` are **ignored** whether the fans are on or off.
- **On/off via the socket** works: `{"method":"set","params":{"fanAuxiliary":1}}` drives
  fan2 to 100 %, `fanCase` drives fan1, `fan` drives fan0 (and `fan0_en`). Setting `fan=1`
  reported all three percentages as 100 in the next state frame.
- The Klipper pin value is the duty after the firmware's fan curve, not the requested
  percent (30 % gives 0.370 on fan0, 40 % gives 0.635 on fan2, 50 % gives 0.600 on fan1), so k2ctl
  reads the percentage from the socket fields (which echo the requested value, e.g. 30/40/50
  after the M106s above) and uses the pins only for on/off and as a fallback.
- The socket pushes the fan fields lazily (they were not updated after the individual
  aux/case writes, only after the next full push), so k2ctl records what it asked for
  immediately and lets the next state frame confirm it.
- A running print re-asserts the sliced fan settings; manual changes are for idle use
  or temporary overrides.

k2ctl: `GET /api/fans`, `POST /api/fans` (`{part|aux|chamber: pct}` and/or
`{part_on|aux_on|chamber_on: bool}`), `POST /api/fans/recommended` (`{profile?}`) ; the
recommendation comes from the catalog profile of the feeding bay (`fans.part_max/aux/exhaust`
from the Creality Print preset) or material-type defaults.

## Camera (8000)

The K2 advertises `webrtcSupport:1`; there is no MJPEG endpoint. Signaling is one
HTTP round trip to the video service, exactly what Creality Print's device page does:

```
POST http://<printer>:8000/call/webrtc_local      Content-Type: text/plain
body:  base64( {"type":"offer","sdp":"<complete SDP, ICE gathering finished>"} )
reply: base64( {"type":"answer","sdp":"..."} )    (H.264 baseline only, host ICE candidates)
```

GET on that path returns `{}`; a malformed body also returns `{}` with HTTP 200. k2ctl
relays it as `POST /api/camera/offer` (JSON `{type,sdp}` in, JSON answer out) so an HTTPS
dashboard can use it without mixed-content problems; the media itself flows directly
from the printer to the browser over UDP. Because the answer arrives in one shot, the browser must
finish ICE gathering before sending the offer (see `web/src/components/CameraCard.tsx`).
Two things the stock page does that matter: it offers a single H.264 payload (baseline
42e01f, packetization-mode 1) with a `sendrecv` transceiver, and it runs in a browser that
sends real host candidates. Chrome and Firefox hide host candidates behind mDNS names
(`xxxx.local`) when the page has no camera/mic permission; the printer cannot resolve those,
never learns a usable remote candidate, and DTLS sits in "connecting" forever with ICE
already "connected". k2ctl's relay rewrites those names to the requesting client's LAN
address before forwarding, after which DTLS completes and 1280x720 H.264 arrives at
about 15 fps.
Printers with the `videoInfo.videoEncryption` feature use `https://<printer>/call/webrtc_local`
with a token instead; this one does not.

## On-printer environment

OpenWrt 21.02 (procd init, `/etc/init.d/*`), ARMv7 (armv7l, 2 cores, ~500 MB RAM), user data on
`/mnt/UDISK` (`printer_data/gcodes`, `printer_data/config`, logs). `k2ctl` is a static Go binary
(GOARCH=arm GOARM=7) installed to `/mnt/UDISK/k2ctl` and started by `/etc/init.d/k2ctl`.
