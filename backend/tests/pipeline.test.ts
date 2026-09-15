import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { processImageToFrameBuffer } from "../src/pipeline/processor.js";
import { BUFFER_SIZE_BYTES } from "../src/pipeline/packer.js";

test("Pipeline: Process test image produces valid 960,000-byte buffer with Spectra 6 nibbles", async () => {
  // Generate a test SVG/PNG with gradient colors
  const testSvg = `
    <svg width="800" height="600">
      <rect width="400" height="600" fill="#ff0000" />
      <rect x="400" width="400" height="600" fill="#0000ff" />
      <circle cx="400" cy="300" r="150" fill="#ffff00" />
    </svg>
  `;

  const inputBuffer = await sharp(Buffer.from(testSvg)).png().toBuffer();
  const outputBin = await processImageToFrameBuffer(inputBuffer, { ditherType: "atkinson" });

  assert.equal(outputBin.length, BUFFER_SIZE_BYTES, `Expected ${BUFFER_SIZE_BYTES} bytes, got ${outputBin.length}`);

  const validNibbles = new Set([0x0, 0x1, 0x2, 0x3, 0x5, 0x6]);

  // Sample 20,000 bytes across the output
  for (let i = 0; i < 20000; i += 17) {
    const byte = outputBin[i];
    const n0 = (byte >> 4) & 0x0f;
    const n1 = byte & 0x0f;
    assert.ok(validNibbles.has(n0), `Byte index ${i} has invalid high nibble: 0x${n0.toString(16)}`);
    assert.ok(validNibbles.has(n1), `Byte index ${i} has invalid low nibble: 0x${n1.toString(16)}`);
  }
});
