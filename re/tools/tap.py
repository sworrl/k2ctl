import struct, time, sys
# Synthetic tap on the K2 Plus touchscreen (gt9xx on /dev/input/event0; 32-bit ARM input_event = 16 bytes).
# Usage on the printer: /usr/share/klippy-env/bin/python tap.py X Y   (portrait coords, 0..479 x 0..799)
def ev(f, t, c, v): f.write(struct.pack("llHHi", 0, 0, t, c, v))
x, y = int(sys.argv[1]), int(sys.argv[2])
with open("/dev/input/event0", "wb", buffering=0) as f:
    ev(f,3,0x39,1); ev(f,3,0x35,x); ev(f,3,0x36,y); ev(f,3,0x30,20); ev(f,1,0x14a,1); ev(f,3,0,x); ev(f,3,1,y); ev(f,0,0,0)
    time.sleep(0.08)
    ev(f,3,0x39,-1); ev(f,1,0x14a,0); ev(f,0,0,0)
