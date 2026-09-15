import sharp from "sharp";
import * as epd from "epdoptimize";
import { EPD_WIDTH, EPD_HEIGHT, TOTAL_PIXELS, pack4BitPixels } from "./packer.js";
import { config, EpdOptimizeConfig } from "../config.js";

/**
 * Resolves an epdoptimize JSON export (as produced by the epdoptimize web tool at
 * https://paperlesspaper.github.io/epdoptimize/) into the flat ProcessOptions shape
 * consumed by processImageToFrameBuffer.
 */
export function flattenEpdConfig(rawConfig: EpdOptimizeConfig | undefined | null): ProcessOptions {
  if (!rawConfig || typeof rawConfig !== "object") return {};

  const flat: ProcessOptions = {};

  if (typeof rawConfig.palette === "string") {
    flat.palette = rawConfig.palette;
  }

  const drc = rawConfig.imageAdjustmentOptions?.dynamicRangeCompression;
  if (drc) {
    flat.dynamicRangeCompression = drc;
  }

  const canvasDither = rawConfig.canvasDitherOptions;
  if (canvasDither) {
    if (typeof canvasDither.serpentine === "boolean") {
      flat.serpentine = canvasDither.serpentine;
    }
    if (canvasDither.edgePreservation) {
      flat.edgePreservation = canvasDither.edgePreservation;
    }
  }

  return flat;
}

function resolvePalette(name: string | undefined): epd.PaletteColorEntry[] {
  if (name && typeof (epd as any)[name] !== "undefined") {
    return (epd as any)[name];
  }
  return epd.aitjcizeSpectra6Palette;
}

export interface ProcessOptions {
  frameOrientation?: "portrait" | "portrait_180" | "landscape" | "landscape_270";
  fitMode?: "matting" | "cover" | "rotate";
  palette?: string;
  dynamicRangeCompression?: {
    mode: "display" | "auto" | "off";
    strength: number;
    lowPercentile: number;
    highPercentile: number;
  };
  serpentine?: boolean;
  edgePreservation?: {
    enabled: boolean;
    strength: number;
  };
}

export interface ImageAnalysis {
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  aspectRatio: number;
}

/**
 * Inspects image metadata after applying EXIF rotation.
 */
export async function getImageAnalysis(input: string | Buffer): Promise<ImageAnalysis> {
  const meta = await sharp(input, { failOnError: false }).rotate().metadata();
  const width = meta.width || 1200;
  const height = meta.height || 1600;
  const aspectRatio = Number((width / height).toFixed(3));
  const orientation = width === height ? "square" : width > height ? "landscape" : "portrait";
  return { width, height, orientation, aspectRatio };
}

// Lightweight headless CanvasLike implementation for epdoptimize in Node.js
function makeCanvas(width: number, height: number, initialData?: Uint8ClampedArray): epd.CanvasLike {
  const imgData: epd.ImageDataLike = {
    width,
    height,
    data: initialData || new Uint8ClampedArray(width * height * 4)
  };
  return {
    width,
    height,
    getContext(type: string) {
      if (type === "2d") {
        return {
          getImageData(_sx: number, _sy: number, _sw: number, _sh: number) {
            return imgData;
          },
          putImageData(newImgData: epd.ImageDataLike, _dx: number, _dy: number) {
            imgData.data.set(newImgData.data);
          }
        };
      }
      return null;
    }
  };
}

// Exact 1:1 color map from aitjcizeSpectra6Palette calibrated RGB to Good Display GDEB0709E01 4-bit nibbles:
// 0x0: Black, 0x1: White, 0x2: Yellow, 0x3: Red, 0x5: Blue, 0x6: Green
const PALETTE_NIBBLE_MAP = new Map<number, number>([
  [(2 << 16) | (2 << 8) | 2, 0x0],         // #020202 -> Black (0x0)
  [(190 << 16) | (200 << 8) | 200, 0x1],   // #BEC8C8 -> White (0x1)
  [(205 << 16) | (202 << 8) | 0, 0x2],     // #CDCA00 -> Yellow (0x2)
  [(135 << 16) | (19 << 8) | 0, 0x3],      // #871300 -> Red (0x3)
  [(5 << 16) | (64 << 8) | 158, 0x5],      // #05409E -> Blue (0x5)
  [(39 << 16) | (102 << 8) | 60, 0x6]      // #27663C -> Green (0x6)
]);

const PALETTE_FALLBACKS = [
  { rgb: [2, 2, 2], nibble: 0x0 },
  { rgb: [190, 200, 200], nibble: 0x1 },
  { rgb: [205, 202, 0], nibble: 0x2 },
  { rgb: [135, 19, 0], nibble: 0x3 },
  { rgb: [5, 64, 158], nibble: 0x5 },
  { rgb: [39, 102, 60], nibble: 0x6 }
];

function rgbToNibble(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const direct = PALETTE_NIBBLE_MAP.get(key);
  if (direct !== undefined) return direct;

  let bestDist = Infinity;
  let bestNibble = 0x1;
  for (const p of PALETTE_FALLBACKS) {
    const dr = r - p.rgb[0];
    const dg = g - p.rgb[1];
    const db = b - p.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestNibble = p.nibble;
    }
  }
  return bestNibble;
}

