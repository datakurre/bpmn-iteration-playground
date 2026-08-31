/**
 * SVG-to-PNG conversion using @resvg/resvg-js.
 *
 * Converts SVG strings (as produced by bpmn-js `saveSVG()`) into PNG buffers.
 *
 * resvg-js is a Rust-based SVG renderer compiled to a native addon — no
 * Canvas / node-gyp build chain required.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let ResvgClass: any = null;
function getResvgClass() {
  if (ResvgClass) return ResvgClass;
  try {
    const mod = require('@resvg/resvg-js');
    ResvgClass = mod.Resvg;
    return ResvgClass;
  } catch {
    return null;
  }
}

/**
 * Platform-specific system font directories.
 *
 * @resvg/resvg-js has no access to system fonts by default — text labels
 * render as empty boxes when no font paths are provided.  We scan these
 * directories for TTF/OTF font files and pass them via `fontFiles` to the
 * Rust renderer, enabling it to find and rasterize fonts used by bpmn-js
 * SVG output (typically `font-family: Arial, sans-serif`).
 *
 * Also respects Nix-based font configuration via the `FONTCONFIG_PATH`
 * environment variable (set by the `nix run` / devShell environment), so
 * that Nix-provisioned fonts are found first.
 */
function getSystemFontDirs(): string[] {
  const dirs: string[] = [];

  // Nix: FONTCONFIG_PATH may point to directories with fonts.conf that
  // reference Nix store paths. We also check for a fonts directory
  // relative to the fontconfig path (e.g. /nix/store/.../share/fonts).
  const fontconfigPath = process.env.FONTCONFIG_PATH;
  if (fontconfigPath) {
    for (const p of fontconfigPath.split(':')) {
      if (p) {
        dirs.push(p);
        // Walk up to find share/fonts relative to the fontconfig dir
        const shareFonts = path.resolve(p, '..', 'fonts');
        if (fs.existsSync(shareFonts)) dirs.push(shareFonts);
      }
    }
  }

  // Platform defaults
  switch (process.platform) {
    case 'linux':
      dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'));
      break;
    case 'darwin':
      dirs.push(
        '/System/Library/Fonts',
        '/Library/Fonts',
        path.join(os.homedir(), 'Library/Fonts')
      );
      break;
    case 'win32':
      dirs.push('C:\\Windows\\Fonts');
      break;
  }
  return dirs;
}

const SYSTEM_FONT_DIRS: string[] = getSystemFontDirs();

/** Font file extensions supported by resvg-js. */
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

/**
 * Recursively collect font files from a directory.
 * Silently skips directories that don't exist or can't be read.
 */
function collectFontFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files; // directory doesn't exist or permission denied
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFontFiles(fullPath));
    } else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Locate the bundled `fonts/` directory shipped with this package.
 *
 * The directory contains Liberation Sans TTF files (metrically equivalent to
 * Arial) and serves as a guaranteed fallback when no system fonts are available
 * (e.g. minimal Docker images, AWS Lambda, CI runners).
 *
 * Resolution order:
 * 1. `<packageRoot>/fonts/` — when running from source (`src/`) or tests
 * 2. `<dist>/../fonts/` — when running from the esbuild bundle (`dist/cli.js`)
 *
 * Returns `null` if the directory cannot be found (should not happen in a
 * properly installed package).
 */
export function getBundledFontDir(): string | null {
  // When running from source: __dirname is src/, fonts/ is a sibling
  const fromSrc = path.resolve(__dirname, '..', 'fonts');
  if (fs.existsSync(fromSrc) && fs.statSync(fromSrc).isDirectory()) return fromSrc;

  return null;
}

/** Lazily collected system font file paths (collected once on first use). */
let _cachedFontFiles: string[] | null = null;

export function getSystemFontFiles(): string[] {
  if (_cachedFontFiles !== null) return _cachedFontFiles;
  const files: string[] = [];
  for (const dir of SYSTEM_FONT_DIRS) {
    files.push(...collectFontFiles(dir));
  }

  // Fallback: include bundled Liberation Sans fonts so that text labels
  // render even when no system fonts are installed.
  const bundledDir = getBundledFontDir();
  if (bundledDir) {
    files.push(...collectFontFiles(bundledDir));
  }

  _cachedFontFiles = files;
  return files;
}

/**
 * Remove the dead space at the SVG origin that bpmn-js leaves in its output.
 *
 * bpmn-js `saveSVG()` produces SVGs where:
 *   width  = viewBox.x + viewBox.width
 *   height = viewBox.y + viewBox.height
 *
 * This means there is an unused whitespace region from (0,0) to
 * (viewBox.x, viewBox.y).  Resvg (and browsers) will render that blank area
 * as padding around the actual diagram content.
 *
 * Fix: set the SVG `width` / `height` attributes to match the viewBox
 * dimensions so the renderer clips exactly to the diagram bounding box.
 * If `background` is given, inserts a background rect matching the viewBox.
 */
