#include <Arduino.h>
#include <WiFi.h>
#include "config.h"
#include "epd_gdeb0709e01.h"
#include "captive_portal.h"
#include "stream_client.h"
#include "power_manager.h"

// Global component instances
EPD_GDEB0709E01 epd;
CaptivePortal portal;
StreamClient streamClient(epd);
PowerManager powerManager;

void setup() {
  Serial.begin(115200);
  delay(100);

  log_i("=================================================");
  log_i("              Cuadro - IoT E-Paper System         ");
  log_i("       Good Display 7.09\" Spectra 6 (ESP32-S3)   ");
  log_i("=================================================");
}

// Runs once per wake cycle. Light sleep (see PowerManager::lightSleep) returns instead
// of rebooting the chip, so the Arduino framework calling loop() repeatedly forever is
// exactly the "do one cycle, sleep, repeat" structure this device needs.
void loop() {
  // Read wakeup cause and button state as the very first action, before any panel
  // initialization delay, so a quick tap is captured immediately on wake.
  WakeupReason wakeupReason = powerManager.getWakeupReason();
  ButtonAction buttonAction = powerManager.checkButtonAction();

  log_i("[MAIN] Total PSRAM: %d bytes, Free PSRAM: %d bytes", ESP.getPsramSize(), ESP.getFreePsram());

  epd.begin();
  epd.checkDriverStatus();

  float batteryVoltage = powerManager.readBatteryVoltage();
  log_i("[MAIN] Battery Voltage: %.2f V", batteryVoltage);

  // Load stored Wi-Fi/server config (and the last-known frame orientation) up front so
  // every displaySetupScreen() call site below - even ones before Wi-Fi is configured -
  // can render the setup screen upright for however the panel is physically mounted.
  DeviceConfig config;
  bool hasWifiConfig = portal.loadConfig(config);

  // 1. Button 1 Held (>3s): Clear screen to pure white and enter Storage Mode
  if (buttonAction == ACTION_ENTER_STORAGE_MODE) {
    log_i("[MAIN] Storage mode requested via Button 1 hold. Clearing panel...");
    epd.displayPureWhite();
    epd.powerSleep();
    log_i("[MAIN] Panel cleared to pure white. Entering indefinite light sleep (timer disabled)...");
    powerManager.lightSleep(0); // 0 = indefinite sleep until button press
    return;
  }

  // 2. Button 2 Held (>3s): Launch SoftAP Wi-Fi Captive Portal for network configuration
  if (buttonAction == ACTION_LAUNCH_HOTSPOT) {
    log_i("[MAIN] Hotspot requested via Button 2 hold. Launching SoftAP Captive Portal...");
    epd.displaySetupScreen(WIFI_AP_SSID, WIFI_AP_IP, config.frameOrientation);
    epd.powerSleep();
    portal.runPortal(CAPTIVE_PORTAL_TIMEOUT_MS);
    powerManager.lightSleep(DEFAULT_SLEEP_SECONDS);
    return;
  }

  // 3. Button 3 Clicked: Render diagnostic 6-color test pattern
  if (buttonAction == ACTION_DIAGNOSTICS) {
    log_i("[MAIN] Diagnostic test requested via Button 3. Rendering 6-color test pattern...");
    epd.displayTestColorBars();
    epd.powerSleep();
    powerManager.lightSleep(DEFAULT_SLEEP_SECONDS);
    return;
  }

  // 4. If Button 1 was tapped (ACTION_REFRESH_NOW) or regular scheduled timer wakeup:
  if (buttonAction == ACTION_REFRESH_NOW) {
    log_i("[MAIN] Button 1 clicked: Manual immediate refresh triggered!");
  } else if (wakeupReason == WAKEUP_TIMER_SCHEDULED) {
    log_i("[MAIN] Scheduled timer wakeup: Refreshing photo queue.");
  }

  // 5. Bail out to the Captive Portal if no Wi-Fi/server configuration has been saved yet
  if (!hasWifiConfig) {
    log_w("[MAIN] No Wi-Fi credentials found. Displaying Cuadro Setup screen and launching Captive Portal...");
    epd.displaySetupScreen(WIFI_AP_SSID, WIFI_AP_IP, config.frameOrientation);
    epd.powerSleep();
    portal.runPortal(CAPTIVE_PORTAL_TIMEOUT_MS);
    powerManager.lightSleep(DEFAULT_SLEEP_SECONDS);
    return;
  }

  // 6. Connect to Wi-Fi with 20-second timeout
  log_i("[MAIN] Connecting to Wi-Fi SSID: '%s'...", config.wifiSsid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(config.wifiSsid.c_str(), config.wifiPassword.c_str());

  uint32_t wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    if (millis() - wifiStart > WIFI_CONNECT_TIMEOUT_MS) {
      log_e("[MAIN] Wi-Fi connection timed out (20s). Falling back to Captive Portal...");
      WiFi.disconnect(true);
      epd.displaySetupScreen(WIFI_AP_SSID, WIFI_AP_IP, config.frameOrientation);
      epd.powerSleep();
      portal.runPortal(CAPTIVE_PORTAL_TIMEOUT_MS);
      powerManager.lightSleep(DEFAULT_SLEEP_SECONDS);
      return;
    }
  }

  log_i("[MAIN] Wi-Fi connected! IP: %s, RSSI: %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  // 7. Fetch, stream, and refresh the next image payload
  StreamResult result = streamClient.fetchAndStreamFrame(config.serverUrl, config.frameToken, batteryVoltage, config.caCert);

  if (result.success) {
    log_i("[MAIN] Frame refreshed successfully in %u ms.", result.durationMs);
    streamClient.acknowledgeSuccess(config.serverUrl, config.frameToken, result.imageId, result.durationMs, batteryVoltage, config.caCert);

    // Keep the persisted orientation in sync with whatever the backend is actually
    // using, so the setup screen stays correctly oriented across reboots even before
    // the very next photo fetch.
    if (result.frameOrientation.length() > 0 && result.frameOrientation != config.frameOrientation) {
      log_i("[MAIN] Frame orientation changed: '%s' -> '%s'. Persisting.",
            config.frameOrientation.c_str(), result.frameOrientation.c_str());
      config.frameOrientation = result.frameOrientation;
      portal.saveConfig(config);
    }
  } else {
    log_w("[MAIN] Frame streaming did not complete successfully.");
  }

  // 8. Put display into low-power sleep
  epd.powerSleep();

  // 9. Disconnect Wi-Fi to save energy
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  // 10. Light sleep until the next cycle
  uint32_t sleepSeconds = result.success ? result.nextSleepSeconds : 300; // retry in 5m on failure
  powerManager.lightSleep(sleepSeconds);
}
