#pragma once

#include <Arduino.h>

// ==============================================================================
// Hardware Pinout Definitions for Good Display ESP32-133C02 (ESP32-S3)
// Verified via official board schematics & manufacturer reference driver
// ==============================================================================

// EPD Control & SPI Pins
#define EPD_PWR_PIN     45   // Power switch pin (Active HIGH)
#define EPD_CS_M_PIN    18   // Master IC Chip Select (Left half columns 0..599)
#define EPD_CS_S_PIN    17   // Slave IC Chip Select (Right half columns 600..1199)
#define EPD_DC_PIN      2    // Data/Command control line
#define EPD_RST_PIN     6    // Hardware Reset (Active LOW)
#define EPD_BUSY_PIN    7    // Busy status line (Active LOW while busy, HIGH when ready)
#define EPD_SCK_PIN     9    // Hardware SPI Clock
#define EPD_MOSI_PIN    41   // Hardware SPI MOSI
#define EPD_MISO_PIN    40   // Hardware SPI MISO

// Physical User Buttons on Good Display ESP32-133C02
// Button 1 (SW2, GPIO 12): Click = Refresh Now, Hold (3s) = Clear to White & Storage Mode
// Button 2 (SW3, GPIO 13): Hold (3s) = Open Wi-Fi Setup Hotspot (Captive Portal)
// Button 3 (SW4, GPIO 14): Click = Diagnostic 6-Color Test Pattern
// Boot Button (GPIO 0): Alternative active-LOW trigger
#define BUTTON_REFRESH_PIN  12   // Physical User Button SW2 (RTC GPIO 12)
#define BUTTON_HOTSPOT_PIN  13   // Physical User Button SW3 (RTC GPIO 13)
#define BUTTON_DIAG_PIN     14   // Physical User Button SW4 (RTC GPIO 14)
#define BUTTON_BOOT_PIN     0    // Hardware Boot Button (Active LOW, RTC GPIO 0)

// Active level: Good Display ESP32-133C02 board buttons are active HIGH.
#define BUTTON_ACTIVE_LEVEL HIGH
#define BUTTON_HOLD_MS         3000 // 3000ms hold threshold for storage mode (Button 1)
#define BUTTON_HOTSPOT_HOLD_MS 1500 // 1500ms hold threshold for hotspot (Button 2 / BOOT) - fast captive portal activation

// Optional Onboard Battery ADC
#define BATTERY_ADC_PIN 1    // ADC pin for battery voltage divider (if populated)

// Panel Dimensions & Geometry
#define EPD_WIDTH           1200
#define EPD_HEIGHT          1600
#define EPD_ROW_BYTES       600   // 1200 pixels / 2 pixels-per-byte
#define EPD_HALF_ROW_BYTES  300   // 600 pixels / 2 pixels-per-byte
#define EPD_TOTAL_PAYLOAD   960000 // 600 * 1600 bytes

// Circular Streaming Buffer Parameters (SRAM footprint)
#define STREAM_CHUNK_ROWS   8
#define STREAM_BUFFER_SIZE  (STREAM_CHUNK_ROWS * EPD_ROW_BYTES) // 4,800 bytes

// Wi-Fi & Network Timeouts
#define WIFI_CONNECT_TIMEOUT_MS   20000   // 20 seconds before fallback to captive portal
#define CAPTIVE_PORTAL_TIMEOUT_MS 300000  // 5 minutes AP mode before sleep
#define DEFAULT_SLEEP_SECONDS     14400   // 4 hours default sleep

// Setup Wi-Fi SoftAP branding (shown in Wi-Fi picker and on the panel's setup screen)
#define WIFI_AP_SSID       "Cuadro-Setup"
#define WIFI_AP_IP         "192.168.4.1"
