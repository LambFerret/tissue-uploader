# 확정한 운영 구성

**Workers + R2 Standard + D1**. EC2·NAS는 이번 배포에 사용하지 않습니다. 계정 연결·실행은 [DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md)를 참고하세요.

Workers는 웹·API·인증, R2는 비공개 원본·썸네일, D1은 사진 정보·세션·누적 통계·사용량 캐시를 담당합니다. 썸네일과 ZIP용 CRC는 브라우저에서 계산하고 ZIP은 100장씩 스트리밍합니다.

2026-09-09 확인: R2 Standard에는 10GB-month, Class A 100만 회, Class B 1,000만 회가 무료 범위로 포함됩니다. 저장 초과분은 $0.015/GB-month, 인터넷 전송료는 무료입니다. [R2 요금](https://developers.cloudflare.com/r2/pricing/)

| 평균 원본 크기 | 1만 장 원본 | 5만 장 원본 | 1만 장 저장비/월 | 5만 장 저장비/월 |
|---|---:|---:|---:|---:|
| 1.9MB | 19GB | 95GB | 약 $0.14 | 약 $1.28 |
| 2MB | 20GB | 100GB | 약 $0.15 | 약 $1.35 |
| 5MB | 50GB | 250GB | 약 $0.60 | 약 $3.60 |

십진수 기준으로 원본을 한 달 내내 보관한 추정치입니다. 썸네일·백업·요청 초과분·세금은 별도입니다. 최대 크기 사진 5만 장은 이 표보다 훨씬 큽니다.

Workers Free는 10만 요청/일·요청당 CPU 10ms, D1 Free는 500만 행 읽기/일·10만 행 쓰기/일·계정 저장량 5GB입니다. 무료 실행 한도 초과 시 요청이 실패할 수 있으며 앱이 자동 유료 전환하지 않습니다. 실제 운영 CPU 사용량은 배포 후 확인해야 합니다. [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/)

관리자 자동 폴링은 껐습니다. 전체 통계는 누적값을 사용하고 요청 통계는 15분마다 수집합니다. R2 요청량은 달력 월초가 아닌 계정 청구 주기에 맞춥니다. [청구 사용량 집계](https://developers.cloudflare.com/billing/manage/billable-usage/)
