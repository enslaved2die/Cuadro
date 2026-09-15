#pragma once

#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "config.h"
#include "epd_gdeb0709e01.h"

struct StreamResult {
  bool success;
  uint32_t nextSleepSeconds;
  String frameMode;
  String imageId;
  uint32_t durationMs;
  // Echoes the backend's X-Frame-Orientation response header - the frameOrientation
  // it actually rendered the photo for (see backend/src/api/frame.ts) - so the
  // caller can persist it and keep the on-panel setup screen's orientation in sync.
  String frameOrientation;
};

class StreamClient {
public:
  StreamClient(EPD_GDEB0709E01& epd);
  StreamResult fetchAndStreamFrame(const String& serverUrl, const String& token, float batteryVoltage, const String& caCert = "");
  void acknowledgeSuccess(const String& serverUrl, const String& token, const String& imageId, uint32_t durationMs, float batteryVoltage, const String& caCert = "");

private:
  EPD_GDEB0709E01& epd;
};
