#!/usr/bin/env python3
"""Generate Creality Print user filament presets for third-party filaments.

Each profile inherits a Creality-tuned Creality K2 (F021) system preset (speeds, cooling
ramps, start g-code, CFS ramming...) and overrides only the manufacturer-
specific numbers (temps, density, cost, fan policy). Output is written in the
same "diff-from-parent" JSON format Creality Print writes itself, plus the
.info sidecar it expects.

Usage:
  gen_filaments.py               # write every profile that doesn't exist yet
  gen_filaments.py --only PC     # only names matching substring (case-insens.)
  gen_filaments.py --force       # overwrite existing (drops in-app edits!)
  gen_filaments.py --list        # show what would be written
  gen_filaments.py --nozzles 0.4 0.6
Close Creality Print before running, it caches presets on start.
"""
import argparse, json, os, sys, time, glob, re

HOME = os.path.expanduser("~")
CONF = f"{HOME}/.config/Creality/Creality Print/7.0"
SYS_FIL = f"{CONF}/system/Creality/filament"
PRINTER = "Creality K2"   # F021: Creality K2 (standard/combo), bed 262x262x270
MARK = "[gen_filaments]"

def vendor_version():
    j = json.load(open(f"{CONF}/system/Creality.json"))
    # the app normalises "26.07.18.17" to "26.7.18.17" when it writes presets
    return ".".join(str(int(x)) for x in j["version"].split("."))

def user_dir():
    c = json.load(open(f"{CONF}/Creality.conf"))
    folder = c.get("preset_folder") or c.get("app", {}).get("preset_folder") or "default"
    return folder, f"{CONF}/user/{folder}/filament"

# ---------------------------------------------------------------------------
# Profile table. Keys:
#   vendor, name  -> preset shown as "<vendor> <name> @Creality K2 X nozzle"
#   ftype         -> override filament_type when the base is a stand-in (K2 has no PC preset)
#   base          -> system preset prefix to inherit (must exist for the nozzle)
#   nozzle        -> print temp; first -> first-layer temp (default = nozzle)
#   lo/hi         -> manufacturer nozzle range
#   bed           -> plate temp (all plate types); bed_first optional
#   fan           -> (min,max) part-cooling %; chamber -> chamber target C
#   density, cost ($/kg), vol (max volumetric mm3/s), tg (softening C)
#   pa            -> pressure advance override
#   notes         -> free text (drying, plate prep, source)
#   src           -> manufacturer/retailer URL the numbers came from (appended to notes)
#   cfs           -> True/False: may this spool live in a CFS bay? (default: by type,
#                    flexible filament is refused); cfs_reason -> why not
#   warn          -> list of short user-facing cautions; dry -> (temp_c, hours)
#   base may be a tuple of candidates; the first system preset that exists is used
# Numbers are the manufacturers' published ranges; the chosen point is what
# works on an enclosed high-flow machine. Tune flow/PA per spool in-app.
# ---------------------------------------------------------------------------
P = []
def add(**k): P.append(k)

# ---- Polymaker -------------------------------------------------------------
add(vendor="Polymaker", name="PolyLite PC Clear", base="Hyper ABS", ftype="PC", nozzle=265, lo=250, hi=270,
    bed=105, fan=(0, 15), chamber=50, density=1.19, cost=40, vol=12, tg=113,
    notes="Polymaker PolyLite PC (transparent). Mfr: 250-270C nozzle, 90-105C bed, fan OFF, "
          "dry 75C/12h if wet. Fan kept near zero and flow capped at 12mm3/s for clarity and "
          "layer bonding; preheat bed 10-15min before start. Glue stick / Magigoo PC on the plate.")
add(vendor="Polymaker", name="PolyMax PC", base="Hyper ABS", ftype="PC", nozzle=260, lo=250, hi=270,
    bed=100, fan=(0, 20), chamber=50, density=1.19, cost=45, vol=14, tg=113,
    notes="Polymaker PolyMax PC. Mfr: 250-270C nozzle, 90-105C bed, fan OFF, dry 75C/12h. Anneal 90C/2h for max strength.")
add(vendor="Polymaker", name="PolyLite PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230,
    bed=55, density=1.24, cost=20, vol=16, tg=60,
    notes="Polymaker PolyLite PLA. Mfr: 190-230C nozzle, 25-60C bed, fan ON.")
add(vendor="Polymaker", name="PolyTerra PLA", base="Hyper PLA", nozzle=210, lo=190, hi=230,
    bed=55, density=1.31, cost=20, vol=14, tg=60,
    notes="Polymaker PolyTerra PLA (matte). Mfr: 190-230C nozzle, 25-60C bed, fan ON. Softer/more brittle than standard PLA; keep retraction modest.")
add(vendor="Polymaker", name="PolyLite PETG", base="Hyper PETG", nozzle=240, lo=230, hi=240,
    bed=75, fan=(30, 60), density=1.25, cost=22, vol=12, tg=80,
    notes="Polymaker PolyLite PETG. Mfr: 230-240C nozzle, 70-80C bed, fan 30-60%%. Dry 65C/6h if stringy.")
add(vendor="Polymaker", name="PolyLite ABS", base="Hyper ABS", nozzle=255, lo=245, hi=265,
    bed=95, fan=(0, 30), chamber=50, cost=22, vol=14, tg=100,
    notes="Polymaker PolyLite ABS. Mfr: 245-265C nozzle, 90-100C bed, fan OFF/low. Keep the door closed.")
add(vendor="Polymaker", name="PolyLite ASA", base="Generic ASA", nozzle=250, lo=240, hi=260,
    bed=90, fan=(0, 30), chamber=50, cost=25, vol=12, tg=100,
    notes="Polymaker PolyLite ASA. Mfr: 240-260C nozzle, 75-95C bed, fan OFF/low.")
add(vendor="Polymaker", name="PolyFlex TPU95", base="Generic TPU", nozzle=225, lo=210, hi=230,
    bed=40, density=1.22, cost=35, vol=3, tg=60,
    notes="Polymaker PolyFlex TPU95 / TPU95-HF. Mfr: 210-230C nozzle, 25-60C bed. Not CFS-feedable; load direct.")

# ---- Bambu Lab -------------------------------------------------------------
add(vendor="Bambu", name="PLA Basic", base="Hyper PLA", nozzle=220, lo=190, hi=230,
    bed=55, density=1.24, cost=20, vol=18, tg=60,
    notes="Bambu Lab PLA Basic. Mfr: 190-230C nozzle (220 rec), 35-65C bed. Dry 55C/8h if needed.")
add(vendor="Bambu", name="PLA Matte", base="Hyper PLA", nozzle=220, lo=190, hi=230,
    bed=55, density=1.31, cost=20, vol=16, tg=60,
    notes="Bambu Lab PLA Matte. Mfr: 190-230C nozzle, 35-65C bed. Abrasive-ish; lower flow than Basic.")
add(vendor="Bambu", name="PETG HF", base="Hyper PETG", nozzle=250, lo=240, hi=270,
    bed=70, fan=(30, 80), density=1.27, cost=20, vol=18, tg=75,
    notes="Bambu Lab PETG HF. Mfr: 240-270C nozzle (250 rec), 65-75C bed. Dry 65C/8h.")
