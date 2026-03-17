let _defaultTimeout = 120_000; // 2 minutes
let _flexTimeout = 600_000; // 10 minutes

export function setDefaultTimeout(ms: number): void {
  _defaultTimeout = ms;
}

export function getDefaultTimeout(): number {
  return _defaultTimeout;
}

export function setFlexTimeout(ms: number): void {
  _flexTimeout = ms;
}

export function getFlexTimeout(): number {
  return _flexTimeout;
}

export function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const ms = timeoutMs ?? _defaultTimeout;
  const signal = AbortSignal.timeout(ms);
  if (init?.signal) {
    const combined = AbortSignal.any([signal, init.signal]);
    return fetch(url, { ...init, signal: combined });
  }
  return fetch(url, { ...init, signal });
}
