// Supabase 1000행 제한을 넘는 전체 조회 공용 루프 — 클라이언트/서버 겸용 (next 의존 없음).
// 서버 전용 lib/api-helpers.ts 의 fetchAllRows 와 같은 역할이며, 클라 훅에서는 이쪽을 쓴다.

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * buildQuery(from, to) 가 만든 range 쿼리를 페이지가 가득 차는 동안 반복 실행해 전부 모은다.
 * 오류가 나면 그때까지 모은 행과 함께 error 메시지를 반환한다.
 */
export async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) return { rows, error: error.message };
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return { rows, error: null };
    from += pageSize;
  }
}
