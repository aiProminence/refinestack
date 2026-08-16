import "server-only";

import { randomUUID } from "node:crypto";
import type { ApiErrorBody } from "@/types/contracts";

export function requestId(request: Request) {
  const incoming = request.headers.get("x-request-id");
  return incoming && /^[a-zA-Z0-9._:-]{8,128}$/.test(incoming) ? incoming : randomUUID();
}

export function apiError(status: number, code: string, message: string, id: string, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message, requestId: id, ...(details === undefined ? {} : { details }) } };
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Request-Id": id },
  });
}

export function apiSuccess<T>(data: T, id: string, status = 200) {
  return Response.json({ data, requestId: id }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Request-Id": id },
  });
}

export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

export function apiResponse(response: Response, id: string) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Request-Id", id);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
