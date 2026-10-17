# 개인판 USB 휴대판 — 나만 쓰는 구독 사용량 버전 (2026-10-13)

> 사용자 요청(2026-10-13): «개인 PC에서 나만 사용할 구독 사용량 버전을 만들고 싶어. USB에 담아서 가지고 다니면서 여러 대의 윈도우 컴퓨터에서 옮겨가며 사용할 수 있어야 해.»
>
> 사용자 결정(같은 날): ① 전자책 · 이야기 **둘 다 — 프로젝트마다 고른다.** ② 구독 로그인은 **PC 마다 한다**(로그인 정보를 USB 에 봉해 두지 않는다).
> ③ **ChatGPT · Gemini 도 구독 사용량으로** 쓸 수 있게(§8).

«구독 사용량» = API 키가 아니라 **사용자 본인의 Claude 구독**(Claude Code 로그인)으로 부르는 것. 개인판이 처음부터 그렇게 돈다(DESIGN §0 · §6-2 · §6-3).
이 문서는 그 개인판을 **USB 한 폴더에 담아 여러 윈도우 PC 에서** 쓰기 위해 더한 것만 적는다. 개인판의 계약(포트 8801 · op 이름과 응답 꼴 · 한 폴더)은 그대로다.

---

## 1. 한 장 요약

| | |
|---|---|
| **폴더** | USB 의 아무 폴더 하나 — 앱 · `tools\node\node.exe`(휴대용 Node 22) · `tools\claude\claude.exe`(Claude Code) · `data\`(원고). 드라이브 문자(E: · F: …)가 PC 마다 달라도 돈다(박힌 경로가 없다 — DESIGN §6-3) |
| **켜기** | 그 폴더의 `스토리 엔진 개인판.cmd` 더블클릭. 설치 · 관리자 권한 · 레지스트리 없음 |
| **로그인** | 그 PC 에서 처음이면 검은 창이 묻는다 — [Enter] 이 창에서 Claude 브라우저 로그인(`claude auth login --claudeai`) · [S] 건너뛰고 앱을 열어 화면의 [설정]에서 Claude · ChatGPT 로그인. 로그인이 실패해도 앱은 연다(2026-10-17). 로그인 정보는 **그 PC 의 사용자 폴더**에 각 실행기가 둔다 — USB 에는 없다 |
| **안전** | `127.0.0.1` 에만 연다 · 같은 `data\` 를 두 곳에서 열지 않는다(잠금) · 뽑혀도 반쪽 파일이 남지 않는다(내려쓰기) · 켤 때마다 백업 한 벌 |
| **만들기 · 업데이트** | 아무 PC 에서 `node tools\usb-build.mjs --out <USB 의 폴더>` 한 줄 — 받는 곳 · 버전 · 해시를 맞춰 본다(§4) |
| **용도** | 프로젝트마다 «이야기» 또는 «전자책»(§7) |
| **ChatGPT · Gemini** | 설정 › 무엇으로 › [ChatGPT 구독] — 그 PC 에 로그인한 Codex CLI 로, 모델은 Codex 제 목록에서 고른다. [Gemini API 키] — 키 + 카탈로그의 모델(§8) |
| **크기** | 앱 약 1MB + node.exe 약 87MB + claude.exe 약 260MB(2026-10 기준) + 원고. **1GB 이상의 USB** 를 권한다 |

## 2. 폴더 그림

```
<USB>\<아무 이름>\
  스토리 엔진 개인판.cmd     더블클릭하는 한 장(ASCII · CRLF)
  README.md · DESIGN.md · 기획서.md · docs\
  tools\  web\  core\  ai\  config\      앱(만들기 도구가 옮겨 적는다)
  tools\node\node.exe                    휴대용 Node(윈도우 x64)
  tools\claude\claude.exe                Claude Code(윈도우 x64)
  .usb-build.json                        담은 버전 · 해시 · 앱 파일 목록(업데이트가 읽는다)
  data\                                  원고 — 만들기 도구는 읽지도 쓰지도 않는다
    projects\<id>.json                   작품 하나 = 파일 하나
    backup\projects\                     켤 때마다 한 벌(§3)
    auth.json                            무엇으로 부를지(구독 / API 키)
    .lock                                지금 이 상자를 연 PC(§3)
