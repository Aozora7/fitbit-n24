import { useEffect, useRef, useCallback } from "react";
import { scaleLinear } from "d3-scale";
import type { ActogramRow } from "../../models/actogramData";
import type { CircadianDay } from "../../models/circadian";
import type { SleepLevelEntry } from "../../api/types";

export interface ActogramConfig {
  doublePlot: boolean;
  rowHeight: number;
  leftMargin: number;
  topMargin: number;
  rightMargin: number;
  bottomMargin: number;
}

const DEFAULT_CONFIG: ActogramConfig = {
  doublePlot: false,
  rowHeight: 5,
  leftMargin: 80,
  topMargin: 30,
  rightMargin: 16,
  bottomMargin: 20,
};

const COLORS = {
  // v1 minuteData colors
  asleep: "#3b82f6",
  restless: "#eab308",
  awake: "#ef4444",
  // v1.2 stage colors
  deep: "#1e40af",
  light: "#60a5fa",
  rem: "#06b6d4",
  wake: "#ef4444",
  // UI colors
  background: "#1e293b",
  grid: "#334155",
  text: "#94a3b8",
};

/** Map v1 minuteData value to color */
function minuteColor(value: string): string {
  switch (value) {
    case "1":
      return COLORS.asleep;
    case "2":
      return COLORS.restless;
    case "3":
      return COLORS.awake;
    default:
      return COLORS.asleep;
  }
}

/** Map v1.2 stage level to color */
function stageColor(level: string): string {
  switch (level) {
    case "deep":
      return COLORS.deep;
    case "light":
      return COLORS.light;
    case "rem":
      return COLORS.rem;
    case "wake":
      return COLORS.wake;
    default:
      return COLORS.light;
  }
}

