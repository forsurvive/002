# Migration 계획과 위험

> 상태: **초안 v1 (2026-10-04)**. 두 가지 이동을 다룬다 — ① **코드**(개인판 → Core + 어댑터, 기능 그대로) ② **데이터**(프로젝트 JSON → PostgreSQL).
> 어느 쪽도 «한 번에 갈아엎기»가 아니다. 단계마다 기존 시험 676(+새 시험)이 통과해야 다음으로 간다.

## 1. 코드 이동 — 목 졸라 바꾸기(strangler) 방식

| 단계 | 하는 일 | 개인판 동작 | 확인 |
|---|---|---|---|
| A. 기준선 | 원본 이력 보존 · 시험 676/0 기록 · 설계 문서 · CLAUDE.md | 그대로 | `node tools/test.mjs` |
| B. 호스팅 준비(1차 구현) | 포트/호스트/허용 호스트/스테이징 열쇠 — **기본값은 지금과 같음** | 그대로(127.0.0.1:8801) | 기존 시험 + 새 시험 |
| C. Core 추출 | `model`·`assemble`·`engine` 순수 부분·`agents` 를 `core/` 로 **옮기고**, `tools/*.mjs` 는 다시 내보내는 껍데기로 | 그대로 | 기존 시험(소스 무늬 검사의 경로만 갱신) + Core 단위 시험 |
| D. 포트 도입 | `ProjectStore`·`Generator`·`JobContext`·`RunRecorder` 를 주입받게. `newId`·`bookText`·env 읽기를 바깥으로 | 그대로 | 시험에서 가짜 포트로 Core 를 돈다 |
| E. 작업 종류 표 | `jobs.start(pid, { kind, params })` + `JOB_KINDS` — 개인판 실행기도 이 표를 쓴다 | 그대로 | 작업 시험(일시중지·한도 물음·삭제) |
| F. Provider | `LocalClaudeCliProvider`(지금 call.mjs) → 이어서 Anthropic/OpenAI/Gemini | 그대로(CLI) | 어댑터 계약 시험(가짜 HTTP) |
| G. 온라인 앱 | `online/server.mjs`·`worker.mjs`·Postgres 저장 · 인증 | 영향 없음 | 통합 시험(DB) |

규칙:
- **옮기기와 바꾸기를 한 커밋에 섞지 않는다.** 옮기는 커밋은 의미가 같아야 하고 시험이 그 증거다.
- 시험이 소스 무늬(정규식)로 지키는 규칙은 옮긴 뒤에도 **같은 규칙을 새 자리에서** 지키게 고친다(지우지 않는다).
- 폰 동반 프로그램이 기대는 개인판 API(127.0.0.1:8801 · op 이름 · 응답 꼴)는 바꾸지 않는다.

## 2. 데이터 이동 — JSON → PostgreSQL

### 2-1. 언제 · 누가

- 개인판 사용자가 «온라인으로 옮기기»를 고를 때(Phase 9 의 export/import 와 같은 길). **자동으로 올리지 않는다** — 원고는 사용자 PC 의 개인 자료다.
- 형식: `story-project` 묶음(명세 §40) = `project.json`(지금 파일 그대로) + `manifest.json`(판·도구 버전·해시). 첫 판은 JSON 하나로 충분하다.
  → 구현(2026-10-05, `tools/bundle.mjs`): 한 JSON `{format:'story-project', version:1, exportedAt, sha256, project}`. 두 판 모두 설정 탭 «작품 파일 내려받기» · 작업실 «작품 파일 가져오기».
- 가져오기는 **새 프로젝트를 만든다**(덮어쓰지 않는다). 실패하면 트랜잭션 전체를 되돌린다.

### 2-2. 변환 절차