add(vendor="Bambu", name="ABS", base="Hyper ABS", nozzle=260, lo=240, hi=270,
    bed=95, chamber=50, density=1.04, cost=20, vol=18, tg=100,
    notes="Bambu Lab ABS. Mfr: 240-270C nozzle (260 rec), 90-100C bed, enclosed. Dry 80C/8h.")
add(vendor="Bambu", name="ASA", base="Generic ASA", nozzle=260, lo=240, hi=270,
    bed=95, fan=(10, 40), chamber=50, density=1.05, cost=25, vol=14, tg=100,
    notes="Bambu Lab ASA. Mfr: 240-270C nozzle, 90-100C bed, enclosed. Dry 80C/8h.")
add(vendor="Bambu", name="PC", base="Hyper ABS", ftype="PC", nozzle=270, lo=260, hi=290,
    bed=105, fan=(0, 20), chamber=50, density=1.19, cost=40, vol=14, tg=115,
    notes="Bambu Lab PC. Mfr: 260-290C nozzle (270 rec), 90-110C bed, fan low, enclosed. Dry 80C/8h. Glue on plate.")
add(vendor="Bambu", name="TPU 95A HF", base="Generic TPU", nozzle=230, lo=220, hi=240,
    bed=35, density=1.20, cost=35, vol=6, tg=60, pa=0.2,
    notes="Bambu Lab TPU 95A HF. Mfr: 220-240C nozzle, 30-35C bed. HF grade tolerates ~6mm3/s. Not CFS-feedable.")

# ---- SUNLU -----------------------------------------------------------------
add(vendor="SUNLU", name="PLA", base="Hyper PLA", nozzle=215, lo=200, hi=230, bed=55, density=1.24, cost=15, vol=15, tg=60,
    notes="SUNLU PLA. Mfr: 200-230C nozzle, 50-65C bed.")
add(vendor="SUNLU", name="PLA+", base="Hyper PLA", nozzle=220, lo=205, hi=230, bed=60, density=1.23, cost=16, vol=15, tg=60,
    notes="SUNLU PLA+. Mfr: 205-225C nozzle, 50-65C bed. Tougher than PLA; slightly hotter.")
add(vendor="SUNLU", name="PETG", base="Hyper PETG", nozzle=240, lo=220, hi=250, bed=75, fan=(30, 60), density=1.27, cost=16, vol=12, tg=80,
    notes="SUNLU PETG. Mfr: 220-250C nozzle, 70-80C bed. Dry 65C/6h.")
add(vendor="SUNLU", name="ABS", base="Hyper ABS", nozzle=250, lo=230, hi=260, bed=100, chamber=50, density=1.04, cost=16, vol=14, tg=100,
    notes="SUNLU ABS. Mfr: 230-260C nozzle, 90-110C bed, enclosed.")
add(vendor="SUNLU", name="TPU 95A", base="Generic TPU", nozzle=220, lo=200, hi=230, bed=40, density=1.21, cost=22, vol=3, tg=60,
    notes="SUNLU TPU 95A. Mfr: 200-230C nozzle, 25-60C bed. Slow; not CFS-feedable.")

# ---- Overture --------------------------------------------------------------
add(vendor="Overture", name="PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=55, density=1.24, cost=18, vol=15, tg=60,
    notes="Overture PLA. Mfr: 190-230C nozzle (200-220 rec), 50-60C bed.")
add(vendor="Overture", name="PLA Pro", base="Hyper PLA", nozzle=220, lo=190, hi=230, bed=55, density=1.24, cost=20, vol=15, tg=60,
    notes="Overture PLA Professional (PLA+). Mfr: 190-230C nozzle (210-220 rec), 50-60C bed.")
add(vendor="Overture", name="PETG", base="Hyper PETG", nozzle=240, lo=230, hi=250, bed=80, fan=(30, 60), density=1.27, cost=20, vol=12, tg=80,
    notes="Overture PETG. Mfr: 230-250C nozzle, 80-90C bed. Dry 65C/6h.")
add(vendor="Overture", name="ABS", base="Hyper ABS", nozzle=250, lo=230, hi=260, bed=100, chamber=50, density=1.04, cost=18, vol=14, tg=100,
    notes="Overture ABS. Mfr: 230-260C nozzle, 90-110C bed, enclosed.")
add(vendor="Overture", name="TPU 95A", base="Generic TPU", nozzle=220, lo=210, hi=230, bed=40, density=1.21, cost=25, vol=3, tg=60,
    notes="Overture TPU 95A. Mfr: 210-230C nozzle, 25-60C bed. Slow; not CFS-feedable.")

# ---- Hatchbox --------------------------------------------------------------
add(vendor="Hatchbox", name="PLA", base="Hyper PLA", nozzle=210, lo=180, hi=220, bed=55, density=1.24, cost=22, vol=12, tg=60,
    notes="Hatchbox PLA. Mfr: 180-210C nozzle, 50-60C bed. Runs cool; flow capped at 12mm3/s so it doesn't starve at speed. Raise to 215-220 if extrusion clicks.")
add(vendor="Hatchbox", name="PETG", base="Hyper PETG", nozzle=245, lo=230, hi=260, bed=80, fan=(30, 60), density=1.27, cost=24, vol=12, tg=80,
    notes="Hatchbox PETG. Mfr: 230-260C nozzle, 70-85C bed.")
add(vendor="Hatchbox", name="ABS", base="Hyper ABS", nozzle=240, lo=210, hi=245, bed=100, chamber=50, density=1.04, cost=22, vol=12, tg=100,
    notes="Hatchbox ABS. Mfr: 210-240C nozzle, 90-110C bed, enclosed. Runs cooler than most ABS.")

# ---- Prusament -------------------------------------------------------------
add(vendor="Prusament", name="PLA", base="Hyper PLA", nozzle=215, first=215, lo=205, hi=225, bed=60, density=1.24, cost=30, vol=15, tg=60,
    notes="Prusament PLA. Mfr: 215C nozzle, 60C bed (40-60).")
add(vendor="Prusament", name="PETG", base="Hyper PETG", nozzle=250, first=240, lo=240, hi=260, bed=90, bed_first=85, fan=(30, 60), density=1.27, cost=32, vol=12, tg=80,
    notes="Prusament PETG. Mfr: 250C nozzle (240 first layer), 90C bed (85 first). Dry 65C/6h.")
add(vendor="Prusament", name="ASA", base="Generic ASA", nozzle=260, lo=250, hi=270, bed=105, fan=(0, 30), chamber=50, density=1.07, cost=35, vol=12, tg=100,
    notes="Prusament ASA. Mfr: 260C nozzle, 105C bed, enclosed, fan low.")
add(vendor="Prusament", name="PC Blend", base="Hyper ABS", ftype="PC", nozzle=275, lo=265, hi=285, bed=110, fan=(0, 20), chamber=50, density=1.22, cost=55, vol=12, tg=113,
    notes="Prusament PC Blend. Mfr: 275C nozzle, 110C bed, enclosed, fan low. Dry 90C/6h. Glue on smooth plate.")

# ---- ELEGOO ----------------------------------------------------------------
add(vendor="ELEGOO", name="PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=60, density=1.24, cost=14, vol=15, tg=60,
    notes="ELEGOO PLA / Rapid PLA. Mfr: 190-230C nozzle, 50-65C bed.")