export function useActogramRenderer(
  rows: ActogramRow[],
  circadian: CircadianDay[],
  config: Partial<ActogramConfig> = {},
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const hoursPerRow = cfg.doublePlot ? 48 : 24;

  const getTooltipInfo = useCallback(
    (canvasX: number, canvasY: number): Record<string, string> | null => {
      const dpr = window.devicePixelRatio || 1;
      const x = canvasX * dpr;
      const y = canvasY * dpr;

      const plotWidth =
        (canvasRef.current?.width ?? 0) / 1 -
        cfg.leftMargin * dpr -
        cfg.rightMargin * dpr;
      const rowIdx = Math.floor(
        (y - cfg.topMargin * dpr) / (cfg.rowHeight * dpr),
      );

      if (rowIdx < 0 || rowIdx >= rows.length) return null;
      const row = rows[rowIdx]!;

      const xScale = scaleLinear()
        .domain([0, hoursPerRow])
        .range([cfg.leftMargin * dpr, cfg.leftMargin * dpr + plotWidth]);
      const hour = xScale.invert(x);

      // Find block at this hour
      for (const block of row.blocks) {
        const match =
          (hour >= block.startHour && hour <= block.endHour) ||
          (cfg.doublePlot &&
            hour >= block.startHour + 24 &&
            hour <= block.endHour + 24);
        if (match) {
          const info: Record<string, string> = {
            date: row.date,
            start: block.record.startTime.toLocaleTimeString(),
            end: block.record.endTime.toLocaleTimeString(),
            duration: block.record.durationHours.toFixed(1) + "h",
            efficiency: block.record.efficiency + "%",
          };
          if (block.record.stages) {
            const s = block.record.stages;
            info.stages = `D:${s.deep} L:${s.light} R:${s.rem} W:${s.wake}min`;
          }
          return info;
        }
      }

      return { date: row.date } as Record<string, string>;
    },
    [rows, cfg, hoursPerRow],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rows.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight =
      cfg.topMargin + rows.length * cfg.rowHeight + cfg.bottomMargin;

    canvas.style.height = cssHeight + "px";
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    const plotLeft = cfg.leftMargin;
    const plotWidth = cssWidth - cfg.leftMargin - cfg.rightMargin;
    const plotTop = cfg.topMargin;

    const xScale = scaleLinear()
      .domain([0, hoursPerRow])
      .range([plotLeft, plotLeft + plotWidth]);

    // Clear
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // Draw hour grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    for (let h = 0; h <= hoursPerRow; h += 6) {
      const x = xScale(h);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + rows.length * cfg.rowHeight);
      ctx.stroke();
    }

    // Hour labels
    ctx.fillStyle = COLORS.text;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (let h = 0; h <= hoursPerRow; h += 6) {
      const label = h % 24;
      ctx.fillText(label.toString().padStart(2, "0"), xScale(h), plotTop - 8);
    }

    // Draw circadian overlay
    if (circadian.length > 0) {
      const circadianMap = new Map<string, CircadianDay>();
      for (const cd of circadian) {
        circadianMap.set(cd.date, cd);
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const cd = circadianMap.get(row.date);
        if (!cd) continue;

        const y = plotTop + i * cfg.rowHeight;

        // Alpha based on confidence score
        const alpha =
          "confidenceScore" in cd
            ? 0.1 + (cd as { confidenceScore: number }).confidenceScore * 0.25
            : 0.25;
        ctx.fillStyle = `rgba(168, 85, 247, ${alpha})`;

        // Normalize night hours to [0, 24) range
        let nightStart = ((cd.nightStartHour % 24) + 24) % 24;
        let nightEnd = ((cd.nightEndHour % 24) + 24) % 24;

        if (nightEnd < nightStart) {
          ctx.fillRect(
            xScale(nightStart),
            y,
            xScale(24) - xScale(nightStart),
            cfg.rowHeight,
          );
          ctx.fillRect(xScale(0), y, xScale(nightEnd) - xScale(0), cfg.rowHeight);
        } else {
          ctx.fillRect(
            xScale(nightStart),
            y,
            xScale(nightEnd) - xScale(nightStart),
            cfg.rowHeight,
          );
        }

        if (cfg.doublePlot) {
          nightStart += 24;
          nightEnd += 24;
          if (nightEnd < nightStart) {
            ctx.fillRect(xScale(nightStart), y, xScale(48) - xScale(nightStart), cfg.rowHeight);
            ctx.fillRect(xScale(24), y, xScale(nightEnd) - xScale(24), cfg.rowHeight);
          } else {
            ctx.fillRect(xScale(nightStart), y, xScale(nightEnd) - xScale(nightStart), cfg.rowHeight);
          }
        }
      }
    }

    // Draw sleep blocks
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const y = plotTop + i * cfg.rowHeight;

      for (const block of row.blocks) {
        const drawBlock = (hourOffset: number) => {
          const bStart = block.startHour + hourOffset;
          const bEnd = block.endHour + hourOffset;
          const blockPixelWidth = xScale(bEnd) - xScale(bStart);

          if (block.record.stageData && blockPixelWidth > 5) {
            // v1.2: render per-interval stage coloring
            drawStageBlock(
              ctx,
              xScale,
              block.record.stageData,
              block.record.startTime,
              row.date,
              bStart,
              bEnd,
              y,
              cfg.rowHeight,
              hourOffset,
            );
          } else if (block.record.minuteData && blockPixelWidth > 10) {
            // v1: render per-minute coloring
            drawMinuteBlock(
              ctx,
              xScale,
              block.record.minuteData,
              block.record.startTime,
              row.date,
              bStart,
              bEnd,
              y,
              cfg.rowHeight,
            );
          } else {
            // Solid fallback
            ctx.fillStyle = block.record.stageData ? COLORS.light : COLORS.asleep;
            ctx.fillRect(
              xScale(bStart),
              y,
              Math.max(blockPixelWidth, 1),
              cfg.rowHeight - 0.5,
            );
          }
        };

        drawBlock(0);
        if (cfg.doublePlot) drawBlock(24);
      }
    }

    // Date labels
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    const labelInterval = cfg.rowHeight < 6 ? 7 : 1;
    for (let i = 0; i < rows.length; i += labelInterval) {
      const row = rows[i]!;
      const y = plotTop + i * cfg.rowHeight + cfg.rowHeight;
      ctx.fillText(row.date, plotLeft - 6, y);
    }
  }, [rows, circadian, cfg, hoursPerRow]);

  return { canvasRef, getTooltipInfo };
}

/**
 * Draw a sleep block colored by v1.2 stage data intervals.
 *
 * blockStartHour/blockEndHour are on the x-axis scale (0..24 or 0..48 for double plot).
 * hourOffset is 0 for the first plot, 24 for the double-plot repeat.
 *
 * Strategy: compute the block's absolute time boundaries, then map each stage entry
 * into the x-axis coordinate space by linear interpolation.
 */
