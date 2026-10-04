import sharp from "sharp";
import { logger } from "../lib/logger";
import type { HullCamFrame } from "./hullcamStore";

/**
 * Lazy, viewer-driven re-compression for the HullCam relay.
 *
 * The pilot's plugin uploads a JPEG once per second per camera. That JPEG sits in the
 * hot store until it's replaced. When tower controllers open the Tower View tile they
 * each poll `/snapshot.jpg` at ~1 fps, so the *egress* multiplier is N viewers × 1 fps
 * per upload — re-encoding once per frame and serving the smaller variant N times is a
 * straight bandwidth win.
 *
 * Design constraints:
 *   * Zero CPU when nobody's watching. We only re-encode on the GET path, never on
 *     ingress, so a 50-pilot game where nobody opens the tower view costs nothing.
 *   * One encode per frame regardless of viewer count. Concurrent viewers share an
 *     in-flight `Promise` cached on the frame itself; whoever lands first triggers
 *     the encode, everyone else awaits the same promise.
 *   * Fail open. If sharp throws (libvips missing, malformed JPEG, OOM, etc.) we
 *     mark the frame as un-optimizable and serve the original bytes forever for
 *     this frame, then try again on the next one.
 *
 * Tunables sit at the top so they're easy to revisit if the tile UI changes size or
 * we want to bias toward bandwidth vs. quality.
 */

/** Max width the re-encoded variants are downscaled to. Tower tiles are ~480 px wide
 *  on a 4-tile wall and ~960 px when expanded; 960 is the largest size that's actually
 *  rendered, so anything larger from JRTI is wasted pixels. `withoutEnlargement: true`
 *  makes this a ceiling, not a target. */
const TARGET_WIDTH_PX = 960;

/** mozjpeg quality for the downscaled JPEG variant. 78 is the visual sweet spot —
 *  perceptually indistinguishable from the JRTI default at half the bytes. */
const JPEG_QUALITY = 78;

/** WebP quality for the WebP variant. WebP at 72 is roughly equivalent to JPEG q80
 *  but ~25–35% smaller; modern browsers all accept it, the SPA <img> tag negotiates
 *  via the `Accept` header. */
const WEBP_QUALITY = 72;

/**
 * Returns a downscaled, mozjpeg-recompressed copy of `frame.jpeg`, computing it
 * once on first call and caching the result on the frame. Subsequent callers
 * (other viewers) share either the cached buffer or the in-flight promise.
 *
 * Returns `frame.jpeg` unchanged when sharp fails — caller doesn't need to
 * branch on errors, the bytes are always usable as image/jpeg.
 */
export async function getOptimizedJpeg(frame: HullCamFrame): Promise<Buffer> {
  if (frame.optimizedJpeg) return frame.optimizedJpeg;
  if (frame.optimizationFailed) return frame.jpeg;
  if (frame.optimizedJpegPromise) return frame.optimizedJpegPromise;

  const promise = sharp(frame.jpeg)
    .rotate() // honor EXIF orientation if JRTI ever starts setting it
    .resize({ width: TARGET_WIDTH_PX, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer()
    .then((buf) => {
      frame.optimizedJpeg = buf;
      frame.optimizedJpegPromise = undefined;
      return buf;
    })
    .catch((err) => {
      frame.optimizationFailed = true;
      frame.optimizedJpegPromise = undefined;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), origBytes: frame.jpeg.length },
        "hullcam JPEG re-encode failed; serving original bytes"
      );
      return frame.jpeg;
    });

  frame.optimizedJpegPromise = promise;
  return promise;
}

/**
 * Same shape as `getOptimizedJpeg` but produces a WebP variant. Caller is
 * responsible for setting `Content-Type: image/webp` when serving the result.
 *
 * On failure, falls back to the optimized JPEG path (which itself falls back to
 * the original bytes). That way a broken WebP encode doesn't penalize the
 * viewer with a giant raw frame — they still get the smaller mozjpeg variant.
 */
export async function getWebp(frame: HullCamFrame): Promise<{ buf: Buffer; isWebp: boolean }> {
  if (frame.webp) return { buf: frame.webp, isWebp: true };
  if (frame.webpPromise) return { buf: await frame.webpPromise, isWebp: true };
  if (frame.optimizationFailed) {
    return { buf: await getOptimizedJpeg(frame), isWebp: false };
  }

  const promise = sharp(frame.jpeg)
    .rotate()
    .resize({ width: TARGET_WIDTH_PX, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
    .then((buf) => {
      frame.webp = buf;
      frame.webpPromise = undefined;
      return buf;
    })
    .catch(async (err) => {
      frame.webpPromise = undefined;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "hullcam WebP encode failed; falling back to optimized JPEG"
      );
      // Note: we don't set optimizationFailed here — the JPEG path may still work
      // even if the WebP encoder is the broken one. getOptimizedJpeg() will set
      // its own flag if it also fails.
      throw err;
    });

  frame.webpPromise = promise;
  try {
    const buf = await promise;
    return { buf, isWebp: true };
  } catch {
    return { buf: await getOptimizedJpeg(frame), isWebp: false };
  }
}
