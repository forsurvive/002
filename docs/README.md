# 설계 문서 — 온라인 개인판 · 교육기관판으로 넓히기

개인판(로컬)은 그대로 제품이고, 이 문서들은 그것을 **하나의 Core 위에 온라인 개인판과 교육기관판**으로 넓히는 계획이다.
근거는 «스토리 엔진 통합 개선·개발 명세서 v5/v6»(이하 명세). 첫 판은 완벽하지 않다 — 구현하면서 고친다(명세 부록 AY).

| 문서 | 내용 |
|---|---|
| [ARCHITECTURE_CURRENT.md](ARCHITECTURE_CURRENT.md) | 지금 개인판: 디렉터리 · 실행 · 모듈 분류(유지/추출/수정/대체) · 데이터 구조 · API 요약 · AI 호출 흐름 · 작업 · 한계 |
| [ARCHITECTURE_TARGET.md](ARCHITECTURE_TARGET.md) | Core / Platform / UI · 디렉터리 계획 · **Core 추출안(함수 단위)** · 포트 · 온라인 실행 구조 · Policy Resolver · 워크플로우 · 교육 UX · 기술 선택 · 단계 계획 |
| [ERD.md](ERD.md) | PostgreSQL 데이터 모델 초안 · 판/참조/생성 기록 · 색인 · 테넌트 격리 · JSON 대응 |
| [API.md](API.md) | 지금 API 전체(op 42개) · 온라인 v1 제안 |
| [AI_PROVIDER.md](AI_PROVIDER.md) | Provider 계약 · Anthropic/OpenAI/Gemini 대응 · 오류 정규화 · tier 카탈로그 · credential 해석 · 비용 기록 |
| [JOB_SYSTEM.md](JOB_SYSTEM.md) | 작업 = 데이터 · 상태 기계 · claim/lease/울타리 · 재시도 · 체크포인트 · 동시성 · DB 를 깨우지 않는 대기 |
| [MIGRATION.md](MIGRATION.md) | 코드 이동(strangler) · JSON → DB 이동 절차 · **migration 위험 20가지** |
| [REPLIT_DEPLOYMENT.md](REPLIT_DEPLOYMENT.md) | Replit 배포 구조 · 환경 변수 · Sprint 1 사용자 절차 · 비용 감 · 막힐 때 · 미확인 목록 |
| [SECURITY.md](SECURITY.md) | 위협 모델 · 지금 있는 것 · 인증 · 권한 매트릭스 · credential 암호화 · **사람이 정할 정책** |
| [TEST_PLAN.md](TEST_PLAN.md) | 시험 돌리는 법 · 규칙 · 지금 있는 것 · 단계별로 더할 시험 |

## 진행 상태 (2026-10-04)

| 단계 | 상태 |
|---|---|
| Sprint 0 — 분석 · 기준선 | 완료: 원본 이력 37커밋 보존, 시험 676/0, 이 문서들, 루트 `CLAUDE.md` |
| Sprint 1 — Replit 에서 지금 판 실행 | 코드 준비 완료(`tools/hosting.mjs`, `.replit`, 시험 725/0). **Replit 가져오기·게시는 사용자 계정 필요** |
| Sprint 2 — Core 분리 | 다음 |