```

## 3. 안전

- **바깥에 열지 않는다.** 실행기(`tools/launch.mjs`)가 띄운 서버는 늘 `SE2_HOST=127.0.0.1` — 그 PC 에 남아 있던 호스팅 설정이 있어도 덮는다. 문지기(DESIGN «문지기»)는 그대로.
- **한 상자는 한 곳에서만**(`tools/datalock.mjs`). 서버가 서기 전에 `data\.lock` 에 PC 이름 · pid · 시각을 적고 1분마다 시각을 새로 적는다.
  - 다른 PC 가 3분 안에 적은 잠금이면 `[STOP] This data folder is open on another PC (...)` 하고 서지 않는다.
  - USB 를 켠 채 뽑았으면 잠금이 남는다 — **3분 뒤 저절로 버려진 것**이 된다(다음 PC 가 가져가며 `[NOTE]` 한 줄).
  - 같은 PC 의 다른 창은 그 창이 살아 있을 때만 막는다(포트 8801 도 이미 막는다).
  - 창을 닫거나(SIGHUP · SIGBREAK) Ctrl+C 로 끄면 잠금을 걷는다.
- **뽑혀도 깨지지 않게.** 모든 저장은 임시 파일에 쓰고 **디스크까지 내려 쓴 뒤(fsync)** 갈아끼운다(`store.writeText`). 그래서 도중에 뽑혀도 «옛 파일 그대로» 아니면 «새 파일 통째로»다.
  예외: 윈도우에서 갈아끼우기가 여섯 번 튕기면(백신이 붙든 때) 제자리에 쓴다(작업을 잃지 않는 편 — DESIGN §6-3). 그 순간에 뽑히면 깨질 수 있어 아래 백업이 있다.
- **백업 한 벌**(`tools/backup.mjs`). 켤 때마다 읽히는 작품 파일만 `data\backup\projects\` 에 옮겨 적는다. 깨진 파일은 옮겨 적지 않고(멀쩡한 백업을 덮지 않는다) 검은 창에 `[WARN] Could not read data/projects/<파일>` 로 알린다.
  되살리기: 프로그램을 끄고 `data\backup\projects\<파일>` 을 `data\projects\` 로 복사한다. 지운 작품의 백업은 다음에 켤 때 걷힌다. 설정 항목이 아니다(DESIGN «설정 탭»).
  USB 자체를 잃는 것에는 백업이 소용없다 — 가끔 [작품 파일 내려받기](DESIGN «작품 파일») 또는 폴더를 통째로 다른 곳에 복사해 둔다.

## 4. 만들기 도구 — `tools/usb-build.mjs`

```
node tools/usb-build.mjs --out <USB 의 폴더>                       처음 만들기 · 업데이트(같은 명령)
node tools/usb-build.mjs --out <USB 의 폴더> --node v22.23.3 --claude 2.1.296   판을 못박기
node tools/usb-build.mjs --out <USB 의 폴더> --skip-download       앱 파일만 바꾼다
```

| 무엇 | 어디서 | 버전 | 확인 |
|---|---|---|---|
| 앱 파일 | 이 저장소(도구가 있는 자리) — 실행기 · 서버(`tools/launch.mjs` · `tools/server.mjs` · `tools/usb-build.mjs`)에서 import 를 따라간 모듈 · 첫 화면(`web/index.html`)이 부르는 파일 · 모듈이 읽는 자료(`tools/prompts.data.json` · `tools/prompts.ebook.json` · `tools/books/` · `config/workflows/`) · 루트의 `.cmd` · `README.md` · `DESIGN.md` · `기획서.md` · `docs/PERSONAL_USB.md` · `docs/WORKFLOW.md` | 저장소 그대로 | 그 밖은 싣지 않는다 — 아래 «결제 기능 빼기» |
| `tools\node\node.exe` | `https://nodejs.org/dist/<판>/win-x64/node.exe` | 기본 `v22.23.3`(2026-09-23 Node 22 LTS) · `--node` 로 바꾼다 | 같은 폴더의 `SHASUMS256.txt` 에 적힌 sha256 |
| `tools\claude\claude.exe` | 앤트로픽이 npm 에 올린 윈도우 패키지 `@anthropic-ai/claude-code-win32-x64`(`registry.npmjs.org`) — 공식 설치기(`claude.ai/install.cmd`)가 받는 것과 같은 실행 파일 | 기본 `latest` · `--claude` 로 못박는다 | 레지스트리가 적은 sha512(`dist.integrity`) |

- **결제 기능 빼기**(사용자 지시, 2026-10-13 «결제 관련한 부가적인 기능들은 삭제해서»): 나만 쓰는 판이라 이용권 검사 없이 AI 작업이 늘 된다. 개인판 코드(`tools/` · `core/`)에는 원래 결제 로직이 없다.
  같은 저장소의 온라인 앱 몫 — 계정 · 이용권 · 체험 · 환불 · 운영 화면(`web/account.html` · `manage.html` · `login.*` · `school.*` · 약관 · 소개 · `policy.js`) · 온라인 어댑터(`ai/router.mjs` 따위) · 온라인 문서 · `online/` — 는
  **만들기 도구가 USB 에 싣지 않는 것으로** 뺀다(위 «앱 파일» — 따라간 것만 담는다. 스위치가 아니라 빌드에서 빼기). 저장소에서는 지우지 않는다(온라인 앱들이 쓰고, 그 시험이 지킨다).
  업데이트 때 지난번에 담았던 그런 파일이 USB 에 있으면 걷는다. 남는 것 하나: 개인판과 온라인판이 함께 쓰는 `web/app.js` 의 «이용권이 없어 …» 한 줄 — 온라인에 로그인한 사람(`S.me`)에게만 서고 개인판에는 `S.me` 가 없어 그려지지 않는다(시험이 지킨다).
