# Cuadro: IoT Remote E-Paper Photo Frame

An end-to-end, production-grade connected picture frame for family and friends. Newly uploaded photos in a remote album (**Immich**, **Google Photos**, or **Apple iCloud**) automatically sync, optimize, dither, and display on a high-resolution 6-color E-Paper display.

The frame sits behind residential NAT/firewalls, pulling updates from a self-hosted Docker backend over HTTPS, and enters an ultra-low-power deep sleep between updates with complete physical pin isolation.

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

1. **Parasitic Voltage Isolation:** Multi-color e-paper panels degrade rapidly if pins are held HIGH under static power. After any screen draw/refresh, the firmware issues `0x02` (POF - Power Off) to the driver IC, waits for `BUSY` HIGH, and configures all 8 SPI lines to high-impedance `INPUT` with `rtc_gpio_isolate()` before entering deep sleep.
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
                                          |  5. POF + Pin Isolation + Deep Sleep        |
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
  4. Click **Save & Connect**. The frame reboots, connects to your Wi-Fi, fetches the first image, refreshes the display, and deep sleeps!
