import type { InfiniteData } from '@tanstack/react-query';
import { apiList, type ListEnvelope, type QueryParams, type RequestOptions } from './client.js';

/**
 * Cursor pagination helpers (F5.3 / TDS 04 §1.2).
 *
 * The cursor is **opaque**: base64 over "the stated ordering key of that resource" (the
 * UUIDv7 `id` for most collections, the per-session `ordinal` for messages). The client
 * neither parses nor constructs one — it echoes what `meta.nextCursor` handed back. Any
 * code here that looked inside a cursor would break the day a resource changed its ordering
 * key, and would earn an `INVALID_CURSOR` from the Backend for its trouble.
 */

/** F5.3: `limit` defaults to 50 and is capped at 200 server-side. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export type PageOf<T> = ListEnvelope<T>;

/** `undefined` stops `useInfiniteQuery` — `null` from the envelope means "no more pages". */
export function nextPageParam<T>(page: PageOf<T>): string | undefined {
  return page.meta.nextCursor ?? undefined;
}

/** Flatten `useInfiniteQuery` pages back into one ordered array for rendering. */
export function flattenPages<T>(data: InfiniteData<PageOf<T>> | undefined): readonly T[] {
  if (data === undefined) return [];
  return data.pages.flatMap((page) => page.data);
}

export interface CursorPageOptions {
  readonly limit?: number | undefined;
  readonly query?: QueryParams | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Fetch one cursor page. The `cursor` param is appended only when present, so the first
 * page is a plain `GET /resource?limit=n` — the shape the Backend documents.
 */
export function fetchCursorPage<T>(
  path: string,
  cursor: string | undefined,
  options: CursorPageOptions = {},
): Promise<PageOf<T>> {
  const limit = clampLimit(options.limit);
  const request: RequestOptions = {
    query: {
      ...options.query,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return apiList<T>(path, request);
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
}