export function cropSvgToViewBox(svg: string, background?: string): string {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  if (!viewBoxMatch || !viewBoxMatch[1]) return svg;
  const parts = viewBoxMatch[1].trim().split(/[\s,]+/);
  if (parts.length !== 4) return svg;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const w = Number(parts[2]);
  const h = Number(parts[3]);
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return svg;

  let updatedSvg = svg
    .replace(/(<svg[^>]*)\bwidth="[^"]*"/, `$1width="${w}"`)
    .replace(/(<svg[^>]*)\bheight="[^"]*"/, `$1height="${h}"`);

  if (background && !svg.includes('class="bpmn-to-image-background"')) {
    const bgX = isFinite(x) ? x : 0;
    const bgY = isFinite(y) ? y : 0;
    const bgRect = `<rect class="bpmn-to-image-background" x="${bgX}" y="${bgY}" width="${w}" height="${h}" fill="${background}"/>`;
    updatedSvg = updatedSvg.replace(/(<svg[^>]*>)/, `$1${bgRect}`);
  }

  return updatedSvg;
}

/** Padding (px) around diagram content in tightened SVG viewBox. */
const TIGHTEN_PADDING = 10;

/**
 * Compute the tight bounding box of all diagram elements, labels, and
 * connection waypoints from the element registry.
 *
 * Handles both shapes (x/y/width/height) and connections (waypoints array).
 * Labels are included via `el.label.x / el.label.y / el.label.width / el.label.height`.
 *
 * @internal Shared between `tightenSvgViewBox` and callers that need raw bounds.
 */
