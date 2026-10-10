# API — 현재 명세와 온라인판 v1 제안

> §1 은 **기준선의 실제 동작**(코드에서 읽음, `tools/server.mjs`). §2 는 온라인판 제안 — 구현하면서 고친다.

## 1. 현재 API (개인판, 127.0.0.1:8801)

### 1-1. 길

| 메서드 · 경로 | 하는 일 | 응답 |
|---|---|---|
| `POST /api` | 본문 `{ op, pid?, … }` 를 op 표로 넘긴다 | `200 { ok:true, … }` / `200 { ok:false, error }` · op 없음 `400` · 모르는 op `404` |
| `GET /api/state` | 프로젝트 목록 | `{ ok, projects:[{ id, name, updatedAt, createdAt }] }` |
| `GET /api/state?pid=` | 프로젝트 전체 상태(아래 1-3) + 목록 | `{ ok, project, projects }` · 없으면 `{ ok:false, error:'없음' }` |
| `GET /api/download?pid=&kind=doc\|cat\|thread&id=` | 마크다운 첨부(`text/markdown`, `content-disposition` UTF-8 이름) | 본문 · 없으면 `404` |
| `GET /…` | `web/` 정적 파일(`/` = index.html) | |
| `GET /healthz` | (1차 구현에서 더함) 살아 있는지 | `200 ok` — 출입 열쇠·호스트 검사를 거치지 않는다 |

문지기(모든 길 앞, [SECURITY.md](SECURITY.md) §2): Host 허용 목록 · `POST /api` 는 `application/json` 만(`415`) · Origin 은 같은 자리만(`403`).
1차 구현부터 호스팅 실행(`SE2_HOST` 가 루프백이 아님)에서는 **스테이징 출입 열쇠**(HTTP Basic)가 그 앞에 선다 — [REPLIT_DEPLOYMENT.md](REPLIT_DEPLOYMENT.md) §3.

### 1-2. op 표 (42개)

모든 op 는 `pid` 를 본문에 싣는다(프로젝트를 고르지 않는 op 제외). 대부분 `state.update` 를 지나며 실패해도 `{ ok:true }` 가 돌아오는 경우가 있다(없는 id 를 고치면 조용히 무시).

| op | 본문(필수 **굵게**) | 하는 일 | 응답 |
|---|---|---|---|
| `project.list` | — | 목록 | `{ ok, projects }` |
| `project.create` | **name**, **spec.form**, **materials[{name,text}]**, spec.outline, spec.length, standard, request | 생성 · 자료를 «자료» 카테고리 문서로 · 작법서 문서 · **에이전트 준비 작업 시작** | `{ ok, pid }` / `필수 항목 누락 — 이름 · 형식 · 자료` |
| `project.spec` | **pid**, name, spec, standard, request, model, noCount | 설정 저장 | `{ ok }` |
| `project.prepare` | **pid**, request(이번만) | 에이전트 준비 다시(작업) | `{ ok }` / 이미 도는 중 / 이미 준비됨 |
| `project.delete` | **pid** | 그 프로젝트 작업 정지 + 파일 삭제 | `{ ok }` |
| `prompt.read` | **pid**, **code** | 자리 프롬프트(3층 합친 값) | `{ ok, one:{ code,name,role,task,craft,model,edited,made } }` |
| `prompt.write` | **pid**, **code**, name, role, task, craft | 작가 고침 층 저장 | `{ ok }` |
| `prompt.reset` | **pid**, **code** | 고침 층 걷기 | `{ ok }` |
| `prompt.model` | **pid**, **code**, model(`''`=작품 따름) | 자리 모델 | `{ ok }` |
| `peek` | **pid**, **id** | 문서·에이전트 본문 펼쳐 보기 | `{ ok, one:{ id,name,text } }` |
| `material.add` | **pid**, **text**, name | 자료 문서 추가(폰) | `{ ok }` |
| `material.delete` | **pid**, **ids[]** | 자료 문서 휴지통(폰) | `{ ok }` |
| `agent.create` | **pid**, name, role, craft, model | 에이전트(crew) 짓기 | `{ ok, id }` |
| `agent.write` | **pid**, **id**, name, role, craft, model | 고치기 | `{ ok }` |
| `agent.delete` | **pid**, **ids[]** | 지우기(문서·스레드에서도 떼기) | `{ ok }` |
| `doc.create` | **pid**, kind(`doc`/`check`/`review`), title, body, categoryId | 빈 문서(호출 없음) | `{ ok, id }` |
| `doc.write` | **pid**, **id**, title, body, request, refIds, targetIds, agentIds, categoryId | 고치기(제목·본문이 바뀌면 직전 판을 이력에) | `{ ok }` |
| `doc.final` | **pid**, **ids[]**, **on** | 확정본 켜고 끄기 | `{ ok }` |
| `doc.delete` | **pid**, **ids[]** | 휴지통 | `{ ok }` |
| `doc.discard` | **pid**, **id** | 갓 만든 빈 검사·합평 거두기(서버가 비었는지 잰다) | `{ ok }` |
| `doc.restoreVersion` | **pid**, **id**, **index** | 그 판으로(지금 판은 이력에) | `{ ok }` |
| `doc.update` | **pid**, **id**, model(이번만) | **갱신 작업 시작**(문서·검사·합평) | `{ ok, jobId }` / 이미 도는 중 |
| `cat.create` | **pid**, name | 카테고리 | `{ ok, id }` |
| `cat.delete` | **pid**, **ids[]** | 그릇만 휴지통(문서는 «새로 추가된 문서»로) | `{ ok }` |
| `thread.create` | **pid**, title, refIds | 논의 스레드 | `{ ok, id }` |
| `thread.refs` / `thread.agents` | **pid**, **id**, refIds / agentIds | 참조·사람 걸기 | `{ ok }` |
| `thread.send` | **pid**, **id**, **text**, model | 말 얹기 + **답 작업** | `{ ok, jobId }` / 빈 말 |
| `thread.edit` | **pid**, **id**, **messageId**, **text**, model | 지난 말 고치기 = 새 가지 + **답 작업** | `{ ok, jobId }` |
| `thread.title` | **pid**, **id**, title | 이름 | `{ ok }` |
| `thread.head` | **pid**, **id**, **messageId** | 가지 옮기기 | `{ ok }` |
| `thread.doc` | **pid**, **id**, request, model | **문서로 정리 작업**(지금 가지) | `{ ok, jobId }` |
| `thread.delete` / `thread.discard` | **pid**, ids[] / id | 휴지통 / 갓 만든 빈 스레드 거두기 | `{ ok }` |
| `trash.restore` / `trash.purge` | **pid**, **ids[]** | 복원 / 영구 삭제 | `{ ok }` |
| `job.pause` / `job.resume` | **pid**, **id** | 다음 호출 앞에서 서기 / 잇기 | `{ ok }` |
| `job.remove` | **pid**, **id** | 멈추고 목록에서 치움(만든 문서는 남음) | `{ ok }` |
| `job.answer` | **pid**, **id**, **choice**(`wait`/`api`/`stop`) | 한도 물음에 답 | `{ ok }` |
| `auth.read` | — | `{ ok, auth:{ mode, hasKey, modes } }` — 키 원문은 내려가지 않음 | |
| `auth.write` | mode, apiKey(`''`=지움, 없으면 그대로) | 무엇으로 부를지 | `{ ok, auth }` |

