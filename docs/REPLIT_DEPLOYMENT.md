# Replit 배포 구조 초안

> 상태: **초안 v1 (2026-10-04)**. Sprint 1(지금 개인판을 Replit 에서 그대로 실행)에 필요한 코드와 설정은 이 저장소에 들어 있다.
> **확인 한계**: 이 개발 환경의 네트워크 정책이 `docs.replit.com` 을 막아 공식 문서를 직접 열지 못했다. 아래 사실은 검색 결과의 문서 발췌와
> 실제 공개 `.replit` 예시(예: [nextjs/deploy-replit](https://github.com/nextjs/deploy-replit/blob/main/.replit))로 확인한 것이고,
> 확인하지 못한 것은 **«미확인»** 으로 적었다. 배포 전에 Replit 화면/문서에서 한 번 더 확인한다.

## 1. 원칙

- **GitHub 가 정본**이다. Replit 은 GitHub 의 코드를 가져와 실행·배포하는 곳이다(Claude Code Cloud = 개발, Replit = 실행).
- Replit 에만 있는 것은 **배포 설정**(`.replit`)과 플랫폼이 주는 환경 변수 읽기(`REPLIT_DOMAINS` 등 — `tools/hosting.mjs` 한 곳)뿐이다.
  Core·문서/판/참조·Provider·Job·DB 스키마·라이선스 정책은 Replit 을 모른다(명세 부록 AO). Cloud Run·AWS 등으로 옮길 때 바꿀 것은 이 문서의 설정뿐이다.
- Replit 파일 시스템을 영구 저장소로 쓰지 않는다 — **게시된 앱의 파일은 다시 게시할 때마다 초기화된다**(문서 발췌). Sprint 1 스테이징은 시험 데이터만.
- 비밀값은 Replit **Secrets** 에만. 저장소·`.replit` 에 적지 않는다(시험이 `.replit` 에 열쇠가 없음을 검사한다).

## 2. 구조

### 2-1. 지금(Sprint 1) — 개인판 그대로, 프로세스 하나

```text
브라우저 ──HTTPS──▶ Replit 프록시 ──▶ node tools/server.mjs (SE2_HOST=0.0.0.0, PORT or 8801)
                                        ├ 스테이징 출입 열쇠(HTTP Basic)
                                        ├ 허용 호스트: REPLIT_DOMAINS / REPLIT_DEV_DOMAIN / SE2_ALLOWED_HOSTS
                                        ├ 작업 실행기(프로세스 안) · AI 는 모의(SE2_MOCK=1)
                                        └ data/ JSON 파일(재게시 때 사라짐 — 시험 데이터만)
```

- 배포 종류: **Reserved VM · Web server**(가장 작은 크기로 충분). **Autoscale 은 쓰지 않는다** — 지금 판은 «메모리가 정본»이라
  잠들었다 깨거나 인스턴스가 여럿이 되면 상태가 갈리고 파일이 사라진다.
- AI: Replit 에는 Claude Code CLI 도 구독 로그인도 없다(있어서도 안 된다 — 개인 구독을 서버에서 쓰지 않는다). 그래서 `SE2_MOCK=1` 로 작업 흐름만 확인한다.
  실제 AI 는 Provider 계층(Phase 2) 뒤에 API 키로 붙는다.

### 2-2. 온라인판(Phase 3 이후) — 앱 하나, 배포 하나, 프로세스 둘

문서 발췌: «한 프로젝트(App)는 한 번에 하나로 게시된다 — 따로 게시하려면 프로젝트를 나눈다» · «Replit App 마다 제 DB 가 있고 다른 App 과 나누지 않는다».
웹과 worker 를 서로 다른 App 으로 나누면 worker 가 웹의 DB 에 정식으로 붙을 길이 없다. 그래서:

```text
Replit App «story-engine-<env>» ── Reserved VM 배포(Web server) 하나
   node online/main.mjs  (작은 감독 프로세스 — 플랫폼 중립)
     ├─ online/server.mjs   웹: 인증·권한·op·상태·작업 등록
     └─ online/worker.mjs   worker: claim·호출·저장 (죽으면 감독이 다시 띄움, 웹이 IPC 로 «일 있음»을 알림)
   PostgreSQL(Replit 제공: 개발 DB / production DB 따로) · App Storage(파일) · Secrets
```

- 다른 플랫폼에서는 감독 없이 웹과 worker 를 **두 서비스**로 띄우면 된다(같은 코드, 실행 명령만 다름).
- 감독 프로세스는 셸의 `a & b & wait` 를 쓰지 않는다 — 한쪽이 죽어도 셸이 살아 있어 다시 띄우지 못한다(문서 예시의 한계).

### 2-3. 환경 분리 (명세 부록 AP·AL)

| | Local | Staging | Production |
|---|---|---|---|
| 어디 | 개발자 PC · Claude Code Cloud | Replit App `story-engine-staging` (Reserved VM) | Replit App `story-engine` (Reserved VM) |
| DB | 없음(JSON) → 로컬 PostgreSQL | 그 App 의 production DB | 그 App 의 production DB — **staging 과 절대 공유하지 않음** |
| 비밀 | 셸 환경 변수 | 그 App 의 Secrets(배포용) | 별도 Secrets |
| 도메인 | 127.0.0.1:8801 | `*.replit.app` | 사용자 도메인(나중) |
| 브랜치 | `claude/*`·`feature/*` | `staging` | `main` |

App 을 둘로 나누는 까닭: Replit 에서 작업 공간(개발)과 게시(production)가 한 App 안에 있으므로, staging 을 «진짜 배포»로 시험하려면 App 이 따로 있어야 한다.

## 3. 환경 변수

### 3-1. 이 저장소가 읽는 것(Sprint 1)

| 이름 | 기본 | 뜻 |
|---|---|---|
| `PORT` | — (Replit 작업 공간이면 `5000`) | 플랫폼이 주는 포트. `SE2_PORT` 가 없을 때만 따른다. 둘 다 없고 Replit 작업 공간(`REPL_ID`)이면 미리보기가 기다리는 **5000** — `.replit` 의 `[[ports]] localPort = 5000 → 80` 과 같다 |
| `SE2_PORT` | `8801` | 포트를 못박는다(로컬 실행기·폰 동반 프로그램용). 배포 명령에는 쓰지 않는다 |
| `SE2_HOST` | `127.0.0.1` | 붙을 주소. Replit 은 `0.0.0.0`(`.replit` 의 실행 명령이 준다) |
| `SE2_ACCESS_KEY` | — | **스테이징 출입 열쇠**. 루프백이 아닌 주소에 열면 필수(16자 이상) — 없으면 서버가 `[STOP]` 을 찍고 서지 않는다. **Secrets 에만** |
| `SE2_ALLOWED_HOSTS` | — | 받아 줄 호스트 이름 더하기(쉼표). 보통은 필요 없다 — `REPLIT_DOMAINS`·`REPLIT_DEV_DOMAIN` 을 저절로 받는다 |
| `SE2_ALLOW_OPEN` | — | `1` 이면 열쇠 없이 바깥에 연다(권하지 않음, 시작할 때 경고) |
| `SE2_MOCK` | — | `1` 이면 AI 대신 모의 응답(스테이징 Sprint 1 권장) |
| `SE2_DATA_DIR` | `<폴더>/data` | JSON 저장 자리 |

Replit 이 주는 것(문서 발췌): `REPLIT_DOMAINS`(앱의 모든 도메인, 쉼표 — 사용자 도메인은 다시 게시해야 들어감) · `REPLIT_DEV_DOMAIN`(작업 공간 미리보기 주소, **배포에는 없음**) ·
`REPLIT_DEPLOYMENT`(게시된 앱이면 `1`). 플랫폼의 `PORT` 실제 값은 **미확인**.

### 3-2. 온라인판에서 더해질 것(Phase 3~)

`DATABASE_URL`(Replit 이 넣어 줌) · `SESSION_SECRET` · `CREDENTIALS_KEY_V1`(credential 암호화 마스터 키, 32바이트 base64) · `NODE_ENV`(`staging`/`production`) ·
`SE_EDITION`(`school` 기본 — 교육기관판 · `open` — 자유 가입판, docs/OPEN_EDITION.md. 모르는 값은 `school`) ·
`GROBLE_WEBHOOK_SECRET` · `GROBLE_WEBHOOK_SECRET_PREVIOUS`(자유 가입판만 — 그로블 웹훅 서명 시크릿, 교체하는 24시간만 옛 값도 · §4-4) ·
`SE_TRUST_PROXY=1`(플랫폼 앞단 뒤) · `SE_WORKER=0`(웹만 — worker 는 `npm run worker` 로 따로, `WORKER_POLL_MS` 기본 2000) · `SE_MIGRATE_ON_BOOT`(기본 켬) · `DB_POOL_MAX`(기본 5) · `WORKER_CONCURRENCY` · (플랫폼이 AI 를 대 줄 때만) `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`·`GEMINI_API_KEY`.
**기관/개인의 API 키는 환경 변수에 두지 않는다** — DB 에 암호화(명세 AH-7).

## 4. Sprint 1 — 사용자가 할 일(계정 필요)

이 단계는 Replit·GitHub 계정 로그인과 비밀값 입력이 필요해서 사람이 한다. 코드는 준비되어 있다.

1. **가져오기**: replit.com 로그인 → **Import from GitHub**(replit.com/import) → GitHub 계정 연결/승인 → 저장소 `forsurvive/002` 선택 → Import.
   가져온 뒤 Git 창에서 브랜치 `claude/charming-keller-12p0c5`(또는 병합한 `main`)를 고른다.
2. **Secrets(작업 공간)**: `SE2_ACCESS_KEY` = 비밀번호 관리자로 만든 24자 이상의 무작위 문자열 · `SE2_MOCK` = `1`.
3. **Run**: 콘솔에 `Story Engine : listening on 0.0.0.0:…` 과 `Host names : …replit.dev` 가 찍히면 선 것이다.
   미리보기 창(iframe)에서는 로그인 창이 뜨지 않을 수 있다 → **새 탭으로 열기** → 사용자 이름은 아무것이나, 비밀번호 칸에 열쇠.
4. **확인**(명세 부록 AI 의 앞부분): 첫 화면 → 새 프로젝트(이름·형식·자료) → 문서 만들기·고치기 → 이력 복원 → 참조 걸기 → 확정본 켜기 → 갱신(모의 응답) → 논의 → 튜토리얼.
5. **게시**: Publishing → **Reserved VM** → **Web server** → 가장 작은 머신 → 실행 명령은 `.replit` 의 `[deployment] run` 그대로 →
   **Production app secrets** 에 `SE2_ACCESS_KEY`(작업 공간과 다른 값 권장) · `SE2_MOCK=1` → Publish.
   상태 검사는 첫 화면(`/`)을 두드린다 — 열쇠 없는 상태 검사에는 원고 없는 안내 페이지가 200 으로 답한다.
6. `https://<이름>.replit.app` 을 열어 3~4 를 한 번 더.

## 4-1. 온라인판 띄우기 — 사람이 할 일은 셋(2026-10-04 간소화)

[Run] 이 `online/start.mjs` 를 부른다. 그것이 스스로: 데이터베이스가 있으면 온라인판 · 없으면 개인판을 고르고,
온라인판 의존성을 설치(npm ci)하고, 마이그레이션을 적용하고, AI 키를 봉할 마스터 키가 Secrets 에 없으면 `data/online-master.key` 를 만들어 쓴다.
모델 표(`config/models.json` — Anthropic 세 tier)는 저장소에 들어 있다.

1. **최신 코드 받기** — Shell 에 한 줄 붙여 넣기(Replit Agent 가 바꿔 둔 것은 지우지 않고 한쪽에 치워 둔다):
   ```
   git fetch origin claude/charming-keller-12p0c5 && git stash -u ; git checkout -B claude/charming-keller-12p0c5 origin/claude/charming-keller-12p0c5
   ```
2. **데이터베이스 만들기** — 작업 공간 도구 목록의 Database 에서 PostgreSQL 을 만든다(Secrets 에 `DATABASE_URL` 이 저절로 들어온다).
3. **[Run] → 미리보기를 새 탭으로** → (계정이 없으면 **Console 에 찍힌 `[SETUP] First-run setup code`** 를 설정 화면에 넣는다) → **처음 설정 화면**에서 아이디 · 이름 · 비밀번호 · Anthropic API 키를 넣는다.
   계정이 하나도 없을 때 한 번만 나오는 화면이고, 설정 코드를 넣은 요청만 받는다(온라인판은 출입 열쇠를 쓰지 않는다). 키는 서버에서 봉해 저장되고 다시 보이지 않는다.

켜고 끄기(새 Replit 화면은 실행 중에 정지 단추를 숨긴다): 켜기는 초록 ▶(«실행»), 끄기는 Shell 에서 `npm run stop`,
최신 코드 받기는 Shell 에서 `npm run update`(끄고 → `git pull`) 뒤 ▶. `pkill` 무늬는 `[o]nline/start.mjs` 꼴이라 제 명령 줄은 죽이지 않는다.

그 뒤: 프로젝트를 만들면 «에이전트 준비»가 돌고, 문서의 [갱신] · 논의가 실제 AI 로 돈다.
**게시(배포)할 때만** `data/online-master.key` 의 값을 Secrets 의 `CREDENTIALS_KEY_V1` 으로 옮긴다(다시 게시하면 파일이 사라질 수 있다 — 콘솔 `[NOTE]` 가 알려 준다).

손으로 하는 길(선택): 계정 추가 `node online/admin.mjs create-user <아이디>` · 키 바꾸기 `node online/admin.mjs set-key <아이디> anthropic` · 개인판 작품 옮기기 `node online/import.mjs <파일> --owner <아이디>`.

## 4-2. 게시(Publish) — 따라 하기(2026-10-05, docs.replit.com «Publish your app» · «Development and production databases» 확인)

게시하면 **개발용과 따로인 운영 데이터베이스**가 생긴다(현재 Replit 인프라 «Helium» — 게시할 때 저절로 만들어지고 `DATABASE_URL` 도 저절로 꽂힌다).
그래서 게시한 주소에는 계정이 하나도 없다 — 처음 한 번 «처음 설정»을 한다(설정 코드는 게시 쪽 Logs 에 찍힌다). 개발용 데이터는 옮기지 않는다(시험 계정이 섞인다).

1. 작업 공간에서 최신 코드: Shell `npm run update` → ▶ 실행 → Preview 에서 로그인 · 작품 열기가 되는지 본다.
2. 운영용 마스터 키 만들기: Shell `npm run key` → 찍힌 한 줄(44자)을 복사해 둔다. **이 대화 · 문서 · 깃에는 붙이지 않는다.**
3. 오른쪽 위 **게시(Publish)** → 배포 종류 **Reserved VM**(Autoscale 아님 — 작업 worker 가 늘 돌아야 한다) → 기계는 가장 작은 공유 VM 이면 파일럿에 충분.
4. 게시 설정의 Secrets(«Adjust settings»/«Manage» 안)에 `CREDENTIALS_KEY_V1` = 2 에서 복사한 값. 운영 데이터베이스 설정이 보이면 «Create production database» 켜기 · 개발 데이터 복사는 끈다.
5. 접근은 **Public**(계정이 문을 지킨다) → **Publish** → 끝나면 `….replit.app` 주소를 연다.
6. 첫 화면이 «처음 설정»이면: 게시 화면의 **Logs** 에서 `[SETUP] First-run setup code: XXXX-XXXX-XXXX` 를 찾아 넣고 운영자 아이디 · 비밀번호를 정한다(운영용 새 계정).
   **Logs 가 비어 있으면**(2026-10-05 실제로 겪음): 게시 설정의 Secrets 에 `SE2_SETUP_CODE` = 스스로 정한 글자 · 숫자 12자 이상(예: 문장처럼 긴 것)을 넣고 **Republish** →
   처음 설정 화면의 «설정 코드»에 그 값을 친다(대소문자 · 띄어쓰기 · `-` 는 가리지 않는다). 계정을 만든 뒤에는 이 Secret 을 지워도 된다(계정이 있으면 처음 설정 화면이 다시 열리지 않는다).
7. 이후 고칠 때: 작업 공간 `npm run update` → Preview 확인 → **Republish**. 운영 데이터는 그대로다(마이그레이션은 서버가 켤 때 스스로 돈다).

**운영자 비밀번호를 잊었을 때**: 게시 설정의 Secrets 에 `SE2_RECOVERY_CODE` = 스스로 정한 글자 · 숫자 12자 이상 → Republish → 로그인 화면 «비밀번호를 잊었어요»에 운영자 아이디 · 그 값 · 새 비밀번호. 다 쓴 뒤에는 이 Secret 을 지운다(지우면 그 길은 닫힌다).
다른 사람(기관 관리자 · 강사 · 학생)은 한 단계 위 사람이 관리 화면에서 «비밀번호 재설정 코드»를 준다.

비용: Reserved VM 은 달마다 정액, 운영 데이터베이스는 쓴 만큼(5분 쉬면 계산이 멈춘다). 결제 수단을 물으면 그때 넣는다.

## 4-3. 운영자 구독 켜기(선택, 2026-10-07)

최상위 운영자 본인의 개인 작품을 API 키 대신 Claude 구독으로 돌리려면:

1. 자기 PC(브라우저가 있는 곳)에서 Claude Code 를 설치하고 `claude setup-token` → 화면에 나온 긴 토큰을 복사한다(Pro · Max 요금제, 1년짜리).
2. Replit → Secrets 에 `CLAUDE_CODE_OAUTH_TOKEN` = 그 토큰. 채팅 · 코드 · 파일에 붙여 넣지 않는다.
3. `npm run update` → Run(처음 한 번 Claude Code 실행기를 받아 온다) → [다시 게시].
4. 게시 사이트 «내 계정 → Claude 구독(운영자 전용)» 켜기 → [연결 확인].

## 4-4. 자유 가입판 띄우기 — 두 번째 앱(2026-10-09, docs/OPEN_EDITION.md §4-7 · §5)

코드는 같다 — 같은 GitHub 브랜치를 **App 하나 더**로 띄우고 `SE_EDITION=open` 만 다르다. DB 도 따로다(교육기관판의 계정 · 작품과 섞이지 않는다).

1. **App 하나 더**: replit.com/import 에서 같은 저장소(`forsurvive/002`)로 새 App → Git 창에서 브랜치 `claude/charming-keller-12p0c5`.
2. **데이터베이스**: 그 App 의 Database 에서 PostgreSQL 을 새로 만든다(`DATABASE_URL` 이 저절로).
3. **Secrets**: `SE_EDITION` = `open`. 게시할 때는 `CREDENTIALS_KEY_V1` 도(`npm run key` 로 **교육기관판과 다른 값**).
4. ▶ 실행 → Console 에 `Edition : open (open sign-up)` 가 찍히면 자유 가입판이다 → 처음 설정(운영자 계정). 처음 설정 전에는 가입을 받지 않는다(낯선 사람이 첫 계정을 차지하지 못하게).
5. **결제 옵션 넣기**: 관리 → 운영 → [결제 옵션] → [+ 새 결제 옵션] — 이름(사용자에게 보임, 예: «월 이용권(5,000원)») · 그로블 결제창 링크 · 가격 5000 · 주기 1.
6. **그로블 상품 설정**: «진입 페이지» = `https://<자유 가입판 주소>/login?signup`(가입 칸이 열린 첫 화면) · «이동 페이지» = `https://<자유 가입판 주소>/account.html?paid=1`(돌아오면 이용권을 1분까지 기다려 보인다).
   세 주소(진입 · 이동 · 웹훅)는 게시한 사이트의 운영 → [결제 옵션] 맨 위에 [복사] 단추와 함께 지어져 있다 — 손으로 짓지 않아도 된다.
7. **웹훅 연결**: 그로블 «내 스토어 → 연동» → URL `https://<자유 가입판 주소>/api/billing/groble`(운영 → [결제 기록]의 «받는 주소» [복사]) → 이벤트 여덟 모두 켜기 →
   **처음 한 번만 보이는 시크릿을 곧바로 Secrets 의 `GROBLE_WEBHOOK_SECRET` 에**(채팅 · 문서 · 깃에 붙이지 않는다) → 다시 게시(Secrets 는 다시 게시해야 들어간다).
   시크릿이 없을 때 온 웹훅은 503 으로 돌려보내 그로블이 다시 보낸다(약 44시간까지) — 그동안 운영 → [결제 기록]이 «시크릿 없음»을 붉게 보인다.
8. **확인**: 그로블 [테스트 발송] → [결제 기록]에 한 줄(테스트 값은 우리 참조값이 아니어서 «연결 안 됨» — [무시]로 닫는다) → **시험 결제 한 번 + 해지 한 번** →
   [결제 기록]에 «반영» 줄 · [고객]에서 그 사람의 «이용 중 → 해지 예정 → 끝남».

시크릿을 바꿀 때: 그로블에서 재발급 → 새 값을 `GROBLE_WEBHOOK_SECRET`, 옛 값을 `GROBLE_WEBHOOK_SECRET_PREVIOUS` 에 → 다시 게시 → 24시간 뒤 `…_PREVIOUS` 를 지운다(그동안 두 서명을 모두 받는다).
웹훅이 오래 끊겼으면(그로블은 20건 연속 실패 + 3일이면 엔드포인트를 끈다): [결제 기록]의 «소식이 늦은 정기결제» → [고객]에서 [기간 연장]으로 메우고, 그로블 «연동»에서 다시 켠다.

## 5. PostgreSQL (Phase 3 계획)

문서 발췌:
- **개발 DB**(작업 공간): PostgreSQL 16, `DATABASE_URL` 하나만(옛 `PG*` 변수는 예전 DB 에만), 그 App 안에서만 닿는다.
- **production DB**(게시): 개발 DB 와 따로. 게시할 때 만들어 주고 배포의 `DATABASE_URL` 을 넣어 준다. PostgreSQL 16/17(Neon 기반).
  **요청이 없으면 5분 뒤 잠들고 깨어 있는 시간만 과금**(2026-08 기준 활성 시간당 $0.16, 저장 GiB·월 $0.35, DB 당 10 GiB). 연결 풀링은 기본 꺼짐(`-pooler` 호스트).
- 백업: production DB 는 시점 복원(기본 7일, 요금제에 따라 28일까지). 동시 연결 상한은 **미확인** → 앱 풀은 작게(예: 웹 5 · worker 3).

설계에 주는 뜻:
- 마이그레이션은 `migrations/*.sql` 을 앞으로만 적용하는 작은 실행기(`online/migrate.mjs`)로, 게시 시작 때 한 번 돌린다. DB 를 손으로 고치지 않는다(명세 AH-8).
- **쉬는 동안 DB 를 두드리지 않는다** — worker 가 몇 초마다 큐를 SELECT 하면 DB 가 늘 깨어 있어 월 고정비가 된다(대략 $100 대).
  웹 → worker IPC 로 깨우고, 도는 작업이 있을 때만 heartbeat/회수 검사([JOB_SYSTEM.md](JOB_SYSTEM.md) §8).
- 파일럿 데이터 백업은 시점 복원 + 주기적 `pg_dump`(플랫폼 밖 보관) 둘 다.

## 6. 파일 저장 (Phase 9)

- Replit App Storage(옛 Object Storage, GCS 기반, GiB·월 $0.015). 접근에 npm 의존성(`@replit/object-storage` 또는 GCS 클라이언트)이 든다 — **미확인: 의존성 없이 쓰는 길**.
- 코드는 `ObjectStore` 포트(put/get/delete/signedUrl)만 알고, Replit/S3/로컬 디스크 구현을 갈아 끼운다.

## 7. 비용 감(2026-08 문서 발췌, 확인 필요)

| 항목 | 값 |
|---|---|
| Reserved VM 0.5 vCPU / 2 GiB(공유) | 시간당 $0.0208 (≈ 월 $15) |
| Reserved VM 1 vCPU / 4 GiB(전용) | 시간당 $0.0486 (≈ 월 $35) |
| Autoscale | 15분 무요청이면 잠듦 · 연산 단위 + 요청 수 과금 — 지금 판·worker 에 맞지 않음 |
| Production DB | 활성 시간당 $0.16 + 저장 |

AI 비용은 이와 따로다(명세 0-F) — 개인은 BYOK, 기관은 기관 credential.

## 8. 막힐 때

| 증상 | 까닭 / 할 일 |
|---|---|
| 콘솔에 `[STOP] … SE2_ACCESS_KEY is not set` | Secrets 에 열쇠를 넣는다(배포는 Production app secrets 따로) |
| 브라우저에서 `허락하지 않은 호스트 이름입니다`(403) | 그 이름이 `REPLIT_DOMAINS` 에 없다 — 사용자 도메인이면 다시 게시하거나 `SE2_ALLOWED_HOSTS` 에 더한다 |
| 게시 단계의 상태 검사 실패 | ① 콘솔에 찍힌 포트와 `.replit` 의 `[[ports]] localPort` 가 같은지 ② `externalPort = 80` ③ 첫 화면이 5초 안에 답하는지 |
| 로그인 창이 안 뜸 | 미리보기 iframe 이다 → 새 탭에서 연다 · 안내 페이지의 «들어가기» |
| 다시 게시했더니 프로젝트가 사라짐 | Sprint 1 은 파일 저장이라 정상이다(시험 데이터만) — Phase 3 에서 DB 로 |
| AI 작업이 «실패» | `SE2_MOCK=1` 이 없으면 CLI 를 찾다 실패한다(정상). 모의로 확인한다 |

## 9. 미확인 목록(배포 전 Replit 화면에서 확인)

- `deploymentTarget = "gce"` 가 Reserved VM 에 해당하는지(Publishing 화면에서 고르면 그 값으로 바뀐다 — 화면이 정본).
- 배포 환경에서 `PORT` 를 주는지, 준다면 `[[ports]] localPort` 와 같은 값인지.
- 상태 검사가 요구하는 상태 코드(지금은 «/ 가 200 으로 빨리»에 맞춰 두었다).
- Secrets: 작업 공간과 배포가 따로인지(2025-04 변경 기록은 «자동 동기화», 현재 문서는 «따로») — 화면에서 확인.
- production DB 의 동시 연결 상한.

참고(검색으로 확인한 문서 주소): docs.replit.com 의 `references/project-setup/configuration` · `features/project-setup/ports` ·
`references/publishing/reserved-vm-deployments` · `features/projects-and-artifacts/multiple-artifacts-vs-projects` ·
`core-concepts/project-editor/app-setup/secrets` · `references/data-and-storage/production-databases` · `cloud-services/storage-and-databases/object-storage` ·
`billing/deployment-pricing` · `cloud-services/deployments/troubleshooting` · `build/import-from-providers`.
