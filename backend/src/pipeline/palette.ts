/**
 * Good Display 7.09" E Ink Spectra™ 6 (GDEB0709E01) Palette Definition
 *
 * Physical Pigments:
 * - 0x0: Black
 * - 0x1: White
 * - 0x2: Yellow
 * - 0x3: Red
 * - 0x5: Blue
 * - 0x6: Green
 * (0x4 is skipped in 6-color Spectra 6 mapping)
 */

export interface Spectra6Color {
  name: string;
  nibble: number;
  // Calibrated sRGB reflectance values measured on physical Spectra 6 panels
  rgb: [number, number, number];
  hex: string;
}

export const SPECTRA_6_PALETTE: Spectra6Color[] = [
  { name: "Black",  nibble: 0x0, rgb: [20, 20, 20],     hex: "#141414" },
  { name: "White",  nibble: 0x1, rgb: [235, 235, 235], hex: "#ebebeb" },
  { name: "Yellow", nibble: 0x2, rgb: [235, 205, 45],  hex: "#ebcd2d" },
  { name: "Red",    nibble: 0x3, rgb: [180, 25, 30],   hex: "#b4191e" },
  { name: "Blue",   nibble: 0x5, rgb: [25, 75, 155],   hex: "#194b9b" },
  { name: "Green",  nibble: 0x6, rgb: [35, 125, 55],   hex: "#237d37" }
];

export const NIBBLE_TO_COLOR = new Map<number, Spectra6Color>(
  SPECTRA_6_PALETTE.map(c => [c.nibble, c])
);
