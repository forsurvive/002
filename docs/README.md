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
| [OPEN_EDITION.md](OPEN_EDITION.md) | 자유 가입판(개인 가입 · 본인 키 · 월 이용료 — 그로블 정기결제) — 회사별 «구독으로 돌리기» 허용 여부(출처) · 결정 · **만든 것(§4)** · 사람이 할 것(§5) |
| [EBOOK_EDITION.md](EBOOK_EDITION.md) | **전자책 특화판 개발 계획서**(2026-10-10 — 아직 계획) — 용도 축 `SE_PURPOSE` · «전자책 오토» 벤치마킹(호출 60~75 → 약 20) · 지금 구조에 얹는 법 · 원칙 8 개정안(사람 결정) · 로드맵 E0~E7 |

## 진행 상태 (2026-10-06)

| 단계 | 상태 |
|---|---|
| Sprint 0~2 — 분석 · Replit 실행 · Core 분리 | 완료 |
| Sprint 3~5 — AI Provider(Claude · ChatGPT · Gemini) · 카탈로그 · credential | 완료 · Claude 실제 키 연결 확인(2026-10-06, 워크스페이스 ID 지원) · ChatGPT · Gemini 실제 키는 운영자 확인 대기 |
| Sprint 6~8 — PostgreSQL · 인증 · 개인 작품 온라인 저장 · JSON 가져오기 | 완료 |
| Sprint 9 — 영속 작업 · worker(`npm run worker` 따로 띄우기 가능) | 완료 |
| Sprint 10~12 — 기관 · 수업 · 라이선스 · 기관 키 · 계정(초대 링크 · 운영자 직접 발급 · 재설정 코드) · 사용량(생성 기록 기준 추정) | 완료 |
| Sprint 13~14 — 워크플로우 단계 · 강의 카드 · 강사/기관 관리자/운영 화면 | 완료 |
| Phase 9 — 작품 파일 내보내기/가져오기 · 글 파일(txt/md) 자료 | 완료 · docx/pdf 자료 · 파일 저장소는 아직 |
| Sprint 15~16 — 파일럿 · production | 게시 중(Replit). 사람 검수 → 파일럿 |
| 자유 가입판(2026-10-09) — 판 스위치 `SE_EDITION` · 자유 가입 · 키 등록(클릭 몇 번 + 붙여 넣기) · 이용권(그로블 정기결제 웹훅) · 고객 · 결제 관리 화면 | 완료 · 사람: 그로블 상품 · 웹훅 시크릿 · 두 번째 Replit 앱 · 약관(OPEN_EDITION §5 · REPLIT_DEPLOYMENT §4-4) |
| 7일 환불(2026-10-10, OPEN_EDITION §4-8) — 판정 · [환불 요청](이용권 즉시 정지) · 그로블 환불 · 해지 «둘 다» 확인 | 완료 · 구글 로그인(§4-9)은 설계만 |
| 전자책 특화판(2026-10-10) | 계획서([EBOOK_EDITION.md](EBOOK_EDITION.md)) — 원칙 8 개정 등 사람 결정 8건 대기 |

2026-10-07 더한 것: 운영자 구독(AI_PROVIDER §9-1) · 바뀜 알림 SSE/NOTIFY(API.md) · docx/pdf 자료(DESIGN «자료») · 사용량 장부 · 키 고삐(AI_PROVIDER §7-1) · DB 2차 격리 RLS(ERD «격리»).
남은 것: 파일 저장소(원본 파일 보관 — 지금은 뽑은 글만 둔다, 필요해지면). 사람이 정할 것: SECURITY.md §7(개인정보 · 보존 · 미성년자 · 결제).
