#pragma once

#include <Arduino.h>
#include "config.h"
#include "epd_gdeb0709e01.h"

struct OtaUpdateInfo {
  String version;
  String url;
  String sha256;
  size_t size;
};

enum OtaResultCode {
  OTA_SUCCESS = 0,
  OTA_ERR_BATTERY_LOW,
  OTA_ERR_CONNECT_FAILED,
  OTA_ERR_HTTP_FAILED,
  OTA_ERR_INVALID_HEADER,
  OTA_ERR_INCOMPLETE_DOWNLOAD,
  OTA_ERR_FLASH_BEGIN,
  OTA_ERR_FLASH_WRITE,
  OTA_ERR_HASH_MISMATCH,
  OTA_ERR_SET_BOOT,
  OTA_ERR_NO_PARTITION
};

class OtaManager {
public:
  OtaManager();

  // Returns true if the currently running partition is in ESP_OTA_IMG_PENDING_VERIFY state
  bool isPendingVerify();

  // Called after Wi-Fi connects to confirm healthy operation and cancel bootloader rollback.
  // Returns true if the partition was in PENDING_VERIFY and has just been marked valid.
  bool confirmRunningFirmwareValid();

  // Marks the running PENDING_VERIFY slot invalid and immediately reboots into the previous known-good slot
  void rollbackAndReboot();

  // Downloads, verifies, and flashes update, then calls esp_restart() on success
  OtaResultCode applyUpdate(
    const String& serverUrl,
    const String& token,
    const OtaUpdateInfo& info,
    float batteryVoltage,
    const String& caCert,
    EPD_GDEB0709E01& epd
  );

  // Reports OTA telemetry back to backend /api/v1/frame/ota/status
  void reportStatus(
    const String& serverUrl,
    const String& token,
    const String& version,
    const String& status,
    const String& errorMessage,
    float batteryVoltage,
    const String& caCert
  );

  static const char* errorToString(OtaResultCode code);

private:
  String calculateSha256Hex(const uint8_t* hashBytes);
};