/**
 * Full Pipeline with epdoptimize:
 * 1. Decode image (EXIF auto-oriented)
 * 2. Fit to physical frame mounting (matting, cover, or rotate)
 * 3. Hardware rotation into panel memory (0 deg, 180 deg for cable-at-top, 90 deg, 270 deg)
 * 4. Automatic image style classification via epdoptimize (suggestCanvasProcessingOptions)
 * 5. Advanced Spectra 6 dithering (dynamicRangeCompression, serpentine, edgePreservation, aitjcizeSpectra6Palette)
 * 6. Pack into 4-bit nibbles (960,000 bytes)
 */
export async function processImageToFrameBuffer(
  input: string | Buffer,
  options: ProcessOptions = {}
): Promise<Buffer> {
  // Merge the active epdoptimize JSON configuration underneath any explicitly passed options.
  const mergedOptions: ProcessOptions = { ...flattenEpdConfig(config.epdoptimizeConfig), ...options };

  const frameOrientation = mergedOptions.frameOrientation || config.frameOrientation || "portrait_180";
  const fitMode = mergedOptions.fitMode || config.fitMode || "matting";

  // Load and read metadata with EXIF rotation applied
  let pipeline = sharp(input, { failOnError: false }).rotate();
  const meta = await pipeline.metadata();

  const srcW = meta.width || 1200;
  const srcH = meta.height || 1600;
  const isSourceLandscape = srcW > srcH;
  const isSourcePortrait = srcH > srcW;

  // Viewport dimensions before panel hardware rotation
  const isFrameLandscape = frameOrientation === "landscape" || frameOrientation === "landscape_270";
  const viewportWidth = isFrameLandscape ? EPD_HEIGHT : EPD_WIDTH;   // 1600 or 1200
  const viewportHeight = isFrameLandscape ? EPD_WIDTH : EPD_HEIGHT;  // 1200 or 1600

  // Check if source photo orientation mismatches the frame mounting
  const isMismatch =
    (!isFrameLandscape && isSourceLandscape) ||
    (isFrameLandscape && isSourcePortrait);

  if (fitMode === "rotate" && isMismatch) {
    pipeline = pipeline.rotate(90);
  }

  if (fitMode === "matting") {
    pipeline = pipeline.resize(viewportWidth, viewportHeight, {
      fit: "contain",
      position: "centre",
      background: { r: 255, g: 255, b: 255 }
    });
  } else {
    pipeline = pipeline.resize(viewportWidth, viewportHeight, {
      fit: "cover",
      position: "centre"
    });
  }

  // Hardware rotation based on mounting orientation:
  let rotationAngle = 0;
  if (frameOrientation === "portrait_180") {
    rotationAngle = 180;
  } else if (frameOrientation === "landscape") {
    rotationAngle = 90;
  } else if (frameOrientation === "landscape_270") {
    rotationAngle = 270;
  }

  let rawPipeline: sharp.Sharp;
  if (rotationAngle !== 0) {
    const renderedViewportBuffer = await pipeline.png().toBuffer();
    rawPipeline = sharp(renderedViewportBuffer).rotate(rotationAngle).ensureAlpha().raw();
  } else {
    rawPipeline = pipeline.ensureAlpha().raw();
  }

  const { data, info } = await rawPipeline.toBuffer({ resolveWithObject: true });
  if (info.width !== EPD_WIDTH || info.height !== EPD_HEIGHT) {
    throw new Error(`Unexpected buffer dimensions: ${info.width}x${info.height}`);
  }

  // Set up epdoptimize virtual canvases (1200 x 1600)
  const inCanvas = makeCanvas(EPD_WIDTH, EPD_HEIGHT, new Uint8ClampedArray(data));
  const outCanvas = makeCanvas(EPD_WIDTH, EPD_HEIGHT);

  // 1. Automatic Image Detection & Style Classification from epdoptimize
  const activePalette = resolvePalette(mergedOptions.palette);
  const suggestion = epd.suggestCanvasProcessingOptions(inCanvas, activePalette);
  console.log(
    `[EPDOPTIMIZE] Detected style: ${suggestion.classification.style} (${suggestion.imageKind}). Suggested preset: ${suggestion.ditherOptions.processingPreset || "auto"}`
  );

  // 2. Build dither options combining auto-suggestions with the active epdoptimize configuration
  const ditherOptions: epd.DitherImageOptions = {
    ...suggestion.ditherOptions,
    palette: activePalette,
    serpentine: mergedOptions.serpentine ?? true,
    edgePreservation: mergedOptions.edgePreservation ?? {
      enabled: true,
      strength: 0.65
    },
    dynamicRangeCompression: mergedOptions.dynamicRangeCompression ?? {
      mode: "display",
      strength: 0.7,
      lowPercentile: 0.01,
      highPercentile: 0.99
    }
  };

  // 3. Process image with epdoptimize
  const t0 = Date.now();
  await epd.ditherImage(inCanvas, outCanvas, ditherOptions);
  console.log(`[EPDOPTIMIZE] Dithering complete in ${Date.now() - t0}ms`);

  // 4. Map output pixels to 4-bit nibbles
  const outData = outCanvas.getContext("2d")!.getImageData(0, 0, EPD_WIDTH, EPD_HEIGHT).data;
  const outputPixels = new Uint8Array(TOTAL_PIXELS);

  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const r = outData[i * 4];
    const g = outData[i * 4 + 1];
    const b = outData[i * 4 + 2];
    outputPixels[i] = rgbToNibble(r, g, b);
  }

  // 5. Pack into 960,000-byte binary buffer
  return pack4BitPixels(outputPixels);
}
