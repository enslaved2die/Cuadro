#include "epd_gdeb0709e01.h"
#include <esp_heap_caps.h>
#include <driver/rtc_io.h>
#include <driver/gpio.h>
#include <ctype.h>
#include <string.h>
#include <stdio.h>

static const uint8_t PSR_V[2] = {0xDF, 0x6B};
static const uint8_t PWR_V[6] = {0x0F, 0x00, 0x28, 0x2C, 0x28, 0x38};
static const uint8_t POF_V[1] = {0x01};
static const uint8_t POFS_MV[4] = {0x00, 0xC0, 0x03, 0xA8};
static const uint8_t POFS_SV[4] = {0x00, 0xC0, 0x03, 0x9A};
static const uint8_t DRF_V[1] = {0x00};
static const uint8_t PLL_V[1] = {0x08};
static const uint8_t CDI_V[1] = {0x37};
static const uint8_t TCON_V[2] = {0x03, 0x03};
static const uint8_t TRES_V[4] = {0x04, 0xB0, 0x03, 0x20};
static const uint8_t CMD66_V[6] = {0x49, 0x55, 0x13, 0x5D, 0x05, 0x10};
static const uint8_t EN_BUF_V[1] = {0x07};
static const uint8_t CCSET_V[1] = {0x01};
static const uint8_t PWS_V[1] = {0x22};
static const uint8_t AN_TM_V[9] = {0x00, 0x0C, 0x0C, 0xD9, 0xDD, 0xDD, 0x15, 0x15, 0x55};
static const uint8_t AGID_V[1] = {0x10};
static const uint8_t CMDA4_V[9] = {0x03, 0x00, 0x01, 0x03, 0x00, 0x03, 0x00, 0x00, 0x00};
static const uint8_t DCDC_V[3] = {0x44, 0x54, 0x00};
static const uint8_t BTST_P_V[2] = {0xE0, 0x20};
static const uint8_t BOOST_VDDP_EN_V[1] = {0x01};
static const uint8_t BTST_N_V[2] = {0xE0, 0x20};
static const uint8_t BUCK_BOOST_VDDN_V[1] = {0x01};
static const uint8_t TFT_VCOM_POWER_V[1] = {0x02};

static SPISettings s_spiSettings(20000000, MSBFIRST, SPI_MODE0); // 20MHz SPI Mode 0

EPD_GDEB0709E01::EPD_GDEB0709E01() {}
EPD_GDEB0709E01::~EPD_GDEB0709E01() {}

void EPD_GDEB0709E01::selectMaster(bool enable) {
  digitalWrite(EPD_CS_M_PIN, enable ? LOW : HIGH);
}

void EPD_GDEB0709E01::selectSlave(bool enable) {
  digitalWrite(EPD_CS_S_PIN, enable ? LOW : HIGH);
}

void EPD_GDEB0709E01::selectBoth(bool enable) {
  uint8_t level = enable ? LOW : HIGH;
  digitalWrite(EPD_CS_M_PIN, level);
  digitalWrite(EPD_CS_S_PIN, level);
}

void EPD_GDEB0709E01::writeCommand(uint8_t cmd) {
  digitalWrite(EPD_DC_PIN, LOW);
  SPI.beginTransaction(s_spiSettings);
  SPI.transfer(cmd);
  SPI.endTransaction();
}

void EPD_GDEB0709E01::writeDataByte(uint8_t data) {
  digitalWrite(EPD_DC_PIN, HIGH);
  SPI.beginTransaction(s_spiSettings);
  SPI.transfer(data);
  SPI.endTransaction();
}

void EPD_GDEB0709E01::writeDataBytes(const uint8_t* data, size_t len) {
  if (len == 0) return;
  digitalWrite(EPD_DC_PIN, HIGH);
  SPI.beginTransaction(s_spiSettings);
  SPI.writeBytes(data, len);
  SPI.endTransaction();
}

void EPD_GDEB0709E01::writeCommandData(uint8_t cmd, const uint8_t* data, size_t len) {
  writeCommand(cmd);
  writeDataBytes(data, len);
}

void EPD_GDEB0709E01::writeMasterRegister(uint8_t cmd, const uint8_t* data, size_t len) {
  selectMaster(true);
  selectSlave(false);
  writeCommandData(cmd, data, len);
  selectMaster(false);
}

