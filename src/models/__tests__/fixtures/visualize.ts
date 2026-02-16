/**
 * Test visualization utility — generates self-contained HTML actograms
 * showing synthetic sleep records, algorithm overlay, and ground truth.
 *
 * Usage: set VIZ=1 env var, then run tests. HTML files are written to test-output/.
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { SleepRecord } from "../../../api/types";
import type { CircadianAnalysis } from "../../circadian";
import { computeTrueMidpoint, type SyntheticOptions } from "./synthetic";

export interface VizOptions {
    title: string;
    records: SleepRecord[];
    analysis: CircadianAnalysis;
    algorithmId: string;
    groundTruth?: SyntheticOptions;
}

interface VizRecord {
    date: string;
    startHour: number;
    endHour: number;
    isMainSleep: boolean;
}

interface VizDay {
    date: string;
    nightStartHour: number;
    nightEndHour: number;
    localTau: number;
    localDrift: number;
    confidenceScore: number;
    confidence: string;
    isForecast: boolean;
    isGap: boolean;
}

interface VizGroundTruth {
    day: number;
    date: string;
    midpointHour: number;
}

interface VizData {
    meta: { title: string; algorithmId: string; globalTau: number; globalDrift: number };
    records: VizRecord[];
    days: VizDay[];
    groundTruth: VizGroundTruth[];
    tauSegments?: { untilDay: number; tau: number }[];
}

function buildVizData(opts: VizOptions): VizData {
    const { title, records, analysis, algorithmId, groundTruth } = opts;

    // Build simplified record data (hour-of-day positions)
    const vizRecords: VizRecord[] = records.map((r) => {
        const dayStart = new Date(r.startTime);
        dayStart.setHours(0, 0, 0, 0);
        const startHour = (r.startTime.getTime() - dayStart.getTime()) / 3_600_000;
        const endHour = startHour + r.durationHours;
        return {
            date: r.dateOfSleep,
            startHour,
            endHour,
            isMainSleep: r.isMainSleep,
        };
    });

    // Build analysis day data
    const vizDays: VizDay[] = analysis.days.map((d) => ({
        date: d.date,
        nightStartHour: d.nightStartHour,
        nightEndHour: d.nightEndHour,
        localTau: d.localTau,
        localDrift: d.localDrift,
        confidenceScore: d.confidenceScore,
        confidence: d.confidence,
        isForecast: d.isForecast,
        isGap: d.isGap,
    }));

    // Compute ground truth midpoints
    const gtPoints: VizGroundTruth[] = [];
    if (groundTruth) {
        const days = groundTruth.days ?? 90;
        const baseDate = new Date("2024-01-01T00:00:00");
        for (let d = 0; d < days; d++) {
            const mid = computeTrueMidpoint(d, groundTruth);
            const dayDate = new Date(baseDate);
            dayDate.setDate(dayDate.getDate() + d);
            const dateStr =
                dayDate.getFullYear() +
                "-" +
                String(dayDate.getMonth() + 1).padStart(2, "0") +
                "-" +
                String(dayDate.getDate()).padStart(2, "0");
            gtPoints.push({ day: d, date: dateStr, midpointHour: ((mid % 24) + 24) % 24 });
        }
    }

    return {
        meta: {
            title,
            algorithmId,
            globalTau: analysis.globalTau,
            globalDrift: analysis.globalDailyDrift,
        },
        records: vizRecords,
        days: vizDays,
        groundTruth: gtPoints,
        tauSegments: groundTruth?.tauSegments,
    };
}

// language=html
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{TITLE}}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f172a; color: #e2e8f0; font-family: 'Consolas', 'Monaco', monospace; padding: 16px; }
  h1 { font-size: 16px; margin-bottom: 4px; color: #f8fafc; }
  .meta { font-size: 12px; color: #94a3b8; margin-bottom: 12px; }
  .meta span { margin-right: 16px; }
  .meta .value { color: #e2e8f0; }
  #container { position: relative; }
  canvas { display: block; }
  #tooltip {
    position: absolute; display: none; pointer-events: none;
    background: rgba(15, 23, 42, 0.95); border: 1px solid #475569;
    padding: 8px 10px; font-size: 11px; line-height: 1.5;
    border-radius: 4px; white-space: nowrap; z-index: 10;
  }
  .legend { display: flex; gap: 20px; margin-top: 8px; font-size: 11px; color: #94a3b8; }
  .legend-item { display: flex; align-items: center; gap: 5px; }
  .legend-swatch { width: 14px; height: 10px; border-radius: 2px; }
</style>
</head>
<body>
<h1 id="title"></h1>
<div class="meta" id="meta"></div>
<div id="container">
  <canvas id="actogram"></canvas>
  <div id="tooltip"></div>
</div>
<div class="legend">
  <div class="legend-item"><div class="legend-swatch" style="background:#60a5fa"></div>Sleep (main)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#60a5fa80"></div>Sleep (nap)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:rgba(168,85,247,0.35)"></div>Algorithm overlay</div>
  <div class="legend-item"><div class="legend-swatch" style="background:rgba(251,191,36,0.35)"></div>Forecast</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#22c55e"></div>Ground truth midpoint</div>
</div>
<script type="application/json" id="vizdata">{{DATA}}</script>
<script>
(function() {
  const data = JSON.parse(document.getElementById('vizdata').textContent);
  const { meta, records, days, groundTruth, tauSegments } = data;

  document.getElementById('title').textContent = meta.title;
  document.getElementById('meta').innerHTML =
    '<span>Algorithm: <span class="value">' + meta.algorithmId + '</span></span>' +
    '<span>Global τ: <span class="value">' + meta.globalTau.toFixed(3) + 'h</span></span>' +
    '<span>Daily drift: <span class="value">' + (meta.globalDrift * 60).toFixed(1) + 'min</span></span>';

  // Collect all dates (union of days + records)
  const dateSet = new Set();
  days.forEach(d => dateSet.add(d.date));
  records.forEach(r => dateSet.add(r.date));
  const allDates = Array.from(dateSet).sort();

  const dateIndex = {};
  allDates.forEach((d, i) => dateIndex[d] = i);

  // Index days and records by date
  const dayByDate = {};
  days.forEach(d => dayByDate[d.date] = d);
  const recordsByDate = {};
  records.forEach(r => {
    if (!recordsByDate[r.date]) recordsByDate[r.date] = [];
    recordsByDate[r.date].push(r);
  });
  const gtByDate = {};
  groundTruth.forEach(g => gtByDate[g.date] = g);

  // Layout
  const LEFT = 80, TOP = 36, RIGHT = 16, BOTTOM = 24;
  const ROW_H = 7;
  const numRows = allDates.length;
  const width = LEFT + 720 + RIGHT; // 720px for 24h = 30px/hour
  const height = TOP + numRows * ROW_H + BOTTOM;
  const PLOT_W = width - LEFT - RIGHT;

  const canvas = document.getElementById('actogram');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const X_RIGHT = LEFT + PLOT_W; // x position of hour 24 (right edge)
  function hourToX(h) {
    const norm = ((h % 24) + 24) % 24;
    return LEFT + (norm / 24) * PLOT_W;
  }

  // Background
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, width, height);

  // Grid lines
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 0.5;
  for (let h = 0; h <= 24; h += 6) {
    const x = h === 24 ? X_RIGHT : hourToX(h);
    ctx.beginPath();
    ctx.moveTo(x, TOP);
    ctx.lineTo(x, TOP + numRows * ROW_H);
    ctx.stroke();
  }

  // Hour labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Consolas, Monaco, monospace';
  ctx.textAlign = 'center';
  for (let h = 0; h <= 24; h += 6) {
    const x = h === 24 ? X_RIGHT : hourToX(h);
    const label = String(h % 24).padStart(2, '0') + ':00';
    ctx.fillText(label, x, TOP - 6);
  }

  // Regime boundaries (if tauSegments)
  if (tauSegments && tauSegments.length > 0) {
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const baseDate = new Date('2024-01-01T00:00:00');
    tauSegments.forEach(seg => {
      const segDate = new Date(baseDate);
      segDate.setDate(segDate.getDate() + seg.untilDay);
      const dateStr = segDate.getFullYear() + '-' +
        String(segDate.getMonth() + 1).padStart(2, '0') + '-' +
        String(segDate.getDate()).padStart(2, '0');
      const row = dateIndex[dateStr];
      if (row !== undefined) {
        const y = TOP + row * ROW_H;
        ctx.beginPath();
        ctx.moveTo(LEFT, y);
        ctx.lineTo(LEFT + PLOT_W, y);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  // Draw algorithm overlay bands
  allDates.forEach((date, row) => {
    const day = dayByDate[date];
    if (!day || day.isGap) return;
    const y = TOP + row * ROW_H;
    const alpha = 0.1 + day.confidenceScore * 0.25;
    const color = day.isForecast ? 'rgba(251,191,36,' + alpha + ')' : 'rgba(168,85,247,' + alpha + ')';
    ctx.fillStyle = color;

    let ns = ((day.nightStartHour % 24) + 24) % 24;
    let ne = ((day.nightEndHour % 24) + 24) % 24;
    if (ne < ns) {
      // Wraps around midnight — draw two segments
      ctx.fillRect(hourToX(ns), y, X_RIGHT - hourToX(ns), ROW_H);
      ctx.fillRect(LEFT, y, hourToX(ne) - LEFT, ROW_H);
    } else {
      ctx.fillRect(hourToX(ns), y, hourToX(ne) - hourToX(ns), ROW_H);
    }
  });

  // Draw sleep blocks
  allDates.forEach((date, row) => {
    const recs = recordsByDate[date];
    if (!recs) return;
    const y = TOP + row * ROW_H;
    recs.forEach(r => {
      const alpha = r.isMainSleep ? 1 : 0.5;
      ctx.fillStyle = 'rgba(96, 165, 250, ' + alpha + ')';
      let sh = ((r.startHour % 24) + 24) % 24;
      let eh = sh + (r.endHour - r.startHour);
      // Clamp to 24h (records crossing midnight handled within single row)
      if (eh > 24) {
        ctx.fillRect(hourToX(sh), y + 1, X_RIGHT - hourToX(sh), ROW_H - 2);
        ctx.fillRect(LEFT, y + 1, hourToX(eh - 24) - LEFT, ROW_H - 2);
      } else {
        ctx.fillRect(hourToX(sh), y + 1, hourToX(eh) - hourToX(sh), ROW_H - 2);
      }
    });
  });

  // Draw ground truth midpoints
  if (groundTruth.length > 0) {
    ctx.fillStyle = '#22c55e';
    allDates.forEach((date, row) => {
      const gt = gtByDate[date];
      if (!gt) return;
      const y = TOP + row * ROW_H + ROW_H / 2;
      const x = hourToX(gt.midpointHour);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Date labels (every 7th row, or first/last)
  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px Consolas, Monaco, monospace';
  ctx.textAlign = 'right';
  allDates.forEach((date, row) => {
    if (row === 0 || row === numRows - 1 || row % 7 === 0) {
      const y = TOP + row * ROW_H + ROW_H / 2 + 3;
      ctx.fillText(date.slice(5), LEFT - 6, y); // show MM-DD
    }
  });

  // Tooltip
  const tooltip = document.getElementById('tooltip');
  canvas.addEventListener('mousemove', function(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const row = Math.floor((my - TOP) / ROW_H);
    if (row < 0 || row >= numRows || mx < LEFT || mx > LEFT + PLOT_W) {
      tooltip.style.display = 'none';
      return;
    }
    const date = allDates[row];
    const day = dayByDate[date];
    const gt = gtByDate[date];
    let html = '<b>' + date + '</b>';
    if (day) {
      html += '<br>τ: ' + day.localTau.toFixed(2) + 'h  drift: ' + (day.localDrift * 60).toFixed(1) + 'min';
      html += '<br>overlay: ' + fmtH(day.nightStartHour) + ' – ' + fmtH(day.nightEndHour);
      html += '<br>confidence: ' + day.confidence + ' (' + (day.confidenceScore * 100).toFixed(0) + '%)';
      if (day.isForecast) html += '<br><span style="color:#fbbf24">forecast</span>';
      if (day.isGap) html += '<br><span style="color:#ef4444">gap</span>';
    }
    if (gt) {
      html += '<br>ground truth mid: ' + fmtH(gt.midpointHour);
      if (day) {
        const predMid = ((((day.nightStartHour + day.nightEndHour) / 2) % 24) + 24) % 24;
        const err = circDist(predMid, gt.midpointHour);
        html += '<br>phase error: ' + (err * 60).toFixed(0) + 'min';
      }
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(mx + 12, width - 200) + 'px';
    tooltip.style.top = (my + 12) + 'px';
  });
  canvas.addEventListener('mouseleave', function() { tooltip.style.display = 'none'; });

  function fmtH(h) {
    const n = ((h % 24) + 24) % 24;
    const hr = Math.floor(n);
    const min = Math.round((n - hr) * 60);
    return String(hr).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }
  function circDist(a, b) {
    const d = Math.abs(((a % 24) + 24) % 24 - ((b % 24) + 24) % 24);
    return Math.min(d, 24 - d);
  }
})();
</script>
</body>
</html>`;

export function generateVizHtml(options: VizOptions): string {
    const data = buildVizData(options);
    return HTML_TEMPLATE.replace("{{TITLE}}", data.meta.title.replace(/</g, "&lt;")).replace(
        "{{DATA}}",
        JSON.stringify(data),
    );
}

const OUTPUT_DIR = resolve(__dirname, "../../../../test-output");

export function maybeSaveViz(filename: string, options: VizOptions): void {
    if (process.env.VIZ !== "1") return;
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const html = generateVizHtml(options);
    writeFileSync(resolve(OUTPUT_DIR, `${filename}.html`), html, "utf-8");
}
