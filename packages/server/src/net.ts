// Network configuration for the local dashboard server: where it listens,
// how that is validated, and a small Host/Origin guard.
//
// The server has NO authentication - its whole security model is "it only
// listens on this machine". So the default is loopback, and anything wider is
// an explicit, warned-about opt-in (WOWSYNC_HOST). Everything here is pure or
// tiny so it can be tested without process-level side effects (index.ts is
// only the bootstrap that calls it).
import http from "node:http";
import net from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4173;

/** A configuration mistake the user can fix - reported plainly, not as a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * - loopback: only this machine can connect.
 * - all-interfaces: 0.0.0.0 / :: - every network the machine is on.
 * - specific: one non-loopback address or a hostname (reachable by whoever can reach that address).
 */
export type HostExposure = "loopback" | "specific" | "all-interfaces";

export interface ResolvedHost {
  host: string;
  exposure: HostExposure;
}

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * How far an IP address (as configured, or as reported by the OS for a bound
 * socket) exposes the server. Every spelling counts - `::0`, `0::0`, the
 * zero-padded forms, and IPv4-mapped forms such as `::ffff:0.0.0.0` or
 * `::ffff:127.0.0.1` - so a wildcard can never be mistaken for "a specific
 * address". Anything unrecognised is "specific" (the cautious reading).
 */
export function classifyAddress(ip: string): HostExposure {
  if (net.isIPv4(ip)) {
    if (ip === "0.0.0.0") return "all-interfaces";
    return ip.startsWith("127.") ? "loopback" : "specific";
  }
  if (net.isIPv6(ip)) {
    let canonical: string;
    try {
      canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase(); // the URL parser canonicalises every spelling
    } catch {
      return "specific"; // e.g. a zone id (fe80::1%eth0)
    }
    if (canonical === "::") return "all-interfaces";
    if (canonical === "::1") return "loopback";
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical); // IPv4-mapped, e.g. ::ffff:7f00:1
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      if (high === 0 && parseInt(mapped[2], 16) === 0) return "all-interfaces";
      if (high >> 8 === 127) return "loopback";
    }
  }
  return "specific";
}

/**
 * Resolves the bind address from `WOWSYNC_HOST` ONLY. Deliberately never
 * reads the generic `HOST`/`HOSTNAME` variables (shells and Docker set
 * those to unrelated values).
 *
 * - unset, empty or whitespace  -> 127.0.0.1. (An empty string handed to
 *   `listen()` binds EVERY interface, so it must never pass through.)
 * - "localhost"                 -> 127.0.0.1. (On Node 24 the name resolves
 *   to ::1 first, which would leave the IPv4 self-loopback and IPv4 clients
 *   unable to connect.)
 * - an IP address or a hostname -> used as given.
 * - anything else               -> ConfigError (the server refuses to start
 *   rather than guess a wider bind).
 */
export function resolveHost(env: Record<string, string | undefined>): ResolvedHost {
  const raw = (env.WOWSYNC_HOST ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "localhost") return { host: DEFAULT_HOST, exposure: "loopback" };
  if (net.isIP(raw) !== 0) return { host: raw, exposure: classifyAddress(raw) };
  // All digits and dots but not a valid IP ("0", "127.1", "2130706433"): a resolver may
  // read these as an address (0 -> 0.0.0.0), so they are refused rather than guessed.
  if (/^[0-9.]+$/.test(raw)) throw new ConfigError(badHost(raw));
  if (HOSTNAME_RE.test(raw)) return { host: raw, exposure: "specific" };
  throw new ConfigError(badHost(raw));
}

function badHost(raw: string): string {
  return `WOWSYNC_HOST="${raw}" is not a valid IP address or hostname. Use e.g. 127.0.0.1 (this machine only, the default) or 0.0.0.0 (all network interfaces - see README "Network exposure").`;
}

/** Strict port parsing: an integer 1-65535. Empty/unset -> the default. Anything else is an error, never a silent random port. */
export function resolvePort(env: Record<string, string | undefined>): number {
  const raw = (env.PORT ?? "").trim();
  if (raw === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new ConfigError(`PORT="${raw}" is not a valid port number (expected an integer from 1 to 65535).`);
  }
  return Number(raw);
}

/** A multi-line warning for non-loopback binds; undefined when the bind is loopback-only. */
export function exposureWarning(resolved: ResolvedHost, port: number): string | undefined {
  if (resolved.exposure === "loopback") return undefined;
  const where = resolved.exposure === "all-interfaces" ? "on EVERY network interface" : `on ${resolved.host}`;
  return [
    `WARNING: WoWSync is listening ${where} (WOWSYNC_HOST=${resolved.host}, port ${port}).`,
    "It has NO authentication. Anyone who can reach this address can read your character data,",
    "import or DELETE characters, and use Ask My Account (spending your OPENAI_API_KEY).",
    "Only do this on a network you trust. Unset WOWSYNC_HOST to listen on this machine only.",
  ].join("\n");
}

