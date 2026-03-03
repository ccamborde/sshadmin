/**
 * Converts a Docker timestamp (UTC) to the browser's local time.
 *
 * Docker timestamps have the format: 2024-01-15T12:43:00.123456789Z
 * JavaScript only handles milliseconds, so we truncate nanoseconds.
 *
 * @param {string} ts - Docker UTC timestamp
 * @param {'datetime'|'time'|'full'} format - Output format
 * @returns {string} Timestamp formatted in local time
 */
export function formatLocalTimestamp(ts, format = 'datetime') {
  if (!ts) return '';

  try {
    // Docker timestamps may have nanoseconds (9 digits after the dot)
    // JavaScript only supports milliseconds (3 digits)
    // Truncate: 2024-01-15T12:43:00.123456789Z → 2024-01-15T12:43:00.123Z
    let normalized = ts;

    // Handle timestamps without trailing Z (treat as UTC)
    if (!normalized.endsWith('Z') && !normalized.includes('+') && !normalized.includes('-', 10)) {
      normalized += 'Z';
    }

    // Truncate fractional seconds to 3 digits (milliseconds)
    normalized = normalized.replace(
      /(\.\d{3})\d*(Z|[+-])/,
      '$1$2'
    );

    const date = new Date(normalized);

    // Check that the date is valid
    if (isNaN(date.getTime())) {
      // Fallback: return raw formatted timestamp
      return ts.replace('T', ' ').slice(0, 19);
    }

    const pad = (n) => String(n).padStart(2, '0');

    const y = date.getFullYear();
    const mo = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const s = pad(date.getSeconds());

    switch (format) {
      case 'time':
        // HH:MM:SS only (local time)
        return `${h}:${mi}:${s}`;
      case 'full':
        // YYYY-MM-DD HH:MM:SS.mmm (local time)
        const ms = String(date.getMilliseconds()).padStart(3, '0');
        return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
      case 'datetime':
      default:
        // YYYY-MM-DD HH:MM:SS (local time)
        return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
    }
  } catch {
    // On error, return raw timestamp
    return ts.replace('T', ' ').slice(0, 19);
  }
}