void EPD_GDEB0709E01::writeSlaveRegister(uint8_t cmd, const uint8_t* data, size_t len) {
  selectSlave(true);
  selectMaster(false);
  writeCommandData(cmd, data, len);
  selectSlave(false);
}

void EPD_GDEB0709E01::hardwareReset() {
  digitalWrite(EPD_RST_PIN, HIGH);
  delay(30);
  digitalWrite(EPD_RST_PIN, LOW);
  delay(30);
  digitalWrite(EPD_RST_PIN, HIGH);
  delay(30);
  digitalWrite(EPD_RST_PIN, LOW);
  delay(30);
  digitalWrite(EPD_RST_PIN, HIGH);
  delay(30);
}

void EPD_GDEB0709E01::waitBusy(uint32_t timeoutMs) {
  uint32_t start = millis();

  // The controller can take a bit after a command (or, right after hardwareReset(),
  // after the reset pulse itself) to actually pull BUSY low. Waiting only for
  // "BUSY == HIGH" (below) without first confirming it was ever asserted LOW means a
  // stale/premature HIGH reading (e.g. panel not fully powered up yet) returns
  // instantly, silently skipping the real refresh entirely - this is exactly what
  // caused the storage-mode white-clear to "complete" in ~30ms instead of the ~40s a
  // real refresh takes, with nothing visibly changing on the panel. 500ms (up from an
  // initial 200ms) comfortably covers the post-reset assertion delay observed in
  // practice - every other command in this driver asserts BUSY well within 200ms, but
  // the very first check right after hardwareReset() needs a bit more room.
  uint32_t assertWaitStart = millis();
  while (digitalRead(EPD_BUSY_PIN) == HIGH) {
    if (millis() - assertWaitStart > 500) {
      log_w("[EPD] BUSY never asserted LOW within 500ms - panel may not be powered/ready yet.");
      break;
    }
    delay(2);
  }

  // On GDEB0709E01, BUSY is Active LOW (LOW while busy, HIGH when idle/ready)
  while (digitalRead(EPD_BUSY_PIN) == LOW) {
    delay(10);
    if (millis() - start > timeoutMs) {
      log_e("[EPD] BUSY timeout after %u ms!", timeoutMs);
      return;
    }
  }
  delay(20);
  log_d("[EPD] BUSY released in %u ms", millis() - start);
}

void EPD_GDEB0709E01::begin() {
  // Matches Good Display's own official reference init (DEV_Module_Init) exactly - no
  // GPIO isolation/hold cleanup needed here. That machinery existed only to work around
  // deep sleep rebooting the chip and resetting the GPIO matrix/SPI peripheral on every
  // wake; now that PowerManager uses light sleep instead, none of these pins are ever
  // isolated or held across sleep in the first place; light sleep leaves the whole chip
  // - including SPI, the GPIO matrix, and every pin's configuration and level - exactly
  // as this function last left it.
  pinMode(EPD_BUSY_PIN, INPUT);
  pinMode(EPD_RST_PIN, OUTPUT);
  pinMode(EPD_DC_PIN, OUTPUT);
  pinMode(EPD_PWR_PIN, OUTPUT);
  pinMode(EPD_CS_M_PIN, OUTPUT);
  pinMode(EPD_CS_S_PIN, OUTPUT);

  digitalWrite(EPD_CS_M_PIN, HIGH);
  digitalWrite(EPD_CS_S_PIN, HIGH);
  digitalWrite(EPD_DC_PIN, HIGH);
  digitalWrite(EPD_PWR_PIN, HIGH);
  digitalWrite(EPD_RST_PIN, HIGH);

  // Let the panel's power rail settle before talking to it.
  delay(100);

  // Initialize hardware SPI (20MHz SPI Mode 0)
  SPI.begin(EPD_SCK_PIN, EPD_MISO_PIN, EPD_MOSI_PIN, -1);

  // 5-stage reset pulse
  hardwareReset();
  waitBusy();

  // Initialization sequence matching official Good Display reference
  selectBoth(false);
  writeMasterRegister(0x74, AN_TM_V, sizeof(AN_TM_V));

  selectBoth(true);
  writeCommandData(0xF0, CMD66_V, sizeof(CMD66_V));
  selectBoth(false);

  selectBoth(true);
  writeCommandData(0x00, PSR_V, sizeof(PSR_V));
  selectBoth(false);

  writeMasterRegister(0xA5, DCDC_V, sizeof(DCDC_V));

  selectBoth(true);
  writeCommandData(0x30, PLL_V, sizeof(PLL_V));
  selectBoth(false);

  selectBoth(true);
  writeCommandData(0x50, CDI_V, sizeof(CDI_V));
  selectBoth(false);

  selectBoth(true);
  writeCommandData(0x60, TCON_V, sizeof(TCON_V));
  selectBoth(false);

  writeMasterRegister(0x03, POFS_MV, sizeof(POFS_MV));
  writeSlaveRegister(0x03, POFS_SV, sizeof(POFS_SV));

  selectBoth(true);
  writeCommandData(0x86, AGID_V, sizeof(AGID_V));
  selectBoth(false);

  selectBoth(true);
  writeCommandData(0xE3, PWS_V, sizeof(PWS_V));
  selectBoth(false);

  selectBoth(true);
  writeCommandData(0xE0, CCSET_V, sizeof(CCSET_V));
  selectBoth(false);

  selectBoth(true);
  writeCommandData(0x61, TRES_V, sizeof(TRES_V));
  selectBoth(false);

  writeMasterRegister(0xA4, CMDA4_V, sizeof(CMDA4_V));
  writeMasterRegister(0x01, PWR_V, sizeof(PWR_V));
  writeMasterRegister(0xB6, EN_BUF_V, sizeof(EN_BUF_V));
  writeMasterRegister(0x06, BTST_P_V, sizeof(BTST_P_V));
  writeMasterRegister(0xB7, BOOST_VDDP_EN_V, sizeof(BOOST_VDDP_EN_V));
  writeMasterRegister(0x05, BTST_N_V, sizeof(BTST_N_V));
  writeMasterRegister(0xB0, BUCK_BOOST_VDDN_V, sizeof(BUCK_BOOST_VDDN_V));
  writeMasterRegister(0xB1, TFT_VCOM_POWER_V, sizeof(TFT_VCOM_POWER_V));

  log_i("[EPD] Initialization sequence completed.");
}