add(vendor="ELEGOO", name="PLA+", base="Hyper PLA", nozzle=220, lo=205, hi=230, bed=60, density=1.23, cost=15, vol=15, tg=60,
    notes="ELEGOO PLA+ / Rapid PLA+. Mfr: 205-225C nozzle, 50-65C bed.")
add(vendor="ELEGOO", name="PETG", base="Hyper PETG", nozzle=245, lo=230, hi=260, bed=75, fan=(30, 60), density=1.27, cost=15, vol=12, tg=80,
    notes="ELEGOO PETG / Rapid PETG. Mfr: 230-260C nozzle, 70-80C bed. Dry 65C/6h.")
add(vendor="ELEGOO", name="ABS", base="Hyper ABS", nozzle=250, lo=240, hi=260, bed=100, chamber=50, density=1.04, cost=15, vol=14, tg=100,
    notes="ELEGOO ABS. Mfr: 240-260C nozzle, 90-110C bed, enclosed.")
add(vendor="ELEGOO", name="ASA", base="Generic ASA", nozzle=255, lo=240, hi=270, bed=95, fan=(10, 40), chamber=50, density=1.07, cost=18, vol=12, tg=100,
    notes="ELEGOO ASA. Mfr: 240-270C nozzle, 90-100C bed, enclosed.")
add(vendor="ELEGOO", name="TPU 95A", base="Generic TPU", nozzle=220, lo=200, hi=230, bed=40, density=1.21, cost=20, vol=3, tg=60,
    notes="ELEGOO TPU 95A. Mfr: 200-230C nozzle, 25-60C bed. Slow; not CFS-feedable.")

# ---- Multi-color spools (k2ctl carries the color list; the printer keeps one) ----
add(vendor="Generic", name="Rainbow PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=55, density=1.24, cost=20, vol=15, tg=60, pa=0.04,
    colors=["#ff4d4d", "#ffb400", "#3ddc84", "#2b8cff", "#b56cff"],
    notes="Gradient / rainbow PLA that shifts color along the spool. Standard PLA settings. The color list is for k2ctl's CFS view; the printer bay record gets the middle color.")

# ---- Inland (Micro Center) -------------------------------------------------
add(vendor="Inland", name="PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=55, density=1.24, cost=14, vol=15, tg=60,
    notes="Inland PLA. Mfr: 190-230C nozzle, 50-60C bed.")
add(vendor="Inland", name="PLA+", base="Hyper PLA", nozzle=220, lo=205, hi=230, bed=60, density=1.23, cost=15, vol=15, tg=60,
    notes="Inland PLA+. Mfr: 205-225C nozzle, 50-65C bed.")
add(vendor="Inland", name="PETG", base="Hyper PETG", nozzle=240, lo=230, hi=250, bed=75, fan=(30, 60), density=1.27, cost=15, vol=12, tg=80,
    notes="Inland PETG. Mfr: 230-250C nozzle, 70-80C bed.")


# ---- AMOLEN (amolen.com product pages) ---------------------------------------
add(vendor="AMOLEN", name="Transparent Rainbow TPU 95A", base="Generic TPU", nozzle=230, lo=220, hi=240, bed=45, fan=(100, 100),
    density=1.19, cost=30, vol=3, tg=60, colors=["#ff6ec7", "#ffa64d", "#fff275", "#7ce8a4", "#5ec8ff", "#b68cff"],
    dry=(55, 7), cfs=False, cfs_reason="95A TPU: Creality says flexible filament bends in the CFS tube and causes feed/unload failures; print it from the external spool holder",
    warn=["Keep speed under 60 mm/s", "Retraction 0.5–1.0 mm @ 20–30 mm/s", "Dry 55 ± 5 °C for 6–8 h before use", "Translucent: color shifts along the spool"],
    notes="AMOLEN transparent multicolor rainbow TPU, Shore 95A ± 2. Mfr: 220-240C nozzle, 30-65C bed, fan on, speed <60 mm/s, retraction 0.5-1.0 mm @ 20-30 mm/s, dry 55±5C 6-8 h. Density 1.19. Not for the CFS (flexible).",
    src="https://www.amolen.com/products/tpu-rainbow")
add(vendor="AMOLEN", name="Silk Rainbow PLA", base="Hyper PLA", nozzle=215, lo=210, hi=240, bed=55, cost=22, vol=12, tg=60,
    colors=["#ff4d6d", "#ff9f1c", "#ffe066", "#3ddc84", "#2b8cff", "#b56cff"], dry=(55, 7),
    warn=["Silk: bed above 65 °C dulls the gloss; slower outer walls shine more"],
    notes="AMOLEN silk multicolor rainbow PLA. Mfr: 210-240C nozzle (205-210 sweet spot), 30-65C bed, dry 55±5C 6-8 h.",
    src="https://amolen.com/products/amolen-silk-multicolor-rainbow-pla-filamnet-1kg1-75")
add(vendor="AMOLEN", name="Silk PLA S-Series", base="Hyper PLA", nozzle=215, lo=210, hi=240, bed=55, cost=22, vol=12, tg=60, dry=(55, 7),
    warn=["Retraction 0.8–1.2 mm @ 25–40 mm/s", "Fast color change: color shifts every few metres"],
    notes="AMOLEN fast-color-change silk PLA. Mfr: 210-240C nozzle, 30-65C bed, speed <200 mm/s.",
    src="https://www.amolen.com/products/pla-silk-s-series")
add(vendor="AMOLEN", name="Glow PLA", base="Hyper PLA", nozzle=220, lo=210, hi=230, bed=55, cost=24, vol=12, tg=60, dry=(55, 7),
    warn=["Glow pigment is abrasive: hardened 0.5–0.6 mm nozzle recommended by AMOLEN"],
    notes="AMOLEN glow-in-the-dark PLA. Mfr: 210-230C nozzle, 30-65C bed, dry 55±5C 6-8 h.", src="https://www.amolen.com/products/pla-glow")

# ---- SUNLU extras (sunlu.com wiki / retailers) --------------------------------
add(vendor="SUNLU", name="PLA Meta", base="Hyper PLA", nozzle=200, lo=185, hi=210, bed=55, density=1.23, cost=16, vol=15, tg=60,
    notes="SUNLU PLA Meta (high flow, low stringing). Mfr: 185-210C nozzle, 50-65C bed.", src="https://filamentsettings.com/filament/sunlu-pla-meta/")
add(vendor="SUNLU", name="Silk PLA", base="Hyper PLA", nozzle=210, lo=205, hi=215, bed=65, cost=17, vol=12, tg=60,
    warn=["Silk: dry sealed at 40–50 °C only (SUNLU), never above 50 °C"],
    notes="SUNLU silk PLA. Mfr: 205-215C nozzle, 60-80C bed.", src="https://www.sunlu.com/wiki/43")
add(vendor="SUNLU", name="Silk PLA+ Rainbow", base="Hyper PLA", nozzle=210, lo=205, hi=215, bed=65, cost=18, vol=12, tg=60,
    colors=["#ff5c5c", "#ffb84d", "#ffe66d", "#5be37a", "#4fa3ff", "#c084fc"],
    notes="SUNLU silk PLA+ rainbow (color shifts along the spool). Silk PLA settings: 205-215C nozzle, 60-80C bed.", src="https://www.sunlu.com/wiki/43")

