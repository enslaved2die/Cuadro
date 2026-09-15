#include "stream_client.h"
#include <ArduinoJson.h>
#include <esp_heap_caps.h>

StreamClient::StreamClient(EPD_GDEB0709E01& epdRef) : epd(epdRef) {}

StreamResult StreamClient::fetchAndStreamFrame(
  const String& serverUrl,
  const String& token,
  float batteryVoltage,
  const String& caCert
) {
  StreamResult result = { false, DEFAULT_SLEEP_SECONDS, "NORMAL", "", 0, "" };

  String endpoint = serverUrl + "/api/v1/frame/next";
  log_i("[STREAM] Connecting to endpoint: %s", endpoint.c_str());

  WiFiClientSecure secureClient;
  if (caCert.length() > 0) {
    secureClient.setCACert(caCert.c_str());
  } else {
    log_w("[STREAM] No CA certificate configured - TLS certificate validation is DISABLED. "
          "Set a CA certificate via the Wi-Fi setup portal to enable full validation.");
    secureClient.setInsecure();
  }

  HTTPClient http;
  if (!http.begin(secureClient, endpoint)) {
    log_e("[STREAM] Unable to initialize HTTPClient");
    return result;
  }

  // Set Request Headers
  http.addHeader("Authorization", "Bearer " + token);
  http.addHeader("X-Frame-ID", WiFi.macAddress());
  http.addHeader("X-Battery-Voltage", String(batteryVoltage, 2));
  http.addHeader("X-Firmware-Version", "1.0.0");

  const char* headerKeys[] = { "X-Sleep-Seconds", "X-Frame-Mode", "X-Image-ID", "X-Frame-Orientation", "Content-Length" };
  http.collectHeaders(headerKeys, 5);

  uint32_t startTime = millis();
  int httpCode = http.GET();

  if (httpCode != HTTP_CODE_OK) {
    log_e("[STREAM] HTTP GET failed, code: %d, error: %s", httpCode, http.errorToString(httpCode).c_str());
    http.end();
    return result;
  }

  // Parse Headers
  if (http.hasHeader("X-Sleep-Seconds")) {
    result.nextSleepSeconds = http.header("X-Sleep-Seconds").toInt();
  }
  if (http.hasHeader("X-Frame-Mode")) {
    result.frameMode = http.header("X-Frame-Mode");
  }
  if (http.hasHeader("X-Image-ID")) {
    result.imageId = http.header("X-Image-ID");
  }
  if (http.hasHeader("X-Frame-Orientation")) {
    result.frameOrientation = http.header("X-Frame-Orientation");
  }

  int contentLength = http.getSize();
  log_i("[STREAM] HTTP 200 OK. Payload Size: %d, Mode: %s, Next Sleep: %u s",
        contentLength, result.frameMode.c_str(), result.nextSleepSeconds);

  if (contentLength > 0 && contentLength != EPD_TOTAL_PAYLOAD) {
    log_w("[STREAM] Payload size mismatch (expected %d, got %d). Aborting.", EPD_TOTAL_PAYLOAD, contentLength);
    http.end();
    return result;
  }

  uint8_t* frameBuffer = (uint8_t*)ps_malloc(EPD_TOTAL_PAYLOAD);
  if (!frameBuffer) {
    // fallback to heap_caps_malloc if ps_malloc is not defined
    frameBuffer = (uint8_t*)heap_caps_malloc(EPD_TOTAL_PAYLOAD, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  if (!frameBuffer) {
    log_e("[STREAM] Failed to allocate 960KB in PSRAM!");
    http.end();
    return result;
  }

  WiFiClient* stream = http.getStreamPtr();
  size_t totalBytesRead = 0;
  uint32_t readTimeoutStart = millis();

  while (http.connected() && (totalBytesRead < EPD_TOTAL_PAYLOAD)) {
    size_t available = stream->available();
    if (available == 0) {
      if (millis() - readTimeoutStart > 10000) {
        log_e("[STREAM] Stream read timeout!");
        break;
      }
      delay(2);
      continue;
    }
    readTimeoutStart = millis();
    size_t toRead = min(available, (size_t)(EPD_TOTAL_PAYLOAD - totalBytesRead));
    size_t bytesRead = stream->readBytes(frameBuffer + totalBytesRead, toRead);
    if (bytesRead == 0) break;
    totalBytesRead += bytesRead;
  }
  http.end();

  if (totalBytesRead == EPD_TOTAL_PAYLOAD) {
    log_i("[STREAM] Frame download complete (960,000 bytes). Sending to display...");
    epd.displayImage(frameBuffer);
    result.success = true;
    result.durationMs = millis() - startTime;
  } else {
    log_e("[STREAM] Incomplete transfer: received %u of %d bytes", totalBytesRead, EPD_TOTAL_PAYLOAD);
  }

  free(frameBuffer);
  return result;
}

void StreamClient::acknowledgeSuccess(
  const String& serverUrl,
  const String& token,
  const String& imageId,
  uint32_t durationMs,
  float batteryVoltage,
  const String& caCert
) {
  String endpoint = serverUrl + "/api/v1/frame/ack";

  WiFiClientSecure secureClient;
  if (caCert.length() > 0) {
    secureClient.setCACert(caCert.c_str());
  } else {
    log_w("[STREAM] No CA certificate configured - TLS certificate validation is DISABLED. "
          "Set a CA certificate via the Wi-Fi setup portal to enable full validation.");
    secureClient.setInsecure();
  }

  HTTPClient http;
  if (!http.begin(secureClient, endpoint)) return;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + token);
  http.addHeader("X-Frame-ID", WiFi.macAddress());

  JsonDocument doc;
  doc["imageId"] = imageId;
  doc["status"] = "SUCCESS";
  doc["drawDurationMs"] = durationMs;
  doc["rssi"] = WiFi.RSSI();
  doc["batteryVoltage"] = batteryVoltage;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  log_d("[STREAM] Telemetry ACK response code: %d", code);
  http.end();
}
