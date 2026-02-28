/** Fallback max canvas height in pixels (Firefox-compatible default) */
const DEFAULT_MAX_CANVAS_HEIGHT = 32767;
function getMajorVersion(ua: string, tokenPattern: RegExp): number | null {
    const match = ua.match(tokenPattern);
    if (!match) return null;
    const major = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(major) ? major : null;
}
/**
 * Browser-specific max canvas height derived from canvas-size test results:
 * https://jhildenbiddle.github.io/canvas-size/#/?id=test-results
 */
export function getMaxCanvasHeightByUserAgent(): number {
    if (typeof navigator === "undefined") return DEFAULT_MAX_CANVAS_HEIGHT;

    const ua = navigator.userAgent;

    if (/Windows Phone|IEMobile/i.test(ua)) return 4096;

    if (/MSIE\s(?:9|10)\./i.test(ua)) return 8192;
    if (/Trident\/7\.0|MSIE\s11\./i.test(ua)) return 16384;

    if (/Edge\//i.test(ua)) return 16384;

    if (/Edg\//i.test(ua)) {
        const major = getMajorVersion(ua, /Edg\/(\d+)/i);
        return major !== null && major >= 80 ? 65535 : 32767;
    }

    if (/Firefox\//i.test(ua)) return 32767;

    if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua) || /CriOS\//i.test(ua)) {
        const major =
            getMajorVersion(ua, /Chrome\/(\d+)/i) ??
            getMajorVersion(ua, /Chromium\/(\d+)/i) ??
            getMajorVersion(ua, /CriOS\/(\d+)/i);
        return major !== null && major >= 73 ? 65535 : 32767;
    }

    if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua) && !/Chromium\//i.test(ua) && !/Edg\//i.test(ua)) {
        return 8388607;
    }

    return DEFAULT_MAX_CANVAS_HEIGHT;
}