- 해시가 맞지 않으면 쓰지 않고 멈춘다. 큰 파일은 임시 이름으로 다 쓴 뒤 갈아끼운다(도중에 뽑혀도 반쪽 exe 가 남지 않게).
- 담은 버전 · 해시 · 앱 파일 목록을 `.usb-build.json` 에 적는다. 다음 업데이트는 같은 판 · 같은 파일이면 다시 받지 않고, **지난 목록에만 있던 앱 파일**(지워진 코드)은 걷는다. `data\` 는 목록에 있어도 건드리지 않는다.
- 저장소 안(`--out` 이 이 폴더 아래)에는 만들지 않는다.
- 만드는 PC 에 Node 22 가 있어야 한다. 이미 만든 USB 가 있으면 그 안의 것으로 돌려도 된다: `<USB>\tools\node\node.exe tools\usb-build.mjs --out <다른 USB>`.
- 회사 망처럼 프록시가 있으면 `NODE_USE_ENV_PROXY=1` 과 `HTTPS_PROXY` 를 함께 준다(Node 22.21 이상).
- 앱 파일만 받는 길: 이 저장소를 내려받아(zip 또는 git) 그 자리에서 위 명령을 돌린다.

확인한 것(2026-10-13, 리눅스): 두 파일을 실제로 받아 해시를 맞춰 보았고(node.exe — PE32+ x86-64 · claude.exe 2.1.296 — PE32+ x86-64), 두 번째 실행은 다시 받지 않았다. 만든 폴더에서 `SE2_MOCK=1` 로 서버가 서고 `data\` 와 잠금이 그 폴더 안에 생겼다.

## 5. 쓰는 법

### 처음 한 번(USB 만들기)
1. 아무 PC(윈도우 · 맥 · 리눅스)에 Node 22 와 이 저장소를 둔다.
2. USB 를 꽂고 `node tools/usb-build.mjs --out <USB 의 폴더>`. 끝나면 `Done.` 과 Node · Claude 판이 찍힌다.
3. 지금 쓰던 개인판이 있으면 그 폴더의 `data\` 를 USB 폴더의 `data\` 로 복사한다(아래 «데이터 옮기기»).

### 앱 묶음(zip)으로 시작하기 — 만들기 도구 없이 (2026-10-13)
완성본(Node · Claude Code 포함)은 압축해도 약 143MB 라 대화로 보낼 수 있는 크기를 넘는다. 그래서 앱 묶음만 주고, **처음 한 번 실행이 나머지를 폴더 안으로 받아 와 완성본이 된다.**
1. 앱 묶음 `StoryEngineUSB.zip`(약 0.3MB)을 받아 **오른쪽 클릭 › 속성 › «차단 해제»**를 켠 뒤 원하는 곳에 푼다 — USB 든 PC 의 폴더(바탕화면 · `C:\StoryEngine` …)든 같다.
2. `스토리 엔진 개인판.cmd` 더블클릭. 처음 한 번만(인터넷 필요):
   - `tools\node\node.exe` 가 없으면 `.cmd` 가 윈도우에 들어 있는 `curl` 로 nodejs.org 에서 받아 **SHA256 을 맞춰 보고**(`certutil`) 맞을 때만 넣는다(약 90MB — 만들기 도구와 같은 판 · 같은 해시).
     받지 못하면(인터넷 없음 · curl 없는 옛 윈도우) PC 에 깔린 Node 를 쓰고, 그것도 없으면 받을 주소를 알린다.
   - 폴더의 node 로 도는 창은 Claude Code 가 없으면 **PC 에 깔지 않고 `tools\claude\` 로 받아 온다**(sha512 — `launch.mjs` 가 만들기 도구의 `fetchClaude` 를 쓴다). 이어서 로그인 → 앱.
3. 그 뒤로 그 폴더는 완성본이다 — 통째로 USB ↔ PC 로 복사해도 된다. Node · Claude Code 를 새로 받으려면 그 폴더에서 `tools\node\node.exe tools\usb-build.mjs --here`.

### PC 에서 쓰기
같은 폴더를 PC 의 아무 폴더에 두고 같은 `.cmd` 를 더블클릭한다 — USB 에서와 한 글자도 다르지 않다(박힌 경로 · 설치 · 레지스트리 없음). 작품은 그 폴더의 `data\` 에 쌓인다.
USB 와 PC 에 폴더를 하나씩 두면 원고도 두 벌이 된다(저절로 맞춰지지 않는다) — 한쪽을 정본으로 정하고, 옮길 때는 `data\` 를 통째로 복사하거나 [작품 파일 내려받기 / 가져오기]를 쓴다.

### 새 PC 에서
1. USB 를 꽂고 그 폴더의 `스토리 엔진 개인판.cmd` 를 더블클릭한다. 검은 창은 쓰는 동안 닫지 않는다.
2. 그 PC 에서 처음이면 검은 창이 «NOT SIGNED IN ON THIS COMPUTER YET»을 보이고 묻는다(Claude Code 는 USB 에 있어 설치하지 않는다).
   - **Enter** — 브라우저 로그인 창이 뜬다. claude.ai 계정으로 로그인하고 승인하면 앱이 뜬다.
   - **S** — 건너뛴다. 앱이 열리고 첫 화면에 «이 PC 에 AI 연결이 아직 없습니다 — [로그인]»이 선다. [로그인] → [Claude 로그인] 또는 [ChatGPT 로그인](§8-4).
     ChatGPT 계정만 있는 사람의 길이다(사용자 지시 2026-10-17 «로그인이 안 되어 있어도 간단히 등록»). 화면에서 ChatGPT 로그인을 마치면 그 길(ChatGPT 구독)로 돈다.
   - Claude 로그인이 실패하거나 중간에 그만두어도 앱은 연다(«[NOT LOGGED IN] … The app opens anyway»). 화면에서 다시 로그인한다.
   - 창 없이 띄웠으면(입력이 없는 자리) 묻지 않고 지금처럼 Claude 로그인을 띄운다. 점검은 `SE2_LAUNCH_ANSWER=s`(건너뜀)로 답을 미리 줄 수 있다.
3. 브라우저가 `http://127.0.0.1:8801` 로 열린다.
4. 다 쓰면 검은 창을 닫고, USB 를 «안전하게 제거»한 뒤 뽑는다.
5. **내 PC 가 아니면** 떠나기 전에 로그아웃한다 — 그 PC 에 로그인 정보가 남기 때문이다(§6). USB 폴더에서 주소창에 `cmd` 를 쳐 창을 열고 `tools\claude\claude.exe auth logout` · ChatGPT 로 로그인했으면 `tools\codex\bin\codex.exe logout`.

