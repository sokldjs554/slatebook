'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { MAX_RATING, MIN_RATING, REVIEW_MAX_BODY } from '@/shared/rating';
import type { ReviewView } from '@/shared/schemas';

/** 이용 완료된 예약의 후기 작성 폼. 같은 후기가 두 번 등록되지 않도록 제출 중에는 버튼을 잠근다 (서버도 예약당 1건을 강제한다). */
export function ReviewForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    if (rating < MIN_RATING) {
      setError('별점을 선택해 주세요.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await api<ReviewView>(`/api/bookings/${bookingId}/review`, { method: 'POST', body: { rating, ...(body.trim() ? { body } : {}) } });
    inFlight.current = false;
    setBusy(false);
    if (r.ok || r.code === 'REVIEW_EXISTS') {
      onDone(); // 이미 등록돼 있어도(다른 탭·재시도) 결과는 같다 → 예약 상태를 다시 읽어 내 후기를 보여준다
      return;
    }
    setError(
      r.code === 'NETWORK'
        ? '네트워크가 불안정해요. 다시 눌러 주세요. (같은 후기가 두 번 등록되지 않아요)'
        : r.code === 'UNAUTHORIZED'
          ? '화면 위쪽에서 데모 사용자를 선택해 주세요.'
          : r.message,
    );
  }

  return (
    <form onSubmit={submit} className="card stack" aria-label="후기 작성">
      <h2 style={{ margin: 0 }}>이용 후기를 남겨 주세요</h2>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="muted" style={{ fontSize: 14, marginBottom: 4 }}>별점</legend>
        <div role="radiogroup" aria-label="별점" style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: MAX_RATING }, (_, i) => i + 1).map((n) => (
            <label key={n} style={{ margin: 0, cursor: 'pointer', fontSize: 28, lineHeight: 1, color: n <= rating ? 'var(--warn)' : 'var(--line)' }}>
              <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} aria-label={`${n}점`} />
              ★
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="review-body">한줄 후기 (선택)</label>
        <textarea
          id="review-body"
          value={body}
          maxLength={REVIEW_MAX_BODY}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', font: 'inherit', color: 'var(--ink)', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8 }}
        />
        <div className="muted" style={{ fontSize: 12, textAlign: 'right' }}>{body.length} / {REVIEW_MAX_BODY}</div>
      </div>
      {error && <p className="notice bad" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? (<><span className="spinner" />등록 중…</>) : '후기 등록'}</button>
    </form>
  );
}
