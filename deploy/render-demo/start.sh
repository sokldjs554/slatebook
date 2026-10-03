#!/usr/bin/env bash
# 데모 컨테이너 기동 스크립트: 컨테이너 안의 PostgreSQL 16 을 준비하고, 마이그레이션·데모 시드를 적용한 뒤 Next.js 를 띄운다.
#
# 한 컨테이너에 DB 까지 넣은 이유: 데모를 무료 웹 서비스 하나로 띄우기 위해서다 (관리형 DB 가 필요 없다).
# 대가: 재배포·재시작마다 데이터가 초기화되고(시드가 다시 돈다), 인스턴스는 하나만 둬야 한다 —
# 가짜 PG 의 상태가 이 프로세스의 메모리에 있기 때문이다.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PGPORT_LOCAL="${PGPORT_LOCAL:-5432}"
APP_PORT="${PORT:-3000}"
RUN_AS_POSTGRES=""
if [ "$(id -u)" = "0" ]; then RUN_AS_POSTGRES="su postgres -c"; fi
as_pg() { if [ -n "$RUN_AS_POSTGRES" ]; then $RUN_AS_POSTGRES "$*"; else bash -c "$*"; fi; }

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[start] initdb"
  mkdir -p "$PGDATA"
  [ -n "$RUN_AS_POSTGRES" ] && chown -R postgres "$PGDATA"
  as_pg "$PGBIN/initdb -D '$PGDATA' -A trust -U slatebook --encoding=UTF8 >/dev/null"
fi

# 외부에서 접근할 수 없는 루프백에서만 듣는다 (그래서 trust 인증으로 충분하다)
as_pg "$PGBIN/pg_ctl -D '$PGDATA' -o '-c listen_addresses=127.0.0.1 -p $PGPORT_LOCAL -c fsync=off' -l /tmp/postgres.log -w start" >/dev/null
as_pg "$PGBIN/psql -h 127.0.0.1 -p $PGPORT_LOCAL -U slatebook -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='slatebook'\"" | grep -q 1 \
  || as_pg "$PGBIN/createdb -h 127.0.0.1 -p $PGPORT_LOCAL -U slatebook slatebook"

export DATABASE_URL="postgres://slatebook@127.0.0.1:${PGPORT_LOCAL}/slatebook"
echo "[start] migrate + seed"
npm run --silent db:migrate
npm run --silent db:seed

echo "[start] next start :${APP_PORT}"
exec npx next start -H 0.0.0.0 -p "$APP_PORT"
