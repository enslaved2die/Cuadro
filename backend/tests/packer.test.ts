import test from "node:test";
import assert from "node:assert/strict";
import {
  pack4BitPixels,
  generatePureWhiteBuffer,
  generateTestColorBars,
  EPD_WIDTH,
  EPD_HEIGHT,
  BUFFER_SIZE_BYTES,
  TOTAL_PIXELS
} from "../src/pipeline/packer.js";

test("Packer: Buffer size matches exactly 960,000 bytes", () => {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  pixels.fill(0x1); // White

  const packed = pack4BitPixels(pixels);
  assert.equal(packed.length, BUFFER_SIZE_BYTES, `Expected ${BUFFER_SIZE_BYTES} bytes, got ${packed.length}`);
});

test("Packer: Nibble packing correctly combines upper and lower nibbles", () => {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  // Pixel 0 = 0x3 (Red), Pixel 1 = 0x5 (Blue)
  pixels[0] = 0x3;
  pixels[1] = 0x5;

  const packed = pack4BitPixels(pixels);
  const expectedFirstByte = (0x3 << 4) | 0x5; // 0x35
  assert.equal(packed[0], expectedFirstByte, `Expected 0x${expectedFirstByte.toString(16)}, got 0x${packed[0].toString(16)}`);
});

test("Packer: generatePureWhiteBuffer returns 960,000 bytes of 0x11", () => {
  const white = generatePureWhiteBuffer();
  assert.equal(white.length, 960000);
  for (let i = 0; i < 1000; i++) {
    assert.equal(white[i], 0x11, `Byte at index ${i} should be 0x11`);
  }
});

test("Packer: generateTestColorBars contains valid Spectra 6 nibbles", () => {
  const bars = generateTestColorBars();
  assert.equal(bars.length, 960000);

  const validNibbles = new Set([0x0, 0x1, 0x2, 0x3, 0x5, 0x6]);

  for (let i = 0; i < 1000; i++) {
    const b = bars[i];
    const n0 = (b >> 4) & 0x0f;
    const n1 = b & 0x0f;
    assert.ok(validNibbles.has(n0), `Invalid nibble 0x${n0.toString(16)}`);
    assert.ok(validNibbles.has(n1), `Invalid nibble 0x${n1.toString(16)}`);
  }
});
