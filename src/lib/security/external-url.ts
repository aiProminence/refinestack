import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

type AddressRecord = { address: string; family: number };
type Resolver = (hostname: string) => Promise<AddressRecord[]>;

function ipv4Number(ip: string) {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inIpv4Cidr(ip: number, base: string, bits: number) {
  const network = ipv4Number(base)!;
  const divisor = 2 ** (32 - bits);
  return Math.floor(ip / divisor) === Math.floor(network / divisor);
}

const NON_PUBLIC_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function expandIpv6(ip: string): number[] | null {
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
  const mapped = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) {
    const v4 = ipv4Number(mapped[2]);
    if (v4 === null) return null;
    ip = `${mapped[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const pieces = ip.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) return null;
  return groups.map((part) => Number.parseInt(part, 16));
}

function inIpv6Cidr(ip: number[], base: string, bits: number) {
  const network = expandIpv6(base)!;
  const fullGroups = Math.floor(bits / 16);
  for (let index = 0; index < fullGroups; index += 1) if (ip[index] !== network[index]) return false;
  const remaining = bits % 16;
  if (!remaining) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (ip[fullGroups] & mask) === (network[fullGroups] & mask);
}

const NON_PUBLIC_IPV6: Array<[string, number]> = [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32],
  ["2001:10::", 28], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];

export function isPublicIp(ip: string) {
  const version = isIP(ip);
  if (version === 4) {
    const value = ipv4Number(ip);
    return value !== null && !NON_PUBLIC_IPV4.some(([base, bits]) => inIpv4Cidr(value, base, bits));
  }
  if (version !== 6) return false;
  const value = expandIpv6(ip);
  if (value === null) return false;
  if (inIpv6Cidr(value, "::ffff:0:0", 96)) {
    const embedded = value[6] * 65_536 + value[7];
    return !NON_PUBLIC_IPV4.some(([base, bits]) => inIpv4Cidr(embedded, base, bits));
  }
  if (inIpv6Cidr(value, "2002::", 16)) {
    const embedded = value[1] * 65_536 + value[2];
    if (NON_PUBLIC_IPV4.some(([base, bits]) => inIpv4Cidr(embedded, base, bits))) return false;
  }
  return !NON_PUBLIC_IPV6.some(([base, bits]) => inIpv6Cidr(value, base, bits));
}

const systemResolver: Resolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function resolveSafeExternalUrl(value: string, resolver: Resolver = systemResolver) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Destination must be a valid absolute URL."); }
  if (url.protocol !== "https:") throw new Error("Only HTTPS destinations are supported.");
  if (url.username || url.password) throw new Error("Embedded URL credentials are not supported.");
  if (!["", "443"].includes(url.port)) throw new Error("Only the standard HTTPS port is supported.");
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new Error("Private destinations are not supported.");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literalVersion = isIP(hostname);
  const records = literalVersion ? [{ address: hostname, family: literalVersion }] : await resolver(hostname);
  if (records.length === 0 || records.some(({ address }) => !isPublicIp(address))) throw new Error("Private or unresolved destinations are not supported.");
  return { url, records };
}

export async function assertSafeExternalUrl(value: string) {
  return (await resolveSafeExternalUrl(value)).url;
}

export type SafeExternalFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolver?: Resolver;
};

/** Validates every redirect and pins the validated DNS address into the TLS socket. */
export async function safeExternalFetch(value: string, init: RequestInit = {}, options: SafeExternalFetchOptions = {}): Promise<Response> {
  const resolver = options.resolver ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? 0;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new Error("Invalid external redirect limit.");
  let current = value;
  let method = (init.method ?? "GET").toUpperCase();
  let body = typeof init.body === "string" || init.body instanceof Uint8Array ? init.body : undefined;
  let headers = new Headers(init.headers);
  for (let redirect = 0; ; redirect += 1) {
    const { url, records } = await resolveSafeExternalUrl(current, resolver);
    const response = await pinnedHttpsRequest(url, records[0], { ...init, method, headers, body }, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      response.headers.set("x-refinestack-final-url", url.toString());
      return response;
    }
    if (redirect >= maxRedirects) throw new Error("External destination exceeded the redirect limit.");
    const location = response.headers.get("location");
    if (!location) throw new Error("External destination returned a redirect without a location.");
    const next = new URL(location, url);
    if (next.origin !== url.origin) {
      headers = new Headers(headers);
      headers.delete("authorization"); headers.delete("cookie"); headers.delete("proxy-authorization");
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET"; body = undefined; headers.delete("content-length"); headers.delete("content-type");
    }
    current = next.toString();
  }
}

function pinnedHttpsRequest(url: URL, record: AddressRecord, init: RequestInit, options: SafeExternalFetchOptions) {
  return new Promise<Response>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxBytes = options.maxBytes ?? 2_000_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return reject(new Error("Invalid external request timeout."));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20_000_000) return reject(new Error("Invalid external response limit."));
    const request = httpsRequest(url, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      signal: init.signal ?? undefined,
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, record.address, record.family)) as never,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) request.destroy(new Error("External response exceeded the size limit."));
        else chunks.push(chunk);
      });
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502, headers: incoming.headers as HeadersInit })));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("External request timed out.")));
    request.on("error", reject);
    if (init.body instanceof Uint8Array || typeof init.body === "string") request.write(init.body);
    else if (init.body != null) return request.destroy(new Error("External request body must be a string or byte array."));
    request.end();
  });
}
