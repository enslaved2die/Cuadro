#pragma once
#include <Arduino.h>
#include <SPI.h>
#include "config.h"

class EPD_GDEB0709E01 {
public:
  EPD_GDEB0709E01();
  ~EPD_GDEB0709E01();

  void begin();
  void hardwareReset();
  void waitBusy(uint32_t timeoutMs = 60000);
  uint8_t checkDriverStatus();

  void displayImage(const uint8_t* imageBuffer);
  void displayClear(uint8_t color);
  void displayPureWhite();
  void displayTestColorBars();
  void displaySetupScreen(const char* apSsid, const char* ipAddress, const String& orientation = "portrait_180");

  void refresh();
  void powerSleep();

private:
  // Logical mounting orientation used to remap drawChar/drawText coordinates
  // so setup-screen text renders upright to a viewer, matching the same
  // portrait/portrait_180/landscape/landscape_270 convention the backend
  // uses when it rotates real photos server-side (see processor.ts).
  enum class Orientation { PORTRAIT, PORTRAIT_180, LANDSCAPE, LANDSCAPE_270 };
  Orientation m_orientation = Orientation::PORTRAIT_180;

  static Orientation parseOrientation(const String& orientation);
  int logicalWidth() const;
  int logicalHeight() const;
  void setNibbleOriented(uint8_t* buf, int x, int y, uint8_t nibble);

  bool getGlyphRows(char c, uint8_t rows[7]);
  void drawChar(uint8_t* buf, int x, int y, char c, uint8_t colorNibble, int scale);
  void drawText(uint8_t* buf, int x, int y, const char* text, uint8_t colorNibble, int scale);

  void writeCommand(uint8_t cmd);
  void writeDataByte(uint8_t data);
  void writeDataBytes(const uint8_t* data, size_t len);
  void writeCommandData(uint8_t cmd, const uint8_t* data, size_t len);
  void writeMasterRegister(uint8_t cmd, const uint8_t* data, size_t len);
  void writeSlaveRegister(uint8_t cmd, const uint8_t* data, size_t len);

  void selectMaster(bool enable);
  void selectSlave(bool enable);
  void selectBoth(bool enable);
};
