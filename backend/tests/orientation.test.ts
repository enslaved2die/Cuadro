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

test("Orientation: Smartphone EXIF orientation tags (5-8) are correctly detected and rotated", async () => {
  // A smartphone camera sensor is physically vertical: 600 wide x 800 high.
  // When holding phone in landscape, EXIF orientation 6 (Rotate 90 CW) is stored:
  // visually this is an 800 wide x 600 high LANDSCAPE photo!
  const phoneLandscapeImg = await sharp({
    create: { width: 600, height: 800, channels: 3, background: { r: 100, g: 150, b: 200 } }
  }).withMetadata({ orientation: 6 }).jpeg().toBuffer();

  const analysis = await getImageAnalysis(phoneLandscapeImg);
  assert.equal(analysis.orientation, "landscape");
  assert.equal(analysis.width, 800);
  assert.equal(analysis.height, 600);

  // In a portrait frame with fitMode 'rotate', this phone landscape photo must be rotated to match
  const bin = await processImageToFrameBuffer(phoneLandscapeImg, {
    frameOrientation: "portrait",
    fitMode: "rotate"
  });
  assert.equal(bin.length, BUFFER_SIZE_BYTES);
});

test("Orientation: fitMode 'rotate' rotates 4:3 landscape 90° CW into 3:4 portrait without cropping left/right bands", async () => {
  // Visual 1600x1200 landscape image:
  // Left 400px = Black (#000000 -> 0x0), Middle 800px = Blue (#194b9b -> 0x5), Right 400px = White (#ffffff -> 0x1)
  const bandsSvg = `<svg width="1600" height="1200" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="400" height="1200" fill="#000000"/>
    <rect x="400" y="0" width="800" height="1200" fill="#194b9b"/>
    <rect x="1200" y="0" width="400" height="1200" fill="#ffffff"/>
  </svg>`;
  const landscapePng = await sharp(Buffer.from(bandsSvg)).png().toBuffer();

  // Also create an EXIF-orientation-6 version (raw 1200x1600 rotated 270 CW so orientation=6 makes it visually 1600x1200)
  const exif6Jpeg = await sharp(landscapePng).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();

  for (const [label, inputBuf] of [
    ["standard 1600x1200", landscapePng],
    ["EXIF orientation=6 1600x1200", exif6Jpeg]
  ] as const) {
    const rotateBin = await processImageToFrameBuffer(inputBuf, {
      frameOrientation: "portrait",
      fitMode: "rotate"
    });
    assert.equal(rotateBin.length, BUFFER_SIZE_BYTES);

    const rowBytes = 600;
    // After 90° CW rotation:
    // - Left band (Black, 0x00) is at top (row 100, col 300)
    // - Middle band (Blue, 0x55) is at center (row 800, col 300)
    // - Right band (White, 0x11) is at bottom (row 1500, col 300)
    assert.equal(rotateBin[100 * rowBytes + 300], 0x00, `${label}: top of rotated frame should be Black (left band)`);
    assert.equal(rotateBin[800 * rowBytes + 300], 0x55, `${label}: center of rotated frame should be Blue (center band)`);
    assert.equal(rotateBin[1500 * rowBytes + 300], 0x11, `${label}: bottom of rotated frame should be White (right band)`);
  }
});