# ---- ELEGOO extras (elegoo.com product pages; note: us.elegoo.com is blocked on this LAN) -----
add(vendor="ELEGOO", name="Silk PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=60, cost=15, vol=12, tg=60,
    notes="ELEGOO silk PLA. Mfr: 190-230C nozzle, 35-65C bed.", src="https://us.elegoo.com/products/elegoo-silk-pla-filament-1-75mm-colored-1kg")
add(vendor="ELEGOO", name="PLA-CF", base=("Hyper PLA-CF", "Generic PLA-CF", "Hyper PLA"), ftype="PLA-CF", nozzle=225, lo=210, hi=240, bed=55, cost=22, vol=12, tg=60,
    notes="ELEGOO carbon-fibre PLA. Mfr: 210-240C nozzle, 35-65C bed.", src="https://us.elegoo.com/products/pla-cf-filament-1-75mm-black-1kg")
add(vendor="ELEGOO", name="Rapid TPU 95A", base="Generic TPU", nozzle=220, lo=200, hi=230, bed=50, density=1.21, cost=22, vol=5, tg=60, dry=(70, 8), pa=0.25,
    notes="ELEGOO Rapid TPU 95A (high speed). Mfr: 200-230C nozzle (220 start), 40-60C bed, dry 70±5C 8 h.", src="https://eu.elegoo.com/en-es/products/rapid-tpu-filament-1-75mm-colored-1kg")

# ---- Overture extras (overture3d.com) -----------------------------------------
add(vendor="Overture", name="Matte PLA", base="Hyper PLA", nozzle=210, lo=190, hi=230, bed=55, density=1.26, cost=20, vol=12, tg=60, dry=(50, 6),
    notes="Overture matte PLA. Mfr: 190-230C nozzle, 50-60C bed; dry PLA at 50C, never above 55C.", src="https://overture3d.com/products/overture-matte-pla")
add(vendor="Overture", name="Silk PLA", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=55, cost=20, vol=12, tg=60, dry=(50, 6),
    notes="Overture silk PLA. Overture PLA profile guide: 190-230C nozzle, 50-60C bed.", src="https://overture3d.com/blogs/overture-blogs/overture-filament-profiles-guide")

# ---- Hatchbox extras (hatchbox3d.com) -----------------------------------------
add(vendor="Hatchbox", name="TPU 95A", base="Generic TPU", nozzle=215, lo=190, hi=235, bed=40, cost=28, vol=3, tg=60,
    notes="Hatchbox TPU Shore 95A. Mfr: 190-235C nozzle, ±0.03 mm.", src="https://www.hatchbox3d.com/products/3d-tpu-1kg1-75-blk")
add(vendor="Hatchbox", name="Silk PLA", base="Hyper PLA", nozzle=205, lo=180, hi=210, bed=55, cost=24, vol=10, tg=60,
    notes="Hatchbox silk PLA. Hatchbox PLA range 180-210C nozzle, 20-60C bed; runs cool, raise temp if under-extruding at speed.", src="https://filamentcheatsheet.com/database/brand/hatchbox/")

# ---- Inland extras (Micro Center product pages) -------------------------------
add(vendor="Inland", name="Tough PLA", base="Hyper PLA", nozzle=220, lo=210, hi=230, bed=65, cost=16, vol=14, tg=60,
    notes="Inland Tough PLA. Mfr: 210-230C nozzle, 60-80C bed.", src="https://www.microcenter.com/product/692935/inland-175mm-pla-basic-3d-printer-filament-1kg-(22lbs)-cardboard-spool-black")
add(vendor="Inland", name="Silk PLA", base="Hyper PLA", nozzle=205, lo=190, hi=220, bed=65, cost=16, vol=12, tg=60,
    notes="Inland silk PLA. Mfr: 190-220C nozzle, 60-80C bed.", src="https://www.microcenter.com/product/692935/inland-175mm-pla-basic-3d-printer-filament-1kg-(22lbs)-cardboard-spool-black")

# ---- Anycubic (wiki.anycubic.com / store.anycubic.com) ------------------------
add(vendor="Anycubic", name="PLA", base="Hyper PLA", nozzle=210, lo=190, hi=230, bed=60, density=1.24, cost=15, vol=14, tg=60, dry=(50, 6),
    notes="Anycubic PLA. Mfr: 190-230C nozzle, 55-65C bed, dry max 50C.", src="https://wiki.anycubic.com/en/filament-and-resin/filament-guide")
add(vendor="Anycubic", name="High Speed PLA", base="Hyper PLA", nozzle=220, lo=180, hi=260, bed=55, cost=16, vol=20, tg=60, dry=(50, 6),
    warn=["Temperature follows speed: 180–210 °C ≤150 mm/s, 210–230 °C to 300 mm/s, 230–260 °C above"],
    notes="Anycubic High Speed PLA. Mfr: 180-260C by speed band, 45-60C bed.", src="https://store.anycubic.com/products/high-speed-pla-filament")
add(vendor="Anycubic", name="Silk PLA", base="Hyper PLA", nozzle=200, lo=190, hi=220, bed=60, cost=16, vol=12, tg=60,
    notes="Anycubic silk PLA. Mfr: prints around 200C.", src="https://store.anycubic.com/pages/filaments-performance-comparison")
add(vendor="Anycubic", name="PETG", base="Hyper PETG", nozzle=240, lo=220, hi=250, bed=75, fan=(30, 60), density=1.27, cost=17, vol=12, tg=80, dry=(65, 6),
    notes="Anycubic PETG. Mfr: 220-250C nozzle, 70-80C bed, dry max 65C.", src="https://store.anycubic.com/blogs/3d-printing-guides/petg-vs-pla-filament")
add(vendor="Anycubic", name="ABS", base="Hyper ABS", nozzle=250, lo=240, hi=280, bed=95, chamber=50, density=1.04, cost=17, vol=14, tg=100,
    notes="Anycubic ABS. Mfr: 240-280C nozzle, 90-100C bed, enclosed.", src="https://wiki.anycubic.com/en/filament-and-resin/abs-printing-guide")
add(vendor="Anycubic", name="TPU 95A", base="Generic TPU", nozzle=215, lo=195, hi=230, bed=55, cost=24, vol=3, tg=60,
    notes="Anycubic TPU 95A. Mfr: 195-230C nozzle, 50-60C bed, 50-150 mm/s claimed; start slow on the K2.", src="https://store.anycubic.com/products/tpu-filament")

# ---- Flashforge (flashforge.com) ----------------------------------------------
add(vendor="Flashforge", name="PLA", base="Hyper PLA", nozzle=210, lo=180, hi=230, bed=60, cost=18, vol=14, tg=60,
    notes="Flashforge PLA. Mfr: 210C nozzle / 60C bed (range 180-230C).", src="https://www.flashforge.com/blogs/news/pla-bed-temperature-guide")
add(vendor="Flashforge", name="PETG", base="Hyper PETG", nozzle=240, lo=220, hi=250, bed=80, fan=(30, 60), cost=20, vol=12, tg=80,
    notes="Flashforge PETG. Mfr: 220-250C nozzle, 75-90C bed.", src="https://www.flashforge.com/blogs/news/how-to-use-a-3d-printer-for-different-filaments")