화면(`web/app.js`)이 직접 부르는 op 는 36개이고, `project.list`·`material.*`·`auth.read`·`job.pause/resume`(동적 이름) 은 폰 동반 프로그램 또는 동적 호출이 쓴다.
**폰 동반 프로그램이 이 표에 기대고 있으므로 개인판에서는 op 이름과 응답 꼴을 바꾸지 않는다.**

### 1-3. `GET /api/state?pid=` 의 `project`

```text
{ id, name, spec, standard, request,
  categories: [{ id, name, virtual, docIds }],            // «새로 추가된 문서»(__inbox__)는 가상
  crew: [{ id, name, role, craft, model }],
  docs: [{ id, kind, title, body, src, chars, isFinal, categoryId, request, refIds, targetIds, agentIds,
           versions: [{ i, at, title, body }], updatedAt }],   // ← 모든 판의 본문까지 매번
  threads: [{ id, title, refIds, agentIds, messages, headId, path }],
  trash: [{ id, at, kind, from, title }],
  jobs: [job], model, models: ['opus','sonnet','fable'], noCount,
  prompts: [{ code, name, edited, made, model, control }], agentKind,
  auth: { mode, hasKey, modes }, limit: <마지막 rate_limit 정보|null>, prepared }
```

## 2. 온라인판 v1 제안

### 2-1. 방침

- **같은 봉투를 쓴다**: `POST /api { op, … }` + `GET /api/state`. 편집기 화면(`web/app.js`)과 그 배선 시험을 그대로 살리기 위해서다.
  편집 op(§1-2)는 이름과 의미를 지키고, 온라인 전용 op 를 더한다.
- 인증은 **세션 쿠키**(`HttpOnly; Secure; SameSite=Lax`). 상태를 바꾸는 요청은 지금의 문지기(JSON 만 · 같은 출처 Origin)를 그대로 CSRF 방어로 쓴다.
- 오류는 `{ ok:false, error, code }` — `code` 는 기계가 읽는 값(`unauthenticated` `forbidden` `not_found` `conflict` `license_inactive` `credential_missing` `validation` `rate_limited`).
  HTTP 상태도 맞춘다(401/403/404/409/422/429). **다른 테넌트의 id 는 «없음(404)»으로 답한다**(존재 여부를 흘리지 않음).
- AI 를 부르는 op 는 모두 **작업 등록**만 한다 → `202 { ok, jobId }`. 결과는 상태 조회로 본다.
- 학생 응답에는 비용·횟수·credential·모델 id 를 싣지 않는다(역할별 응답 모양을 서버가 정한다).

### 2-2. 새 op (초안)

