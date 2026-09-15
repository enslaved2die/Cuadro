#include "captive_portal.h"

static const byte DNS_PORT = 53;

// Escapes &, <, >, " so untrusted stored values can be safely interpolated
// into HTML attribute values / textarea content.
static String htmlEscape(const String& input) {
  String out;
  out.reserve(input.length());
  for (size_t i = 0; i < input.length(); i++) {
    char c = input[i];
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += c; break;
    }
  }
  return out;
}

CaptivePortal::CaptivePortal() : server(80) {}

void CaptivePortal::begin() {
  prefs.begin("memories", false);
}

bool CaptivePortal::loadConfig(DeviceConfig& config) {
  begin();
  config.wifiSsid = prefs.getString("ssid", "");
  config.wifiPassword = prefs.getString("pass", "");
  config.serverUrl = prefs.getString("server", "http://192.168.1.100:8080");
  config.frameToken = prefs.getString("token", "memories-frame-secure-token-12345");
  config.caCert = prefs.getString("cacert", "");
  config.sleepSeconds = prefs.getUInt("sleep", DEFAULT_SLEEP_SECONDS);
  // Default matches backend/src/config.ts's own default so the very first setup
  // screen (before any successful fetch has taught us the real orientation) is at
  // least oriented per the most common real-world mounting (ribbon cable at top).
  config.frameOrientation = prefs.getString("orient", "portrait_180");
  prefs.end();

  return (config.wifiSsid.length() > 0);
}

void CaptivePortal::saveConfig(const DeviceConfig& config) {
  begin();
  prefs.putString("ssid", config.wifiSsid);
  prefs.putString("pass", config.wifiPassword);
  prefs.putString("server", config.serverUrl);
  prefs.putString("token", config.frameToken);
  prefs.putString("cacert", config.caCert);
  prefs.putUInt("sleep", config.sleepSeconds);
  prefs.putString("orient", config.frameOrientation);
  prefs.end();
}

void CaptivePortal::setupRoutes() {
  server.on("/", HTTP_GET, [this]() { handleRoot(); });
  server.on("/save", HTTP_POST, [this]() { handleSave(); });
  server.onNotFound([this]() { handleRoot(); }); // Redirect all requests for captive portal detection
}

void CaptivePortal::handleRoot() {
  DeviceConfig current;
  loadConfig(current);

  String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cuadro Setup</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f1f5f9; padding: 1.5rem; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 400px; margin: 0 auto; }
    h2 { margin-top: 0; color: #0f172a; }
    label { display: block; margin-top: 1rem; font-weight: 600; font-size: 0.85rem; color: #475569; }
    input { width: 100%; box-sizing: border-box; padding: 0.6rem; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 0.25rem; font-size: 1rem; }
    button { width: 100%; background: #2563eb; color: #fff; border: none; padding: 0.75rem; border-radius: 6px; font-weight: 600; font-size: 1rem; margin-top: 1.5rem; cursor: pointer; }
    details { margin-top: 1.25rem; }
    summary { font-weight: 600; font-size: 0.85rem; color: #475569; cursor: pointer; }
    textarea { width: 100%; box-sizing: border-box; padding: 0.6rem; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 0.5rem; font-size: 0.8rem; font-family: monospace; }
    .hint { font-size: 0.78rem; color: #64748b; margin: 0.5rem 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🖼️ Cuadro Wi-Fi Setup</h2>
    <form action="/save" method="POST">
      <label>Wi-Fi Network (SSID)</label>
      <input type="text" name="ssid" value=")rawliteral" + current.wifiSsid + R"rawliteral(" required>

      <label>Wi-Fi Password</label>
      <input type="password" name="pass" value=")rawliteral" + current.wifiPassword + R"rawliteral(">

      <label>Backend Server URL</label>
      <input type="text" name="server" value=")rawliteral" + current.serverUrl + R"rawliteral(" required>

      <label>Frame Security Token</label>
      <input type="text" name="token" value=")rawliteral" + current.frameToken + R"rawliteral(" required>

      <details)rawliteral" + String(current.caCert.length() > 0 ? " open" : "") + R"rawliteral(>
        <summary>Advanced: Custom CA Certificate (optional)</summary>
        <p class="hint">Leave this blank to accept any server certificate (less secure, vulnerable to
        network attackers). Paste your server's CA certificate in PEM format to enable full TLS
        certificate validation.</p>
        <textarea name="cacert" rows="6" placeholder="-----BEGIN CERTIFICATE-----...">)rawliteral" + htmlEscape(current.caCert) + R"rawliteral(</textarea>
      </details>

      <button type="submit">Save & Connect</button>
    </form>
  </div>
</body>
</html>
)rawliteral";

  server.send(200, "text/html", html);
}

void CaptivePortal::handleSave() {
  DeviceConfig cfg;
  cfg.wifiSsid = server.arg("ssid");
  cfg.wifiPassword = server.arg("pass");
  cfg.serverUrl = server.arg("server");
  cfg.frameToken = server.arg("token");
  cfg.caCert = server.arg("cacert");
  cfg.caCert.trim();
  cfg.sleepSeconds = DEFAULT_SLEEP_SECONDS;

  saveConfig(cfg);
  configSaved = true;

  String html = "<html><body style='font-family: sans-serif; text-align: center; padding: 2rem;'>"
                "<h2>Settings Saved!</h2><p>Cuadro is restarting to connect to your Wi-Fi...</p>"
                "</body></html>";
  server.send(200, "text/html", html);
}

void CaptivePortal::runPortal(uint32_t timeoutMs) {
  log_i("[PORTAL] Starting SoftAP '" WIFI_AP_SSID "'...");
  WiFi.mode(WIFI_AP);
  WiFi.softAP(WIFI_AP_SSID);

  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));

  dnsServer.start(DNS_PORT, "*", apIP);
  setupRoutes();
  server.begin();

  log_i("[PORTAL] AP IP: %s. Listening for setup requests...", apIP.toString().c_str());

  uint32_t startTime = millis();
  while (!configSaved) {
    dnsServer.processNextRequest();
    server.handleClient();
    delay(5);

    if (millis() - startTime > timeoutMs) {
      log_w("[PORTAL] Timed out waiting for configuration.");
      break;
    }
  }

  server.stop();
  dnsServer.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);

  if (configSaved) {
    log_i("[PORTAL] Configuration updated. Rebooting...");
    delay(500);
    ESP.restart();
  }
}
