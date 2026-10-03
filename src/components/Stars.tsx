/** 별점 표시 (읽기 전용). 스크린리더에는 "평점 4점"으로 읽힌다. */
export function Stars({ rating, size = 16 }: { rating: number; size?: number }) {
  const full = Math.round(rating);
  return (
    <span role="img" aria-label={`평점 ${rating}점`} style={{ fontSize: size, letterSpacing: 1, color: 'var(--warn)' }}>
      {'★'.repeat(full)}
      <span style={{ color: 'var(--line)' }}>{'★'.repeat(5 - full)}</span>
    </span>
  );
}