| 묶음 | op | 누가 | 메모 |
|---|---|---|---|
| 인증 | `auth.signup` `auth.login` `auth.logout` `auth.me` `auth.password` | 누구나/본인 | 교육기관판에서 가입은 **닫혀 있다**(운영자 발급 · 초대 코드, SECURITY §7-0). 자유 가입판은 `POST /api/auth/signup`(§2-3 · OPEN_EDITION §4-2). 로그인 실패는 같은 문구, 속도 제한 |
| 초대 | `invite.create` `invite.accept` `invite.list` `invite.revoke` | 기관 관리자·강사 / 학생 | 코드 원문은 만들 때 한 번만 보여 준다 |
<!-- invite.list: 아직 쓸 수 있는 코드(원문 없이) — 기관 관리자 · 최상위는 기관 것 모두, 강사는 맡은 수업 것만. 관리 · 내 수업 화면의 «초대 코드 목록»에서 취소한다. -->
| 기관 | `org.create` `org.update` `org.list` `org.members` `org.member.add/remove/role` | 플랫폼 관리자 / 기관 관리자 | 감사 로그 |
| 라이선스 | `license.issue` `license.update` `license.revoke` `license.read` | 플랫폼 관리자 / 기관 관리자(읽기) | 감사 로그 |
| 수업 | `class.create` `class.update` `class.list` `class.members` `class.enroll` `class.progress` | 기관 관리자·강사 | `class.progress` = 학생별 현재 단계·최근 작업 상태 |
| Credential | `credential.list` `credential.set` `credential.test` `credential.revoke` | 개인(본인) / 기관 관리자(기관) / 플랫폼 관리자 | `set` 은 키를 받기만 하고 **돌려주지 않는다** — `{ provider, status, keyHint, lastVerifiedAt }` |
| 모델 | `model.catalog` `model.catalog.set` | 모두(표시명만) / 플랫폼 관리자 | 학생에게는 표시명·tier 만 |
| 작업 | `job.list` `job.cancel` `job.retry` `job.answer` `job.pause` `job.resume` `job.remove` | 프로젝트 쓰기 권한 | `job.remove` = 취소 + 목록에서 숨김 |
| 생성 기록 | `run.list` `run.read` | 프로젝트 쓰기 권한(학생은 비용 칸 없음) | «이 결과는 무엇을 보고 만들었나» — 참조 스냅샷 |
| 워크플로우 | `workflow.templates` `stage.list` `stage.start` `stage.approve` `stage.reopen` `stage.skip` | 프로젝트 쓰기 권한 | `stage.start` = 추천 참조 확인 후 `doc.update` 와 같은 작업 등록 |
| 사용량 | `usage.summary` `usage.byClass` `usage.byModel` | 기관 관리자 / 플랫폼 관리자 / 개인(본인) | 학생 불가 |
| 내보내기 | `GET /api/download?kind=project` · `project.import {bundle}`(온라인은 큰 파일용 `POST /api/import`, 60MB · 로그인한 사람만) | 읽을 수 있는 사람 / 누구나(내 개인 작품으로) | `story-project` 묶음 `{format, version, exportedAt, sha256, project}` — 지문이 틀리면 거절 · 늘 새 작품(덮어쓰지 않음) · 개인판 project.json 그대로도 받는다 (2026-10-05 구현) |
| 관리 | `admin.jobs` `admin.errors` `admin.users` | 플랫폼 관리자 | |

편집 op 의 온라인 차이:
- `doc.update` 에 `requestOnce`(이번 실행에만) · `tier`/`provider`(정책이 허락할 때) · `idempotencyKey` 를 더한다.
- `doc.write` 에 `rowVersion` 을 더한다(동시 편집 충돌이면 `409 conflict`).
  → 구현(2026-10-05)은 거절 대신 **알림**: `baseAt`(화면이 고치기 시작할 때 본 `updatedAt`)보다 문서가 새로우면 지금 글을 쓰되 `{ok:true, conflict:true}` — 먼저 고친 글은 판 이력에 남아 잃는 것이 없다(거절하면 치던 글을 잃는다). 두 판 공통 · `baseAt` 없는 옛 부르기(폰)는 그대로.
- `auth.read`/`auth.write`(개인판 CLI 갈래)는 온라인에서 쓰지 않는다 → `credential.*` 가 대신한다.

### 2-3. 지금 구현된 것 — `online/server.mjs` (Sprint 6~8)

