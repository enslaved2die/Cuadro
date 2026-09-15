# Cuadro: IoT Remote E-Paper Photo Frame

An end-to-end, production-grade connected picture frame for family and friends. Newly uploaded photos in a remote album (**Immich**, **Google Photos**, or **Apple iCloud**) automatically sync, optimize, dither, and display on a high-resolution 6-color E-Paper display.

The frame sits behind residential NAT/firewalls, pulling updates from a self-hosted Docker backend over HTTPS, and light-sleeps between updates to keep peripheral state intact across wakeups.

---

## Features

- **Multiple frames, multiple albums.** Connect any number of physical frames. Define reusable "Album Sources" (a named connection to a Google Photos, Immich, or iCloud album, or a manual-upload bucket) and assign any combination of them to each frame independently — a frame with no assignment falls back to showing your whole library.
- **Per-frame overrides.** Mounting orientation, fit style (matting / cover / rotate), epdoptimize color config, refresh schedule, and Storage Mode can all be set globally as defaults and overridden per frame from the dashboard.
- **On-demand cloud downloads.** Cloud albums are synced as lightweight metadata plus a small preview thumbnail only — the full-resolution original and the 960 KB e-paper render are fetched and cached just before a photo is actually about to be shown (pre-warmed in the background ahead of each frame's next expected refresh), not eagerly for every photo in the album. Photos that haven't been needed in a while have their heavy files automatically reclaimed, keeping disk usage bounded regardless of album size.
- **Timezone-aware scheduling.** Set one or more daily refresh times per display's own local timezone; a 24-hour watchdog forces a refresh regardless, to protect against e-ink particle sticking.
- **Web dashboard & hardware emulator.** Manage frames, album sources, and the photo library from a browser; a full software emulator of the physical panel is included for testing without hardware.
- **Hardened by default.** Session-cookie auth with rate-limited login, timing-safe password comparison, an auto-generated admin password when none is set, and optional TLS certificate pinning for the frame's connection to the backend.

---

## Hardware Specification & Verified Pinout

- **Display Module:** Good Display 7.09" E Ink Spectra™ 6 (`GDEB0709E01`)
  - Resolution: 1200 × 1600 pixels (or 1600 × 1200 landscape) @ 282 PPI
  - Physical Pigments: 6-color microcup system (Black `0x0`, White `0x1`, Yellow `0x2`, Red `0x3`, Blue `0x5`, Green `0x6`)
  - Dual-IC Architecture: Left 600 columns driven by Master IC (`CS_M`), right 600 columns driven by Slave IC (`CS_S`)
  - Full Frame Binary: Exactly **960,000 bytes** ($1200 \times 1600 \div 2$, 4-bit nibbles)
- **Driver Board:** Good Display `ESP32-133C02` (ESP32-S3)

### Hardware Connections:
| Signal | Board Label | ESP32-S3 GPIO | Direction / Details |
| :--- | :--- | :--- | :--- |
| **CS_M** | CS_M / CS0 | **GPIO 18** | Output (Master IC Chip Select) |
| **CS_S** | CS_S / CS1 | **GPIO 17** | Output (Slave IC Chip Select) |
| **DC** | DC | **GPIO 2** | Output (Data/Command) |
| **RST** | RST | **GPIO 6** | Output (Hardware Reset, Active LOW) |
| **BUSY** | BUSY | **GPIO 7** | Input (Active LOW while busy, HIGH when ready) |
| **SCK** | SCK | **GPIO 9** | Hardware SPI Clock |
| **MOSI** | MOSI | **GPIO 41** | Hardware SPI MOSI |
| **MISO** | MISO | **GPIO 40** | Hardware SPI MISO |
| **SW2 Button**| SW2 | **GPIO 12** | Input (Active HIGH, RTC wake-capable) |
| **Boot Button**| BOOT | **GPIO 0** | Input (Active LOW, RTC wake-capable) |

---

## Physical Screen Safety & Health Protection

1. **Safe Power-Down Sequencing:** Multi-color e-paper panels must be powered down cleanly between refreshes. After any screen draw/refresh, the firmware issues `0x02` (POF - Power Off) to the driver IC and waits for `BUSY` HIGH before the ESP32 light-sleeps. Light sleep (rather than deep sleep) keeps peripheral and GPIO state intact across wakeups, since this frame runs on mains power rather than battery.
2. **24-Hour Particle Refresh Rule:** E-ink microcapsules suffer from particle sticking/burn-in if static images sit indefinitely. The backend watchdog schedules a full panel cycle at least once every 24 hours.
3. **Long-Term Storage / Vacation Mode:** When stored or unused for extended periods, the screen must be refreshed to pure white. The system includes an admin toggle that delivers a 100% white buffer (`0x11` across 960 KB) and indefinitely sleeps the frame (`X-Sleep-Seconds: 0`). Pressing the physical button wakes it up on demand.

---

## System Architecture

```
                                          +---------------------------------------------+
                                          |             Docker Cloud Backend            |
                                          |                                             |
   [ Immich Album ] ------------------->  |  +------------------+    +---------------+  |
   [ Google Photos ] ------------------>  |  | Ingestion Queue  | -> | LAB Dithering |  |
   [ iCloud Shared ] ------------------>  |  +------------------+    +---------------+  |
                                          |                            |                |
                                          |                            v                |
                                          |                   [ 960 KB Pre-baked Bin ]  |
                                          |                            |                |
                                          |                            v                |
                                          |                  HTTPS REST API (/next)     |
                                          +---------------------------------------------+
                                                                       |
                                                    NAT / Residential Firewall
                                                                       | (Pull Polling)
                                                                       v
                                          +---------------------------------------------+
                                          |                    Cuadro                   |
                                          |                                             |
                                          |  1. Timer / Button Wakeup (EXT0)            |
                                          |  2. Wi-Fi / Fallback Captive Portal         |
                                          |  3. Direct Stream Chunking (Zero Big Buffer)|
                                          |  4. Dual-IC Display Refresh (GDEB0709E01)   |
                                          |  5. POF + Light Sleep (state kept intact)   |
                                          +---------------------------------------------+
```

---

## Getting Started

### 1. Docker Backend Deployment

1. Copy `.env.example` to `.env` and fill in your settings:
   ```bash
   cp .env.example .env
   ```
2. Start the Docker container:
   ```bash
   docker compose up -d
   ```
3. Open `http://localhost:8080/` to access the Admin Web UI.
   - Enter your `ADMIN_PASSWORD`. If left unset, a secure one-time password is auto-generated and printed to the container logs on first startup.
   - Monitor connected frames, trigger manual sync, upload photos, or toggle Storage Mode.

### 2. Firmware Compilation & Flashing

The firmware is located in `/firmware` and built with **PlatformIO**.

1. Connect the `ESP32-133C02` board via USB Type-C.
2. Build and flash the firmware:
   ```bash
   cd firmware
   pio run --target upload
   pio device monitor
   ```

### 3. First-Time Wi-Fi Provisioning (Captive Portal)

- On first boot (or whenever the physical **SW3 button** on GPIO 13 is held for 1.5s):
  1. The frame broadcasts a Wi-Fi hotspot named: `Cuadro-Setup`.
  2. Connect using your phone or laptop. A captive portal page will appear automatically at `http://192.168.4.1`.
  3. Enter your home Wi-Fi SSID, password, backend server URL (e.g. `https://memories.yourdomain.com`), and `FRAME_TOKEN`.
  4. Click **Save & Connect**. The frame reboots, connects to your Wi-Fi, fetches the first image, refreshes the display, and light-sleeps until the next scheduled refresh!

---

## Acknowledgements

Cuadro is built on top of some excellent open-source work:

- **[epdoptimize](https://paperlesspaper.github.io/epdoptimize/)** by [paperlesspaper](https://github.com/paperlesspaper) — the color-matching, dynamic range compression, and dithering engine that turns full-color photos into something a 6-color e-paper panel can actually reproduce well. Its web tool is also what generates the JSON config the dashboard's epdoptimize settings accept.
- **[sharp](https://github.com/lovell/sharp)** — fast, libvips-based image decoding, resizing, and format conversion used throughout the processing pipeline.
- **[Express](https://expressjs.com/)** — the backend's HTTP server and routing.
- **[node-cron](https://github.com/node-cron/node-cron)** — schedules the periodic album sync and cloud-photo eviction jobs.
- **[ArduinoJson](https://arduinojson.org/)** by Benoit Blanchon — JSON parsing/serialization in the ESP32 firmware (captive portal config, frame telemetry).
- **[PlatformIO](https://platformio.org/)** and the **[Arduino-ESP32](https://github.com/espressif/arduino-esp32)** core — the firmware build system and hardware abstraction layer for the ESP32-S3.
- **[Material Symbols](https://fonts.google.com/icons)** and the **[Urbanist](https://fonts.google.com/specimen/Urbanist)** / **[Gabarito](https://fonts.google.com/specimen/Gabarito)** typefaces (Google Fonts) — the dashboard's iconography and type.

And thank you to **Good Display** for the GDEB0709E01 panel and its accompanying reference demo, which was invaluable for confirming the driver's init/refresh/sleep command sequences during development.