uint8_t EPD_GDEB0709E01::checkDriverStatus() {
  uint8_t status = 0;

  for (int cs = 0; cs < 2; cs++) {
    uint8_t buf[3] = {0, 0, 0};

    if (cs == 0) {
      selectMaster(true);
      selectSlave(false);
    } else {
      selectSlave(true);
      selectMaster(false);
    }

    writeCommand(0xF2);
    digitalWrite(EPD_DC_PIN, HIGH);
    SPI.beginTransaction(s_spiSettings);
    for (int i = 0; i < 3; i++) {
      buf[i] = SPI.transfer(0x00);
    }
    SPI.endTransaction();

    if (cs == 0) {
      selectMaster(false);
    } else {
      selectSlave(false);
    }

    log_i("[STATUS] IC[%d] = 0x%02X 0x%02X 0x%02X", cs, buf[0], buf[1], buf[2]);
    if ((buf[0] & 0x01) == 0x01) {
      log_i("[STATUS] IC[%d] ready", cs);
    } else {
      log_w("[STATUS] IC[%d] not ready", cs);
      status = 1;
    }
  }

  return status;
}

void EPD_GDEB0709E01::displayImage(const uint8_t* imageBuffer) {
  if (!imageBuffer) return;

  // Master controller (Left half: columns 0..599, 300 bytes per row)
  selectMaster(true);
  selectSlave(false);
  writeCommand(0x10);
  for (uint32_t row = 0; row < EPD_HEIGHT; row++) {
    writeDataBytes(imageBuffer + row * EPD_ROW_BYTES, EPD_HALF_ROW_BYTES);
  }
  selectMaster(false);

  // Slave controller (Right half: columns 600..1199, 300 bytes per row)
  selectSlave(true);
  selectMaster(false);
  writeCommand(0x10);
  for (uint32_t row = 0; row < EPD_HEIGHT; row++) {
    writeDataBytes(imageBuffer + row * EPD_ROW_BYTES + EPD_HALF_ROW_BYTES, EPD_HALF_ROW_BYTES);
  }
  selectSlave(false);

  refresh();
}

