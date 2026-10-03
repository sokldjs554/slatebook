'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ReviewListResponse, ReviewView } from '@/shared/schemas';
import { Stars } from './Stars';

const PAGE = 5;

/** 상품의 후기 목록. 커서 방식으로 이어 읽고, 늦게 도착한 이전 응답이 화면을 덮어쓰지 않게 한다. */
export function ReviewList({ listingId }: { listingId: string }) {
  const [summary, setSummary] = useState<ReviewListResponse['summary'] | null>(null);
  const [items, setItems] = useState<ReviewView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [more, setMore] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    async (next: string | null) => {
      const gen = generation.current;
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (next) qs.set('cursor', next);
      const r = await api<ReviewListResponse>(`/api/listings/${listingId}/reviews?${qs}`);
      if (gen !== generation.current) return; // 그 사이 다른 상품·새로고침이 있었다
      if (!r.ok) {
        setState('error');
        setMore(false);
        return;
      }
      setSummary(r.data.summary);
      // 이어 읽는 동안 새 후기가 생겨도 같은 후기가 두 번 보이지 않게 id 로 합친다
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...r.data.reviews.filter((x) => !seen.has(x.id))];
      });
      setCursor(r.data.nextCursor);
      setState('ready');
      setMore(false);
    },
    [listingId],
  );

  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setCursor(null);
    setSummary(null);
    setState('loading');
    void load(null);
  }, [load]);

  return (
    <section aria-label="이용 후기" className="card stack">
      <h2 style={{ margin: 0 }}>
        이용 후기{' '}
        {summary && summary.count > 0 && summary.average !== null && (
          <span style={{ fontWeight: 400, fontSize: 15 }}>
            <Stars rating={summary.average} /> <strong>{summary.average.toFixed(1)}</strong> <span className="muted">({summary.count}개)</span>
          </span>
        )}
      </h2>
      {state === 'loading' && <p className="muted"><span className="spinner" />불러오는 중…</p>}
      {state === 'error' && <p className="notice bad">후기를 불러오지 못했어요. <button type="button" className="secondary" onClick={() => { setState('loading'); void load(cursor); }}>다시 시도</button></p>}
      {state === 'ready' && items.length === 0 && <p className="muted">아직 후기가 없어요. 첫 후기를 기다리고 있어요.</p>}
      {items.map((r) => (
        <article key={r.id} className="kv" style={{ display: 'block' }}>
          <div><Stars rating={r.rating} /> <strong>{r.authorName}</strong> <span className="muted" style={{ fontSize: 12 }}>{r.createdAt.slice(0, 10)}</span></div>
          {/* 사용자 입력은 텍스트로만 출력한다 (React 가 이스케이프). 줄바꿈만 살린다. */}
          {r.body && <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.body}</p>}
        </article>
      ))}
      {cursor && (
        <button type="button" className="secondary" disabled={more} onClick={() => { setMore(true); void load(cursor); }}>
          {more ? '불러오는 중…' : '후기 더 보기'}
        </button>
      )}
    </section>
  );
}