/** The URL a client on THIS machine should use to reach a server bound to `host` (used for /api/ask's request to its own /api/account-context). */
export function loopbackOrigin(host: string, port: number): string {
  if (classifyAddress(host) === "all-interfaces") return `http://127.0.0.1:${port}`;
  if (net.isIPv6(host)) return `http://[${host}]:${port}`;
  return `http://${host}:${port}`;
}

/** What to print at startup, based on the address the OS actually bound (never a loopback URL for a wildcard bind). */
export function describeListening(address: { address: string; port: number }): string {
  const shown = net.isIPv6(address.address) ? `[${address.address}]` : address.address;
  return classifyAddress(address.address) === "all-interfaces"
    ? `${shown}:${address.port} (ALL network interfaces)`
    : `http://${shown}:${address.port}`;
}

/** The Host names to allow for a bind, or undefined when no guard applies (a deliberate wider bind). A loopback bind also allows its own address (127.0.0.5 must not lock itself out). */
export function allowedHostsFor(bind: ResolvedHost): string[] | undefined {
  if (bind.exposure !== "loopback") return undefined;
  return [...new Set([...LOOPBACK_HOSTNAMES, bind.host.toLowerCase()])];
}

function friendlyListenError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case "EADDRINUSE":
      return `Port ${port} is already in use on ${host}. Is WoWSync already running? Stop the other server first (an older WoWSync may still be running), or choose another port with PORT=<number>.`;
    case "EACCES":
      return `Permission denied listening on ${host}:${port}. Try a port above 1024 (PORT=<number>).`;
    case "EADDRNOTAVAIL":
    case "ENOTFOUND":
      return `Cannot listen on "${host}": that address does not belong to this machine (WOWSYNC_HOST). Use 127.0.0.1 for this machine only, or 0.0.0.0 for all interfaces.`;
    default:
      return `Could not start the server on ${host}:${port}: ${err.message}`;
  }
}

/** Starts listening and resolves with the running server, or rejects with a ConfigError carrying a plain-language reason. `port` 0 picks a free port (tests). */
/** True when something already accepts connections at host:port. */
export function isPortAnswering(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function listenOnce(handler: http.RequestListener, host: string, port: number): Promise<http.Server> {
  // Some systems (Windows) let a socket bind 127.0.0.1:PORT even while another process
  // holds the same port on ALL interfaces, so EADDRINUSE never fires - and an older,
  // network-exposed WoWSync would keep running next to the new one, silently defeating the
  // loopback default. So first ask whether anything already answers on that port.
  if (port !== 0) {
    const probeHost = classifyAddress(host) === "all-interfaces" ? "127.0.0.1" : host;
    if (await isPortAnswering(probeHost, port)) {
      throw new ConfigError(friendlyListenError(Object.assign(new Error("in use"), { code: "EADDRINUSE" }), host, port));
    }
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const onError = (err: NodeJS.ErrnoException) => reject(new ConfigError(friendlyListenError(err, host, port)));
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------
// Host / Origin guard (loopback binds only)
// ---------------------------------------------------------------------

/** Hostnames a browser on this machine legitimately uses to reach a loopback-bound server. */
export const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "::1"];

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]")); // [::1]:4173 -> ::1
  const colon = h.lastIndexOf(":");
  return colon >= 0 && h.indexOf(":") === colon ? h.slice(0, colon) : h; // host:port -> host (a bare IPv6 has several colons)
}

/**
 * Rejects requests whose Host header is not one of `allowed` (403), and, for
 * requests that can change state, whose Origin header is present but not one
 * of them either.
 *
 * Why: binding to loopback stops OTHER machines, but a web page the user
 * merely visits can point an attacker-controlled hostname at 127.0.0.1
 * ("DNS rebinding") and then read and write this API as if it were
 * same-origin. Such requests carry the attacker's hostname in Host/Origin,
 * which this refuses. It is a proportionate hardening, not authentication: any
 * program running on this machine can still call the API.
 */
export function hostGuard(allowed: readonly string[] = LOOPBACK_HOSTNAMES): RequestHandler {
  const ok = new Set(allowed.map((h) => h.toLowerCase()));
  const reject = (req: Request, res: Response, why: string) => {
    // Drain the (unread) request body and close the connection after replying:
    // otherwise the socket can be reset with the 403 still in flight and the
    // client sees a network error instead of the refusal.
    req.resume();
    res.setHeader("Connection", "close");
    return res.status(403).json({ error: `Forbidden: ${why}.`, code: "HOST_NOT_ALLOWED" });
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const hostHeader = req.headers.host;
    if (!hostHeader || !ok.has(hostnameOf(hostHeader))) return reject(req, res, "unexpected Host header");
    const origin = req.headers.origin;
    const safeMethod = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    if (!safeMethod && origin !== undefined) {
      let originHost = "";
      try {
        originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      } catch {
        // "null" or malformed: not an origin we trust for a state-changing request
      }
      if (!ok.has(originHost)) return reject(req, res, "unexpected Origin header");
    }
    next();
  };
}