### 업데이트
- 앱 · Node · Claude Code 모두: 처음 만들 때와 같은 명령을 다시 돌린다. 원고는 그대로다.
- 프로그램이 켜져 있으면 먼저 끈다(돌고 있는 exe 는 바꿔 끼울 수 없다).

### 데이터 옮기기
- **원고는 `data\` 하나다.** 프로그램을 끈 뒤 그 폴더를 통째로 복사하면 된다(USB ↔ PC 하드 · 다른 USB).
- 두 곳에 사본을 두고 번갈아 쓰면 저절로 맞춰지지 않는다 — 늘 USB 의 것을 정본으로 들고 다닌다.
- 작품 하나만 옮길 때: 설정 탭 맨 아래 [작품 파일 내려받기] → 다른 쪽 작업실 «+» [작품 파일 가져오기](늘 새 작품으로).
- 남에게 USB 를 줄 때: `data\auth.json` 에 API 키를 넣어 두었으면 설정 › 무엇으로 › [키 지우기] 부터. 구독 로그인 정보는 USB 에 없다.

## 6. PC 에 남는 것

| 남는 것 | 자리 | 까닭 · 지우는 법 |
|---|---|---|
| **Claude 로그인 정보** | `%USERPROFILE%\.claude\` (`.credentials.json` 등) | 사용자 결정 «PC 마다 로그인». `claude.exe auth logout` 으로 지운다 |
| ChatGPT 로그인 정보(골랐을 때만) | `%USERPROFILE%\.codex\` (`auth.json` · `installation_id` 등) | PC 마다 로그인. `tools\codex\bin\codex.exe logout` |
| Claude Code 의 설정 · 상태 | `%USERPROFILE%\.claude.json` · `%USERPROFILE%\.claude\backups\` | Claude Code 가 켤 때마다 쓴다(리눅스에서 `auth status` 만 돌려도 생기는 것을 확인) |
| 호출 기록(원고가 든 대화) | `%USERPROFILE%\.claude\projects\` | 실행기가 `--no-session-persistence` 를 알면 **남지 않는다**(2.1.296 은 안다 — 동봉 판). 모르는 옛 실행기(데스크톱 앱에 딸린 것)를 쓰면 남는다 |
| 호출 한 벌의 임시 폴더 | `%TEMP%\se2-call-*` | 호출이 끝나면 지운다. 호출 도중에 뽑히면 남는다(시스템 프롬프트 한 장) |
| 브라우저 방문 기록 · `se-theme`(밝은/어두운) | 그 PC 의 브라우저 | 원고는 브라우저에 저장하지 않는다(`cache-control: no-store`). 남의 PC 면 시크릿 창으로 열어도 된다 |
| 윈도우가 스스로 남기는 것 | 프리페치 · 최근 항목 · 백신 검사 기록 | 앱이 막을 수 없다 |

남지 않게 한 것: Claude Code 를 그 PC 에 설치하지 않는다(USB 의 것) · 저절로 업데이트하며 PC 에 새 판을 깔지 않는다(`DISABLE_AUTOUPDATER=1`) · 레지스트리 · 시작 프로그램 · 서비스 없음.
USB 에 `tools\claude\` 가 없으면(만들기 도구 없이 복사만 한 폴더) 첫날 공식 설치기가 Claude Code 를 그 PC 에 깐다(`%USERPROFILE%\.local\bin\`) — DESIGN §6-2.

## 7. 용도 — 프로젝트마다 이야기 / 전자책

새 작품 창에서 **이야기 · 전자책** 을 고른다(기본 이야기). 전자책을 고르면 그 작품은 전자책 단계(`config/workflows/ebook.json`) · 글 종류 «전자책» · 회차 상한 없는 규격 · 화면 말 «작품 → 책» 으로 연다 — 온라인 «전자책 오토»(docs/EBOOK_EDITION.md)의 E0 와 같은 꼴.
고르는 것은 만들 때 한 번이다(에이전트가 그 종류로 지어지고 단계 기록이 그 템플릿에 묶이므로, 만든 뒤 바꾸지 않는다). 다른 용도로 쓰려면 새 작품을 만든다.
전자책 작품에는 **반자동 · 완전 자동 레일**이 선다(2026-10-13 사용자 결정 — DESIGN.md §5-1). 작품을 만든 뒤 위쪽 바의 [자동 실행]을 눌러 반자동 · 완전 자동을 고른다(누르지 않으면 지금처럼 완전 수동). 언제든 [중지] · 걸음마다 되돌리기(직접 만들거나 들여온 문서는 그대로). 개인판의 이야기 작품은 지금과 한 글자도 다르지 않다.
작업은 작품을 나가도 · 다시 켜도 이어지고 여러 작품이 함께 돈다(DESIGN.md §6-5) — USB 를 뽑았다 다른 PC 에서 켜도 끊긴 작업 · 레일이 그 자리에서 잇는다(그 PC 에서 로그인이 되어 있어야 한다).

## 8. ChatGPT · Gemini 구독 (사용자 지시, 2026-10-13 — «챗 지피티와 제미니도 구독 사용량으로»)

### 8-1. ChatGPT — 만들었다
- **길**: OpenAI 의 공식 Codex CLI 를 그대로 띄운다(`codex exec`, `tools/codex-cli.mjs` · `tools/call.mjs runCodexCall` · `ai/local-codex.mjs`). Codex 는 ChatGPT 요금제(Plus · Pro …)로 로그인해 쓰는 것이 공식 쓰임이고,
  OpenAI 문서는 `codex exec` 가 저장된 ChatGPT 로그인을 그대로 쓴다고 적는다(자동화에는 API 키를 권하고, «내 계정으로 돌려야 할 때 믿을 수 있는 자리»에서 ChatGPT 로그인을 쓰게 한다 — developers.openai.com/codex/auth · /codex/noninteractive, 검색 요약으로 확인. 이 작업 환경에서는 페이지를 직접 열지 못했다).
  이 앱은 그 사람의 PC 에서, 그 사람의 로그인으로, 그 사람의 작품에만 부른다 — 로그인 정보(`%USERPROFILE%\.codex\auth.json`)는 읽지도 옮기지도 않는다.
- **고르는 곳**: 설정 › 무엇으로 › **[ChatGPT 구독]**(`data\auth.json` 의 `mode: 'chatgpt'` — 그대로 · 구독 · API 키 옆의 네 번째 갈래). 그 PC 의 모든 작품이 ChatGPT 로 돈다. 클로드로 돌아가려면 다른 갈래를 누른다.
- **로그인**: PC 마다(사용자 결정). ChatGPT 구독을 골라 둔 채 `.cmd` 를 켜면 검은 창이 `codex login status` 를 보고, 안 되어 있으면 `codex login`(브라우저)을 띄운다. 그때는 클로드 로그인을 묻지 않는다.
  떠날 때: `tools\codex\bin\codex.exe logout`.
- **부르는 꼴**: `codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only -C <빈 임시 폴더> -o <끝 글 파일> -c model_instructions_file="<시스템 프롬프트 파일>" -`(프롬프트는 stdin).
  `--ephemeral` — 그 PC 에 대화 기록을 남기지 않는다. `read-only` — 파일을 고치거나 명령을 돌리지 못한다. 모델은 사람이 고른다(아래).
  부르기 전에 로그인을 본다 — 로그인이 없으면 Codex 는 실패하지 않고 «다시 잇는 중»으로 오래 버티므로(조사에서 확인), 띄우지 않고 «ChatGPT 로그인이 필요합니다»로 물러선다.
  돌려주는 꼴 · 동시 고삐(3) · 임시 폴더 · 끊기 · 실패 갈래는 클로드와 같다(한도 문구 «usage limit» → `quota-session`). 한도의 남은 양은 Codex 가 구조화해 주지 않아 보이지 않는다.
- **USB 에 담기**: `node tools/usb-build.mjs --out <USB 의 폴더> --with-codex` — OpenAI 가 npm 에 올린 `@openai/codex` 의 윈도우 판(dist-tag `win32-x64`)을 sha512 로 맞춰 보고
  `vendor/x86_64-pc-windows-msvc/` 를 `tools\codex\` 에 통째로 푼다(`bin\codex.exe` 와 곁 파일, 0.162.1 기준 약 460MB). 한 번 담으면 다음 업데이트 때 함께 바뀐다. 담지 않았으면 그 PC 에 깔린 Codex 를 쓴다.
  **담지 않았고 그 PC 에도 없으면 처음 쓸 때 받는다**(2026-10-13 윈도우 실측 — 없을 때 [ChatGPT 로그인]이 «실행기를 띄우지 못했습니다»로 멎었다):
  화면의 [ChatGPT 로그인]이나 ChatGPT 구독으로 켠 검은 창이 같은 곳 · 같은 sha512 확인으로 `tools\codex\` 에 받고(`usb-build.codexIntoFolder` — 휴대판 목록이 있으면 적어 두어 다음 업데이트 때 함께 바뀐다) 이어서 로그인을 띄운다.
  받는 동안 화면은 «ChatGPT 실행기(Codex)를 이 폴더로 받는 중». PC 에 깔지 않는다. 윈도우 x64 밖에서는 받지 않고 `npm i -g @openai/codex` 를 이른다.
- **확인 못 한 것**(로그인 없이 `--help` · 빈 HOME 으로만 조사): 실제 로그인 뒤의 끝 글 · 사용량 칸, `model_instructions_file` 이 기본 지시문을 «갈음»하는지(깃발은 받는 것을 확인), 윈도우의 `read-only` 모래 상자가 관리자 권한 없이 서는지(`codex-windows-sandbox-setup.exe` 가 곁에 있다), USB 에서 띄운 codex.exe 가 PC 에 무엇을 남기는지(`%USERPROFILE%\.codex\` — 로그인 · `installation_id` 등).

- **모델 고르기**(사용자 지시, 2026-10-13 «챗 지피티도 모델을 고를 수 있도록 해»): [ChatGPT 구독]을 고르면 그 밑에 «ChatGPT 모델» 줄이 선다 — 맨 앞 [Codex 기본] + 그 PC 의 Codex 가 `codex debug models` 로 내보이는 모델(visibility «list» 만 · 표시 이름).
  고른 것(이름)은 `data\auth.json` 의 `chatgptModel` 에 두고 `-m <이름>` 으로 싣는다. 목록은 Codex 의 것이라 코드에 모델 id 가 없다(원칙 4). 목록을 못 읽으면 «Codex 기본»만 선다.
  설정의 «모델»(opus · sonnet · fable)은 클로드에만 걸린다. 0.162.1 의 목록은 로그인 없이 읽힌다(조사로 확인) — 로그인한 요금제에서 그 모델이 실제로 열리는지는 확인 못 함.

### 8-2. Gemini — API 키로 만들었다(사용자 결정, 2026-10-13 «제미니 구독은 API키로»)
- **고르는 곳**: 설정 › 무엇으로 › **[Gemini API 키]** — 그 밑에 «Gemini 모델»(카탈로그 `config/models.json` 의 Gemini 세 등급을 표시 이름으로 — 기본 Balanced)과 «Gemini API 키» 칸.
  키는 Google AI Studio 에서 사람이 만들어 넣는다. 키는 `data\auth.json` 의 `geminiKey` 에만 두고 화면 · 상태 · 기록에 내려 주지 않는다(«들어 있음»만). [키 지우기]. 남에게 주는 USB 라면 먼저 지운다.
- **부르는 길**: 온라인판과 같은 어댑터(`ai/gemini.mjs` — fetch · 키는 `x-goog-api-key` 헤더에만) · 등급 → model id 는 카탈로그(`tools/catalog-local.mjs`) · 같은 동시 고삐(`call.withSeat`) · 같은 실패 갈래 · 잘리면 이어 쓰기(`ai/local-gemini.mjs`).
  실행기 로그인은 묻지 않는다. 비용은 Google 에 그 키의 종량으로 나간다(구독 사용량이 아니다 — 무료 등급이 있다).
- **구독 로그인(Gemini CLI)은 쓰지 않는다**: Google 계정 로그인(«Login with Google»)을 제3자 소프트웨어가 Gemini CLI 를 거쳐 쓰는 것을 Google 약관이 금하고 실제 계정 정지 사례가 있다(docs/OPEN_EDITION.md §1) — 그래서 사용자가 API 키 길을 골랐다.
- 확인 못 한 것: 실제 키로 부른 결과(모의 · 가짜 어댑터로만 시험).

### 8-4. 클릭과 붙여 넣기로 등록 (사용자 지시, 2026-10-13 — «챗 지피티 구독, 클로드/제미니 api발급을 클릭과 복붙 몇번으로» · «챗 지피티 api 간편 등록도» · «챗지피티가 로그인되어 있다면 자동으로»)
설정(첫 화면 [설정] · 작품 설정 탭 — 같은 칸) › 무엇으로 아래에 다섯 줄 — **Claude 구독 · ChatGPT 구독 · Claude API 키 · ChatGPT API 키 · Gemini API 키** 마다 «등록됨 / 등록 안 됨».
- **구독(Claude · ChatGPT) — [로그인] 한 번**: 누르면 서버가 그 회사의 실행기를 띄운다(`claude auth login --claudeai` · `codex login`, `tools/login.mjs`). 실행기가 브라우저를 연다 — 로그인 · 승인하면 끝.
  브라우저가 안 열리면 실행기가 찍은 로그인 주소를 [로그인 페이지 열기 ↗]로 보인다(그 회사의 자리 — claude.com · claude.ai · anthropic.com · openai.com 일 때만). Claude 가 코드를 보여 주면 [붙여 넣기]/칸 → 실행기에 그대로 건넨다.
  화면은 2초마다 상태를 보고, 끝나면 «등록됨». 로그인 정보는 각 실행기가 그 PC 의 사용자 폴더에 둔다 — 이 앱은 읽지도 옮기지도 않는다. 실측(리눅스 · 창 없이): 두 실행기 모두 주소를 찍고 기다린다. 윈도우에서 브라우저가 열리는지는 확인 못 함.
- **자동 등록**: Claude 는 그 PC 에 Claude Code 로그인이 있으면 처음부터 «등록됨»이고 «그대로»가 그것으로 돈다(지금까지와 같다).
  ChatGPT 는 그 PC 에 Codex 로그인(`%USERPROFILE%\.codex`)이 있으면 «등록됨» — 담아 온 Codex · 그 PC 에 깔린 Codex(PATH 의 codex.exe · npm 으로 깐 것의 진짜 실행 파일) 어느 것이든 그 PC 의 로그인을 읽는다.
  아직 아무것도 고르지 않은 PC(«그대로»)에서 Claude 로그인은 없고 ChatGPT 로그인이 있으면, 켤 때 **묻지 않고 ChatGPT 구독으로 돈다**(검은 창에 한 줄). 화면에서 ChatGPT 로그인을 마쳐도 그 길로 바뀐다. 둘 다 있으면 Claude 그대로 · 사람이 고른 갈래는 건드리지 않는다.
- **API 키(Claude · ChatGPT · Gemini) — ① ② 만**: [+ API 키 넣기 · 바꾸기] → 회사 고르기 → ① [키 만들기 페이지 열기 ↗](platform.claude.com/settings/keys · platform.openai.com/api-keys · aistudio.google.com/apikey) ② [붙여 넣기](클립보드) 또는 칸에 붙여 넣기
  → ③ 앞머리로 회사를 알아보고(`sk-ant-` Claude · `AIza` Gemini · 그 밖의 `sk-` ChatGPT) `data\auth.json` 에 저장하고, 값이 들지 않는 모델 목록 문으로 맞는지 본다(`tools/keytest.mjs` — 키는 헤더에만). 키는 다시 보이지 않는다.
  키를 넣었다고 저절로 그 키로 돌리지 않는다 — 값이 키 주인에게 나가는 길이라 [이 키로 돌리기]를 한 번 더 누른다.
- **ChatGPT API 키 길**(«ChatGPT API 키»): 온라인판과 같은 어댑터(`ai/openai.mjs`) · 모델은 카탈로그의 ChatGPT 세 등급을 표시 이름으로 · 같은 고삐(`ai/local-key.mjs` — Gemini 와 한 본체). 구독(Codex)과 달리 종량이다.
- 새 문: `login.start` · `login.code` · `login.status` · `auth.key`(개인판만 — 온라인판은 «여기서는 할 수 없습니다»). 있는 문의 이름 · 응답 꼴은 그대로.
- **등록된 계정 보이기**(사용자 지시, 2026-10-13 «등록된 계정 보이게» — 남의 PC 에 꽂으면 그 PC 주인의 로그인으로 묻지 않고 돌 수 있어서): «등록됨» 옆에 어느 계정인지 적는다(`login.status` 의 `claudeAccount` · `chatgptAccount`). 검은 창도 `Signed in : <이메일>` 한 줄.
  Claude 는 `claude auth status --text` 의 «Email» · «Login method»(보기: «이메일 · Claude Max»). ChatGPT 는 `codex login status` 가 이메일을 찍을 때만 — 0.162.1 은 «Logged in using ChatGPT» 만 찍고 `codex doctor --json` 도 계정을 가려서 **지금은 비어 있다**.
  이메일을 얻으려고 로그인 파일(`.codex\auth.json` — 토큰)을 열지는 않는다(§8-1 «로그인 정보는 읽지도 옮기지도 않는다»).
- 윈도우 실측(2026-10-13, Codex 가 없던 PC): [ChatGPT 로그인] → `tools\codex\` 에 0.162.1 을 받고 → 브라우저 로그인 → «ChatGPT 구독 등록됨». 앞서 그 PC 에서는 «실행기를 띄우지 못했습니다»로 멎었다.

### 8-3. 옛 기록 — Gemini 를 멈추고 물었던 까닭
- Gemini 는 Codex 처럼 Gemini CLI(`gemini -p`, `-o json`)를 띄울 수는 있다(조사로 확인). 그러나 **Google 계정 로그인(«Login with Google»)을 제3자 소프트웨어가 Gemini CLI 를 거쳐 쓰는 것을 Google 약관이 금하고, 실제 계정 정지 사례가 있다**(docs/OPEN_EDITION.md §1 · geminicli.com/docs/resources/tos-privacy — 검색 요약, 페이지를 직접 열지 못했다).
  이 앱이 Gemini CLI 를 띄우는 것이 바로 그 꼴로 읽힐 수 있다 — 잃는 것이 사용자의 Google 계정이라 사람이 정한다(CLAUDE.md «멈추고 묻는다» — 법률 · 정책).
- 약관에 걸리지 않는 길: Google AI Studio 의 **API 키**(구독 사용량이 아니라 종량 — 무료 등급이 있다). 온라인판에는 이미 Gemini 어댑터(`ai/gemini.mjs`)가 있어 개인판에 «Gemini API 키» 갈래로 붙일 수 있다.

## 9. 구독 규정 — «본인만 사용»

- 이 휴대판은 **본인의 Claude 계정으로, 본인이, 본인 작품에** 수정하지 않은 Claude Code 를 부른다. 여러 PC 에서 같은 사람이 로그인하는 것은 Claude Code 가 원래 하는 쓰임이다.
- 하지 말 것: USB 나 로그인된 PC 를 남이 쓰게 하는 것(계정 공유) · 이 폴더를 남에게 주며 내 로그인을 함께 쓰게 하는 것. 남에게 주는 USB 에는 내 로그인이 따라가지 않는다(PC 마다 로그인) — 그 사람은 자기 계정으로 로그인해야 한다.
- 앤트로픽 문서(docs/OPEN_EDITION.md §1): «제3자 개발자가 사용자 대신 Free · Pro · Max 자격으로 요청을 보내는 것»과 «로그인 정보 · 세션 토큰을 모으거나 저장하거나 중개하는 것»을 금한다. 이 휴대판은 토큰을 다루지 않고(로그인은 Claude Code 자신의 화면 · 자신의 자리), 남을 대신해 부르지 않는다.
  다만 «자동화된 대량 호출»이 구독 사용 정책에 어떻게 읽히는지는 앤트로픽이 정한다 — 한도(5시간 · 주간)를 넘기지 않게 개인판의 동시 고삐(`SE2_MAX_CALLS`, 기본 3)를 그대로 둔다.

## 10. 확인 못 한 것(이 작업 환경은 리눅스) — 윈도우에서 해 볼 순서

| 확인할 것 | 해 볼 순서 | 기대 |
|---|---|---|
| 동봉한 `claude.exe` 가 설치 없이 돈다 | 새 USB 를 만들고, Claude Code 가 깔린 적 없는 PC 에서 `.cmd` 더블클릭 | 검은 창 `Claude Code : <USB>\tools\claude\claude.exe (via: portable (tools/claude))` → 로그인 브라우저 → 앱 |
| 드라이브 문자가 달라도 돈다 | 같은 USB 를 E: 로 잡히는 PC 와 F: 로 잡히는 PC 에서 | 둘 다 같은 작품 목록 |
| 잠금 | ① PC A 에서 켠 채로 USB 를 뽑아 PC B 에 꽂고 켠다 ② 3분 기다려 다시 | ① `[STOP] ... on another PC (A)` ② `[NOTE] Took over a lock ...` 하고 선다 |
| 창 닫기로 잠금이 걷힌다 | 켠 뒤 검은 창의 X 로 닫고 `data\.lock` 이 있는지 본다 | 없다 |
| 기록이 PC 에 남지 않는다 | 생성 한 번 뒤 `%USERPROFILE%\.claude\projects\` 를 본다 | 이 앱의 호출 기록(`se2-call-` 이 든 폴더 이름)이 없다 |
| 자동 업데이트가 PC 에 깔지 않는다 | 며칠 쓰고 `%USERPROFILE%\.local\bin\claude.exe` · `%USERPROFILE%\.local\share\claude\` 를 본다 | 없다(전에 따로 설치한 적이 없다면) |
| 로그아웃 | `tools\claude\claude.exe auth logout` 뒤 다시 켠다 | 로그인 창이 다시 뜬다 |
| 회사 · 학교 PC | 이동식 드라이브의 실행 파일을 막는 정책(AppLocker 등)이 있으면 켜지지 않는다 | 그런 PC 에서는 쓸 수 없다 — 앱이 풀 수 없다 |
| ChatGPT 구독 | `--with-codex` 로 만든 USB · 설정 › 무엇으로 › [ChatGPT 구독] → 검은 창을 닫고 다시 켠다 → 로그인 → 문서 하나 생성 | 검은 창 `ChatGPT : <USB>\tools\codex\bin\codex.exe (via: portable (tools/codex))` · 생성 결과가 문서의 새 판으로. 관리자 권한 창이 뜨거나 «sandbox» 오류가 나면 알려 주십시오 |
| ChatGPT 모델 | 설정 › 무엇으로 › [ChatGPT 구독] 밑의 «ChatGPT 모델» 목록이 서는지 · 하나 골라 생성 | 목록이 뜨고, 고른 모델로 생성된다 |
| Gemini API 키 | [Gemini API 키] → 키 넣기 → 모델 고르기 → 문서 하나 생성 | 생성 결과가 새 판으로. 키가 틀리면 «로그인 필요» 갈래 |
| ChatGPT 기록이 남지 않는다 | 생성 뒤 `%USERPROFILE%\.codex\sessions\` 를 본다 | 이 앱의 호출 기록이 없다(`--ephemeral`) |
| 윈도우 ARM PC | `win32-arm64` 판은 아직 담지 않는다 | x64 에뮬레이션으로 돌 것으로 보지만 확인 못 함 |
