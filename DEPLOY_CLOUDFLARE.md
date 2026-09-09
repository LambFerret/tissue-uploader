# Cloudflare 배포

## 현재 상태

운영 Worker와 R2 연결 및 D1 초기화가 완료되었습니다. 아래는 새 환경을 만들거나 설정을 변경할 때의 안내입니다. 기존 로컬 사진을 자동 이전하지는 않습니다.

## R2와 전용 데이터베이스 준비

[Cloudflare 대시보드](https://dash.cloudflare.com/) → 해당 계정 → **R2 Object Storage**에서 활성화합니다. Cloudflare가 결제 수단 등록을 요구할 수 있습니다. 이 앱의 무료 한도 경고는 초과 과금을 자동 차단하지 않습니다.

```powershell
npx wrangler whoami
npx wrangler r2 bucket create tissue-uploader-photos
npx wrangler d1 create tissue-uploader
```

`wrangler.jsonc`의 `CF_ACCOUNT_ID`가 실제 계정과 일치하는지 확인하고, 생성 명령에서 출력된 D1 `database_id`를 `d1_databases[0]`에 추가합니다. 다른 앱의 데이터베이스를 재사용하지 않습니다. R2 버킷의 Public access / r2.dev는 비활성 상태로 유지합니다. 브라우저는 Worker를 통해 접근하므로 R2 CORS 설정은 필요하지 않습니다.

```powershell
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put ADMIN_PASSWORD
```

관리자 비밀번호는 명령 입력창에 넣습니다. 코드·wrangler vars·채팅에 넣지 않습니다. `.dev.vars`는 로컬 전용이며 자동 배포되지 않습니다.

## 요청량 통계 연결 (선택)

[API 토큰](https://dash.cloudflare.com/profile/api-tokens)에서 해당 계정에 한정한 **Account / Account Analytics / Read** 토큰을 만듭니다. 배포용 Wrangler OAuth 토큰을 서버 비밀값으로 재사용하지 않습니다.

```powershell
npx wrangler secret put CF_ANALYTICS_TOKEN
```

없으면 업로드·관리자 기능은 정상 사용하고 요청 통계만 `미연결`로 표시합니다. 특정 데이터셋 권한/API 오류는 해당 카드만 조회 실패로 표시하며 0으로 바꾸지 않습니다.

R2 요청량은 **계정 Billing의 청구 기간 시작 시각**을 확인하여 `wrangler.jsonc`의 `R2_BILLING_ANCHOR`에 UTC ISO 값으로 넣습니다. 예: 매월 15일 00:00 UTC이면 `2026-09-15T00:00:00Z`. 매월 같은 날짜·시각으로 계산하고 짧은 달은 말일로 보정합니다. 실제 청구 주기가 바뀌면 이 값도 갱신합니다. 값이 없으면 R2 요청 카드는 `청구 주기 미설정`으로 표시합니다.

기본 한도는 Workers Free·D1 Free·R2 Standard 기준입니다. 계정이 유료 플랜이면 무료 기준 참고선이며 실제 청구 한도가 아닙니다. 계정의 모든 유료 제품을 감시하는 도구는 아닙니다.

## 검사·배포

```powershell
npm run cf:types
npm run cf:check
npm run cf:deploy
```

출력된 `https://tissue-uploader.<계정서브도메인>.workers.dev`가 업로드 주소입니다. **그 주소의 `/admin`이 관리자 주소**입니다. 관리자 `링크 · QR`은 실제 접속 주소를 사용합니다. 자체 도메인은 Worker Settings → Domains & Routes에서 연결합니다.

Cloudflare 요청량은 최초 Cron 실행 후 집계됩니다. 다음 15분 주기 이후 관리자 ‘새로고침’을 누릅니다. Cloudflare 자체 집계 지연으로 더 늦을 수 있습니다. 사진 목록은 자동 폴링하지 않습니다.

## 저장·운영 동작

업데이트에 새 D1 마이그레이션 파일이 포함되면 먼저 `npx wrangler d1 migrations apply DB --remote`를 실행한 뒤 코드를 배포합니다. 관리자 삭제 기능은 `0002_admin_delete.sql`이 필요합니다. 이 마이그레이션은 삭제 기능용 테이블·트리거를 추가하며 기존 사진을 삭제하지 않습니다.

- 전용 비공개 R2 키: `originals/<UUID>`, `thumbs/<UUID>.jpg`.
- 업로드 예약 → 원본·썸네일 PUT → 완료의 세 단계. 동일 ID 재시도로 중복 사진을 막습니다.
- 미완료 업로드는 24시간 뒤 만료하며, 48시간 이상 지난 미완료 객체를 Cron이 한 번에 20건씩 정리합니다. 완성 사진은 자동 삭제하지 않습니다.
- 관리자 선택 삭제는 1~60장씩 확인 후 실행합니다. 사진 기록·기관 수·원본 용량은 한 트랜잭션에서 반영합니다. R2 원본과 썸네일 삭제가 성공해야 저장량 영수증을 줄입니다. 삭제 실패 작업은 `deletion_jobs`에 유지하고 Cron이 재시도합니다. `deleted_uploads`에는 재시도 복원을 막기 위한 ID만 남습니다.
- 앱 저장량 영수증은 원본·썸네일 저장 성공 시 증가합니다. R2 저장 직후 D1 기록 실패 구간은 재시도 또는 미완료 객체 정리 때 정합성을 회복합니다. 외부 업로드 객체·다른 버킷은 포함하지 않습니다.
- ZIP은 100장씩 분할합니다. 현재 조회 조건의 모든 페이지를 포함하며 계획 시각 이후 추가된 사진은 해당 계획에서 제외합니다.
- API 비밀값은 응답·정적 파일에 포함하지 않습니다. API 응답은 no-store, 운영 관리자 쿠키는 HttpOnly·SameSite=Strict·Secure입니다.
- 로컬 workerd 테스트와 실제 운영 CPU/Analytics 검증은 다릅니다. 배포 후 운영 요청 통계·CPU 제한을 확인해야 합니다.

## 기존 Node 데이터

`data/`와 `server.js`는 보존되어 있습니다. Cloudflare 배포가 기존 SQLite·사진을 자동 이동하지는 않습니다. 기존 자료를 옮길 때는 Node 쓰기를 중단하고 `data/` 전체를 백업한 뒤 원본·썸네일과 기존 업로드 날짜·기관명·소유자 해시·파일 크기·CRC32를 새 R2·D1 스키마에 함께 이전해야 합니다. 사진 수·해시·용량을 대조한 후 공유 링크를 전환합니다. 다른 도메인에서는 localStorage가 공유되지 않아 기존 기관명·방문자 ID가 자동 이동하지 않습니다.

## 공식 기준

- [R2 요금](https://developers.cloudflare.com/r2/pricing/)
- [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 Analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [D1 Analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [Workers Analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [청구 주기와 사용량](https://developers.cloudflare.com/billing/manage/billable-usage/)
