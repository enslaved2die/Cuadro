#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include "config.h"

struct DeviceConfig {
  String wifiSsid;
  String wifiPassword;
  String serverUrl;
  String frameToken;
  String caCert;
  uint32_t sleepSeconds;
  // Mirrors backend/src/config.ts's frameOrientation ("portrait"/"portrait_180"/
  // "landscape"/"landscape_270"); kept in sync from the X-Frame-Orientation response
  // header returned by the backend on each successful frame fetch (see main.cpp),
  // so the on-panel setup screen can render text upright for the actual mounting
  // even before Wi-Fi/server config exists yet.
  String frameOrientation;
};

class CaptivePortal {
public:
  CaptivePortal();
  void begin();
  bool loadConfig(DeviceConfig& config);
  void saveConfig(const DeviceConfig& config);
  void runPortal(uint32_t timeoutMs = CAPTIVE_PORTAL_TIMEOUT_MS);

private:
  Preferences prefs;
  WebServer server;
  DNSServer dnsServer;
  bool configSaved = false;

  void setupRoutes();
  void handleRoot();
  void handleSave();
};
