#include "ota_manager.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

OtaManager::OtaManager() {}

bool OtaManager::isPendingVerify() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  if (!running) return false;

  esp_ota_img_states_t otaState;
  if (esp_ota_get_state_partition(running, &otaState) == ESP_OK) {
    return otaState == ESP_OTA_IMG_PENDING_VERIFY;
  }
  return false;
}

bool OtaManager::confirmRunningFirmwareValid() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  if (!running) {
    log_w("[OTA] Unable to retrieve running partition.");
    return false;
  }

  esp_ota_img_states_t otaState;
  if (esp_ota_get_state_partition(running, &otaState) == ESP_OK) {
    if (otaState == ESP_OTA_IMG_PENDING_VERIFY) {
      log_i("[OTA] Running on newly flashed slot in PENDING_VERIFY state. Confirming boot validation...");
      esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
      if (err == ESP_OK) {
        log_i("[OTA] Rollback cancelled successfully! Firmware v%s permanently validated.", FIRMWARE_VERSION);
        return true;
      } else {
        log_e("[OTA] Failed to cancel rollback: 0x%x", err);
      }
    } else {
      log_d("[OTA] Running partition '%s' is in state 0x%x (valid).", running->label, otaState);
    }
  }
  return false;
}

void OtaManager::rollbackAndReboot() {
  log_e("[OTA] Newly flashed firmware failed health check in PENDING_VERIFY state! Rolling back to previous slot...");
  delay(200);
  esp_ota_mark_app_invalid_rollback_and_reboot();
  // Fallback restart if bootloader rollback wasn't enabled in bootloader image
  esp_restart();
}

const char* OtaManager::errorToString(OtaResultCode code) {
  switch (code) {
    case OTA_SUCCESS:                 return "Success";
    case OTA_ERR_BATTERY_LOW:         return "Battery voltage below safe flash threshold (3.6V)";
    case OTA_ERR_CONNECT_FAILED:      return "Failed to initialize HTTPS connection for OTA download";
    case OTA_ERR_HTTP_FAILED:         return "HTTP GET for firmware binary returned non-200 status";
    case OTA_ERR_INVALID_HEADER:      return "Invalid ESP32 firmware header (magic byte 0xE9 missing)";
    case OTA_ERR_INCOMPLETE_DOWNLOAD: return "Incomplete firmware download (stream closed early)";
    case OTA_ERR_FLASH_BEGIN:         return "esp_ota_begin failed to prepare target partition";
    case OTA_ERR_FLASH_WRITE:         return "Flash write or esp_ota_end failed";
    case OTA_ERR_HASH_MISMATCH:       return "SHA-256 checksum mismatch";
    case OTA_ERR_SET_BOOT:            return "esp_ota_set_boot_partition failed";
    case OTA_ERR_NO_PARTITION:        return "No target OTA partition available in partition table";
    default:                          return "Unknown OTA error";
  }
}

String OtaManager::calculateSha256Hex(const uint8_t* hashBytes) {
  char hexBuffer[65];
  for (int i = 0; i < 32; i++) {
    snprintf(hexBuffer + (i * 2), 3, "%02x", hashBytes[i]);
  }
  hexBuffer[64] = '\0';
  return String(hexBuffer);
}

void OtaManager::reportStatus(
  const String& serverUrl,
  const String& token,
  const String& version,
  const String& status,
  const String& errorMessage,
  float batteryVoltage,
  const String& caCert
) {
  String endpoint = serverUrl + "/api/v1/frame/ota/status";

  WiFiClientSecure secureClient;
  if (caCert.length() > 0) {
    secureClient.setCACert(caCert.c_str());
  } else {
    secureClient.setInsecure();
  }

  HTTPClient http;
  if (!http.begin(secureClient, endpoint)) {
    log_w("[OTA] Failed to begin HTTP client for status report");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + token);
  http.addHeader("X-Frame-ID", WiFi.macAddress());

  JsonDocument doc;
  doc["version"] = version;
  doc["status"] = status;
  if (errorMessage.length() > 0) {
    doc["error"] = errorMessage;
  }
  if (batteryVoltage > 0.0f) {
    doc["batteryVoltage"] = batteryVoltage;
  }

  String body;
  serializeJson(doc, body);

  int httpCode = http.POST(body);
  log_d("[OTA] Status report (%s, %s) HTTP response code: %d", version.c_str(), status.c_str(), httpCode);
  http.end();
}