1. 읽기: `store.loadProject` 와 같은 보정(빠진 칸 채우기, 옛 모델 값 정리) + `model.materialsToDocs`(옛 `p.materials` → «자료» 카테고리 문서).
2. id 다시 매기기: 모든 행에 새 uuid, 옛 id 는 `legacy_id`. `refIds`/`targetIds`/`agentIds`/`parentId`/`headId`/`categoryId`/`orphanFrom`/휴지통의 `memberIds` 를 **매핑표로 바꿔 쓴다**.
3. 문서와 판: `versions[]`(직전 판들, `at` 순) → `document_versions` seq 1..n-1, **현재 본문 → seq n**(`source='import'`) → `current_version_id`.
   휴지통을 지나 «본문이 마른 판»(`chars` 만 있음)은 판으로 만들지 않고 `audit`/manifest 에 «몇 판이 있었음»만 남긴다.
4. 참조: `refIds`·`targetIds` → `document_links`(sort_order = 배열 순서, `pinned_version_id = NULL`). **가리키는 문서가 없으면(이미 영구 삭제) 버리고 보고서에 적는다.**
5. 확정본: `isFinal` → `is_final`(`finalized_at` 은 알 수 없음 → NULL).
6. 스레드: `messages[]` 그대로(가지 구조 보존), `headId` 매핑.
7. 휴지통: `trash[]` 의 문서·스레드 payload → 해당 표에 `deleted_at = at` 으로 넣는다. 카테고리 항목 → `categories.deleted_at` + 남아 있는 문서의 `orphan_from_category_id`.
8. 에이전트·프롬프트: `crew[]` → `agents(scope='project')`, `prompts{}` → `project_prompt_layers(override)`, `agents{}` → `(generated)` + `projects.agent_kind`.
9. 모델: `opus`/`sonnet`/`fable`(CLI 별칭) → `model_policy = { provider:'anthropic', alias }` 로 **그대로 보존**하고, 온라인에서 쓸 tier 는 운영자가 정한 대응표로 해석한다.
10. 작업: 끝난 것만(선택) 역사로. `running`/`paused` 는 이미 거짓이므로 `cancelled`.
11. `data/auth.json`: **가져오지 않는다**. 키는 사용자가 온라인에서 다시 연결한다(평문 키를 서버로 옮기지 않기 위해).
12. 검증: 문서 수·판 수·참조 수·스레드 메시지 수·확정본 수가 원본과 맞는지, 본문 sha256 이 같은지 → 보고서를 사용자에게 보여 준다.

### 2-3. 되돌리기

- 가져오기는 새 프로젝트만 만들므로 «되돌리기 = 그 프로젝트 지우기». 원본 JSON 은 사용자 PC 에 그대로 있다.
- 스키마 마이그레이션(`migrations/*.sql`)은 **앞으로만** 간다. 파괴적 변경(열 삭제·데이터 삭제)은 두 단계(먼저 안 쓰게 → 다음 판에서 지우기)로 하고, **production 에 거는 파괴적 마이그레이션은 사람의 명시적 승인**을 받는다(사용자 개입 규칙).

## 3. Migration 위험 (명세 요청 12번)

