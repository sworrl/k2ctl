# K2 touchscreen: how the stock UI works, and how to replace it

Mapped 2026-09-10 from the running printer (firmware Klipper `09faed31-dirty`, OpenWrt
21.02, kernel 5.4.61 armv7l, glibc 2.29). Raw material lives in `re/` (binary, strings,
`ui-map.json`, screenshot tools). Nothing here needs the printer's cloud account.

## 1. Hardware and kernel interfaces

| Item | Fact |
|---|---|
| Panel | 4.3" 480×800 portrait MIPI panel (`lcm_id=st7701_9bit_mipi_tjc_480_800`), used in landscape by the UI (rotated 90° in software) |
| Framebuffer | `/dev/fb0`, 480×800, 32 bpp BGRA, stride 1920, double buffered (virtual 480×1600); `disp_reserve=1536000` bytes reserved |
| Touch | GT9xx capacitive controller, `/dev/input/event0` (multitouch protocol B: ABS_MT_TRACKING_ID/POSITION_X/Y + BTN_TOUCH); `/dev/input/by-id/usb_keyboard` optional |
| Sleep | the UI blanks fb0 to black on idle; any touch wakes it. Capture works with `re/tools/screenshot.sh` (taps if blank, dumps fb0, rotates) |
| SoC / RAM | 2-core ARMv7, ~500 MB RAM, ~280 MB free with everything running |
| Toolchain target | armhf, glibc 2.29, so cross-build with `arm-linux-gnueabihf` and link **statically** (Ubuntu's glibc is far newer); Go static binaries (GOARM=7) already work (k2ctl) |

## 2. Process model

`/etc/init.d/app` starts these under procd, each with only `HOME=/root`:
`master-server`, `audio-server`, `wifi-server`, `app-server`, `display-server`,
`upgrade-server`, `web-server`, `Monitor`. There is no respawn in procd; **`Monitor`
is the watchdog**: if `display-server` dies it relaunches it within ~5 s
(`killall display-server` is therefore the safe way to reload UI resources; `setsid`
does not exist on the box).

- `master-server`: the hub. Owns the state shared-memory segments, a UNIX socket
  `/tmp/sys_sock`, talks to Klipper via `/tmp/klippy_uds`, writes `master-server.log`.
- `display-server`: the touchscreen app (this document). 2.6 MB stripped ARM ELF,
  statically linked **LVGL 8.x** (log strings reference `lv_conf.h`, anim timelines,
  `LV_IMG_CACHE_DEF_SIZE = 0`, i.e. images are re-decoded from disk on every draw, which
  is why file swaps take effect on restart with no cache to flush).
  Links: libpng16, libjpeg, freetype (fonts), json-c, protobuf-c, inotifytools, fmtlog,
  openssl. 8 threads (7 UI/comms + `memCheck`).
- `web-server`: libhv HTTP/WebSocket server: :80 (thumbnails etc.), :443 (self-signed
  "My Server / My Private CA" cert, `/` is 404) and **:9999 JSON WebSocket** (what
  Creality Print and k2ctl use). Ports are compiled defaults (it accepts `-p`/`-c` but is
  launched without args and ignores a config file). k2ctl owns 443 by loading
  `/lib/k2ctl-bindshim.so` through `/etc/ld.so.preload`; the shim remaps bind() 443 to 8443
  only inside the process named `web-server`, so Creality's HTTPS moves to 8443 and the
  stock binary stays untouched (`deploy/install-443.sh`, `deploy/PORT-443-NOTES.md`). A
  wrapper script at `/usr/bin/web-server` does not work: Monitor checks the path and
  restart-loops.
- `cam_app`: camera, `/tmp/delivery_socket100`; WebRTC signaling on :8000.
- Klipper + Moonraker (:7125) + Fluidd (:4408 via nginx) are stock.

## 3. How display-server talks to the rest

It opens **no network sockets**. Everything goes through shared memory + semaphores
created by master-server (POSIX shm in `/tmp/shm`):

| Segment | Content (from names in the binary) |
|---|---|
| `device_state_shm` / `device_state_sem` | temperatures, fans, print job, positions, network, error state |
| `materail_box_shm` (sic) / `materail_box_sem` | CFS inventory (boxes, bays, colors, RFID) |
| `print_object_shm` | exclude-object list of the running job |
| `dev_maintain_shm` | maintenance counters (nozzle, belts, cleaning) |

Messages are **protobuf-c** structs (`Message/ServerMessage.c` has 526 log points).
58 message types are compiled in, e.g. `material_box`, `material_box_config`,
`material_info`, `modify_material_info`, `multi_color`, `multi_color_print`,
`refresh_rfid_material`, `dry_box`, `print_work_info`, `extruder`, `heater_bed`,
`chamber`, `multi_fan`, `axis_position_info`, `app_control_print`, `web_control_print`,
`dis_control_print`, `file_control`, `get_gcode_file_list`, `local_gcode_info`,
`history_record(_list)`, `upgrade_info`, `wifi_info`, `networks_info`, `system_setting`,
`system_config_proto`, `voice_commands`, `ai_control_prefer`, `delay_image_*` (time-lapse),
`power_loss_prefer`, `temp_auto_pid_prefer`, `auto_pid_result`, `report_auto_level_res`,
`export_log_state`, `set_maintain_item`, `updata_error_info`. Full list:
`grep -oE '^[a-z0-9_]+__pack$' re/strings.txt`.

It also watches files with inotify (`/tmp/creality/...`, `/tmp/load_done`,
`/tmp/.mcu_version`), reads JSON configs via json-c (`cxsw_params.json`,
`current_work_info.json`, `device_structure_config.json`, `fault_code_info.json`,
`defData/error_code_map.json`, `delay_image_info.json`, `iotprint_info.json`,
`cam_detect_config.json`) and the user identity from
`/mnt/UDISK/creality/userdata/cloud/{user_info.json,user_avatar.png}` (log lines
`cxyusername:%s, userid:%s, imgsrc:%s`, `UserImg file path`).

Material identities come from `/etc/sysConfig/defData/material/F021_material_database.json`
(38 entries for this model, slicer-preset style `kvParam` blocks with a single
`default_filament_color`; there is no multi-color notion anywhere on the printer, which
is why k2ctl keeps rainbow bays in its own `bays.json`). Bays with a non-Creality vendor
get rfid `"0"`.

## 4. Resources

- Images: `/etc/sysConfig/UIResource/K1/` (207 files; the K2 reuses the K1 set,
  the `K1_Max` dir holds 15 overrides). PNG RGBA, natural sizes; LVGL draws them 1:1
  except where the code zooms (the avatar overlay is stretched into a 43 px box).
- Fonts: FreeType, `/etc/sysConfig/defData/SourceHanSansCN-Normal.otf` (opened 4×, one
  per size); UI text is compiled-in English/Chinese/German… strings selected by
  `ui_Screen_Changelanguage.c`, not external language files.
- Boot/branding images: `img_logo_animation.gif` (426×360 boot animation),
  `img_boot4.png`, `img_k2_s1_boot_machine.png`, `img_f028_boot_machine.png`.

### Screens

The binary was built from `k1_horizontal_ui/ui_Screen_*.c` (84 screen/widget sources;
list in `re/ui-map.md`, with the images each references in link order and sample
texts). The important ones:

| Screen | Purpose | Notable images |
|---|---|---|
| `ui_screen_PrintHome` | home: avatar+nickname, camera/wifi icons, file card, CFS card, temps | `img_small_default_user_avatar` (41²), `img_home_user_mask` (43², overlay scaled onto the avatar), `img_new_camera` (39²), `img_new_wifi_{low,mid,high}` (38×39), `img_auto_drying` (33×32) |
| `ui_screen_multi_color_box` / `_printer` / `_common` | CFS bays, color matching, load/unload | 26 + 12 images (bay shapes, arrows, dryer) |
| `ui_screen_material_info` | edit a bay (vendor/type/color/temps) | text only |
| `ui_screen_Preview`, `ui_screen_FileManage`, `ui_screen_SubDir` | file browser + thumbnails | `file_icon`, `folder_icon`, `file_preview` from defData |
| `ui_Screen_Settings`, `ui_Screen_AboutDevice`, `ui_Screen_NetworkInfo`, `ui_Screen_TimezoneSettings`, `ui_Screen_Changelanguage`, `ui_Screen_RootAccountInfo`, `ui_Screen_RootPolicy` | settings tree | 13 + 9 images |
| `ui_screen_AxisMove`, `ui_Screen_HotBedManualAdjust`, `ui_Screen_BedMeshAdjust`, `ui_screen_ExpertZoffset`, `ui_screen_Expert{HotPid,BedPid,Traffic}` | control / calibration | 15 + 3 + 6 + 4 + 2 images |
| `ui_Screen_ManualDrySetting`, `ui_Screen_AutoDrySetting` | CFS dryer | 17 images |
| `ui_screen_DetectionAI`, `ui_screen_camera_settings`, `ui_screen_CameraList`, `ui_screen_VedioInfo` | AI detection, camera, time-lapse | |
| `ui_Screen_Selftest*`, `ui_Screen_Machine*`, `ui_Screen_FactoryTest`, `ui_Screen_LaserTest` | first-run wizard and factory tests | |
| `ui_custom_*` (messagebox, reminderbox, numbers_keys, print_opt, print_history) | shared widgets | |
| `custom/lvgl_horizontal_screen_interface.c`, `custom/lvgl_cmd.c`, `custom/mystyle.c` | screen router, command dispatch, theme | |

### What the home top bar can and cannot show

Layout is compiled C; only PNG contents can change. Verified by experiment (and
reverted): a wider `img_home_user_mask.png` is scaled into the 43 px avatar box, it does
not extend beside the nickname. Options that work: swap `img_new_camera.png` (tap
still opens the camera; this is what `deploy/printer-ui-logo.sh` does with the K2CTL icon), use the falcon as the Creality Cloud avatar (native), or
replace the boot animation. Backups of any swapped original go to
`/mnt/UDISK/k2ctl/ui-backup/`; a firmware update restores stock files.

## 5. Building our own UI

The plan below keeps Creality's stack as is and swaps only the screen app:

1. **App**: LVGL 9 in C, statically linked (`arm-linux-gnueabihf-gcc -static`), using
   LVGL's built-in Linux `fbdev` display driver (`/dev/fb0`, set rotation 90°) and
   `evdev` input driver (`/dev/input/event0`). No X/Wayland, no GPU. LVGL 9 ships the
   PNG decoder (lodepng) and TTF via FreeType or its own font converter; reuse
   SourceHanSans for CJK if wanted.
2. **Data**: do not touch the protobuf/shm bus. Read everything from **k2ctl**
   (`http://127.0.0.1:8085/api/status`, `/api/sensors`, `/api/ws`) and write through
   its API (`/api/cfs/{box}/{slot}/material`, `/api/print/*`, `/api/light`,
   `/api/gcode`). k2ctl already normalizes Moonraker + the :9999 socket, so the UI
   is a thin renderer; multi-color/rainbow bays render from the `colors` array.
   For things k2ctl does not yet expose (file browser, wifi setup, calibration
   wizards) add endpoints to k2ctl first, backed by Moonraker (`/server/files`,
   `/printer/gcode/script`) and the :9999 socket (`wifi`, `boxConfig`, `ctrlVideoFiles`).
3. **Taking over the panel**: Monitor and procd find the screen app by process name, so
   the replacement has to be called `display-server` too. Move the stock binary to
   `/mnt/UDISK/k2ctl/orig/display-server` (same trick as the web-server port shim) and
   install ours as `/usr/bin/display-server`. Keep a "stock UI" menu entry that execs
   the original, and a one-line SSH restore in `deploy/`. Verify with
   `re/tools/screenshot.sh`.
4. **Skinning / customization**: keep all colors, images and layout in a JSON theme
   file on `/mnt/UDISK/k2ctl/ui/` that the app reloads on SIGHUP, so users edit a file
   (or the dashboard) rather than recompiling.
5. **Risks**: two apps must never own fb0/event0 at once (stop display-server first);
   screen blanking/backlight is handled by the stock app, so ours must implement the
   idle timer (blank the fb, wake on touch); first-run wizards and firmware-update
   prompts live in the stock UI, so keep the "stock UI" escape hatch.

Rough effort: a first usable set of screens (home, CFS, temps, print control) is a few
days of LVGL work once the cross toolchain builds. The wizard and calibration screens are
the long tail and can stay on the stock UI for as long as we want.