void EPD_GDEB0709E01::displayClear(uint8_t color) {
  uint8_t packed = (color << 4) | (color & 0x0F);
  uint8_t line[EPD_HALF_ROW_BYTES];
  memset(line, packed, sizeof(line));

  // Master controller
  selectMaster(true);
  selectSlave(false);
  writeCommand(0x10);
  for (uint32_t row = 0; row < EPD_HEIGHT; row++) {
    writeDataBytes(line, sizeof(line));
  }
  selectMaster(false);

  // Slave controller
  selectSlave(true);
  selectMaster(false);
  writeCommand(0x10);
  for (uint32_t row = 0; row < EPD_HEIGHT; row++) {
    writeDataBytes(line, sizeof(line));
  }
  selectSlave(false);

  refresh();
}

void EPD_GDEB0709E01::displayPureWhite() {
  displayClear(0x01);
}

void EPD_GDEB0709E01::displayTestColorBars() {
  log_i("[EPD] Rendering 6-color test pattern...");

  // Master receives bars 0, 1, 2: Black 0x0 (0x00), White 0x1 (0x11), Yellow 0x2 (0x22)
  uint8_t masterLine[EPD_HALF_ROW_BYTES];
  memset(masterLine, 0x00, 100);
  memset(masterLine + 100, 0x11, 100);
  memset(masterLine + 200, 0x22, 100);

  // Slave receives bars 3, 4, 5: Red 0x3 (0x33), Blue 0x5 (0x55), Green 0x6 (0x66)
  uint8_t slaveLine[EPD_HALF_ROW_BYTES];
  memset(slaveLine, 0x33, 100);
  memset(slaveLine + 100, 0x55, 100);
  memset(slaveLine + 200, 0x66, 100);

  // Master controller
  selectMaster(true);
  selectSlave(false);
  writeCommand(0x10);
  for (uint32_t row = 0; row < EPD_HEIGHT; row++) {
    writeDataBytes(masterLine, sizeof(masterLine));
  }
  selectMaster(false);

  // Slave controller
  selectSlave(true);
  selectMaster(false);
  writeCommand(0x10);
  for (uint32_t row = 0; row < EPD_HEIGHT; row++) {
    writeDataBytes(slaveLine, sizeof(slaveLine));
  }
  selectSlave(false);

  refresh();
}

void EPD_GDEB0709E01::refresh() {
  log_i("[EPD] Powering on booster (PON)...");
  selectBoth(true);
  writeCommand(0x04);
  selectBoth(false);
  waitBusy();

  delay(50);

  log_i("[EPD] Initiating display refresh (DRF)...");
  selectBoth(true);
  writeCommandData(0x12, DRF_V, sizeof(DRF_V));
  selectBoth(false);
  waitBusy();

  log_i("[EPD] Powering off panel (POF)...");
  selectBoth(true);
  writeCommandData(0x02, POF_V, sizeof(POF_V));
  selectBoth(false);
  waitBusy();

  log_i("[EPD] Display refresh cycle finished.");
}

