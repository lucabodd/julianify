export function formatTime(ms: number, decimals = 1): string {
  if (!Number.isFinite(ms)) return '–:––';
  const negative = ms < 0;
  const total = Math.abs(ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const s = seconds.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, '0');
  return `${negative ? '-' : ''}${minutes}:${s}`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function barName(barIndex: number, occurrence = 0): string {
  return occurrence > 0 ? `${barIndex + 1} (${occurrence + 1}ª volta)` : String(barIndex + 1);
}
