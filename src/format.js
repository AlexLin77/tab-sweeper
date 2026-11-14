// Small formatting helpers shared by the popup, options page and policy code.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Compact human duration: "<1m", "12m", "3h 5m", "2d 4h". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE) return '<1m';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Short, readable origin for a URL: "github.com", "chrome://settings", "Local file". */
export function hostOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.hostname.replace(/^www\./, '');
  }
  if (parsed.protocol === 'file:') return 'Local file';
  if (parsed.hostname) return `${parsed.protocol}//${parsed.hostname}`;
  return parsed.protocol.replace(/:$/, '');
}

export function plural(count, word, pluralWord = `${word}s`) {
  return `${count} ${count === 1 ? word : pluralWord}`;
}