| 길 | 하는 일 |
|---|---|
| `GET /healthz` | 200 `ok` (원고 없음, 로그인 없이) |
| `GET /login` | 로그인 화면(`web/login.html`). 로그인한 사람이 오면 `/` 로 |
| `POST /api/auth/login` `{ loginId, password }` | 성공 → `se_session` 쿠키(HttpOnly · SameSite=Lax · 바깥에 열면 Secure). 실패 → 401 `{ code: 'unauthenticated' }` 한 가지 문구, 거듭되면 429 `rate_limited` |
| `POST /api/auth/logout` | 세션 폐기 + 쿠키 지움 |
| `POST /api/billing/groble` | **자유 가입판에만** — 그로블 정기결제 웹훅(OPEN_EDITION §4-4). 서명(`X-Groble-Signature` · `-Previous`, ±5분)이 문을 지킨다 — 출입 열쇠 · 호스트 이름 · 로그인 · Origin 과 무관. 200 받음(같은 `X-Groble-Idempotency-Key` 는 그대로 200) · 401 서명 · 429 거듭 틀림 · 503 시크릿 없음 · DB 안 됨(다시 보내 달라). 410 은 돌려주지 않는다 |
| `POST /api/auth/signup` `{ loginId, displayName, password }` | **자유 가입판(`SE_EDITION=open`)에만.** 계정을 만들고 곧바로 쿠키. 409 같은 아이디 · 422 꼴 · 429 고삐(같은 곳에서 15분에 시도 20 · 1시간에 계정 5) · 403 `setup_needed`(처음 설정 전). 교육기관판에는 이 길이 없다(로그인 전 401 · 뒤 404) |
| `GET /api/auth/google/start[?mode=link]` | **자유 가입판 + Secrets 에 `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` 이 둘 다 있을 때만**(아니면 이 길이 없다 — 로그인 전 401). 한 번용 값(state · nonce · PKCE verifier)을 `oauth_states` 에 두고 state 를 `se_oauth` 쿠키(HttpOnly · SameSite=Lax · `Path=/api/auth/google` · 10분)에도 실어 302 로 구글에. `mode=link` 는 로그인한 사람만(아니면 `/login`), 로그인한 사람의 `login` 은 `/` 로. 같은 곳에서 10분에 30번(넘으면 `?google=busy`). OPEN_EDITION §4-9 |
| `GET /api/auth/google/callback?state&code` | 구글이 돌려보내는 주소(구글 클라우드 «승인된 리디렉션 URI» = `https://<주소>/api/auth/google/callback`). state 줄은 맞든 틀리든 지운다(한 번만) · 쿠키와 같아야 · 10분 안. 서버가 구글과 직접 코드 교환(시크릿 · verifier) → id_token 의 iss · aud · exp · nonce. 결과는 302 로만: 이은 계정 → `/` · 처음 → 새 계정(아이디는 이메일 앞부분, 겹치면 `-2`… · 비밀번호 없음 · 가입 고삐와 처음 설정 전 거절은 가입과 같다) → `/account.html?google=new` · 잇기 → `/account.html?google=linked`. 실패는 `?google=` `state` `expired` `cancel` `failed` `disabled` `setup` `busy` `retry`(로그인 화면) · `already` `taken` `one`(내 계정). **이메일이 같다고 저절로 잇지 않는다** |
| `GET /api/me` | `{ me: { loginId, displayName } }` |
| `POST /api` `{ op, pid, … }` | **개인판과 같은 문 표**(`tools/ops.mjs`) · 같은 응답 꼴. 다른 점: pid 가 필요한 문은 «이 사람의 프로젝트»가 아니면 **404**(남의 것 · 지운 것 · 이상한 id 모두 같은 답) · `auth.write` 403 · AI 작업을 여는 문(`doc.update` `thread.send` `thread.edit` `thread.doc`)은 **영속 큐에 넣고 곧바로 `{ ok, jobId }`**(같은 대상에 도는 작업이 있으면 «이미 도는 중») · `job.pause/resume/answer/remove` 는 큐의 손잡이 · `project.create` 는 개인판처럼 에이전트 준비 작업을 곧바로 세운다 · `project.prepare` 는 끊긴 준비를 다시 |
| `GET /api/state[?pid]` | 개인판과 같은 꼴 + `me`. `project.jobs` 는 jobs 표에서(대기 중은 `status:'running', step:'대기 중'`, 사람의 답을 기다림은 `paused` + `ask.say`). `project.auth` 는 `{ mode:'online', modes:[], hasKey:false }` — 화면이 «무엇으로»(키 칸)를 세우지 않는다 |
| `GET /api/download` | 개인판과 같다(같은 소유 검사) |

로그인 전 `/api*` 는 401 `{ code:'login' }` → 화면(`web/app.js`)이 `/login` 으로 보낸다. 가입 문은 없다 — 계정은 운영자가 `node online/admin.mjs create-user <아이디>` 로 만든다(SECURITY §7).
`GET /api/setup`(로그인 전) → `{ needed, code, ai, edition, google }` — 로그인 화면이 처음 설정 · 가입 칸 · [Google 계정으로 계속하기]를 세울 근거(`google` 은 자유 가입판에서 구글 클라이언트가 있을 때만 true).

### 2-3a. 교육기관판 — `POST /api/edu { op, … }` (online/edu.mjs)