OtaResultCode OtaManager::applyUpdate(
  const String& serverUrl,
  const String& token,
  const OtaUpdateInfo& info,
  float batteryVoltage,
  const String& caCert,
  EPD_GDEB0709E01& epd
) {
  log_i("[OTA] ===============================================");
  log_i("[OTA] Starting Over-The-Air Update to version: %s", info.version.c_str());
  log_i("[OTA] Target URL: %s", info.url.c_str());
  log_i("[OTA] ===============================================");

  // 1. Battery voltage safety check (protect against flash brownouts when battery divider is populated)
  if (OTA_MIN_BATTERY_VOLTAGE > 0.0f && batteryVoltage > 0.0f && batteryVoltage < OTA_MIN_BATTERY_VOLTAGE) {
    log_e("[OTA] Battery voltage too low for safe flashing: %.2f V < %.2f V. Aborting.",
          batteryVoltage, OTA_MIN_BATTERY_VOLTAGE);
    return OTA_ERR_BATTERY_LOW;
  }

  // 2. Identify the inactive target OTA partition
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* updatePartition = esp_ota_get_next_update_partition(NULL);

  if (!updatePartition) {
    log_e("[OTA] No available target partition found! Check partition table.");
    return OTA_ERR_NO_PARTITION;
  }

  if (info.size > 0 && info.size > updatePartition->size) {
    log_e("[OTA] Firmware size (%u bytes) exceeds partition capacity (%u bytes)!",
          (unsigned int)info.size, (unsigned int)updatePartition->size);
    return OTA_ERR_FLASH_BEGIN;
  }

  log_i("[OTA] Running slot: '%s' (0x%08x), Target slot: '%s' (0x%08x, %u KB)",
        running ? running->label : "unknown",
        running ? running->address : 0,
        updatePartition->label,
        updatePartition->address,
        updatePartition->size / 1024);

  // 3. Ensure display is in clean low-power sleep mode so no waveforms are active
  epd.powerSleep();

  // 4. Connect to backend firmware stream
  String fullUrl = info.url.startsWith("http://") || info.url.startsWith("https://")
    ? info.url
    : serverUrl + info.url;

  log_i("[OTA] Connecting to firmware download endpoint: %s", fullUrl.c_str());

  WiFiClientSecure secureClient;
  if (caCert.length() > 0) {
    secureClient.setCACert(caCert.c_str());
  } else {
    secureClient.setInsecure();
  }

  HTTPClient http;
  http.setTimeout(45000); // 45s read timeout
  if (!http.begin(secureClient, fullUrl)) {
    log_e("[OTA] Unable to begin HTTPClient for OTA download");
    return OTA_ERR_CONNECT_FAILED;
  }

  http.addHeader("Authorization", "Bearer " + token);
  http.addHeader("X-Frame-ID", WiFi.macAddress());
  http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    log_e("[OTA] Download GET failed, HTTP code: %d, error: %s",
          httpCode, http.errorToString(httpCode).c_str());
    http.end();
    return OTA_ERR_HTTP_FAILED;
  }

  int contentLength = http.getSize();
  size_t expectedBytes = contentLength > 0 ? (size_t)contentLength : info.size;
  log_i("[OTA] HTTP 200 OK. Incoming payload size: %d bytes (expected: %u)",
        contentLength, (unsigned int)expectedBytes);

  if (expectedBytes > updatePartition->size) {
    log_e("[OTA] Payload size (%u) exceeds partition size (%u)!",
          (unsigned int)expectedBytes, (unsigned int)updatePartition->size);
    http.end();
    return OTA_ERR_FLASH_BEGIN;
  }

  // 5. Initialize SHA-256 context and esp_ota write session
  mbedtls_sha256_context shaCtx;
  mbedtls_sha256_init(&shaCtx);
  mbedtls_sha256_starts(&shaCtx, 0); // 0 = SHA-256

  esp_ota_handle_t otaHandle = 0;
  esp_err_t err = esp_ota_begin(updatePartition, OTA_WITH_SEQUENTIAL_WRITES, &otaHandle);
  if (err != ESP_OK) {
    log_e("[OTA] esp_ota_begin failed: 0x%x", err);
    mbedtls_sha256_free(&shaCtx);
    http.end();
    return OTA_ERR_FLASH_BEGIN;
  }

  // 6. Stream and flash chunks
  WiFiClient* stream = http.getStreamPtr();
  uint8_t chunkBuffer[OTA_STREAM_BUFFER_SIZE];
  size_t totalBytesWritten = 0;
  bool isFirstChunk = true;
  uint32_t lastDataTime = millis();
  uint32_t lastProgressLog = millis();

  while ((http.connected() || stream->available() > 0) &&
         (expectedBytes == 0 || totalBytesWritten < expectedBytes)) {
    size_t available = stream->available();
    if (available == 0) {
      if (millis() - lastDataTime > 20000) {
        log_e("[OTA] Stream read timeout (20s with no data)");
        break;
      }
      delay(2);
      continue;
    }
    lastDataTime = millis();

    size_t toRead = min(available, sizeof(chunkBuffer));
    if (expectedBytes > 0) {
      toRead = min(toRead, expectedBytes - totalBytesWritten);
    }

    size_t bytesRead = stream->readBytes(chunkBuffer, toRead);
    if (bytesRead == 0) break;

    // Validate ESP image header magic byte on first chunk (0xE9)
    if (isFirstChunk) {
      isFirstChunk = false;
      if (chunkBuffer[0] != 0xE9) {
        log_e("[OTA] Invalid firmware header: magic byte 0x%02X != 0xE9", chunkBuffer[0]);
        esp_ota_abort(otaHandle);
        mbedtls_sha256_free(&shaCtx);
        http.end();
        return OTA_ERR_INVALID_HEADER;
      }
    }

    err = esp_ota_write(otaHandle, (const void*)chunkBuffer, bytesRead);
    if (err != ESP_OK) {
      log_e("[OTA] esp_ota_write failed at offset %u: 0x%x", totalBytesWritten, err);
      esp_ota_abort(otaHandle);
      mbedtls_sha256_free(&shaCtx);
      http.end();
      return OTA_ERR_FLASH_WRITE;
    }

    mbedtls_sha256_update(&shaCtx, chunkBuffer, bytesRead);
    totalBytesWritten += bytesRead;

    if (millis() - lastProgressLog > 2000) {
      lastProgressLog = millis();
      if (expectedBytes > 0) {
        log_i("[OTA] Progress: %u / %u bytes (%.1f%%)",
              totalBytesWritten, (unsigned int)expectedBytes, (totalBytesWritten * 100.0f) / expectedBytes);
      } else {
        log_i("[OTA] Flashed %u bytes...", totalBytesWritten);
      }
    }
  }
  http.end();

  // 7. Verify completeness and SHA-256 checksum
  uint8_t calculatedShaBin[32];
  mbedtls_sha256_finish(&shaCtx, calculatedShaBin);
  mbedtls_sha256_free(&shaCtx);

  if (totalBytesWritten == 0 || (expectedBytes > 0 && totalBytesWritten != expectedBytes)) {
    log_e("[OTA] Incomplete download: received %u of %u expected bytes. Aborting.",
          totalBytesWritten, (unsigned int)expectedBytes);
    esp_ota_abort(otaHandle);
    return OTA_ERR_INCOMPLETE_DOWNLOAD;
  }

  String calculatedSha256 = calculateSha256Hex(calculatedShaBin);
  log_i("[OTA] Download completed (%u bytes). Calculated SHA-256: %s",
        totalBytesWritten, calculatedSha256.c_str());

  if (info.sha256.length() > 0 && !calculatedSha256.equalsIgnoreCase(info.sha256)) {
    log_e("[OTA] SHA-256 MISMATCH! Expected: %s, Calculated: %s. Aborting update.",
          info.sha256.c_str(), calculatedSha256.c_str());
    esp_ota_abort(otaHandle);
    return OTA_ERR_HASH_MISMATCH;
  }

  // 8. Commit write to flash partition
  err = esp_ota_end(otaHandle);
  if (err != ESP_OK) {
    log_e("[OTA] esp_ota_end failed: 0x%x", err);
    return OTA_ERR_FLASH_WRITE;
  }

  // 9. Point otadata to the new partition
  err = esp_ota_set_boot_partition(updatePartition);
  if (err != ESP_OK) {
    log_e("[OTA] esp_ota_set_boot_partition failed: 0x%x", err);
    return OTA_ERR_SET_BOOT;
  }

  // Report 'FLASHED' before rebooting; 'SUCCESS' is confirmed only after the new
  // partition actually boots, connects to Wi-Fi, and passes confirmRunningFirmwareValid().
  log_i("[OTA] Boot partition set to '%s'! Reporting FLASHED state before restart...", updatePartition->label);
  reportStatus(serverUrl, token, info.version, "FLASHED", "", batteryVoltage, caCert);

  log_i("[OTA] Rebooting now into updated firmware v%s...", info.version.c_str());
  delay(500);
  esp_restart();

  return OTA_SUCCESS;
}