function drawStageBlock(
  ctx: CanvasRenderingContext2D,
  xScale: (h: number) => number,
  stageData: SleepLevelEntry[],
  recordStart: Date,
  _rowDate: string,
  blockStartHour: number,
  blockEndHour: number,
  y: number,
  rowHeight: number,
  hourOffset: number,
) {
  if (blockEndHour <= blockStartHour) return;
  const blockDurationHours = blockEndHour - blockStartHour;

  // Reconstruct the block's absolute time boundaries.
  // blockStartHour (minus hourOffset) = hours from the row's local midnight.
  // The row's local midnight can be derived: for the day containing this block,
  // actogramData computed startHour = (max(sleepStart, dayMidnight) - dayMidnight) / 3600000.
  // So blockAbsStartMs = dayMidnight + (blockStartHour - hourOffset) * 3600000.
  // We derive dayMidnight from the record: the record start's local midnight, plus
  // the day offset for blocks that fall on subsequent days.
  const recordStartMs = recordStart.getTime();
  const recordMidnight = new Date(recordStart);
  recordMidnight.setHours(0, 0, 0, 0);
  const recordMidnightMs = recordMidnight.getTime();

  // Base block start hour (in local time, 0..24)
  const localBlockStartH = blockStartHour - hourOffset;

  // Record's local start hour
  const recordLocalStartH = (recordStartMs - recordMidnightMs) / 3_600_000;

  // Figure out which day's midnight this block belongs to.
  // If localBlockStartH >= recordLocalStartH, same day as record start.
  // If localBlockStartH < recordLocalStartH, block is on the next day (record spans midnight).
  let dayMidnightMs: number;
  if (localBlockStartH >= recordLocalStartH - 0.5) {
    dayMidnightMs = recordMidnightMs;
  } else {
    // Block is on next calendar day
    dayMidnightMs = recordMidnightMs + 24 * 3_600_000;
  }

  const blockAbsStartMs = dayMidnightMs + localBlockStartH * 3_600_000;
  const blockAbsEndMs = blockAbsStartMs + blockDurationHours * 3_600_000;

  for (const entry of stageData) {
    const entryStartMs = new Date(entry.dateTime).getTime();
    const entryEndMs = entryStartMs + entry.seconds * 1000;

    // Clip to block time range
    const visStartMs = Math.max(entryStartMs, blockAbsStartMs);
    const visEndMs = Math.min(entryEndMs, blockAbsEndMs);
    if (visEndMs <= visStartMs) continue;

    // Map to x-axis hours
    const xStart =
      blockStartHour +
      ((visStartMs - blockAbsStartMs) / 3_600_000);
    const xEnd =
      blockStartHour +
      ((visEndMs - blockAbsStartMs) / 3_600_000);

    ctx.fillStyle = stageColor(entry.level);
    ctx.fillRect(
      xScale(xStart),
      y,
      Math.max(xScale(xEnd) - xScale(xStart), 0.5),
      rowHeight - 0.5,
    );
  }
}

/**
 * Draw a sleep block colored by v1 per-minute data.
 */
function drawMinuteBlock(
  ctx: CanvasRenderingContext2D,
  xScale: (h: number) => number,
  minuteData: { dateTime: string; value: string }[],
  recordStart: Date,
  rowDate: string,
  blockStartHour: number,
  blockEndHour: number,
  y: number,
  rowHeight: number,
) {
  const recordStartHour =
    (recordStart.getTime() - new Date(rowDate + "T00:00:00").getTime()) /
    3_600_000;
  const minuteOffset = Math.max(
    0,
    Math.round((blockStartHour - recordStartHour) * 60),
  );
  const blockMinutes = (blockEndHour - blockStartHour) * 60;
  const minuteCount = Math.round(blockMinutes);
  const blockPixelWidth = xScale(blockEndHour) - xScale(blockStartHour);
  const pixelPerMinute = blockPixelWidth / minuteCount;

  for (let m = 0; m < minuteCount; m++) {
    const dataIdx = minuteOffset + m;
    const datum = minuteData[dataIdx];
    if (!datum) continue;

    ctx.fillStyle = minuteColor(datum.value);
    const mx = xScale(blockStartHour + m / 60);
    const mw = Math.max(pixelPerMinute, 0.5);
    ctx.fillRect(mx, y, mw, rowHeight - 0.5);
  }
}