add(vendor="Flashforge", name="ABS Basic", base="Hyper ABS", nozzle=250, lo=220, hi=260, bed=100, chamber=50, cost=20, vol=14, tg=100,
    notes="Flashforge ABS Basic. Mfr: 220-260C nozzle, 100-110C bed, enclosed.", src="https://www.flashforge.com/blogs/news/abs-print-temperature")

# ---- Bambu Lab composites (bambulab.com filament guides) ----------------------
add(vendor="Bambu", name="PLA-CF", base=("Hyper PLA-CF", "Generic PLA-CF", "Hyper PLA"), ftype="PLA-CF", nozzle=230, lo=210, hi=240, bed=55, density=1.22, cost=35, vol=12, tg=60, dry=(55, 8),
    notes="Bambu Lab PLA-CF. Mfr: 210-240C nozzle, 45-65C bed, dry 55C 8 h. Hardened nozzle.", src="https://bambulab.com/en/filament/pla-cf")
add(vendor="Bambu", name="PETG-CF", base=("Hyper PETG-CF", "Generic PETG-CF", "Hyper PETG"), ftype="PETG-CF", nozzle=255, lo=240, hi=270, bed=70, fan=(20, 50), density=1.25, cost=40, vol=12, tg=80, dry=(65, 8),
    notes="Bambu Lab PETG-CF. Mfr: 240-270C nozzle, 60-80C bed, dry 65C 8 h. Hardened nozzle.", src="https://bambulab.com/en-eu/filament/petg-cf")
add(vendor="Bambu", name="PA6-CF", base=("Hyper PA6-CF", "Generic PA6-CF", "Generic PA-CF", "Generic PA", "Hyper ABS"), ftype="PA6-CF", nozzle=280, lo=260, hi=300, bed=105, chamber=60, fan=(0, 20), density=1.26, cost=60, vol=10, tg=180, dry=(80, 10),
    warn=["Dry 80 °C 8–12 h before every use; nylon absorbs water within hours", "Chamber as warm as the K2 allows (60 °C)"],
    notes="Bambu Lab PA6-CF. Mfr: 260-300C nozzle, 100-120C bed, dry 80C 8-12 h. Hardened nozzle.", src="https://bambulab.com/en-us/filament/pa6-cf")
add(vendor="Bambu", name="PAHT-CF", base=("Generic PAHT-CF", "Hyper PAHT-CF", "Generic PA-CF", "Generic PA", "Hyper ABS"), ftype="PAHT-CF", nozzle=280, lo=260, hi=300, bed=105, chamber=60, fan=(0, 20), density=1.20, cost=65, vol=10, tg=190, dry=(80, 10),
    warn=["Dry 80 °C 8–12 h before every use"],
    notes="Bambu Lab PAHT-CF. Mfr: 260-300C nozzle, 100-120C bed, dry 80C 8-12 h. Hardened nozzle.", src="https://bambulab.com/en-us/filament/paht-cf")

# ---- Prusament extras (help.prusa3d.com) --------------------------------------
add(vendor="Prusament", name="PETG-CF", base=("Hyper PETG-CF", "Generic PETG-CF", "Hyper PETG"), ftype="PETG-CF", nozzle=250, lo=240, hi=260, bed=85, fan=(20, 50), density=1.27, cost=45, vol=12, tg=80,
    notes="Prusament PETG-CF. Mfr: 240-260C nozzle, 80-90C bed. Hardened nozzle, 0.2 mm layers or more.", src="https://help.prusa3d.com/article/composite-materials-filled-with-carbon-kevlar-or-glass_167387")

# ---- NinjaTek (ninjatek.com) ---------------------------------------------------
add(vendor="NinjaTek", name="Cheetah 95A", base="Generic TPU", nozzle=235, lo=220, hi=250, bed=40, density=1.22, cost=45, vol=4, tg=60,
    warn=["Bed 40 °C max per NinjaTek", "Minimum 10 % infill"],
    notes="NinjaTek Cheetah TPU 95A (fast flexible). Mfr: 220-250C nozzle, bed <=40C.", src="https://ninjatek.com/support/troubleshooting-guide/")
add(vendor="NinjaTek", name="NinjaFlex 85A", base="Generic TPU", nozzle=230, lo=225, hi=235, bed=40, density=1.19, cost=45, vol=2, tg=60,
    cfs=False, cfs_reason="flexible filament; and Creality says TPU of 90A or softer cannot be printed on the K2 at all (the extruder gear flattens it and clogs the nozzle)",
    warn=["Creality: 90A or softer TPU is NOT printable on the K2 — expect jams; listed for reference", "Minimum 20 % infill"],
    notes="NinjaTek NinjaFlex 85A. Mfr: 225-235C nozzle, bed <=40C. Too soft for the K2 extruder per Creality's TPU guide.", src="https://3dinsider.com/ninjaflex-filament/")

# ---- PRILINE (community-measured; Amazon listings carry no temps) -------------
add(vendor="PRILINE", name="Polycarbonate", base="Hyper ABS", ftype="PC", nozzle=275, lo=265, hi=280, bed=105, bed_first=100, chamber=50, fan=(0, 15), density=1.20, cost=35, vol=10, tg=110, dry=(70, 20),
    warn=["Dry 20 h at 70 °C (158 °F) when new; wet PC strings and pops", "Bed 100 °C first layer, 110 °C after"],
    notes="PRILINE PC. Community tuning: 265-280C nozzle (275-280 for layer fusion), 100/110C bed, glue.", src="https://ncbob.com/bobsblog/2020/8/16/printing-with-priline-carbon-fiber-polycarbonate")
add(vendor="PRILINE", name="Carbon Fiber Polycarbonate", base="Hyper ABS", ftype="PC-CF", nozzle=275, lo=265, hi=280, bed=105, bed_first=100, chamber=50, fan=(0, 15), density=1.22, cost=45, vol=10, tg=110, dry=(70, 20),
    warn=["Dry 20 h at 70 °C (158 °F) when new"],
    notes="PRILINE 20% carbon-fibre PC. Community tuning: 265-280C nozzle, 100/110C bed, hardened nozzle.", src="https://ncbob.com/bobsblog/2020/8/16/printing-with-priline-carbon-fiber-polycarbonate")

# ---- Geeetech (geeetech.com product pages) ------------------------------------
add(vendor="Geeetech", name="PLA", base="Hyper PLA", nozzle=210, lo=190, hi=220, bed=55, cost=14, vol=13, tg=60,
    notes="Geeetech PLA. Mfr: 190-220C nozzle, 40-60C bed.", src="https://www.geeetech.com/geeetech-pla-sand-gold-175mm-1kg-per-roll-pla-filament-p-1280.html")
add(vendor="Geeetech", name="Silk PLA", base="Hyper PLA", nozzle=215, lo=200, hi=230, bed=55, cost=15, vol=12, tg=60,
    notes="Geeetech silk PLA. Mfr: 200-230C nozzle, 40-60C bed.", src="https://www.geeetech.com/geeetech-silk-black-pla-175mm-1kgroll-p-1266.html")