| # | 위험 | 영향 | 줄이는 법 |
|---|---|---|---|
| 1 | **판 모형이 다르다** — 지금은 «직전 판» 배열 + 현재 본문, 20개 상한으로 오래된 판이 이미 사라졌고 번호(index)가 밀린다 | 옛 생성 결과가 어느 판을 보았는지 되살릴 수 없다 | 가져온 판은 `source='import'`. 옛 생성 기록은 «없음»으로 둔다(지어내지 않는다). 온라인부터 기록 |
| 2 | **id 가 전역 유일이 아니다**(epoch+순번+난수, 설치마다 따로) · 메시지와 에이전트가 같은 접두어 `g_` | 두 PC 의 프로젝트를 들이면 충돌 가능 | 새 uuid + `legacy_id`, 프로젝트 안에서만 매핑 |
| 3 | **끊긴 참조** — 지운(영구 삭제) 문서를 가리키는 `refIds` 가 남아 있다(지금은 조용히 건너뜀) | FK 위반 | 가져오기 때 걸러 내고 보고서에 적음 |
| 4 | 휴지통 문서의 판 본문이 말라 있다(`lighten`) | 판 이력 일부 손실(이미 손실됨) | 판 수만 기록 |
| 5 | 작법서(`src`) 문서 — 본문이 프로젝트 밖(`tools/books/*.txt`, 지금 비어 있음) | 가리킬 글이 없다 | `src` 만 보존, 본문 없음 표시. 온라인 작법서는 문서/파일로 별도 |
| 6 | 모델 별칭(`opus`·`sonnet`·`fable`)이 CLI 이름이다 | 온라인 provider/tier 와 1:1 이 아님 | 원래 값 보존 + 운영자 대응표 |
| 7 | **단일 쓰기 가정** — 지금은 한 프로세스가 차례로 쓴다. DB 는 동시에 쓴다 | 두 탭/두 사람이 같은 문서를 고치면 나중 것이 앞 것을 덮음 | `row_version` 낙관적 잠금 + 409 + 화면 안내 |
| 8 | 상태 조회가 **모든 판 본문**을 1.5초마다 싣는다 | 온라인 대역폭·DB 부하 | 판 본문은 펼칠 때만, ETag, 작업만 보는 길(API §2-4) |
| 9 | 시각이 epoch ms 숫자 | 시간대 혼동 | `timestamptz`(UTC), 화면은 로컬 시간 |
| 10 | 문자열이 크다(자료·본문 수십만 자) · 요청 본문 상한 없음 | DB 행/요청 크기, 메모리 | 상한 설정(온라인 요청 본문 상한, 자료는 파일 업로드 경로로), TOAST |
| 11 | 확정본 의미 — **참조/대상으로 고른 것만** 최우선 사실로 승격(S02 만 전체) | 온라인에서 «모든 확정본 자동 포함»으로 바꾸면 결과가 달라짐 | 지금 규칙을 Core 에 그대로 옮기고 시험으로 못박음 |
| 12 | 작업 기록의 상태 이름(`stopped`) ≠ 온라인(`cancelled`) | 화면 문구 어긋남 | 표시층에서 대응 |
| 13 | CLI 전용 개념(구독 한도 `rate_limit_event` · `apiKeySource` · «API 로 갈아타기») | API provider 에는 없음 | 한도 물음은 `waiting_for_user` 로 일반화, 갈아타기는 개인판만 |
| 14 | 프롬프트 캐시 효과가 달라진다(CLI 는 자동으로 잘 물림) | 온라인 비용 증가 | 어댑터에서 캐시 지점 지정, usage 의 캐시 칸으로 측정 |
| 15 | **소스 무늬 시험**이 파일 위치·문자열에 기대 있다 | 리팩터링 때 시험이 깨지거나, 고치다 보호가 약해짐 | 옮길 때 같은 규칙을 새 자리에서 검사, 줄이지 않음 |
| 16 | 폰 동반 프로그램이 개인판 API 에 기대 있다 | 개인판 API 를 바꾸면 폰이 깨짐 | 개인판 op 표·응답 꼴 고정(온라인은 별도 앱) |
| 17 | 원고는 개인 자료 · 학생 자료는 미성년자 자료일 수 있다 | 법·정책 위험 | 자동 업로드 금지 · 보존/삭제 정책은 **사람이 결정**(SECURITY §7) |
| 18 | 파일 저장소 가정 — 호스팅 플랫폼의 디스크는 배포 때 초기화된다 | 1차 스테이징(JSON 저장)의 데이터가 재배포 때 사라짐 | 스테이징은 시험 데이터만 · 시작 시 경고 출력 · Phase 3 에서 DB 로 |
| 19 | 인코딩/줄 끝(CRLF·LF), 한글 경로 | 가져오기 실패 | JSON 은 UTF-8, 줄 끝 정규화(`\r\n`→`\n`)는 판 본문 해시 전에만 |
| 20 | 비소설 «즉석 에이전트»(`p.agents`)는 프로젝트마다 지어진 프롬프트다 | 버전 추적 대상이 늘어남 | `project_prompt_layers.checksum` 을 run 에 기록 |
