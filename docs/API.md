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
| 인증 | `auth.signup` `auth.login` `auth.logout` `auth.me` `auth.password` | 누구나/본인 | `auth.signup` 은 **닫혀 있다**(결정: 지금은 운영자 발급, 자유 가입은 BYOK + 월 이용료 — 결제 결정 후, SECURITY §7-0). 로그인 실패는 같은 문구, 속도 제한 |
| 초대 | `invite.create` `invite.accept` | 기관 관리자·강사 / 학생 | 코드 원문은 만들 때 한 번만 보여 준다 |
| 기관 | `org.create` `org.update` `org.list` `org.members` `org.member.add/remove/role` | 플랫폼 관리자 / 기관 관리자 | 감사 로그 |
| 라이선스 | `license.issue` `license.update` `license.revoke` `license.read` | 플랫폼 관리자 / 기관 관리자(읽기) | 감사 로그 |
| 수업 | `class.create` `class.update` `class.list` `class.members` `class.enroll` `class.progress` | 기관 관리자·강사 | `class.progress` = 학생별 현재 단계·최근 작업 상태 |
| Credential | `credential.list` `credential.set` `credential.test` `credential.revoke` | 개인(본인) / 기관 관리자(기관) / 플랫폼 관리자 | `set` 은 키를 받기만 하고 **돌려주지 않는다** — `{ provider, status, keyHint, lastVerifiedAt }` |
| 모델 | `model.catalog` `model.catalog.set` | 모두(표시명만) / 플랫폼 관리자 | 학생에게는 표시명·tier 만 |
| 작업 | `job.list` `job.cancel` `job.retry` `job.answer` `job.pause` `job.resume` `job.remove` | 프로젝트 쓰기 권한 | `job.remove` = 취소 + 목록에서 숨김 |
| 생성 기록 | `run.list` `run.read` | 프로젝트 쓰기 권한(학생은 비용 칸 없음) | «이 결과는 무엇을 보고 만들었나» — 참조 스냅샷 |
| 워크플로우 | `workflow.templates` `stage.list` `stage.start` `stage.approve` `stage.reopen` `stage.skip` | 프로젝트 쓰기 권한 | `stage.start` = 추천 참조 확인 후 `doc.update` 와 같은 작업 등록 |
| 사용량 | `usage.summary` `usage.byClass` `usage.byModel` | 기관 관리자 / 플랫폼 관리자 / 개인(본인) | 학생 불가 |
| 내보내기 | `project.export` `project.import` | 소유자 | `story-project` 묶음(Phase 9) |
| 관리 | `admin.jobs` `admin.errors` `admin.users` | 플랫폼 관리자 | |

편집 op 의 온라인 차이:
- `doc.update` 에 `requestOnce`(이번 실행에만) · `tier`/`provider`(정책이 허락할 때) · `idempotencyKey` 를 더한다.
- `doc.write` 에 `rowVersion` 을 더한다(동시 편집 충돌이면 `409 conflict`).
- `auth.read`/`auth.write`(개인판 CLI 갈래)는 온라인에서 쓰지 않는다 → `credential.*` 가 대신한다.

### 2-3. 지금 구현된 것 — `online/server.mjs` (Sprint 6~8)

| 길 | 하는 일 |
|---|---|
| `GET /healthz` | 200 `ok` (원고 없음, 로그인 없이) |
| `GET /login` | 로그인 화면(`web/login.html`). 로그인한 사람이 오면 `/` 로 |
| `POST /api/auth/login` `{ loginId, password }` | 성공 → `se_session` 쿠키(HttpOnly · SameSite=Lax · 바깥에 열면 Secure). 실패 → 401 `{ code: 'unauthenticated' }` 한 가지 문구, 거듭되면 429 `rate_limited` |
| `POST /api/auth/logout` | 세션 폐기 + 쿠키 지움 |
| `GET /api/me` | `{ me: { loginId, displayName } }` |
| `POST /api` `{ op, pid, … }` | **개인판과 같은 문 표**(`tools/ops.mjs`) · 같은 응답 꼴. 다른 점: pid 가 필요한 문은 «이 사람의 프로젝트»가 아니면 **404**(남의 것 · 지운 것 · 이상한 id 모두 같은 답) · `auth.write` 403 · AI 작업을 여는 문(`doc.update` `thread.send` `thread.edit` `thread.doc`)은 **영속 큐에 넣고 곧바로 `{ ok, jobId }`**(같은 대상에 도는 작업이 있으면 «이미 도는 중») · `job.pause/resume/answer/remove` 는 큐의 손잡이 · `project.create` 는 개인판처럼 에이전트 준비 작업을 곧바로 세운다 · `project.prepare` 는 끊긴 준비를 다시 |
| `GET /api/state[?pid]` | 개인판과 같은 꼴 + `me`. `project.jobs` 는 jobs 표에서(대기 중은 `status:'running', step:'대기 중'`, 사람의 답을 기다림은 `paused` + `ask.say`). `project.auth` 는 `{ mode:'online', modes:[], hasKey:false }` — 화면이 «무엇으로»(키 칸)를 세우지 않는다 |
| `GET /api/download` | 개인판과 같다(같은 소유 검사) |