| op | 누가 | 하는 일 |
|---|---|---|
| `me.memberships` | 로그인한 사람 | 내 기관(역할) · 수업(역할). 자유 가입판은 `google: {on, linked, email, since}`(구글 로그인이 켜졌나 · 이은 구글 계정) · `noPassword`(구글로 만든 계정 — 비밀번호 없음)도 |
| `org.create` `{name, slug}` | 플랫폼 관리자 | 기관 만들기 |
| `org.list` | 플랫폼 관리자(전체) · 기관 관리자(제 기관) | |
| `org.settings` `{orgId, adminCanReadProjects, studentCards, allowCopy, aiProvider, aiTier}` | 기관 관리자(열람은 최상위만) | 열람 정책 · 강의 카드 · 복사 허용 · 기관 작품의 AI 회사 · 새 수업 작품의 시작 등급(`high_reasoning`/`balanced`) |
| `license.issue` `{orgId, plan, days, seatLimit, allowedProviders?, allowedTiers?}` · `license.status` `{licenseId, status}` | 플랫폼 관리자 | 사용권 발급 · 정지/해지 |
| `license.limits` `{licenseId, allowedProviders, allowedTiers}` | 플랫폼 관리자 | 그 이용 기간에 쓸 수 있는 AI 회사 · 등급(빈 목록 = 모두). 기관 작품의 부르기는 이 안으로 잘린다(`online/call.mjs` `licensePolicy`) |
| `license.read` `{orgId}` | 기관 관리자 | 라이선스 · 쓰는 학생 자리 |
| `org.status` `{orgId, status: active\|suspended}` | 플랫폼 관리자 | 기관 멈추기 · 다시 열기 — 멈추면 새 작품 · AI 작업이 서지 않는다(`org_suspended`), 작품 · 읽기는 그대로 |
| `user.status` `{loginId, status: active\|disabled}` | 플랫폼 관리자 | 계정 멈추기 · 다시 열기 — 멈추면 세션을 곧바로 끊고 로그인을 막는다(작품은 그대로, 자기 자신은 못 멈춤). 콘솔: `node online/admin.mjs disable-user|enable-user <아이디>` |
| `ops.overview` | 플랫폼 관리자 | 운영 현황 — 작업 상태 수(진행 중 + 24시간) · 응답 없는 작업 · 최근 실패 20(가린 까닭만) · 24시간 AI 호출(회사 · 결과) · 석 달 사용량(기관/개인 · 추정 $). 원고 · 키 없음 |
| `run.list` `{pid, docId}` | 그 작품을 읽을 수 있는 사람 | 만든 기록 — 이 문서를 지은 부르기(최근 20)마다 때 · 결과 판 · 등급 이름 · 이번 요청 · 본 것(역할 · 제목 · **그때의 판 번호**) · 잘렸을 수 있음. 비용 · 모델 id · 키 없음. 문서 창 [만든 기록](온라인) |
| `audit.list` `{orgId?, action?, limit?}` | 플랫폼 관리자(전체) · 기관 관리자(제 기관) | 감사 기록 — 언제 · 누가(아이디) · 무엇을. IP 는 내주지 않는다 · details 는 처음부터 가린 값 |
| `class.create` `{orgId, name, startsAt?, endsAt?}` · `class.list` · `class.archive` `{…, reopen}` | 기관 관리자(목록은 멤버도) | 수업 — 이용 기간(라이선스)이 없으면 403 `license_inactive` |
| `class.instructors` `{classId}` · `class.assign` `{classId, userId, on?}` | 기관 관리자 · 운영자 | 수업의 맡은 강사 — 그 기관의 강사 가운데 골라 링크 없이 바로 넣고(`on` 기본), `on:false` 면 그 수업에서만 뺀다(기관 · 다른 수업은 그대로). 화면: [수업] → 수업 줄 [더보기] → «맡은 강사» (2026-10-05) |
| `class.dates` `{classId, startsAt?, endsAt?}` | 기관 관리자 | 수업 기간(`YYYY-MM-DD`, 한국 날짜 · 끝 날 24시까지, 비우면 기한 없음). 시작 전 · 끝난 뒤에는 그 수업에 새 작품을 만들지 않는다(`class_not_started`/`class_ended`) — 만든 작품은 계속 쓴다 |
| `class.progress` `{classId}` | 맡은 강사 · 기관 관리자 | 학생마다 프로젝트 · 문서 수 · 최근 작업 상태(비용 칸 없음) |
| `invite.create` `{orgId, classId?, role, days, maxUses}` | 기관 관리자(모든 역할) · 강사(맡은 수업 학생만) | 코드(`ABCD-EFGH-JKLM`). `invite.list` 가 봉해 둔 코드를 열어 다시 보인다(2026-10-05) · 닫은 수업의 코드는 `class_closed` |
| `invite.revoke` `{inviteId}` | 만든 쪽 | |
| `invite.accept` `{code, loginId?, password?, displayName?}` | **로그인 없이도** | 새 계정을 만들며(또는 지금 계정에) 기관 · 수업에 더한다 · 학생 자리 상한 · 틀린 코드 고삐(429) |
| `invite.check` `{code}` | **로그인 없이도** | 첫 화면에서 코드만 확인(쓰지 않는다) → `{role, organizationName, className}` · 틀리면 같은 고삐에 센다 |
| `login.available` `{loginId, code?}` | 맞는 초대 코드를 쥔 사람(가입 중) · 기관/최상위 관리자 | 아이디를 쓸 수 있나(대소문자 무시) → `{available, reason: ''|'taken'|'format', say}`. 아무나 아이디를 더듬지 못하게 코드 없는 일반 사용자는 404 · 틀린 코드는 맞히기 고삐. 만들 때는 DB 유일 조건이 다시 막는다(409) |
| `me.key.set` `{apiKey, provider?}` · `me.key.list` | 누구나(제 것만) | 내 AI 키 — 쓰기 전용(끝 네 자리 · 상태만). 내 개인 작품의 AI 는 이 키로(비용 주체 USER) |
| `project.copy_personal` `{pid}` | 그 수업 작품의 주인 | 문서 · 판 이력 · 확정본 · 논의째 «… (개인)» 으로 복사 → `{pid, counts, verified}`. 원본은 기관에 그대로 · 기관 `org.settings allowCopy:false` 면 403 `copy_blocked` |
| `member.create` `{orgId, role, loginId, displayName?, classId?, password?}` | **최상위 관리자만** | 기관 관리자 · 강사 · 학생 계정을 직접 만든다(학생은 수업 · 자리 상한). 비밀번호는 운영자가 정한다(기술 지원용) — 비우면 서버가 지어 응답에 `password`. 봉한 사본을 두어 `org.members` 가 **최상위 관리자에게만** `knownPassword` 로 다시 보인다(본인이 바꾸면 지운다). 기관 관리자 · 강사는 초대 코드로 사람을 부른다(2026-10-05 사용자 결정) |
| `member.reset_password` `{orgId, userId}` | 기관 관리자(그 기관 — 기관 관리자는 최상위만) · 강사(맡은 수업의 학생만) | 비밀번호를 바꾸지 않고 **재설정 코드**(7일 · 한 번)를 준다 → `{resetCode, days}`. 쓰기 전까지 `org.members` · `class.progress` 에 다시 보인다(봉한 사본). 관리자는 남의 비밀번호를 모른다 |
| (링크) `/login?invite=코드` · `/login?reset=코드&id=아이디` | 누구나 | 코드를 손으로 옮기지 않게 — 관리 화면의 [링크 복사] · [보내기](휴대폰 공유 창). 초대 링크는 코드가 채워진 «계정 만들기»(이미 로그인했으면 «내 계정 → 새 수업 코드 넣기»로), 재설정 링크는 아이디 · 코드가 채워진 «비밀번호를 잊었어요». 열면 주소창에서 코드를 지운다. 재설정 링크는 1:1로만(2026-10-05) |
| `me.pass` · `me.pass.checkout` `{planId}` | 로그인한 사람(**자유 가입판에만** — 교육기관판은 404) | 내 이용권 `{active, status: active\|past_due\|cancel_pending\|ended\|none, provider, paidUntil, nextBillingDate, serviceEndsAt, finalFailure, plans:[{id,name}], refund, cancel, reasons}`(금액 없음) · [결제하기] → `{url}`(결제창 + 새 참조값). `refund` = `{eligible, reason: ok\|requested\|refunded\|ai_used, paidOn, startedOn, until, aiRuns, noUse, days, request}` — 기한은 **구독 시작(첫 결제)부터**(OPEN_EDITION §4-8). `cancel` = `{can, nextBillingDate, request: {createdAt, nextBilling, confirmed, charged}}` — 기간이 지나면 [구독 취소]. `reasons` = 이유 목록 `[{code, say}]` |
| `me.pass.refund` `{reason, detail?}` | 로그인한 사람(자유 가입판에만 — 제 것만) | [환불 요청] — 이유(목록의 code, «기타»는 `detail` 필수 · 500자)를 받고 서버가 다시 판정(구독 시작일 다음 날부터 n일 · 규칙이 켜졌으면 AI 작업 0)한 뒤 그 정기결제 이용권을 **곧바로 멈추고**(편집 · 열람 · 내보내기는 그대로) **운영자에게 메일**. 판정 근거 · 이유 · 메일 결과를 `refund_requests` 에. 422 `validation` · `off` · `no_payment` · `window_passed` · `ai_used` · `requested` · `refunded`. 돈 · 해지는 운영자가 그로블에서(판매자 API 가 없다) → 웹훅이 오면 «환불됨 · 해지됨»이 저절로 |
| `me.pass.cancel` `{reason, detail?}` | 로그인한 사람(자유 가입판에만 — 제 것만) | [구독 취소] — 환불 기간이 지난 뒤. 이유와 다음 결제일을 `cancel_requests` 에 남기고 **운영자에게 메일**(이용권은 지금 결제 기간 끝까지 그대로). 그로블의 해지 웹훅이 오면 «해지 확인», 접수 뒤 갱신 결제는 «확인 필요» + 메일. 422 `validation` · `none` · `pending`(이미 해지) · `requested` · `refund_window`(기간 안 — [환불 요청]으로) |
| `billing.customers` `{q?, status?, limit?, offset?}` · `billing.customer` `{userId}` | **최상위 운영자**(자유 가입판에만) | 고객 목록(찾기 · 상태별 거르기 `active\|past_due\|cancel_pending\|ended\|none\|free` · 50명씩) · 한 사람(이용권 줄 · 결제 기록 — 이름 · 전화 · 이메일 가림 · 메모 · 환불 건 · `user.google`(이은 구글, 이메일 가림) · `user.noPassword`) |
| `billing.extend` `{userId, days, reason}` · `billing.end` `{userId, reason}` · `billing.free` `{userId, on, reason}` · `billing.memo` `{userId, memo}` | 최상위 운영자 | 손 연장(지금 기한부터 n일 — `manual` 줄) · 이용권 끝내기(모든 줄 + 무료 이용 끔) · 무료 이용 · 메모. 감사 기록(왜 · 메모는 길이만). 그로블 카드 청구는 끊지 않는다 |
| `billing.events` · `billing.link` `{eventId, loginId\|userId, reason}` · `billing.ignore` `{eventId, reason}` · `billing.health` | 최상위 운영자 | 결제 기록(«확인 필요» 따로 · 최근 100 · 이번 달 수 · 합계) · [이 계정에 연결](금액 검사 없이 반영 · 참조값(다른 계정 것이면 409) 또는 구매자 이메일을 기억) · [무시] · 웹훅 상태(시크릿 있음/없음 · 마지막 받은 때 · 틀린 서명 수 · 소식이 늦은 정기결제 수) |
| `billing.plans` · `billing.plan.save` `{id?, name, checkoutUrl, price, cycleMonths, productId, enabled, sortOrder}` · `billing.rules` · `billing.rules.save` `{trialDays?, graceDays?, refundDays?, refundNoUse?, notifyEmail?}` | 최상위 운영자 | 결제 옵션(가격 · 주기는 만든 뒤 못 바꿈 · 상품 번호는 빈 때 한 번) · 이용 규칙(체험 0~90 · 여유 0~60 · 환불 기간 0~30(구독 시작부터, 기본 7, 0 이면 [환불 요청] 없음) · «AI 작업 전까지만»(기본 끔) · 알림 메일 주소(빈 글은 지움 · 감사 기록에는 «있음»만), 보내지 않은 값은 그대로, 막는 범위는 «새 AI 작업만» 고정) · `rules.mailOn`(Secrets 에 `RESEND_API_KEY` 가 있나) |
| `billing.refund.withdraw` `{requestId, reason}` | 최상위 운영자 | 환불 요청 되돌리기 — 아직 환불되지 않은 «처리 중» 요청만(404 · 409), 멈췄던 이용권을 되살린다 · 감사 기록. 환불 건은 `billing.events` 의 `refunds`(처리 중 먼저 — 이유 · 메일 결과 포함) · `billing.customer` 의 `refunds` · `billing.health` 의 `refundsOpen` · `refundsUncancelled`(환불됐는데 그로블 정기결제가 살아 있는 건) |
| 구독 취소 · 알림 메일(운영) | 최상위 운영자 | `billing.events` · `billing.customer` 의 `cancels`(이유 · 다음 결제일 · `confirmedAt` · `chargedAt` · 메일 결과) · `billing.health` 의 `cancelsOpen` · `cancelsLate`(다음 결제일이 지났는데 해지 확인 없음) · `mail {on, to, failed}`. `billing.mail.test` — «알림 메일»로 시험 한 통(422 `mail` 에 까닭의 사람 말) · `billing.mail.resend {kind: refund\|cancel, id}` — 못 보낸 알림 다시 |
| `user.reset_code` `{userId}` | 최상위 운영자(두 판) | 운영자 아닌 계정에 비밀번호 재설정 코드(7일 · 한 번) — 기관에 묶이지 않은 계정용(자유 가입판 §4-5) |
| `password.reset` `{loginId, code, password}` | **로그인 없이** | 로그인 화면 «비밀번호를 잊었어요» — 재설정 코드(또는 운영자는 Secrets 의 `SE2_RECOVERY_CODE`)로 새 비밀번호를 정하고 곧바로 들어간다. 틀리면 초대 코드와 같은 맞히기 고삐 |

