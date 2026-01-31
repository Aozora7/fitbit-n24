import { useState, useCallback, useMemo } from "react";
import { useActogramRenderer } from "./useActogramRenderer";
import { buildActogramRows } from "../../models/actogramData";
import { useAppContext } from "../../AppContext";

export default function Actogram() {
  const { filteredRecords, showCircadian, circadianAnalysis, doublePlot, effectiveRowHeight, colorMode, forecastDays } = useAppContext();

  const rows = useMemo(
    () => buildActogramRows(filteredRecords, forecastDays),
    [filteredRecords, forecastDays],
  );

  const circadianDays = showCircadian ? circadianAnalysis.days : [];

  const { canvasRef, getTooltipInfo } = useActogramRenderer(rows, circadianDays, {
    doublePlot,
    rowHeight: effectiveRowHeight,
    colorMode,
  });

  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    info: Record<string, string>;
  } | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const info = getTooltipInfo(x, y);
      if (info) {
        setTooltip({ x: e.clientX, y: e.clientY, info });
      } else {
        setTooltip(null);
      }
    },
    [getTooltipInfo],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 rounded bg-gray-900 px-3 py-2 text-xs text-gray-200 shadow-lg"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          {Object.entries(tooltip.info).map(([key, val]) => (
            <div key={key}>
              <span className="text-gray-400">{key}: </span>
              {val}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