add(vendor="Geeetech", name="Matte PLA", base="Hyper PLA", nozzle=210, lo=190, hi=220, bed=60, cost=15, vol=12, tg=60,
    notes="Geeetech matte PLA. Mfr: 190-220C nozzle, 50-70C bed.", src="https://www.geeetech.com/products/pla-matte-3d-printer-filament-1-75mm-1kg-roll")

# ---- JAYO (jayo3d.com / Amazon listings) --------------------------------------
add(vendor="JAYO", name="PLA", base="Hyper PLA", nozzle=215, lo=200, hi=230, bed=60, cost=13, vol=13, tg=60,
    notes="JAYO PLA. Mfr: 200-230C nozzle, 50-65C bed.", src="https://jayo3d.com/products/5kg-large-spool-pla-pla-and-pla-matte-3d-printer-filament")
add(vendor="JAYO", name="PLA+", base="Hyper PLA", nozzle=220, lo=210, hi=235, bed=60, cost=14, vol=13, tg=60,
    notes="JAYO PLA+. Mfr: 210-235C nozzle, 55-65C bed.", src="https://www.amazon.com/Filament-JAYO-1-75mm-Plus-1-1kg/dp/B0BJ1DWCG2")
add(vendor="JAYO", name="PETG", base="Hyper PETG", nozzle=230, lo=220, hi=230, bed=65, fan=(30, 60), cost=14, vol=11, tg=80,
    notes="JAYO PETG. Mfr: 220-230C nozzle, 60-70C bed.", src="https://jayo3d.com/")

# ---- TINMORRY (tinmorry.net product pages) ------------------------------------
add(vendor="TINMORRY", name="PLA", base="Hyper PLA", nozzle=210, lo=195, hi=225, bed=65, cost=14, vol=13, tg=60,
    notes="TINMORRY PLA. Mfr: 195-225C nozzle, 60-75C bed.", src="https://tinmorry.net/en-us/products/pla-filament-1-75mm-1kg-tinmorry-tangle-free-3d-printing-materials-for-3d-printer-1-spool-signal-white")
add(vendor="TINMORRY", name="Silk PLA", base="Hyper PLA", nozzle=210, lo=195, hi=225, bed=55, cost=15, vol=12, tg=60,
    notes="TINMORRY silk PLA. Mfr: 195-225C nozzle, 50-60C bed.", src="https://tinmorry.net/en-us/products/filament-1-75-pla-tinmorry-pla-filament-1-75-mm-filament-3d-druckmaterialien-1-kg-1-spool-silk-bronze")
add(vendor="TINMORRY", name="PETG", base="Hyper PETG", nozzle=245, lo=230, hi=260, bed=80, fan=(30, 60), cost=16, vol=12, tg=80,
    notes="TINMORRY PETG / Rapid PETG-Eco. Mfr: 230-260C nozzle, 75-90C bed.", src="https://tinmorry.net/en-us/products/petg-filament-1-75mm-tinmorry-improved-petg-eco-3d-printing-materials-compatible-with-bambu-fdm-3d-printer-1-kg-1-spool-black")
add(vendor="TINMORRY", name="PETG Galaxy", base="Hyper PETG", nozzle=240, lo=235, hi=245, bed=75, fan=(30, 60), cost=18, vol=11, tg=80,
    notes="TINMORRY PETG Galaxy (sparkle). Mfr: 235-245C nozzle, 70-85C bed.", src="https://tinmorry.com/product/petg/petg-galaxy/")

# ---- IIID MAX (iiidmax.com) ----------------------------------------------------
add(vendor="IIID MAX", name="High Speed PLA+", base="Hyper PLA", nozzle=215, lo=190, hi=230, bed=60, cost=12, vol=16, tg=60,
    notes="IIID MAX High Speed PLA+ (made in USA). Mfr: 190-230C nozzle, 50-70C bed, up to 300 mm/s.", src="https://iiidmax.com/products/iiid-max-high-speed-pla")

# ---- DURAMIC 3D (duramic3d.com) -------------------------------------------------
add(vendor="DURAMIC", name="PETG", base="Hyper PETG", nozzle=240, lo=230, hi=250, bed=75, fan=(30, 60), cost=16, vol=12, tg=80,
    notes="DURAMIC 3D PETG. Mfr: 240±10C nozzle, 70-80C bed.", src="https://duramic3d.com/products/duramic-3d-petg-filament")
add(vendor="DURAMIC", name="TPU 95A", base="Generic TPU", nozzle=220, lo=210, hi=230, bed=45, cost=22, vol=3, tg=60,
    warn=["Mfr speed 20–40 mm/s"],
    notes="DURAMIC 3D TPU 95A. Mfr: 220±10C nozzle, 25-60C bed, 20-40 mm/s.", src="https://duramic3d.com/collections/tpu")

# ---- 3D Solutech --------------------------------------------------------------
add(vendor="3D Solutech", name="PLA", base="Hyper PLA", nozzle=205, lo=190, hi=210, bed=55, cost=18, vol=10, tg=60,
    notes="3D Solutech PLA. Mfr: 190-210C nozzle (no heated bed needed; 50-60C works).", src="https://www.printlog3d.com/library/pla/3d-solutech-pla-standard")

# ---- MatterHackers PRO (matterhackers.com) ------------------------------------
add(vendor="MatterHackers", name="PRO Series PETG", base="Hyper PETG", nozzle=240, lo=230, hi=245, bed=75, fan=(30, 60), cost=35, vol=12, tg=80,
    notes="MatterHackers PRO Series PETG. Mfr: 230-245C nozzle, 65-80C bed.", src="https://www.matterhackers.com/3d-printer-filament-compare")
add(vendor="MatterHackers", name="PRO Series TPU", base="Generic TPU", nozzle=230, lo=220, hi=240, bed=40, cost=40, vol=3, tg=60,
    notes="MatterHackers PRO Series TPU. Mfr: 220-240C nozzle.", src="https://www.matterhackers.com/3d-printer-filament-compare")

# ---- Kingroon (wiki.kingroon.com technical data sheets) -----------------------
add(vendor="Kingroon", name="PETG Basic", base="Hyper PETG", nozzle=230, lo=210, hi=230, bed=70, fan=(30, 60), cost=13, vol=11, tg=80,
    notes="Kingroon PETG Basic. TDS: 210-230C nozzle (230 recommended), 65-80C bed.", src="https://3d.nice-cdn.com/upload/file/KINGROON_PETG_Basic_Technical_Data_Sheet_V1.0.pdf")

# ---- Eryone (eryone3d.com) ----------------------------------------------------
add(vendor="Eryone", name="PLA-CF", base=("Hyper PLA-CF", "Generic PLA-CF", "Hyper PLA"), ftype="PLA-CF", nozzle=210, lo=190, hi=220, bed=65, cost=22, vol=11, tg=60,
    notes="Eryone PLA carbon fibre. Mfr: 190-220C nozzle, 60-70C bed.", src="https://eryone3d.com/products/pla-carbon-fiber-filament")
add(vendor="Eryone", name="PETG", base="Hyper PETG", nozzle=225, lo=215, hi=230, bed=85, fan=(30, 60), cost=17, vol=11, tg=80,
    notes="Eryone PETG. Mfr: 215-230C nozzle, 80-100C bed.", src="https://eryone3d.com/products/petg")