새 작품은 작업실(홈)의 «+» 한 곳에서 만든다(2026-10-05): 창 맨 위 «어디에 만들까요?» — `/api/state` 의 `me.places`(열려 있고 기관 이용 기간 안인 내 수업)
가운데 하나(기본: 첫 수업) 또는 «내 개인 작품». 수업을 고르면 `project.create` 에 `classId` 가 실린다(서버가 다시 본다).
작업실 목록의 수업 작품에는 `place`(수업 이름)가 붙는다. 첫 화면의 초대 코드는 «이미 계정이 있어요» → 로그인하고 그 계정으로 참여(새 계정을 만들지 않는다).
| `org.key.set` `{orgId, provider, apiKey}` · `org.key.list` | 기관 관리자 | 기관 키(쓰기 전용 — 끝 네 자리만 보임) |
| `org.members` `{orgId}` | 기관 관리자 | 사람 목록 — 한 사람 한 계정(아이디 · 이름 · 역할 · 수업). 초대 코드는 들어오는 열쇠일 뿐 계정이 아니다 |
| `member.reset_password` `{orgId, userId}` | 기관 관리자(제 기관 학생 · 강사) | 임시 비밀번호를 한 번만 보여 주고 그 사람의 세션을 끊는다 |
| `member.remove` `{orgId, userId}` | 기관 관리자 | 기관 · 수업에서 내보낸다(계정 · 작품은 남고 그 사람은 제 작품을 읽기만) |
| `usage.summary` `{orgId?}` | 기관 관리자(기관 키) · 본인(개인 키) | 달 · 모델별 호출 · 토큰 · 추정 금액. 학생 · 강사는 없음 |

