# Slatebook 공개 데모 이미지 — PostgreSQL 16 + Node 22 + Next.js 를 한 컨테이너에 담는다 (deploy/render-demo/start.sh 참고).
# 가짜 PG · 데모 인증으로 동작하는 시연용이다. 실제 결제·실제 로그인이 아니다.
FROM postgres:16-bookworm

ARG NODE_MAJOR=22
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# NEXT_PUBLIC_* 값은 빌드 시점에 화면 코드에 박힌다
ENV NEXT_PUBLIC_PAYMENT_MODE=fake
RUN npm run build

# 프로덕션 모드에서 가짜 PG·데모 인증은 명시적으로 허용해야 기동한다 (실수로 실서비스에 올라가는 것을 막는 안전장치)
ENV NODE_ENV=production \
    PAYMENT_GATEWAY=fake \
    DEMO_AUTH=1 \
    ALLOW_FAKE_GATEWAY=1 \
    ALLOW_DEMO_AUTH=1 \
    RUN_JOBS_IN_PROCESS=1 \
    LOG_LEVEL=info \
    PGBIN=/usr/lib/postgresql/16/bin \
    PGDATA=/var/lib/postgresql/data \
    PORT=3000

EXPOSE 3000
# postgres 이미지의 기본 entrypoint 를 쓰지 않는다
ENTRYPOINT []
CMD ["bash", "deploy/render-demo/start.sh"]
