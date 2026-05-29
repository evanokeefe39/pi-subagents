import type { InvokeRequest, InvokeResponse, StatusResponse, ResultResponse } from "./types.ts";

export async function invoke(baseUrl: string, request: InvokeRequest): Promise<InvokeResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<InvokeResponse>;
}

export async function getStatus(baseUrl: string, runId: string): Promise<StatusResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/status/${encodeURIComponent(runId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<StatusResponse>;
}

export async function getResult(baseUrl: string, runId: string): Promise<ResultResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/result/${encodeURIComponent(runId)}`;
  const res = await fetch(url);
  if (res.status === 409) throw new Error(`Run ${runId} still in progress`);
  if (res.status === 404) throw new Error(`Run ${runId} not found`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<ResultResponse>;
}