관리 화면(2026-10-05 다시 짬): 맨 위 줄에서 고른다 — [운영](최상위만: 현황 · 감사 기록 · 단계 · 강의 카드(전체) · 계정 멈추기) · 기관마다 · [+ 새 기관](이용 기간 90일 · 40자리를 바로 연다 · 기관 관리자 아이디 · 이름 · 비밀번호를 넣으면 그 계정도 함께 — 기관 자체는 로그인 계정이 아니다).
기관을 고르면 상태 카드(이용 기간 · AI · 시작 등급 — 빠진 것은 붉게, 운영자에게는 이용 기간 · 범위 · 멈추기 줄) 아래 탭 넷 [수업] [사용자] [AI] [설정].
AI 회사는 키를 넣은 회사만 고른다(서버도 `no_key` 로 막는다) — 첫 키의 회사가 저절로 기본, 그 키를 지우면 남은 키의 회사로. 시작 등급 기본은 Balanced. 키가 없는 기관은 [AI] 탭부터 열린다.
화면: `/manage.html` «관리»(운영자 · 기관 관리자에게만 첫 화면 단추가 보인다 — 막는 것은 서버) · `/school.html` «내 수업»(수업에 든 사람에게만 단추 — 내 수업 작품 · 개인 작품으로 복사 · 수업 현황 · 학생 초대 코드 · 새 수업 코드 넣기) · `/account.html` «내 계정»(누구나 — 새 수업 코드 넣기 · 내 AI 키 · 내 비밀번호 바꾸기). `POST /api/auth/password {current, next}` 는 내 비밀번호 바꾸기(비밀번호가 없는 계정 — 구글로 만든 것 — 은 403 `no_password`: 세션만으로 정하지 못하고 운영자의 재설정 코드로).

