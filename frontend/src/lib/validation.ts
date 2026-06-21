// Shared form validation helpers used by the Node and Job dialogs.

export function isBlank(v: string | null | undefined): boolean {
  return !v || !v.trim();
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIPv4(v: string): boolean {
  const m = IPV4.exec(v.trim());
  if (!m) return false;
  return m.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255 && String(n) === octet.replace(/^0+(?=\d)/, "");
  });
}

const HOSTNAME =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

export function isValidHostname(v: string): boolean {
  return HOSTNAME.test(v.trim());
}

/** Accepts either a dotted-quad IPv4 address or a DNS hostname. */
export function isValidHost(v: string): boolean {
  return isValidIPv4(v) || isValidHostname(v);
}

const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

export function isValidMac(v: string): boolean {
  return MAC.test(v.trim());
}

export function isValidPort(v: number | undefined): boolean {
  return v !== undefined && Number.isInteger(v) && v >= 1 && v <= 65535;
}

export function isAbsolutePath(v: string): boolean {
  return v.trim().startsWith("/");
}

// Standard 5-field cron: minute hour day-of-month month day-of-week.
const CRON_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((item) => {
    const [range, step] = item.split("/");
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) {
      return false;
    }
    if (range === "*") return true;
    const [a, b] = range.split("-");
    if (!/^\d+$/.test(a)) return false;
    const av = Number(a);
    if (av < min || av > max) return false;
    if (b !== undefined) {
      if (!/^\d+$/.test(b)) return false;
      const bv = Number(b);
      if (bv < min || bv > max || bv < av) return false;
    }
    return true;
  });
}

export function isValidCron(v: string): boolean {
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part, i) =>
    isValidCronField(part, CRON_RANGES[i][0], CRON_RANGES[i][1]),
  );
}
