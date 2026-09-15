import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { getImageAnalysis, processImageToFrameBuffer } from "../src/pipeline/processor.js";
import { BUFFER_SIZE_BYTES } from "../src/pipeline/packer.js";

test("Orientation: getImageAnalysis detects portrait, landscape, and square correctly", async () => {
  const landscapeSvg = `<svg width="1200" height="800"><rect width="1200" height="800" fill="#fff"/></svg>`;
  const portraitSvg = `<svg width="800" height="1200"><rect width="800" height="1200" fill="#fff"/></svg>`;
  const squareSvg = `<svg width="800" height="800"><rect width="800" height="800" fill="#fff"/></svg>`;

  const landBuf = await sharp(Buffer.from(landscapeSvg)).png().toBuffer();
  const portBuf = await sharp(Buffer.from(portraitSvg)).png().toBuffer();
  const sqBuf = await sharp(Buffer.from(squareSvg)).png().toBuffer();

  const landMeta = await getImageAnalysis(landBuf);
  assert.equal(landMeta.orientation, "landscape");
  assert.equal(landMeta.width, 1200);
  assert.equal(landMeta.height, 800);

  const portMeta = await getImageAnalysis(portBuf);
  assert.equal(portMeta.orientation, "portrait");
  assert.equal(portMeta.width, 800);
  assert.equal(portMeta.height, 1200);

  const sqMeta = await getImageAnalysis(sqBuf);
  assert.equal(sqMeta.orientation, "square");
});

test("Orientation: All 6 permutations produce valid 960,000-byte binaries", async () => {
  const landscapeSvg = `<svg width="1600" height="1200"><rect width="1600" height="1200" fill="#194b9b"/><circle cx="800" cy="600" r="300" fill="#ebcd2d"/></svg>`;
  const portraitSvg = `<svg width="1200" height="1600"><rect width="1200" height="1600" fill="#b4191e"/><circle cx="600" cy="800" r="300" fill="#237d37"/></svg>`;

  const landImg = await sharp(Buffer.from(landscapeSvg)).png().toBuffer();
  const portImg = await sharp(Buffer.from(portraitSvg)).png().toBuffer();

  // 1. Portrait frame + Landscape photo (matting)
  const b1 = await processImageToFrameBuffer(landImg, { frameOrientation: "portrait", fitMode: "matting" });
  assert.equal(b1.length, BUFFER_SIZE_BYTES);

  // 2. Portrait frame + Landscape photo (cover)
  const b2 = await processImageToFrameBuffer(landImg, { frameOrientation: "portrait", fitMode: "cover" });
  assert.equal(b2.length, BUFFER_SIZE_BYTES);

  // 3. Portrait frame + Landscape photo (rotate)
  const b3 = await processImageToFrameBuffer(landImg, { frameOrientation: "portrait", fitMode: "rotate" });
  assert.equal(b3.length, BUFFER_SIZE_BYTES);

  // 4. Landscape frame + Portrait photo (matting)
  const b4 = await processImageToFrameBuffer(portImg, { frameOrientation: "landscape", fitMode: "matting" });
  assert.equal(b4.length, BUFFER_SIZE_BYTES);

  // 5. Landscape frame + Portrait photo (cover)
  const b5 = await processImageToFrameBuffer(portImg, { frameOrientation: "landscape", fitMode: "cover" });
  assert.equal(b5.length, BUFFER_SIZE_BYTES);

  // 6. Landscape frame + Landscape photo (matting)
  const b6 = await processImageToFrameBuffer(landImg, { frameOrientation: "landscape", fitMode: "matting" });
  assert.equal(b6.length, BUFFER_SIZE_BYTES);
});

test("Orientation: Passe-partout matting produces pure white borders (0x11 nibbles)", async () => {
  // A 1200x600 landscape photo in a 1200x1600 portrait frame with matting
  // Top 500 rows and bottom 500 rows should be pure white (0x11 bytes)
  const shortLandscapeSvg = `<svg width="1200" height="600"><rect width="1200" height="600" fill="#141414"/></svg>`;
  const img = await sharp(Buffer.from(shortLandscapeSvg)).png().toBuffer();

  const bin = await processImageToFrameBuffer(img, { frameOrientation: "portrait", fitMode: "matting" });
  assert.equal(bin.length, BUFFER_SIZE_BYTES);

  // Check top rows (e.g. rows 10 to 50): 600 bytes per row
  // All pixels in the matting border should be pure white (nibble 0x1, packed as 0x11)
  const rowBytes = 600;
  for (let row = 10; row < 50; row++) {
    for (let col = 0; col < rowBytes; col++) {
      const idx = row * rowBytes + col;
      assert.equal(bin[idx], 0x11, `Expected pure white (0x11) in matting border at row ${row}, byte ${col}`);
    }
  }
});