로그인 전 `/api*` 는 401 `{ code:'login' }` → 화면(`web/app.js`)이 `/login` 으로 보낸다. 가입 문은 없다 — 계정은 운영자가 `node online/admin.mjs create-user <아이디>` 로 만든다(SECURITY §7).

### 2-3a. 교육기관판 — `POST /api/edu { op, … }` (online/edu.mjs)

| op | 누가 | 하는 일 |
|---|---|---|
| `me.memberships` | 로그인한 사람 | 내 기관(역할) · 수업(역할) |
| `org.create` `{name, slug}` | 플랫폼 관리자 | 기관 만들기 |
| `org.list` | 플랫폼 관리자(전체) · 기관 관리자(제 기관) | |
| `org.settings` `{orgId, adminCanReadProjects}` | 기관 관리자 | 기관 관리자의 작품 열람 정책(기본 꺼짐) |
| `license.issue` `{orgId, plan, days, seatLimit}` · `license.status` `{licenseId, status}` | 플랫폼 관리자 | 사용권 발급 · 정지/해지 |
| `license.read` `{orgId}` | 기관 관리자 | 라이선스 · 쓰는 학생 자리 |
| `class.create` · `class.list` · `class.archive` `{…, reopen}` | 기관 관리자(목록은 멤버도) | 수업 |
| `class.progress` `{classId}` | 맡은 강사 · 기관 관리자 | 학생마다 프로젝트 · 문서 수 · 최근 작업 상태(비용 칸 없음) |
| `invite.create` `{orgId, classId?, role, days, maxUses}` | 기관 관리자(모든 역할) · 강사(맡은 수업 학생만) | 코드 원문은 이번 응답에만(`ABCD-EFGH-JKLM`) |
| `invite.revoke` `{inviteId}` | 만든 쪽 | |
| `invite.accept` `{code, loginId?, password?, displayName?}` | **로그인 없이도** | 새 계정을 만들며(또는 지금 계정에) 기관 · 수업에 더한다 · 학생 자리 상한 · 틀린 코드 고삐(429) |
| `invite.check` `{code}` | **로그인 없이도** | 첫 화면에서 코드만 확인(쓰지 않는다) → `{role, organizationName, className}` · 틀리면 같은 고삐에 센다 |
| `login.available` `{loginId, code?}` | 맞는 초대 코드를 쥔 사람(가입 중) · 기관/최상위 관리자 | 아이디를 쓸 수 있나(대소문자 무시) → `{available, reason: ''|'taken'|'format', say}`. 아무나 아이디를 더듬지 못하게 코드 없는 일반 사용자는 404 · 틀린 코드는 맞히기 고삐. 만들 때는 DB 유일 조건이 다시 막는다(409) |
| `me.key.set` `{apiKey, provider?}` · `me.key.list` | 누구나(제 것만) | 내 AI 키 — 쓰기 전용(끝 네 자리 · 상태만). 내 개인 작품의 AI 는 이 키로(비용 주체 USER) |
| `project.copy_personal` `{pid}` | 그 수업 작품의 주인 | 문서 · 판 이력 · 확정본 · 논의째 «… (개인)» 으로 복사 → `{pid, counts, verified}`. 원본은 기관에 그대로 · 기관 `org.settings allowCopy:false` 면 403 `copy_blocked` |
| `member.create` `{orgId, role, loginId, displayName?, classId?}` | 최상위 관리자 · 기관 관리자 | 강사(· 기관 관리자 — 최상위만) 계정을 초대 코드 없이 만든다 → `{loginId, tempPassword}`(한 번만). 학생은 초대 코드로(자리 상한) · 있는 아이디는 409 |