편집기 문(`POST /api`)의 `project.create` 에 `classId` 를 주면 그 수업의 프로젝트가 된다(멤버 · 열린 수업 · 유효 라이선스일 때만, 아니면 403/404 — 개인 프로젝트로 새지 않는다).
열람 권한(강사 · 기관 관리자)으로 상태를 받으면 `project.readOnly = true`, 고치는 문은 403 `read_only`.

### 2-4. 상태 조회를 가볍게

> **온라인 서버에 들어간 것(2026-10-04)**: `GET /api/state` 에 지문(`ETag` — 프로젝트 `updated_at` · 내 프로젝트 목록 · 작업 줄을 질의 하나로)과 `Cache-Control: private, no-cache`. 같으면 **프로젝트를 짓지 않고 304**. 브라우저가 스스로 `If-None-Match` 를 붙이므로 화면(`web/app.js`)은 고치지 않았다. 남은 것: 판 본문을 펼칠 때만 받기.

지금의 `GET /api/state?pid=` 는 모든 판의 본문을 1.5초마다 싣는다. 온라인에서는:
- 판 목록은 메타데이터만(`{ id, seq, at, title, chars, source }`), 판 본문은 `GET /api/version?pid=&id=` 로 펼칠 때만.
- `ETag`(프로젝트 `updated_at`+작업 상태 해시) → 바뀌지 않았으면 `304`.
- 작업만 보는 가벼운 길 `GET /api/jobs?pid=` (명세 §45 의 `GET /api/jobs/:id` 에 해당).
- 화면이 쓰는 모양(`stateOf`)은 유지해 `web/app.js` 를 크게 고치지 않는다.

> **바뀜 알림(2026-10-07)**: `GET /api/events?pid=` — SSE. 작품 · 그 작업 줄 · 내 작품 목록이 바뀌면 `data: change` 만 보낸다(내용 없음 — 화면이 `/api/state` 로 다시 묻고, 그 길이 권한을 다시 본다).
> DB 의 `NOTIFY se_change`(migrations/012 — 작품 행 · 작업 줄의 «보이는 칸»만, 숨 쉬기는 빼고)를 서버가 연결 하나로 듣는다(`online/events.mjs`).
> 서버는 처음에 스스로 NOTIFY 를 보내 LISTEN 이 정말 되는지 확인한다 — 연결 풀 뒤라서 안 되면 503, 화면은 1.5초 묻기를 그대로 한다.
> 붙어 있는 동안 화면은 15초마다 한 번만 확인한다. 남의 작품은 404, 사람마다 연결 8개까지. 개인판은 붙지 않는다(로그인 없음).