// ==============================================================================
// Minimal 5x7 bitmap font (uppercase letters, digits, and basic punctuation)
// covering only the characters used by the on-panel setup screen.
// Each row's low 5 bits encode columns left(MSB)->right(LSB).
// ==============================================================================
bool EPD_GDEB0709E01::getGlyphRows(char c, uint8_t rows[7]) {
  static const uint8_t BLANK[7]  = {0x00,0x00,0x00,0x00,0x00,0x00,0x00};
  static const uint8_t D0[7]     = {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E};
  static const uint8_t D1[7]     = {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E};
  static const uint8_t D2[7]     = {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F};
  static const uint8_t D3[7]     = {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E};
  static const uint8_t D4[7]     = {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02};
  static const uint8_t D5[7]     = {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E};
  static const uint8_t D6[7]     = {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E};
  static const uint8_t D7[7]     = {0x1F,0x01,0x02,0x04,0x08,0x08,0x08};
  static const uint8_t D8[7]     = {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E};
  static const uint8_t D9[7]     = {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C};
  static const uint8_t A[7]      = {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11};
  static const uint8_t C[7]      = {0x0F,0x10,0x10,0x10,0x10,0x10,0x0F};
  static const uint8_t D[7]      = {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E};
  static const uint8_t E[7]      = {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F};
  static const uint8_t F[7]      = {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10};
  static const uint8_t H[7]      = {0x11,0x11,0x11,0x1F,0x11,0x11,0x11};
  static const uint8_t I[7]      = {0x0E,0x04,0x04,0x04,0x04,0x04,0x0E};
  static const uint8_t M[7]      = {0x11,0x1B,0x15,0x15,0x11,0x11,0x11};
  static const uint8_t N[7]      = {0x11,0x19,0x15,0x15,0x13,0x11,0x11};
  static const uint8_t O[7]      = {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E};
  static const uint8_t P[7]      = {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10};
  static const uint8_t R[7]      = {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11};
  static const uint8_t S[7]      = {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E};
  static const uint8_t T[7]      = {0x1F,0x04,0x04,0x04,0x04,0x04,0x04};
  static const uint8_t U[7]      = {0x11,0x11,0x11,0x11,0x11,0x11,0x0E};
  static const uint8_t W[7]      = {0x11,0x11,0x11,0x15,0x15,0x1B,0x11};
  static const uint8_t COLON[7]  = {0x00,0x04,0x00,0x00,0x00,0x04,0x00};
  static const uint8_t PERIOD[7] = {0x00,0x00,0x00,0x00,0x00,0x0C,0x0C};
  static const uint8_t DASH[7]   = {0x00,0x00,0x00,0x1F,0x00,0x00,0x00};

  const uint8_t* src = nullptr;
  switch (toupper((unsigned char)c)) {
    case '0': src = D0; break;
    case '1': src = D1; break;
    case '2': src = D2; break;
    case '3': src = D3; break;
    case '4': src = D4; break;
    case '5': src = D5; break;
    case '6': src = D6; break;
    case '7': src = D7; break;
    case '8': src = D8; break;
    case '9': src = D9; break;
    case 'A': src = A; break;
    case 'C': src = C; break;
    case 'D': src = D; break;
    case 'E': src = E; break;
    case 'F': src = F; break;
    case 'H': src = H; break;
    case 'I': src = I; break;
    case 'M': src = M; break;
    case 'N': src = N; break;
    case 'O': src = O; break;
    case 'P': src = P; break;
    case 'R': src = R; break;
    case 'S': src = S; break;
    case 'T': src = T; break;
    case 'U': src = U; break;
    case 'W': src = W; break;
    case ':': src = COLON; break;
    case '.': src = PERIOD; break;
    case '-': src = DASH; break;
    default: src = BLANK; break; // includes space and any unsupported character
  }
  memcpy(rows, src, 7);
  return src != BLANK;
}

static inline void setNibble(uint8_t* buf, int x, int y, uint8_t nibble) {
  if (x < 0 || x >= EPD_WIDTH || y < 0 || y >= EPD_HEIGHT) return;
  size_t idx = (size_t)y * EPD_ROW_BYTES + (x / 2);
  if ((x & 1) == 0) {
    buf[idx] = (nibble << 4) | (buf[idx] & 0x0F);
  } else {
    buf[idx] = (buf[idx] & 0xF0) | (nibble & 0x0F);
  }
}

// Maps a logical (upright-viewer) coordinate, expressed in a canvas sized
// logicalWidth() x logicalHeight() for the current m_orientation, into the
// physical 1200x1600 (EPD_WIDTH x EPD_HEIGHT) raw buffer coordinate space,
// then writes the nibble there. This mirrors - in the opposite direction -
// the hardware rotation backend/src/pipeline/processor.ts applies to real
// photos (sharp .rotate(angle) clockwise: 0/180/90/270 for
// portrait/portrait_180/landscape/landscape_270 respectively), so setup-
// screen text and photos agree on what "upright" means for a given mount.
void EPD_GDEB0709E01::setNibbleOriented(uint8_t* buf, int x, int y, uint8_t nibble) {
  int bx, by;
  switch (m_orientation) {
    case Orientation::PORTRAIT:
      bx = x;
      by = y;
      break;
    case Orientation::PORTRAIT_180:
      bx = EPD_WIDTH - 1 - x;
      by = EPD_HEIGHT - 1 - y;
      break;
    case Orientation::LANDSCAPE:
      bx = EPD_WIDTH - 1 - y;
      by = x;
      break;
    case Orientation::LANDSCAPE_270:
    default:
      bx = y;
      by = EPD_HEIGHT - 1 - x;
      break;
  }
  setNibble(buf, bx, by, nibble);
}

EPD_GDEB0709E01::Orientation EPD_GDEB0709E01::parseOrientation(const String& orientation) {
  if (orientation == "portrait") return Orientation::PORTRAIT;
  if (orientation == "landscape") return Orientation::LANDSCAPE;
  if (orientation == "landscape_270") return Orientation::LANDSCAPE_270;
  return Orientation::PORTRAIT_180; // default, matches backend/src/config.ts default
}