새 작품은 작업실(홈)의 «+» 한 곳에서 만든다(2026-10-05): 창 맨 위 «어디에 만들까요?» — `/api/state` 의 `me.places`(열려 있고 기관 이용 기간 안인 내 수업)
가운데 하나(기본: 첫 수업) 또는 «내 개인 작품». 수업을 고르면 `project.create` 에 `classId` 가 실린다(서버가 다시 본다).
작업실 목록의 수업 작품에는 `place`(수업 이름)가 붙는다. 첫 화면의 초대 코드는 «이미 계정이 있어요» → 로그인하고 그 계정으로 참여(새 계정을 만들지 않는다).
| `org.key.set` `{orgId, provider, apiKey}` · `org.key.list` | 기관 관리자 | 기관 키(쓰기 전용 — 끝 네 자리만 보임) |
| `org.members` `{orgId}` | 기관 관리자 | 사람 목록 — 한 사람 한 계정(아이디 · 이름 · 역할 · 수업). 초대 코드는 들어오는 열쇠일 뿐 계정이 아니다 |
| `member.reset_password` `{orgId, userId}` | 기관 관리자(제 기관 학생 · 강사) | 임시 비밀번호를 한 번만 보여 주고 그 사람의 세션을 끊는다 |
| `member.remove` `{orgId, userId}` | 기관 관리자 | 기관 · 수업에서 내보낸다(계정 · 작품은 남고 그 사람은 제 작품을 읽기만) |
| `usage.summary` `{orgId?}` | 기관 관리자(기관 키) · 본인(개인 키) | 달 · 모델별 호출 · 토큰 · 추정 금액. 학생 · 강사는 없음 |

화면: `/manage.html` «관리»(운영자 · 기관 관리자에게만 첫 화면 단추가 보인다 — 막는 것은 서버) · `/school.html` «내 수업»(수업에 든 사람에게만 단추 — 내 수업 작품 · 개인 작품으로 복사 · 수업 현황 · 학생 초대 코드 · 새 수업 코드 넣기) · `/account.html` «내 계정»(누구나 — 새 수업 코드 넣기 · 내 AI 키 · 내 비밀번호 바꾸기). `POST /api/auth/password {current, next}` 는 내 비밀번호 바꾸기.

편집기 문(`POST /api`)의 `project.create` 에 `classId` 를 주면 그 수업의 프로젝트가 된다(멤버 · 열린 수업 · 유효 라이선스일 때만, 아니면 403/404 — 개인 프로젝트로 새지 않는다).
열람 권한(강사 · 기관 관리자)으로 상태를 받으면 `project.readOnly = true`, 고치는 문은 403 `read_only`.

### 2-4. 상태 조회를 가볍게

> **온라인 서버에 들어간 것(2026-10-04)**: `GET /api/state` 에 지문(`ETag` — 프로젝트 `updated_at` · 내 프로젝트 목록 · 작업 줄을 질의 하나로)과 `Cache-Control: private, no-cache`. 같으면 **프로젝트를 짓지 않고 304**. 브라우저가 스스로 `If-None-Match` 를 붙이므로 화면(`web/app.js`)은 고치지 않았다. 남은 것: 판 본문을 펼칠 때만 받기.

지금의 `GET /api/state?pid=` 는 모든 판의 본문을 1.5초마다 싣는다. 온라인에서는:
- 판 목록은 메타데이터만(`{ id, seq, at, title, chars, source }`), 판 본문은 `GET /api/version?pid=&id=` 로 펼칠 때만.
- `ETag`(프로젝트 `updated_at`+작업 상태 해시) → 바뀌지 않았으면 `304`.
- 작업만 보는 가벼운 길 `GET /api/jobs?pid=` (명세 §45 의 `GET /api/jobs/:id` 에 해당).
- 화면이 쓰는 모양(`stateOf`)은 유지해 `web/app.js` 를 크게 고치지 않는다.