# ---- TTYT3D ---------------------------------------------------------------------
add(vendor="TTYT3D", name="Silk Rainbow PLA", base="Hyper PLA", nozzle=220, lo=215, hi=230, bed=55, cost=20, vol=10, tg=60,
    colors=["#ff5470", "#ff9e3d", "#ffe45c", "#4bd67f", "#3b9dff", "#a86bff"],
    warn=["Silk rainbow: slower speeds, gentle retraction, more infill (TTYT3D)"],
    notes="TTYT3D silk rainbow PLA. Mfr: 220C nozzle (220-230 works), 50-60C bed, 0.4 mm+ nozzle.", src="https://www.amazon.com/ask/questions/Tx24HECPNDROGWH/")

# ---- Protopasta (proto-pasta.com) ---------------------------------------------
add(vendor="Protopasta", name="HTPLA", base="Hyper PLA", nozzle=220, lo=210, hi=230, bed=55, cost=40, vol=12, tg=60,
    warn=["Anneal after printing for the high-temp properties"],
    notes="Protopasta HTPLA. Mfr: 210-230C nozzle, 50-60C bed.", src="https://proto-pasta.com/pages/getting-started-with-proto-pasta-plas")
add(vendor="Protopasta", name="Carbon Fiber HTPLA", base=("Hyper PLA-CF", "Generic PLA-CF", "Hyper PLA"), ftype="PLA-CF", nozzle=235, lo=210, hi=255, bed=55, cost=50, vol=10, tg=60,
    warn=["Protopasta: hot first layer (up to 255 °C) avoids start-up jams, then ~240 °C", "Anneal for heat resistance"],
    notes="Protopasta carbon fibre HTPLA. Mfr tuning: 210-230 nominal, 240-255C on E3D-style hotends.", src="https://proto-pasta.com/blogs/how-to/tuning-for-carbon-fiber-htpla-on-your-prusa-mk3-or-other-3d-printer")

# ---- SainSmart (sainsmart.com) ------------------------------------------------
add(vendor="SainSmart", name="TPU 95A", base="Generic TPU", nozzle=210, lo=200, hi=220, bed=45, cost=25, vol=2, tg=60, dry=(55, 4),
    warn=["SainSmart: 15–30 mm/s, direct-drive dual gear extruder"],
    notes="SainSmart flexible TPU 95A. Mfr: 200-220C nozzle, 30-55C bed, <=20-30 mm/s, dry 55C 4 h+.", src="https://www.sainsmart.com/products/all-colors-tpu-flexible-filament-1-75mm-0-8kg-1-76lb")

# ---- Siraya Tech (siraya.tech) ------------------------------------------------
add(vendor="Siraya Tech", name="Fibreheart PPA-CF", base=("Generic PAHT-CF", "Hyper PAHT-CF", "Generic PA-CF", "Generic PA", "Hyper ABS"), ftype="PPA-CF", nozzle=290, lo=280, hi=300, bed=90, chamber=60, fan=(0, 20), density=1.25, cost=70, vol=8, tg=190, dry=(100, 5),
    warn=["Mfr range 280–320 °C; the K2 hotend stops at 300 °C", "Dry 100 °C 4–6 h if it has taken on moisture; store below 15 % RH", "Hardened nozzle, 0.4 mm or larger"],
    notes="Siraya Tech Fibreheart PPA-CF (15% CF high-temp nylon). Mfr: 280-320C nozzle, bed from 80C, dry 100C 4-6 h.", src="https://siraya.tech/pages/siraya-tech-fibreheart-ppa-cf-filament-user-manual")

# ---------------------------------------------------------------------------
PLATE_KEYS = ["hot_plate_temp", "textured_plate_temp", "cool_plate_temp", "eng_plate_temp"]

def resolve_base(p, nozzle_d):
    """First existing system preset among the candidates in p['base']."""
    cands = p["base"] if isinstance(p["base"], (list, tuple)) else [p["base"]]
    for c in cands:
        if os.path.exists(f"{SYS_FIL}/{c} @{PRINTER} {nozzle_d} nozzle.json"):
            return c
    return None

FLEX_RE = re.compile(r"TPU|TPE|FLEX", re.I)
ABRASIVE_RE = re.compile(r"-CF|-GF|CARBON|GLASS|GLOW|METAL|SPARKLE|GALAXY|TWINKL", re.I)

def cfs_rule(ftype, name, p=None):
    """CFS feed verdict: explicit p['cfs'] wins; otherwise flexible filament is refused."""
    if p and p.get("cfs") is not None:
        return {"ok": bool(p["cfs"]), "reason": p.get("cfs_reason", "" if p["cfs"] else "not CFS-compatible")}
    if FLEX_RE.search(f"{ftype} {name}"):
        return {"ok": False, "reason": "flexible filament bends in the CFS tubes and causes feed/unload failures; use the external spool holder (Creality CFS compatibility note)"}
    if re.search(r"PVA|BVOH", f"{ftype} {name}", re.I):
        return {"ok": True, "reason": "only when dry: damp PVA/BVOH is not CFS-compatible"}
    return {"ok": True, "reason": ""}

def warnings_for(ftype, name, p=None):
    w = list(p.get("warn", [])) if p else []
    if ABRASIVE_RE.search(f"{ftype} {name}"):
        w.append("Abrasive (fibre/particle filled): needs a hardened nozzle (the K2 ships with one) and wears it faster")
    if re.search(r"PVA|BVOH", f"{ftype} {name}", re.I):
        w.append("Hygroscopic support material: keep sealed with desiccant, dry before loading")
    if FLEX_RE.search(f"{ftype} {name}"):
        w.append("Load on the external spool holder, not the CFS; keep speed low and retraction short")
    return w

def build(p, nozzle_d, version):
    resolved = resolve_base(p, nozzle_d)
    if not resolved:
        return None, f"base missing: {p['base']} @{PRINTER} {nozzle_d} nozzle"
    base_name = f"{resolved} @{PRINTER} {nozzle_d} nozzle"
    base = json.load(open(f"{SYS_FIL}/{base_name}.json"))
    name = f"{p['vendor']} {p['name']} @{PRINTER} {nozzle_d} nozzle"
    first = p.get("first", p["nozzle"])
    j = {
        "type": "filament",
        "name": name,
        "from": "User",
        "version": version,
        "inherits": base_name,
        "is_custom_defined": "0",
        "filament_settings_id": [name],
        "filament_vendor": [p["vendor"]],
        "nozzle_temperature": str(p["nozzle"]),
        "nozzle_temperature_initial_layer": str(first),
        "nozzle_temperature_range_low": str(p["lo"]),
        "nozzle_temperature_range_high": str(p["hi"]),
        "filament_cost": str(p["cost"]),
        "filament_max_volumetric_speed": str(p["vol"]),
        "temperature_vitrification": str(p["tg"]),
        "filament_notes": f"{MARK} {p['notes']}" + (f" Source: {p['src']}" if p.get("src") else ""),
    }
    if p.get("ftype"):
        j["filament_type"] = [p["ftype"]]
    bed, bed_first = p["bed"], p.get("bed_first", p["bed"])
    for k in PLATE_KEYS:
        if k in base:  # only override plate types the base defines
            j[k] = str(bed)
            j[k + "_initial_layer"] = str(bed_first)
    if "fan" in p:
        j["fan_min_speed"], j["fan_max_speed"] = str(p["fan"][0]), str(p["fan"][1])
    if "chamber" in p:
        j["chamber_temperature"] = str(p["chamber"])
    if "density" in p:
        j["filament_density"] = str(p["density"])
    if "pa" in p:
        j["pressure_advance"] = str(p["pa"])
    # drop keys identical to the parent so the file stays a true diff
    for k in list(j):
        if k in ("type", "name", "from", "version", "inherits", "is_custom_defined", "filament_settings_id"):
            continue
        bv = base.get(k)
        if bv == j[k] or (isinstance(bv, list) and bv == [j[k]]):
            del j[k]
    return (name, j), None

