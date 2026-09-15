#include "power_manager.h"
#include <driver/gpio.h>

PowerManager::PowerManager() {}

void PowerManager::initButtons() {
  uint8_t mode = (BUTTON_ACTIVE_LEVEL == HIGH) ? INPUT_PULLDOWN : INPUT_PULLUP;
  pinMode(BUTTON_REFRESH_PIN, mode);
  pinMode(BUTTON_HOTSPOT_PIN, mode);
  pinMode(BUTTON_DIAG_PIN, mode);
  pinMode(BUTTON_BOOT_PIN, INPUT_PULLUP);
}

WakeupReason PowerManager::getWakeupReason() {
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  switch (cause) {
    case ESP_SLEEP_WAKEUP_EXT0:
    case ESP_SLEEP_WAKEUP_EXT1:
      log_i("[POWER] Wakeup triggered by Physical Button");
      return WAKEUP_BUTTON_MANUAL;

    case ESP_SLEEP_WAKEUP_TIMER:
      log_i("[POWER] Wakeup triggered by RTC Timer");
      return WAKEUP_TIMER_SCHEDULED;

    default:
      log_i("[POWER] Cold Boot / Power-On Reset (cause: %d)", cause);
      return WAKEUP_POWER_ON_RESET;
  }
}

static bool isPinActive(int pin, int activeLevel) {
  return digitalRead(pin) == activeLevel;
}

static uint32_t measureHoldTime(int pin, int activeLevel, uint32_t maxMs) {
  uint32_t start = millis();
  while (isPinActive(pin, activeLevel)) {
    delay(20);
    if (millis() - start >= maxMs) {
      return maxMs;
    }
  }
  return millis() - start;
}

ButtonAction PowerManager::checkButtonAction() {
  initButtons();
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  uint64_t ext1_pins = 0;
  if (cause == ESP_SLEEP_WAKEUP_EXT1) {
    ext1_pins = esp_sleep_get_ext1_wakeup_status();
  }

  // 1. Check Button 1 (SW2, GPIO 12: Refresh / Storage)
  if ((ext1_pins & (1ULL << BUTTON_REFRESH_PIN)) || isPinActive(BUTTON_REFRESH_PIN, BUTTON_ACTIVE_LEVEL)) {
    log_i("[BUTTON] Button 1 detected! Measuring press duration...");
    uint32_t holdMs = measureHoldTime(BUTTON_REFRESH_PIN, BUTTON_ACTIVE_LEVEL, BUTTON_HOLD_MS);
    if (holdMs >= BUTTON_HOLD_MS) {
      log_i("[BUTTON] Button 1 held for >= %u ms -> ACTION_ENTER_STORAGE_MODE", BUTTON_HOLD_MS);
      return ACTION_ENTER_STORAGE_MODE;
    } else {
      log_i("[BUTTON] Button 1 released after %u ms -> ACTION_REFRESH_NOW", holdMs);
      return ACTION_REFRESH_NOW;
    }
  }

  // 2. Check Button 2 (SW3, GPIO 13: Wi-Fi Hotspot) or Boot Button (GPIO 0)
  if ((ext1_pins & (1ULL << BUTTON_HOTSPOT_PIN)) || isPinActive(BUTTON_HOTSPOT_PIN, BUTTON_ACTIVE_LEVEL) ||
      (cause == ESP_SLEEP_WAKEUP_EXT0) || isPinActive(BUTTON_BOOT_PIN, LOW)) {
    int pin = isPinActive(BUTTON_HOTSPOT_PIN, BUTTON_ACTIVE_LEVEL) ? BUTTON_HOTSPOT_PIN : BUTTON_BOOT_PIN;
    int activeLvl = (pin == BUTTON_BOOT_PIN) ? LOW : BUTTON_ACTIVE_LEVEL;

    log_i("[BUTTON] Button 2 / BOOT detected! Measuring press duration...");
    uint32_t holdMs = measureHoldTime(pin, activeLvl, BUTTON_HOTSPOT_HOLD_MS);
    if (holdMs >= BUTTON_HOTSPOT_HOLD_MS) {
      log_i("[BUTTON] Button 2 held for >= %u ms -> ACTION_LAUNCH_HOTSPOT", BUTTON_HOTSPOT_HOLD_MS);
      return ACTION_LAUNCH_HOTSPOT;
    } else {
      log_i("[BUTTON] Button 2 short tap (%u ms) ignored; hold %ums required for hotspot.", holdMs, BUTTON_HOTSPOT_HOLD_MS);
      return ACTION_NONE;
    }
  }

  // 3. Check Button 3 (SW4, GPIO 14: Diagnostic Color Bars)
  if ((ext1_pins & (1ULL << BUTTON_DIAG_PIN)) || isPinActive(BUTTON_DIAG_PIN, BUTTON_ACTIVE_LEVEL)) {
    log_i("[BUTTON] Button 3 detected -> ACTION_DIAGNOSTICS");
    return ACTION_DIAGNOSTICS;
  }

  return ACTION_NONE;
}

