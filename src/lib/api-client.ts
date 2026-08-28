"use client";

/** Клиентская обёртка над API. Ошибки приходят в формате из src/lib/errors.ts. */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};

  const response = await fetch(url, {
    ...rest,
    headers: json ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
    body: json ? JSON.stringify(json) : rest.body,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      payload?.code ?? "INTERNAL_ERROR",
      payload?.message ?? "Запрос не удался.",
      response.status,
    );
  }

  return payload as T;
}
