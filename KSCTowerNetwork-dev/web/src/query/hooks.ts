/**
 * Thin TanStack Query adapters over our existing `apiFetch` wrapper.
 *
 * Why an adapter instead of using `useQuery` raw:
 *  - `apiFetch` returns a tagged union (`{ ok, data } | { ok, status, message, body }`)
 *    so all error metadata is preserved. TanStack Query expects the fetcher to
 *    THROW on failure, so we translate here once instead of in every call site.
 *  - Surfaces the original HTTP status / message / body via a dedicated
 *    `ApiError` class so consumers can branch on status (e.g. ChatDesk shows
 *    a friendlier 404 than 500).
 *  - Recognises "API unreachable" (no HTTP response) and skips the retry.
 *    Hammering a dead backend is pointless and floods the console.
 *  - Forwards TanStack's abort `signal` into `fetch` so invalidated pollers
 *    cancel in-flight requests instead of stacking them.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
  type UseMutationOptions,
  type UseQueryOptions
} from "@tanstack/react-query";
import { apiFetch } from "../api/client";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly unreachable: boolean;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.unreachable = status === 0;
  }
}

/** Run apiFetch and translate the tagged-union into a plain promise (throws ApiError on failure). */
export async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch<T>(path, init ?? {});
  if (!r.ok) {
    throw new ApiError(r.status, r.message, r.body);
  }
  return r.data;
}

/**
 * Sugar for the most common query pattern: GET a `path` and type the response.
 *
 * `path` and `queryFn` are mutually optional — supply `path` for the common
 * GET-and-decode case, OR supply `queryFn` directly for callers that need to
 * compose multiple requests / handle binary responses (e.g. world-maps and
 * world-inventory clients have their own fetch wrappers).
 *
 * Same options surface as `useQuery`: pass `refetchInterval` for polled
 * queries, `enabled: false` to defer until a dependency is ready, etc.
 */
export function useApiQuery<TData>(
  options: Omit<UseQueryOptions<TData, ApiError>, "queryFn"> & {
    path?: string;
    queryFn?: UseQueryOptions<TData, ApiError>["queryFn"];
  }
) {
  const { path, queryFn, ...rest } = options;
  if (!queryFn && !path) {
    throw new Error("useApiQuery requires either `path` or `queryFn`");
  }
  return useQuery<TData, ApiError>({
    ...rest,
    queryFn:
      queryFn ??
      ((ctx: QueryFunctionContext<readonly unknown[]>) =>
        apiCall<TData>(path as string, { signal: ctx.signal })),
    // Retrying when the API is unreachable (status 0) is pointless — it just
    // re-fails immediately. Keep retries for genuine 5xx blips.
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.unreachable) return false;
      const max = typeof rest.retry === "number" ? rest.retry : 1;
      return failureCount < max;
    }
  });
}

/**
 * Sugar for mutations: a function that takes the variables and returns the
 * result, optionally with an `invalidate` list of query keys to mark stale on
 * success (so e.g. send-message instantly refreshes the messages list).
 *
 * Pass plain `onSuccess` etc to add behavior — `invalidate` is just a shortcut
 * for the most common "this mutation makes some queries stale" pattern.
 */
export function useApiMutation<TData, TVars>(
  options: UseMutationOptions<TData, ApiError, TVars> & {
    invalidate?: ReadonlyArray<readonly unknown[]>;
  }
) {
  const { invalidate, onSuccess, ...rest } = options;
  const qc = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    ...rest,
    // Forward all positional args (TanStack v5's onSuccess signature has
    // four parameters) so callers always see the canonical context shape.
    // Await invalidations + caller hook so async handlers (e.g. await refetch
    // before navigate) finish before the mutation settles — avoids route-guard races.
    onSuccess: async (...args: Parameters<NonNullable<typeof onSuccess>>) => {
      if (invalidate?.length) {
        await Promise.all(
          invalidate.map((key) => qc.invalidateQueries({ queryKey: key as unknown[] }))
        );
      }
      await Promise.resolve(onSuccess?.(...args) as unknown);
    }
  });
}

/** Re-export so call sites only need to import from one module. */
export { useQueryClient } from "@tanstack/react-query";

/**
 * Best-effort, human-readable copy of an error from `useApiQuery` / `useApiMutation`.
 * Used by the few places that render raw error messages — most call sites should
 * route through `formatApiError` in `session/formatApiError.ts` for context-aware copy.
 */
export function describeQueryError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.unreachable) {
      return "Cannot reach the tower API. Check the backend or your network.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