BASE_TYPE = {"Hyper PLA": "PLA", "Hyper PETG": "PETG", "Hyper ABS": "ABS", "Hyper PC": "PC",
             "Generic ASA": "ASA", "Generic TPU": "TPU", "Generic PLA": "PLA", "Generic PETG": "PETG",
             "Hyper PLA-CF": "PLA-CF", "Generic PLA-CF": "PLA-CF", "Hyper PETG-CF": "PETG-CF", "Generic PETG-CF": "PETG-CF",
             "Generic PA-CF": "PA-CF", "Hyper PA6-CF": "PA6-CF", "Generic PA6-CF": "PA6-CF", "Generic PA": "PA", "Generic PAHT-CF": "PAHT-CF"}

def slug(s):
    out, last = [], "-"
    for ch in s.lower():
        if ch.isalnum(): out.append(ch); last = ch
        elif ch == "+": out.append("plus"); last = "s"
        elif last != "-": out.append("-"); last = "-"
    return "".join(out).strip("-")

def _load_preset(name):
    p = f"{SYS_FIL}/{name}.json"
    return json.load(open(p)) if os.path.exists(p) else None

def effective(preset, key, default=None):
    """Value of `key` for a system preset dict, following its `inherits` chain
    (leaf -> fdm_filament_<type> -> fdm_filament_common). Lists are unwrapped."""
    seen = set()
    while preset is not None:
        v = preset.get(key)
        if v not in (None, "", [], ["nil"]):
            return v[0] if isinstance(v, list) else v
        parent = preset.get("inherits")
        if not parent or parent in seen: break
        seen.add(parent); preset = _load_preset(parent)
    return default

def fans_for(base, override=None):
    """Recommended fan percentages, the way Creality Print would run them."""
    def pct(k, d): 
        try: return int(float(effective(base, k, d) if base else d))
        except (TypeError, ValueError): return d
    part_min, part_max = pct("fan_min_speed", 100), pct("fan_max_speed", 100)
    if override: part_min, part_max = int(override[0]), int(override[1])
    return {"part_min": part_min, "part_max": part_max,
            "aux": pct("additional_cooling_fan_speed", 0), "exhaust": pct("during_print_exhaust_fan_speed", 0)}

def export_catalog(path, nozzle="0.4"):
    """Write the k2ctl filament catalog: Creality/Generic system materials (with the
    material ids the printer accepts) plus every third-party profile above."""
    ids = {}
    try:
        for m in json.load(open(f"{CONF}/system/Creality/materialList.json"))["materials"]:
            ids[(m["brand"], m["name"])] = m["id"]
    except Exception:
        pass
    cat = []
    for f in sorted(glob.glob(f"{SYS_FIL}/* @{PRINTER} {nozzle} nozzle.json")):
        j = json.load(open(f))
        vendor = (j.get("filament_vendor") or ["Creality"])[0]
        if vendor not in ("Creality", "Generic"): continue
        name = os.path.basename(f).split(" @")[0]
        ftype = (j.get("filament_type") or [""])[0]
        cat.append({"id": slug(vendor + " " + name), "vendor": vendor, "name": name, "type": ftype,
                    "min_temp": int(j.get("nozzle_temperature_range_low", 0)), "max_temp": int(j.get("nozzle_temperature_range_high", 0)),
                    "pressure": float(j.get("pressure_advance", 0.04)), "rfid": ids.get((vendor, name), ""),
                    "density": float(j.get("filament_density", 0) or 0), "slicer_preset": os.path.basename(f)[:-5],
                    "fans": fans_for(j), "cfs": cfs_rule(ftype, name), "warnings": warnings_for(ftype, name)})
    for p in P:
        resolved = resolve_base(p, nozzle) or (p["base"] if isinstance(p["base"], str) else p["base"][0])
        base_path = f"{SYS_FIL}/{resolved} @{PRINTER} {nozzle} nozzle.json"
        base = json.load(open(base_path)) if os.path.exists(base_path) else {}
        ftype = p.get("ftype") or BASE_TYPE.get(resolved) or (base.get("filament_type") or [""])[0]
        entry = {"id": slug(p["vendor"] + " " + p["name"]), "vendor": p["vendor"], "name": p["name"], "type": ftype,
                 "min_temp": p["lo"], "max_temp": p["hi"], "pressure": float(p.get("pa", base.get("pressure_advance", 0.04))),
                 "rfid": "", "density": p.get("density", float(base.get("filament_density", 0) or 0)),
                 "notes": p["notes"] + (f" Source: {p['src']}" if p.get("src") else ""),
                 "slicer_preset": f"{p['vendor']} {p['name']} @{PRINTER} {nozzle} nozzle",
                 "fans": fans_for(base, p.get("fan")),
                 "cfs": cfs_rule(ftype, p["name"], p), "warnings": warnings_for(ftype, p["name"], p)}
        if p.get("colors"): entry["colors"] = p["colors"]
        if p.get("dry"): entry["dry"] = {"temp_c": int(p["dry"][0]), "hours": int(p["dry"][1])}
        cat.append(entry)
    with open(path, "w") as f: json.dump(cat, f, indent=1, ensure_ascii=False); f.write("\n")
    print(f"catalog: {len(cat)} entries -> {path}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only"); ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true"); ap.add_argument("--nozzles", nargs="+", default=["0.4"])
    ap.add_argument("--export-json", metavar="PATH", help="write the k2ctl filament catalog and exit")
    a = ap.parse_args()
    if a.export_json:
        export_catalog(a.export_json, a.nozzles[0]); return
    version = vendor_version(); folder, out = user_dir()
    os.makedirs(out, exist_ok=True)
    written = skipped = 0
    for p in P:
        for nd in a.nozzles:
            r, err = build(p, nd, version)
            if err: print("SKIP", p["vendor"], p["name"], nd, "-", err); continue
            name, j = r
            if a.only and a.only.lower() not in name.lower(): continue
            path = f"{out}/{name}.json"
            if os.path.exists(path) and not a.force:
                skipped += 1; print("exists", name); continue
            if a.list: print("would write", name, "<-", j["inherits"]); continue
            with open(path, "w") as f: json.dump(j, f, indent=4, ensure_ascii=False); f.write("\n")
            with open(f"{out}/{name}.info", "w") as f:
                f.write(f"sync_info = \nuser_id = {folder}\nsetting_id = \nbase_id = \nupdated_time = {int(time.time())}\n")
            written += 1; print("wrote", name)
    print(f"done: {written} written, {skipped} existing kept -> {out}")

if __name__ == "__main__":
    main()
