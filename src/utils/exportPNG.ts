// PNG export utility — composites actogram + optional periodogram into a single image

export interface ExportStats {
    recordCount: number;
    tau: number;
    drift: number;
    rSquared: number;
    daySpan: number;
    algorithmId: string;
    colorMode: "stages" | "quality";
}

const BACKGROUND = "#1e293b";
const TEXT_COLOR = "#e2e8f0";
const MUTED_COLOR = "#94a3b8";

// Stage colors (match useActogramRenderer.ts)
const STAGE_LEGEND = [
    { label: "Deep", color: "#1e40af" },
    { label: "Light", color: "#60a5fa" },
    { label: "REM", color: "#06b6d4" },
    { label: "Wake", color: "#ef4444" },
];

export function exportActogramPNG(stats: ExportStats, options?: { includePeriodogram?: boolean }): void {
    const actogramCanvas = document.getElementById("actogram-canvas") as HTMLCanvasElement | null;
    if (!actogramCanvas) return;

    const periodogramCanvas = options?.includePeriodogram
        ? (document.getElementById("periodogram-canvas") as HTMLCanvasElement | null)
        : null;

    // Detect DPR from actogram canvas
    const dpr =
        actogramCanvas.clientWidth > 0
            ? actogramCanvas.width / actogramCanvas.clientWidth
            : window.devicePixelRatio || 1;

    const canvasWidth = actogramCanvas.width; // already in device pixels

    // Layout dimensions (in CSS pixels, will be scaled by DPR)
    const cssWidth = canvasWidth / dpr;
    const headerHeight = 64;
    const legendHeight = 48;
    const actogramCSSHeight = actogramCanvas.clientHeight;
    const periodogramCSSHeight = periodogramCanvas ? periodogramCanvas.clientHeight : 0;
    const gapBetween = periodogramCanvas ? 8 : 0;

    const totalCSSHeight = headerHeight + actogramCSSHeight + gapBetween + periodogramCSSHeight + legendHeight;

    // Create offscreen canvas at device-pixel resolution
    const out = document.createElement("canvas");
    out.width = canvasWidth;
    out.height = Math.round(totalCSSHeight * dpr);
    const ctx = out.getContext("2d")!;

    // Fill background
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, out.width, out.height);

    // Scale to CSS coordinates
    ctx.scale(dpr, dpr);

    // ── Header ──────────────────────────────────────────
    let y = 0;
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText("N24 Sleep Visualization", 16, y + 12);

    const driftMin = stats.drift * 60;
    const sign = driftMin >= 0 ? "+" : "";
    const statsLine = [
        `${stats.recordCount} records`,
        `\u03C4=${stats.tau.toFixed(2)}h`,
        `${sign}${driftMin.toFixed(0)}min/day`,
        `R\u00B2=${stats.rSquared.toFixed(3)}`,
        `${stats.daySpan} day span`,
    ].join(" \u00B7 ");

    ctx.fillStyle = MUTED_COLOR;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(statsLine, 16, y + 38);

    y += headerHeight;

    // ── Actogram ────────────────────────────────────────
    ctx.save();
    ctx.translate(0, y);
    // drawImage works in CSS coords when context is scaled
    ctx.drawImage(actogramCanvas, 0, 0, cssWidth, actogramCSSHeight);
    ctx.restore();
    y += actogramCSSHeight;

    // ── Periodogram ─────────────────────────────────────
    if (periodogramCanvas && periodogramCSSHeight > 0) {
        y += gapBetween;
        ctx.save();
        ctx.translate(0, y);
        ctx.drawImage(periodogramCanvas, 0, 0, cssWidth, periodogramCSSHeight);
        ctx.restore();
        y += periodogramCSSHeight;
    }

    // ── Legend ───────────────────────────────────────────
    const legendY = y + 16;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";

    if (stats.colorMode === "stages") {
        let lx = 16;
        for (const item of STAGE_LEGEND) {
            ctx.fillStyle = item.color;
            ctx.fillRect(lx, legendY - 5, 12, 12);
            ctx.fillStyle = TEXT_COLOR;
            ctx.fillText(item.label, lx + 16, legendY + 1);
            lx += ctx.measureText(item.label).width + 36;
        }
    } else {
        // Quality gradient
        const gradWidth = 120;
        const grad = ctx.createLinearGradient(16, 0, 16 + gradWidth, 0);
        grad.addColorStop(0, "#ef4444");
        grad.addColorStop(0.5, "#eab308");
        grad.addColorStop(1, "#22c55e");
        ctx.fillStyle = grad;
        ctx.fillRect(16, legendY - 5, gradWidth, 12);
        ctx.fillStyle = TEXT_COLOR;
        ctx.fillText("0%", 16 + gradWidth + 8, legendY + 1);
        ctx.fillStyle = MUTED_COLOR;
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText("Quality", 16, legendY - 14);
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillStyle = TEXT_COLOR;
        ctx.fillText("100%", 16 + gradWidth + 30, legendY + 1);
    }

    // ── Download ────────────────────────────────────────
    const dataUrl = out.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `fitbit-actogram-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
}
