#pragma once

#include <Arduino.h>
#include <esp_sleep.h>
#include <driver/rtc_io.h>
#include "config.h"

enum WakeupReason {
  WAKEUP_BUTTON_MANUAL,
  WAKEUP_TIMER_SCHEDULED,
  WAKEUP_POWER_ON_RESET
};

enum ButtonAction {
  ACTION_NONE,
  ACTION_REFRESH_NOW,          // Button 1 short click: Fetch next frame immediately
  ACTION_ENTER_STORAGE_MODE,   // Button 1 hold (>3s): Clear to white & sleep indefinitely
  ACTION_LAUNCH_HOTSPOT,       // Button 2 hold (>3s): Launch Wi-Fi SoftAP Captive Portal
  ACTION_DIAGNOSTICS           // Button 3 click: Show 6-color test pattern
};

class PowerManager {
public:
  PowerManager();
  void initButtons();
  WakeupReason getWakeupReason();
  ButtonAction checkButtonAction();
  float readBatteryVoltage();
  void lightSleep(uint32_t sleepSeconds);
};
