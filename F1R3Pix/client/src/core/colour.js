// Colours on the chain are "#RRGGBB" with upper-case hexadecimal digits (D4).
export const COLOUR = /^#[0-9A-F]{6}$/;
export const isColour = (s) => typeof s === "string" && COLOUR.test(s);

export function normalise(s) {
  const t = String(s).trim().toUpperCase();
  const m = /^#?([0-9A-F]{3}|[0-9A-F]{6})$/.exec(t);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h}`;
}

/** The client's 20 swatches: the brand pair, neutrals, and a spectrum. */
export const SWATCHES = [
  "#F3D630", "#3FA9F5", "#FFFFFF", "#000000", "#959595",
  "#E5383B", "#F28C28", "#FFB703", "#8AC926", "#2A9D8F",
  "#007BC4", "#1114AD", "#6A4C93", "#B5179E", "#F15BB5",
  "#7B3F00", "#C8A27C", "#264653", "#0C8E23", "#A0DDAB",
];

export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Black or white, whichever reads better on `hex`. */
export const inkOn = (hex) => (hex && luminance(hex) > 0.35 ? "#000000" : "#FFFFFF");