int EPD_GDEB0709E01::logicalWidth() const {
  return (m_orientation == Orientation::LANDSCAPE || m_orientation == Orientation::LANDSCAPE_270)
    ? EPD_HEIGHT
    : EPD_WIDTH;
}

int EPD_GDEB0709E01::logicalHeight() const {
  return (m_orientation == Orientation::LANDSCAPE || m_orientation == Orientation::LANDSCAPE_270)
    ? EPD_WIDTH
    : EPD_HEIGHT;
}

void EPD_GDEB0709E01::drawChar(uint8_t* buf, int x, int y, char c, uint8_t colorNibble, int scale) {
  uint8_t rows[7];
  getGlyphRows(c, rows);
  for (int row = 0; row < 7; row++) {
    for (int col = 0; col < 5; col++) {
      if (rows[row] & (0x10 >> col)) {
        for (int sy = 0; sy < scale; sy++) {
          for (int sx = 0; sx < scale; sx++) {
            setNibbleOriented(buf, x + col * scale + sx, y + row * scale + sy, colorNibble);
          }
        }
      }
    }
  }
}

void EPD_GDEB0709E01::drawText(uint8_t* buf, int x, int y, const char* text, uint8_t colorNibble, int scale) {
  int cursorX = x;
  for (const char* p = text; *p; p++) {
    drawChar(buf, cursorX, y, *p, colorNibble, scale);
    cursorX += 6 * scale; // 5 columns + 1 column spacing
  }
}

/**
 * Renders a "Cuadro Setup" info screen so the SoftAP is visible on the panel
 * (previously the frame gave no on-screen indication that setup mode was active).
 * `orientation` should be one of "portrait"/"portrait_180"/"landscape"/"landscape_270"
 * (the same values used by backend/src/config.ts's frameOrientation), so the text is
 * drawn upright for however the panel is physically mounted - matching how real
 * photos are already rotated server-side before being streamed to the device.
 */
void EPD_GDEB0709E01::displaySetupScreen(const char* apSsid, const char* ipAddress, const String& orientation) {
  m_orientation = parseOrientation(orientation);

  uint8_t* buf = (uint8_t*)heap_caps_malloc(EPD_TOTAL_PAYLOAD, MALLOC_CAP_SPIRAM);
  if (!buf) {
    log_e("[EPD] Failed to allocate setup screen framebuffer (%d bytes)", EPD_TOTAL_PAYLOAD);
    return;
  }

  // Light/white background with dark/black text: more legible than the previous
  // dark-blue-with-white-text scheme, and e-paper panels typically settle faster
  // when most of the panel area is transitioning to white rather than a solid
  // saturated color, so this also shortens the refresh cycle noticeably.
  const uint8_t bg = 0x1;   // White background
  const uint8_t fg = 0x0;   // Black text
  memset(buf, (bg << 4) | bg, EPD_TOTAL_PAYLOAD);

  char wifiLine[64];
  char openLine[64];
  snprintf(wifiLine, sizeof(wifiLine), "WIFI: %s", apSsid);
  snprintf(openLine, sizeof(openLine), "OPEN: %s", ipAddress);

  const char* title = "CUADRO";
  const char* subtitle = "SETUP MODE";

  int scaleTitle = 10;
  int scaleSub = 5;
  int scaleBody = 4;

  int lw = logicalWidth();

  int y = 300;
  drawText(buf, (lw - (int)strlen(title) * 6 * scaleTitle) / 2, y, title, fg, scaleTitle);
  y += 7 * scaleTitle + 60;
  drawText(buf, (lw - (int)strlen(subtitle) * 6 * scaleSub) / 2, y, subtitle, fg, scaleSub);
  y += 7 * scaleSub + 80;
  drawText(buf, (lw - (int)strlen(wifiLine) * 6 * scaleBody) / 2, y, wifiLine, fg, scaleBody);
  y += 7 * scaleBody + 40;
  drawText(buf, (lw - (int)strlen(openLine) * 6 * scaleBody) / 2, y, openLine, fg, scaleBody);

  displayImage(buf);
  heap_caps_free(buf);
}

void EPD_GDEB0709E01::powerSleep() {
  selectBoth(true);
  writeCommand(0x02);
  writeDataByte(0xA5);
  selectBoth(false);
  delay(20);
  digitalWrite(EPD_PWR_PIN, LOW);
  log_i("[EPD] Panel in sleep mode, power rail disabled.");
}

