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
| Sprint 1 — Replit 에서 지금 판 실행 | 완료. [Run] 은 `online/start.mjs` — 데이터베이스가 있으면 온라인판, 없으면 개인판. 처음 설정 화면 · 자동 npm ci · 마스터 키 파일 대체 · 모델 표(`config/models.json`) 포함(REPLIT_DEPLOYMENT §4-1 — 사람이 할 일 셋) |
| Sprint 2 — Core 분리 | 완료(에이전트 준비는 Provider 단계에서): ① `model`·`assemble`·id 를 `core/` 로 옮김 · ② `planCall()` 추출(프롬프트 옮기기 전후 동일 확인) · ③ 생성 실행을 `core/generation` 으로(저장·호출을 넣어 받음, 시험 750/0) · ④ 작업 = 종류 + 매개변수(`core/generation/kinds.mjs`, 시험 760/0) |
| Sprint 3~5 · 11 일부 — AI Provider · 카탈로그 · credential | 코드 완료: 계약(`ai/provider.mjs`) · CLI 어댑터(`ai/local-cli.mjs`) · 모든 호출이 `engine.callModel` 한 자리를 지남 · Anthropic · OpenAI · Gemini 어댑터(`ai/anthropic.mjs` · `ai/openai.mjs` · `ai/gemini.mjs`, 공식 명세 확인 후 가짜 API 로 시험, 시험 813/0) · 모델 카탈로그(`ai/catalog.mjs` + `config/models.example.json`) · 자격증명 봉인/해석(`ai/credentials.mjs`) · Provider 라우터(`ai/router.mjs`, 시험 837/0) → 남은 것: 실제 키 연기 시험 · 앱 연결(온라인 서버 · DB 와 함께) |
| Sprint 6~8 — PostgreSQL · 인증 · 개인 프로젝트 온라인 저장 | 진행 중: 첫 스키마(`migrations/001_initial_schema.sql`) · 마이그레이션 실행기 · 앱 계정/세션(`online/auth.mjs`) · 실제 PostgreSQL 시험(`online/test.mjs`, CI 에도) · 프로젝트 저장소(`online/store.mjs` + `migrations/002_aggregate_ids_trash.sql` — 표에서 Core 덩어리를 짓고 바뀐 행만 한 트랜잭션으로 씀, Core 연산 왕복 시험 105/0) · 온라인 서버(`online/server.mjs` — 로그인 · 프로젝트 소유 검사 404 · 개인판과 한 벌의 문 표 `tools/ops.mjs` · 로그인 화면 · 운영자 계정 발급 `online/admin.mjs`, 온라인 시험 158/0, 브라우저 확인) · 개인판 JSON 가져오기(`online/import.mjs` — 다시 지어 견준 보고서 · 끊긴 참조 걸러 내기 · 못 옮기는 꼴이면 아무것도 쓰지 않음, 온라인 시험 174/0) → 다음: Sprint 9 |
| Sprint 9 — 영속 작업 · worker | 완료(파일럿 꼴): 작업 큐(`online/jobs.mjs` — 대상당 활성 하나 · 멱등 키 · SKIP LOCKED · lease/heartbeat · 울타리 · 회수 · 갈래별 재시도 · 기관 동시 상한) · worker(`online/worker.mjs` — Core 작업 표 그대로 · 다음 호출 앞 일시중지 · 취소 시 호출 끊기 · 키 없음은 «AI 연결 필요») · 부르기(`online/call.mjs` — 생성 기록 + 참조 판 스냅샷) · 자격증명 PostgreSQL 저장 · 운영자 키 등록, 온라인 시험 271/0 → 에이전트 준비도 온라인에서(Core 로 옮김) · 합평 패널 체크포인트 · 남은 것: 실제 키 연기 시험 |
| Sprint 10~12 — 기관 · 수업 · 라이선스 · 기관 키 | 서버 완료: `migrations/004_education.sql` · 접근 판정 한 곳(`online/tenancy.mjs` — 주인 / 맡은 수업 강사 읽기 / 정책이 허락한 기관 관리자 읽기 / 나머지 «없음») · 라이선스는 AI 작업 등록 때와 worker 실행 직전 두 번 · 기관 일(`online/edu.mjs`, `POST /api/edu` — 기관 · 라이선스 · 수업 · 초대 코드(해시만 저장 · 1회용 경쟁 안전 · 맞히기 고삐) · 학생 자리 상한 · 수업 현황(비용 칸 없음) · 기관 키 쓰기 전용 · 감사 로그), 온라인 시험 392/0 · 화면(`web/school.html` «기관 · 수업» — 초대 코드로 들어오기(새 계정) · 내 수업 · 수업에 새 작품 · 수업 현황 · 초대 코드 만들기 · 기관 키 · 열람 정책 · 운영자의 기관/이용 기간, 강사 열람은 «읽기만» 표시) → 남은 것: 사용량 장부 · DB RLS(2차 격리) |
