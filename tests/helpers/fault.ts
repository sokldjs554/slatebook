import type { Pool } from 'pg';

/**
 * 풀을 감싸서, SQL 이 matcher 에 맞는 쿼리를 times 번 실패시킨다 (DB 장애·프로세스 중단 시뮬레이션).
 * 트랜잭션 안에서 실패하면 호출한 withTx 가 ROLLBACK 하므로 "그 지점에서 서버가 죽은 것"과 같은 상태가 된다.
 */
export function injectFault(pool: Pool, matcher: RegExp, times = 1): Pool {
  let remaining = times;
  const bind = <T extends object>(target: T, prop: string | symbol) => {
    const v = Reflect.get(target, prop, target);
    return typeof v === 'function' ? v.bind(target) : v;
  };
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'connect') return bind(target, prop);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(c, p) {
            if (p !== 'query') return bind(c, p);
            return (...args: unknown[]) => {
              const first = args[0] as string | { text: string };
              const sql = typeof first === 'string' ? first : first.text;
              if (remaining > 0 && matcher.test(sql)) {
                remaining -= 1;
                return Promise.reject(new Error('injected fault'));
              }
              return (c.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      };
    },
  });
}
