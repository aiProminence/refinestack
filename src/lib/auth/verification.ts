export function claimsHaveFreshMailboxOtp(claims: unknown, requestedAt: string | null) {
  return freshMailboxOtpTime(claims, requestedAt) !== null;
}

export function freshMailboxOtpTime(claims: unknown, requestedAt: string | null) {
  if (!requestedAt || !claims || typeof claims !== "object") return null;
  const amr = (claims as { amr?: unknown }).amr;
  if (!Array.isArray(amr)) return null;
  const requestedTime = new Date(requestedAt).getTime();
  if (!Number.isFinite(requestedTime)) return null;
  const timestamps = amr.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const method = (entry as { method?: unknown }).method;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    return method === "otp" && typeof timestamp === "number" && timestamp * 1000 > requestedTime
      ? [timestamp * 1000] : [];
  });
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}