float PowerManager::readBatteryVoltage() {
  // ADC divider calculation if populated on BATTERY_ADC_PIN (GPIO 1)
  int raw = analogRead(BATTERY_ADC_PIN);
  float voltage = (raw / 4095.0f) * 3.3f * 2.0f; // 2x voltage divider
  return (voltage > 2.5f && voltage < 4.5f) ? voltage : 3.30f;
}

void PowerManager::lightSleep(uint32_t sleepSeconds) {
  // Light sleep (not deep sleep): this device isn't battery-powered, and deep sleep's
  // full chip reboot on every wake required re-initializing the SPI/GPIO-matrix
  // peripherals from scratch each cycle. That path turned out to reliably fail to
  // properly re-power/re-sync the EPD panel after a real deep-sleep wake (confirmed
  // live: BUSY never asserted, refresh() silently completed in <1s instead of ~40s,
  // reproduced on both button and genuine RTC-timer wakeups) despite extensive GPIO
  // isolation/hold fixes. Light sleep keeps the CPU core, RAM, and all peripheral state
  // (including the SPI bus and every GPIO's configuration/level) fully intact across
  // the sleep - there is no re-init gap for this class of bug to live in. No pin
  // isolation/holding is needed or done here as a result.
  log_i("[POWER] Preparing for light sleep (%u seconds)...", sleepSeconds);

  // Buttons SW2 (12), SW3 (13), SW4 (14) are RTC GPIOs on ESP32-S3
  uint64_t buttonMask = (1ULL << BUTTON_REFRESH_PIN) |
                        (1ULL << BUTTON_HOTSPOT_PIN) |
                        (1ULL << BUTTON_DIAG_PIN);

  if (BUTTON_ACTIVE_LEVEL == HIGH) {
    esp_sleep_enable_ext1_wakeup(buttonMask, ESP_EXT1_WAKEUP_ANY_HIGH);
  } else {
    esp_sleep_enable_ext1_wakeup(buttonMask, ESP_EXT1_WAKEUP_ANY_LOW);
  }

  // Also support physical BOOT button (GPIO 0, active LOW)
  esp_sleep_enable_ext0_wakeup((gpio_num_t)BUTTON_BOOT_PIN, 0);

  // Configure Timer Wakeup (if sleepSeconds > 0)
  // If sleepSeconds == 0 (Storage Mode), wake up exclusively via manual button!
  if (sleepSeconds > 0) {
    uint64_t sleepMicroseconds = (uint64_t)sleepSeconds * 1000000ULL;
    esp_sleep_enable_timer_wakeup(sleepMicroseconds);
    log_i("[POWER] Timer wakeup set for %u s", sleepSeconds);
  } else {
    log_i("[POWER] Storage mode: timer disabled. Sleeping indefinitely until button press.");
  }

  log_i("[POWER] Entering ESP32 light sleep now...");
  Serial.flush();
  esp_light_sleep_start();
  // Execution resumes HERE after waking - unlike deep sleep, light sleep returns
  // instead of rebooting the chip. loop() in main.cpp calls this, returns, and the
  // Arduino framework immediately calls loop() again to run the next cycle.
  log_i("[POWER] Woke from light sleep.");
}