export function computeElementBounds(
  allElements: any[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  function update(x1: number, y1: number, x2: number, y2: number): void {
    if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return;
    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  }

  for (const el of allElements) {
    // Shape bounds
    if (el.x !== undefined && el.y !== undefined && el.width && el.height) {
      update(el.x, el.y, el.x + el.width, el.y + el.height);
    }
    // Label bounds
    if (el.label?.x !== undefined && el.label?.y !== undefined) {
      const lx = el.label.x,
        ly = el.label.y;
      update(lx, ly, lx + (el.label.width || 90), ly + (el.label.height || 20));
    }
    // Connection waypoints
    if (el.waypoints) {
      for (const wp of el.waypoints) {
        update(wp.x, wp.y, wp.x, wp.y);
      }
    }
  }

  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * Tighten the SVG viewBox to closely fit diagram content.
 *
 * When `allElements` is provided (from `elementRegistry.getAll()`), computes
 * tight bounds from all shapes, labels, and connection waypoints and sets the
 * viewBox to `(minX-padding, minY-padding, width+2*padding, height+2*padding)`.
 *
 * Without `allElements`, falls back to `cropSvgToViewBox` which strips the
 * bpmn-js origin dead-space but does not tighten to content bounds.
 *
 * @param svg         SVG markup from `modeler.saveSVG()`
 * @param allElements All elements from `elementRegistry.getAll()` (optional)
 * @param padding     Padding in px around content bounds. Default: 10
 * @param background  Optional background color (CSS string, e.g. "white", "#FFFFFF")
 */
export function tightenSvgViewBox(
  svg: string,
  allElements?: any[],
  padding = TIGHTEN_PADDING,
  background?: string
): string {
  if (!allElements || allElements.length === 0) return cropSvgToViewBox(svg, background);

  try {
    const bounds = computeElementBounds(allElements);
    if (!bounds) return cropSvgToViewBox(svg, background);

    const vbX = Math.round(bounds.minX - padding);
    const vbY = Math.round(bounds.minY - padding);
    const vbW = Math.round(bounds.maxX - bounds.minX + 2 * padding);
    const vbH = Math.round(bounds.maxY - bounds.minY + 2 * padding);

    let updatedSvg = svg
      .replace(/viewBox="[^"]*"/, `viewBox="${vbX} ${vbY} ${vbW} ${vbH}"`)
      .replace(/(<svg[^>]*)\bwidth="[^"]*"/, `$1width="${vbW}"`)
      .replace(/(<svg[^>]*)\bheight="[^"]*"/, `$1height="${vbH}"`);

    if (background && !svg.includes('class="bpmn-to-image-background"')) {
      const bgRect = `<rect class="bpmn-to-image-background" x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${background}"/>`;
      updatedSvg = updatedSvg.replace(/(<svg[^>]*>)/, `$1${bgRect}`);
    }

    return updatedSvg;
  } catch {
    return cropSvgToViewBox(svg, background);
  }
}

export interface RasterizeOptions {
  /** Pixel density multiplier (default: 2 for 2× / hi-DPI). */
  scale?: number;
  /** Background color (CSS color string, e.g. "white", "#FFFFFF"). Default: undefined (transparent). */
  background?: string;
}

export type SvgToPngOptions = RasterizeOptions;

/**
 * Rasterize an SVG string with @resvg/resvg-js, applying the same viewBox
 * cropping and bundled-font fallback as `svgToPng`. Returns the rendered
 * image (`.pixels` for raw RGBA, `.asPng()`/`.width`/`.height` otherwise) —
 * the shared entry point for both static PNG output and the animated
 * GIF/APNG encoders, which need raw per-frame RGBA rather than a decoded PNG.
 *
 * @param svg            The SVG markup (e.g. from `modeler.saveSVG()`)
 * @param scaleOrOptions Pixel density multiplier or RasterizeOptions object (default: 2)
 * @param background     Optional background color string
 */
export function rasterizeSvg(
  svg: string,
  scaleOrOptions: number | RasterizeOptions = 2,
  background?: string
): any {
  const Resvg = getResvgClass();
  if (!Resvg) {
    throw new Error(
      '@resvg/resvg-js is required for PNG rasterization. Use SVG export instead or install @resvg/resvg-js.'
    );
  }
  const scale = typeof scaleOrOptions === 'number' ? scaleOrOptions : (scaleOrOptions.scale ?? 2);
  const bg =
    typeof scaleOrOptions === 'object' ? (scaleOrOptions.background ?? background) : background;
  const cropped = cropSvgToViewBox(svg, bg);
  const fontFiles = getSystemFontFiles();
  const resvg = new Resvg(cropped, {
    fitTo: { mode: 'zoom' as const, value: scale },
    background: bg ?? undefined,
    font: {
      fontFiles,
      // Disable the built-in system font scanner so we control exactly
      // which files are loaded (avoids slow scanning and permission issues).
      loadSystemFonts: false,
      // Map generic CSS font families to Liberation Sans (bundled) so that
      // bpmn-js SVG output using `font-family: Arial, sans-serif` resolves
      // correctly even when Arial is not installed.
      sansSerifFamily: 'Liberation Sans',
      defaultFontFamily: 'Liberation Sans',
    },
  });
  return resvg.render();
}

/**
 * Convert an SVG string to a PNG buffer.
 *
 * Applies bounding-box cropping (strips the blank origin offset from
 * bpmn-js SVG output) and renders at 2× scale for crisp hi-DPI output.
 *
 * @param svg            The SVG markup (e.g. from `modeler.saveSVG()`)
 * @param scaleOrOptions Pixel density multiplier or SvgToPngOptions object (default: 2)
 * @param background     Optional background color string
 * @returns              A Buffer containing the PNG image data
 */
export function svgToPng(
  svg: string,
  scaleOrOptions: number | SvgToPngOptions = 2,
  background?: string
): Buffer {
  return Buffer.from(rasterizeSvg(svg, scaleOrOptions, background).asPng());
}

/**
 * Convert an SVG string to a PNG buffer with SVG fallback.
 *
 * When no system font files are found, the Rust renderer cannot rasterize
 * text labels — the resulting PNG would show empty boxes instead of labels.
 * In that case this function falls back to returning the raw SVG as a
 * base64-encodable buffer with `mimeType: "image/svg+xml"` so the caller
 * still gets a useful diagram preview.
 *
 * @param svg            The SVG markup
 * @param scaleOrOptions Pixel density multiplier or SvgToPngOptions object (default: 2)
 * @param background     Optional background color string
 * @returns              `{ data: Buffer; mimeType: string }` — PNG or SVG fallback
 */
export function svgToPngWithFallback(
  svg: string,
  scaleOrOptions: number | SvgToPngOptions = 2,
  background?: string
): { data: Buffer; mimeType: string } {
  const fontFiles = getSystemFontFiles();
  const bg =
    typeof scaleOrOptions === 'object' ? (scaleOrOptions.background ?? background) : background;

  if (fontFiles.length === 0) {
    // No fonts available — fall back to SVG to avoid blank labels.
    // Still crop the viewBox offset so the fallback SVG has no dead space.
    return { data: Buffer.from(cropSvgToViewBox(svg, bg), 'utf-8'), mimeType: 'image/svg+xml' };
  }

  const pngBuffer = svgToPng(svg, scaleOrOptions, background);
  return { data: pngBuffer, mimeType: 'image/png' };
}
