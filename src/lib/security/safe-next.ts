const navigationBase = "https://navigation.refinestack.invalid";

export function safeRelativePath(value: unknown, fallback = "/dashboard") {
  const candidate = String(value ?? fallback).trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")
    || candidate.includes("\\") || /%5c/iu.test(candidate)
    || /[\u0000-\u001f\u007f]/u.test(candidate)) return fallback;
  try {
    const parsed = new URL(candidate, navigationBase);
    if (parsed.origin !== navigationBase) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
