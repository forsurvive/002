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
| **로그인** | 그 PC 에서 처음이면 검은 창이 브라우저 로그인을 띄운다(`claude auth login --claudeai`). 로그인 정보는 **그 PC 의 사용자 폴더**에 Claude Code 가 둔다 — USB 에는 없다 |
| **안전** | `127.0.0.1` 에만 연다 · 같은 `data\` 를 두 곳에서 열지 않는다(잠금) · 뽑혀도 반쪽 파일이 남지 않는다(내려쓰기) · 켤 때마다 백업 한 벌 |
| **만들기 · 업데이트** | 아무 PC 에서 `node tools\usb-build.mjs --out <USB 의 폴더>` 한 줄 — 받는 곳 · 버전 · 해시를 맞춰 본다(§4) |
| **용도** | 프로젝트마다 «이야기» 또는 «전자책»(§7) |
| **크기** | 앱 약 2MB + node.exe 약 87MB + claude.exe 약 260MB(2026-10 기준) + 원고. **1GB 이상의 USB** 를 권한다 |

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
| 앱 파일 | 이 저장소(도구가 있는 자리) — `tools` · `web` · `core` · `ai` · `config` · `docs` · 루트의 `.cmd` · `README.md` · `DESIGN.md` · `기획서.md` | 저장소 그대로 | 온라인판(`online/` · `migrations/`) · 시험(`tools/test.mjs`, 저장소 전체를 본다) · 원고는 싣지 않는다 |
| `tools\node\node.exe` | `https://nodejs.org/dist/<판>/win-x64/node.exe` | 기본 `v22.23.3`(2026-09-23 Node 22 LTS) · `--node` 로 바꾼다 | 같은 폴더의 `SHASUMS256.txt` 에 적힌 sha256 |
| `tools\claude\claude.exe` | 앤트로픽이 npm 에 올린 윈도우 패키지 `@anthropic-ai/claude-code-win32-x64`(`registry.npmjs.org`) — 공식 설치기(`claude.ai/install.cmd`)가 받는 것과 같은 실행 파일 | 기본 `latest` · `--claude` 로 못박는다 | 레지스트리가 적은 sha512(`dist.integrity`) |

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

### 새 PC 에서
1. USB 를 꽂고 그 폴더의 `스토리 엔진 개인판.cmd` 를 더블클릭한다. 검은 창은 쓰는 동안 닫지 않는다.
2. 그 PC 에서 처음이면 브라우저 로그인 창이 뜬다 — claude.ai 계정으로 로그인하고 승인한다(Claude Code 는 USB 에 있어 설치하지 않는다).
3. 브라우저가 `http://127.0.0.1:8801` 로 열린다.
4. 다 쓰면 검은 창을 닫고, USB 를 «안전하게 제거»한 뒤 뽑는다.
5. **내 PC 가 아니면** 떠나기 전에 로그아웃한다 — 그 PC 에 로그인 정보가 남기 때문이다(§6). USB 폴더에서 주소창에 `cmd` 를 쳐 창을 열고 `tools\claude\claude.exe auth logout`.

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
자동 집필 «레일»(반자동 · 완전 자동)은 아직 어느 판에도 없다(EBOOK_EDITION 로드맵 E1~). 개인판의 이야기 작품은 지금과 한 글자도 다르지 않다.

## 8. ChatGPT · Gemini 구독

(이어서 적는다 — 조사 중)

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
| 윈도우 ARM PC | `win32-arm64` 판은 아직 담지 않는다 | x64 에뮬레이션으로 돌 것으로 보지만 확인 못 함 |
