/**
 * Go-style formatting helpers: a small Printf, %v rendering and
 * time.Duration's String format.
 */

/** A duration in nanoseconds, as Go's time.Duration. */
export type Duration = bigint;

/** Converts milliseconds to a Duration. */
export function millis(ms: number): Duration {
  return BigInt(Math.round(ms * 1e6));
}

function fmtFrac(v: bigint, prec: number): [string, bigint] {
  let out = '';
  let printed = false;
  for (let i = 0; i < prec; i++) {
    const digit = v % 10n;
    printed = printed || digit !== 0n;
    if (printed) out = String(digit) + out;
    v /= 10n;
  }
  if (printed) out = '.' + out;
  return [out, v];
}

/** Formats a Duration exactly as Go's time.Duration.String does. */
export function formatDuration(d: Duration): string {
  if (d === 0n) return '0s';
  const neg = d < 0n;
  let u = neg ? -d : d;
  let out: string;
  if (u < 1_000_000_000n) {
    let prec: number;
    let unit: string;
    if (u < 1000n) return (neg ? '-' : '') + `${u}ns`;
    if (u < 1_000_000n) {
      prec = 3;
      unit = 'µs';
    } else {
      prec = 6;
      unit = 'ms';
    }
    const [frac, whole] = fmtFrac(u, prec);
    out = `${whole}${frac}${unit}`;
  } else {
    const [frac, whole] = fmtFrac(u, 9);
    u = whole;
    out = `${u % 60n}${frac}s`;
    u /= 60n;
    if (u > 0n) {
      out = `${u % 60n}m` + out;
      u /= 60n;
      if (u > 0n) out = `${u}h` + out;
    }
  }
  return (neg ? '-' : '') + out;
}

/** Renders a value the way Go's %v roughly would. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '<nil>';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return '[' + value.map(formatValue).join(' ') + ']';
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const s = String(value);
    if (s !== '[object Object]') return s;
    try {
      return JSON.stringify(value);
    } catch {
      return s;
    }
  }
  return String(value);
}

/**
 * A minimal Printf with the verbs wish uses: %v %s %d %q %t %x %%. Extra
 * arguments are appended like Go's `%!(EXTRA ...)`, without the decoration.
 */
export function sprintf(format: string, ...args: unknown[]): string {
  let index = 0;
  const out = format.replace(/%[-+# 0]*\d*(?:\.\d+)?([vsdqtx%])/g, (token, verb: string) => {
    if (verb === '%') return '%';
    if (index >= args.length) return `%!${verb}(MISSING)`;
    const value = args[index++];
    switch (verb) {
      case 'd':
        return typeof value === 'bigint' ? value.toString() : String(Math.trunc(Number(value)));
      case 'q':
        return JSON.stringify(formatValue(value));
      case 'x':
        return Buffer.isBuffer(value) ? value.toString('hex') : Number(value).toString(16);
      default:
        return formatValue(value);
    }
  });
  return out;
}

/** Joins values as Go's fmt.Sprint does (spaces only between non-strings). */
export function sprint(...args: unknown[]): string {
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (i > 0 && typeof args[i] !== 'string' && typeof args[i - 1] !== 'string') out += ' ';
    out += formatValue(args[i]);
  }
  return out;
}

/** Joins values as Go's fmt.Sprintln does (always spaces, trailing newline). */
export function sprintln(...args: unknown[]): string {
  return args.map(formatValue).join(' ') + '\n';
}
