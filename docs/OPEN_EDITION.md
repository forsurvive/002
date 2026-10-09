# 자유 가입판(개인 가입) — 검토와 설계안 (2026-10-07)

> 사용자 요청(2026-10-07): 자유 가입을 열고 · 계정마다 **본인의 구독 사용량**(Claude · ChatGPT · Gemini)으로 돌고 · 클릭 몇 번으로 구독 계정을 등록하고 ·
> 구독량을 다 쓰면 등록해 둔 API 키로 넘어가고(사이트 안에서 안내) · 프로그램 이용료는 **월 5,000원**, 외부 정기 결제(사용자가 말한 «래피드» · «그로블»)로.
> 강의용(교육기관판)과 자유 가입판을 나눈다. 서버는 Replit.
>
> 이 문서는 **아직 만들지 않은 것**의 설계다(2026-10-09 그로블 공식 가이드 반영). 아래 «사람이 정할 것»이 정해지면 이 문서를 고치고 만든다(CLAUDE.md «적히지 않은 기능은 만들지 않는다»).

## 1. 확인한 것 — 회사마다 «남의 구독으로 돌리기»가 되는가

| 회사 | 사용자의 구독으로 우리 서비스가 부르기 | 근거 |
|---|---|---|
| **Claude** | **금지(명시).** «제3자 개발자가 자기 앱에 Claude 로그인을 넣거나, 사용자 대신 Free · Pro · Max 자격으로 요청을 보내는 것을 허용하지 않는다. Claude 로그인 정보 · 세션 토큰을 모으거나 저장하거나 중개해서도 안 된다.» 예외: 플랫폼이 **수정하지 않은 Claude Code** 를 호스팅하고(상업 약관 동의 필요) 각 사용자가 **앤트로픽 자체 로그인 화면**으로 직접 로그인하는 경우 | [Claude Code · Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| **ChatGPT** | **공식 길이 있다 — 다만 승인제.** «Sign in with ChatGPT»(OAuth): 사용자가 «ChatGPT 요금제 사용»을 허락하면 요청이 그 사람의 Plus · Pro 한도에서 빠진다. 상용 앱은 «선정된 파트너 · 제한 시범», 요금제 사용은 «오픈소스 파트너 · 선정된 비공개 고객» | [OpenAI SIWC quickstart](https://developers.openai.com/siwc/quickstart) · [cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) (검색 요약으로 확인 — 이 작업 환경에서는 페이지를 직접 열 수 없었다) |
| **Gemini** | **금지(명시) · 실제 정지 사례.** Gemini CLI 의 OAuth 를 제3자 소프트웨어로 쓰는 것은 약관 위반, 계정 정지 사유. 권하는 길은 AI Studio · Vertex API 키 | [Gemini CLI FAQ](https://geminicli.com/docs/resources/faq/) · [ToS](https://www.geminicli.com/docs/resources/tos-privacy) · [Google 포럼 정지 사례](https://discuss.ai.google.dev/t/urgent-mass-403-tos-bans-on-gemini-api-antigravity-for-open-source-cli-users-paid-tier/124508?page=2) |
| **API 키(BYOK)** | 세 회사 모두 허용 — 사용자가 자기 키를 넣고 비용은 키 주인에게. **이미 만들어져 있다**(내 AI 키 · 연결 확인 · 회사 고르기) | Claude 문서의 같은 절(«키 주인에게 청구되고 재판매 · 중개하지 않으면 제한하지 않는다») |

참고: 지금의 «운영자 구독»(AI_PROVIDER §9-1)은 운영자 **본인의** 구독 · 본인 작품 · 수정하지 않은 Claude Code 이므로 위 Claude 문서의 «최종 사용자가 자기 구독으로 Claude Code 에 로그인» 범위다.
그 길을 가입자 전체로 넓히는 것은 위 표의 금지에 바로 걸린다.

## 2. 설계안 — 지켜지는 범위에서 «최대한 쉽게»

**코드는 하나, 판은 둘.** 폴더를 복사해 따로 키우면 고칠 때마다 두 번 고쳐야 하고 곧 서로 어긋난다(CLAUDE.md 원칙 — Core 하나).
같은 저장소 · 같은 코드에 `SE_EDITION=open | school` 하나를 두고, Replit 에 **앱을 하나 더** 만들어 `open` 으로 띄운다(DB 도 따로).

| | 교육기관판(`school`, 지금) | 자유 가입판(`open`) |
|---|---|---|
| 가입 | 초대 링크 · 운영자 발급 | **누구나 가입**(아이디 · 비밀번호 · 이메일 확인은 결정 후) |
| AI 비용 | 기관 키 | **본인 키(BYOK)** — 회사 셋 |
| 이용료 | 기관 라이선스 | **월 5,000원**(정기 결제) — 유효할 때만 «새 AI 작업» |
| 화면 | 관리 · 수업 | 관리 · 수업을 숨김 |

1. **키 등록을 «클릭 몇 번»으로**: 회사마다 3단계 안내 화면 — ① 키 만드는 페이지로 바로 가는 단추 ② 키 붙여 넣기(이미 줄바꿈 · 공백을 걷는다) ③ 자동 [연결 확인].
   Gemini 는 AI Studio **무료 키**로 시작할 수 있다고 안내한다(무료 등급의 한도 · 데이터 사용 조건을 함께 보인다).
2. **구독 로그인은 허락된 회사만, 허락된 뒤에**: ChatGPT 는 OpenAI 에 «Sign in with ChatGPT» 를 신청해 승인되면 붙인다(그때 «요금제 다 쓰면 내 API 키로»도 같은 회사 안에서 자동 전환).
   Claude 는 앤트로픽 상업 약관과 «사용자별 Claude Code 호스팅» 조건을 앤트로픽에 확인한 뒤에만. Gemini 는 하지 않는다.
3. **월 이용료**: 결제 대행의 정기 결제(구독) + 웹훅 → `subscriptions` 표(유효 · 만료 · 정지) → AI 작업 등록 직전 검사(코드 `subscription_inactive`) — SECURITY.md §7-0 에 이미 적어 둔 꼴.
   AI 비용(키 주인)과 이용료를 섞어 기록하지 않는다(원칙 7).

## 3. 결정(2026-10-07 ~ 10-09, 사용자)

1. **AI 는 세 회사 모두 «본인 API 키»** — 구독 로그인은 하지 않는다(§1 의 약관 때문에).
2. **같은 코드 두 판** — `SE_EDITION=open` 에서는 자유 가입판에 필요 없는 기능을 **화면과 서버 문 모두에서** 뺀다.
3. **월 이용료 결제는 래피드(Latpeed, https://www.latpeed.com/)** — 크리에이터용 링크 결제. 멤버십(정기 결제)은 래피드 **Pro 요금제**에서 된다(수수료 1.6% + 월 요금, 사업자 없이 판매 시작 가능 — 검색으로 확인:
   [가격](https://www.latpeed.com/price) · [disquiet 소개](https://disquiet.io/products/%EB%9E%98%ED%94%BC%EB%93%9C-latpeed) · [페이플 고객 사례](https://team.payple.kr/customer-story/latpeed)).
   **래피드 답(2026-10-08, 래피드 비즈니스 상담 채널)**: ① **웹훅으로 결제 · 취소 이벤트를 받을 수 있다.** 해지 이벤트는 «곧 추가 예정».
   ② **결제 단계에 설문을 자유롭게 넣어** 구매자 정보를 받을 수 있다. 안내: [웹훅 기능 가이드](https://mavrks.notion.site/webhook-guide)(이 작업 환경에서는 열리지 않았다 — 사람이 열어 확인).
   **가이드 원문(사용자가 옮겨 줌, 2026-10-08)**:
   - 이벤트 넷: 상품 결제 완료(단건) · 상품 결제 취소(단건 환불) · **멤버십 카드 등록**(구매자가 카드를 등록해 멤버십을 구매) · **멤버십 결제 취소**(판매자가 결제 건을 환불).
   - 연결: 상품(멤버십) 관리 → 외부 툴 연동 → 웹훅 [연결하기] → URL 저장. `POST` · `Content-Type: application/json` · `User-Agent: Latpeed Webhook`.
     **5초 안에 2XX** 를 돌려줘야 한다. 실패하면 [연동 오류 자세히 보기]에 남고, 고친 뒤 «연동 해제 → 다시 연결» — **다시 보내 준다는 말은 없다**(받는 쪽이 늘 살아 있어야 한다).
   - 본문:
     ```
     { "type": "NORMAL_PAYMENT" | "MEMBERSHIP_PAYMENT",
       "payment": { "orderId": "65f0…", "name": "…", "email": "…", "phoneNumber": "…", "amount": 1000,
                    "status": "SUCCESS" | "CANCEL", "date": "2025-04-23T00:00:00.000+09:00",
                    "method"?: "CARD", "canceledReason"?: "…", "option"?: "옵션 1",
                    "forms": [{ "question": "질문 1", "answer": "응답 1" }], "agreements": [{ "question": "동의사항 1", "answer": true }] } }
     ```
   - **웹훅 시크릿(서명)**: 판매자가 래피드에 시크릿을 정하면 머리글 둘을 함께 보낸다 — `X-Latpeed-Timestamp: 1780657200000`(밀리초) · `X-Latpeed-Signature: sha256=<hex>`.
     서명 = `HMAC-SHA256(timestamp + "." + 원본 본문, 시크릿)` 의 hex. 검증: 두 머리글을 읽고 → **파싱하기 전 원본 본문**으로 같은 서명을 셈하고 → 상수 시간 비교 → timestamp 가 5분 넘게 어긋나면 거부.
   - **멤버십 웹훅은 첫 결제 때만 온다**(래피드 답, 2026-10-08): «현재는 첫 결제 시에만 발송, 이후 자동 결제나 해지의 경우에도 웹훅이 발송되도록 업데이트 예정».
     → 지금 래피드 멤버십으로는 갱신 · 해지를 자동으로 알 수 없다(§3-4 의 갈림길).
   **그로블(Groble, https://www.groble.im/) 공식 가이드(사용자가 옮겨 줌, 2026-10-09 — 결제창 · 웹훅 · 웹훅 이벤트, 스키마 `version: 2026-04-30`)**:
   - **정기결제**(서비스 유형 · 주기 1~12개월)와 **결제창**(링크 하나로 붙이는 결제 페이지, 구매자는 가입 없이 휴대폰 인증 · 앱카드 · 카카오페이 · 네이버페이).
   - **회원 연결 `?ref=`**: 결제창 링크 뒤에 `?ref=<참조값>` → 웹훅 `data.object.sellerReference` 로 그대로 돌아온다. **최초 결제뿐 아니라 이후 모든 갱신 · 갱신 실패 · 해지 요청 · 해지 완료에도 같은 값**.
     규칙 `^[A-Za-z0-9\-_.:=~]{1,128}$`(어기면 값만 조용히 빠진다) · 주소창에 보이고 구매자가 바꿀 수 있으므로 **추측 못 할 무작위 토큰**을 쓰고 누구인지는 우리 서버가 안다.
   - **이벤트 여덟**: `payment.completed` · `payment.cancel_requested` · `payment.refunded` · **`subscription_payment.completed`**(최초 `INITIAL` 과 매 갱신 `RENEWAL`) ·
     `subscription_payment.refunded`(회차 환불 — 해지가 아니다) · **`subscription_payment.failed`**(갱신 실패, 기본 3회 · 1일 간격 재시도 → 유예 7일) ·
     **`subscription.cancel_requested`**(해지 «예고» — 이용 기간은 남는다) · **`subscription.terminated`**(해지 완료 — **차단은 이것으로만**, `termination.terminatedAt`).
   - 본문: `{ id, type, version, occurredAt, data: { object } }`. `object` 에 `merchantUid`(결제 건 — 정기결제는 회차마다 새로) · `sellerReference` · `buyer{displayName,email,phoneNumber}` ·
     `content{paymentType: SUBSCRIPTION}` · `pricing{finalAmount}` · `subscription{billingReason, currentRound, nextBillingDate, status, billingCycleMonths}` · `questionAnswers[]`(최초 결제만). 모르는 키는 무시(tolerant).
   - **서명**: `X-Groble-Signature = HEX(HMAC-SHA256(secret, "{X-Groble-Timestamp}.{원본 본문}"))`, timestamp 는 **초** · ±5분. 시크릿 교체 뒤 24시간은 `X-Groble-Signature-Previous` 도 받는다.
     시크릿은 웹훅 첫 등록 때 **한 번만** 보여 준다(재발급 24시간마다 가능).
   - **처리 규칙**: 10초 안에 2xx · `X-Groble-Idempotency-Key` 로 두 번 처리하지 않기 · **도착 순서 보장 없음 → `occurredAt` 로 판단** · 3xx 는 따라가지 않고 실패.
     **408 · 429 · 500~504 는 다시 보낸다**(최대 7회, 1분→…→24시간, 약 44시간) · 400 · 401 · 403 · 404 는 최종 실패 · **410 은 엔드포인트를 즉시 끈다**.
   - 환불: 구매자는 구매 후 7일 안에 취소 요청, 판매자가 승인 · 반려(정산 전이면 판매자가 직접 환불).
   - 수수료는 이 가이드에 없다 — 제3자 정리로 일반결제 4.4% · 정기결제 5.4%(부가세 별도) · 가입비 · 월 요금 없음([agentic30](https://agentic30.app/blog/groble-guide) · [keyzard](https://keyzard.cc/views/nb/LCw3JSVvam5nZWVtbWtsamptamluaW4)) — 그로블 «멤버십 안내»에서 사람이 확인.
4. **결제 대행은 그로블 정기결제로 확정**(2026-10-09, 사용자 — 사업자 없이 팔 수 있고 그로블 멤버십은 필요 없다) — 래피드 멤버십은 지금 첫 결제 웹훅뿐이라 갱신 · 해지를 알 수 없다. 그로블은 갱신마다 · 실패 · 해지 요청 · 해지 완료가 모두 오고,
   서명 · 다시 보내기 · 회원 연결(`?ref=`)까지 갖췄다. 사용자는 한 번 결제하면 매달 자동으로 이어지고, 운영자가 손댈 일이 없다.
   코드는 «결제 대행 어댑터»(`online/billing/groble.mjs`) 뒤에 두어, 래피드가 갱신 웹훅을 내놓으면 어댑터 하나로 갈아 끼울 수 있게 한다.

## 4. 만들 것(작은 단위 → 시험 → 커밋 차례)

**자유 가입판에서 뺄 것**(화면에서 숨기고, 서버 문은 404): 기관 · 수업 · 초대 링크 · 라이선스(이용 기간) · 기관 키 · 수업 현황 · 강사/기관 관리자 열람 · 수업 작품 복사 ·
«내 수업» 화면 · «새 수업 코드 넣기» · 기관 관리 탭. **남길 것**: 개인 작품의 모든 창작 기능(문서 · 판 · 참조 · 확정본 · 논의 · 합평 · 모순 검사 · 에이전트 · 단계 · 휴지통 · 가져오기/내보내기 · docx/pdf) ·
내 AI 키(세 회사) · 내 계정 · 운영 화면(운영자만: 사용자 · 감사 · 사용량 · 이용권) · 운영자 구독(운영자 본인만). 강의 카드는 개인 설정으로 기본 꺼짐.

1. **판 스위치** — `online/edition.mjs`(`SE_EDITION`, 기본 `school` = 지금 그대로). 서버가 `/api/state` 의 `me.edition` 으로 화면에 알리고, edu 문 표에서 `open` 이 쓰지 않는 문을 404 로.
   시험: 같은 시험이 두 판에서 각각 돈다(뺀 문은 open 에서 404, 남긴 기능은 그대로).
   → **만듦(2026-10-09)**: 모르는 값은 `school`(닫힌 쪽). open 에서 404 — 기관 · 이용 기간 · 수업 · 초대(`invite.*` · `login.available`) · 기관 키 · 수업 현황 · 기관 사람(`member.*`) · `project.copy_personal`,
   그리고 `audit.list` · `usage.summary` · `workflow.view/save` 에 `orgId` 를 실은 것. 수업에 만들기(`project.create classId`) 404 · 강사 · 기관 관리자 열람 없음(주인만) · `/school.html` → 첫 화면.
   `me.edition` 은 `/api/me` · `/api/state` · `me.memberships` · `GET /api/setup`(로그인 전 화면)에. 시험: `online/test.edition.mjs` + `test.server.mjs` 가 두 판에서 각각.
2. **자유 가입** — 로그인 화면에 «가입하기»(아이디 · 이름 · 비밀번호, IP 마다 가입 고삐). `school` 에서는 지금처럼 닫혀 있다(시험이 지키는 규칙 «가입 문이 없다»는 school 에서 그대로).
   → **만듦(2026-10-09)**: `POST /api/auth/signup {loginId, displayName, password}`(open 에만 — school 은 로그인 전 401 · 뒤 404 그대로). 이름은 60자까지.
   고삐: 같은 곳(IP)에서 15분에 시도 20번 · 1시간에 새 계정 5개(넘으면 429). **처음 설정(운영자 계정) 전에는 403 `setup_needed`** — 낯선 사람의 첫 계정이 처음 설정 문(계정이 없을 때만 열린다)을 닫지 못하게.
   만들면 곧바로 들어가 «내 계정»(키 넣기 · 이용권)으로 간다 · 감사 `auth.signup`. 로그인 화면 «처음 오셨나요? [가입하기]» — `/login?signup` 으로 오면 가입 칸이 열려 있다. 시험: `online/test.signup.mjs`.
3. **키 등록 안내** — «내 계정 → 내 AI 키»를 회사별 3단계(발급 페이지 바로가기 · 붙여 넣기 · 자동 연결 확인)로. Gemini 는 무료 키 안내.
4. **이용권(월 5,000원 · 그로블 정기결제)** — 새 AI 작업은 이용권이 «유효»할 때만(`subscription_inactive`). 편집 · 열람 · 내보내기는 늘 된다. AI 비용(본인 키)과 이용료를 섞어 기록하지 않는다(원칙 7).
   - **표**: `billing_refs`(사람 ↔ 무작위 참조값 — 사람마다 하나, 다시 만들 수 있음) · `subscriptions`(사람 · 상태 `active | past_due | cancel_pending | ended` · `paid_until` · `next_billing_date` · 마지막 반영 `occurred_at` · 출처) ·
     `billing_events`(받은 웹훅 원문 · `X-Groble-Idempotency-Key` 유일 · `type` · `occurredAt` · 결과 · 연결된 사람). 운영자만 운영 화면에서 본다(전화번호 · 이름은 가려서). 로그에는 개인정보를 쓰지 않는다.
   - **결제하기**: «내 계정 → 이용권»의 [결제하기] = 그로블 결제창 링크 + `?ref=<내 참조값>`(서버가 만든다 · 규칙 정규식으로 미리 검사). 화면: «이용권: ~날짜까지 · 다음 결제일 · 해지 예정이면 그 날짜».
   - **받는 문** `POST /api/billing/groble` — 원본 본문을 그대로 읽어 서명부터(시크릿은 Replit Secrets `GROBLE_WEBHOOK_SECRET`, 교체 중이면 `GROBLE_WEBHOOK_SECRET_PREVIOUS` 도 · 코드 · Git · 로그 · 오류 문구에 두지 않는다).
     서명이 틀리거나 timestamp 가 5분 밖이면 **401**(남기지 않는다 · 고삐). 시크릿이 서버에 없으면 **503**(그로블이 다시 보낸다 · 운영 화면에 «웹훅 시크릿 없음»).
     맞으면 `billing_events` 에 먼저 남기고(같은 Idempotency-Key 면 그대로 200) 반영한 뒤 **200**. DB 가 잠깐 안 되면 **503** → 그로블이 다시 보낸다(최대 약 44시간). **410 은 절대 돌려주지 않는다**(엔드포인트가 꺼진다).
     읽지 못한 꼴 · 연결 못 한 결제도 200 으로 받고 운영 화면에 «확인 필요»로 세운다.
   - **누구의 결제인가**: `sellerReference` → `billing_refs` → 사람. 없거나 모르는 값이면 `buyer.email` 이 가입 이메일과 같은 사람, 그래도 없으면 «연결 안 된 결제» → 운영자가 [이 계정에 연결].
     `merchantUid ↔ 사람` 을 완료 이벤트 때 남겨 두어 `subscription_payment.refunded`(참조값이 없다)도 잇는다.
   - **반영(순서가 뒤바뀌어도 맞게 — `occurredAt` 이 마지막 반영보다 이른 상태 변경은 기록만)**:
     · `subscription_payment.completed` · `content.paymentType: SUBSCRIPTION` · 금액이 상품가와 같음 → `active`, `paid_until = max(paid_until, nextBillingDate 그날 끝 + 여유 10일)`
       (여유 = 그로블의 갱신 재시도 3일 + 유예 7일 — 갱신 소식이 끝내 오지 않아도 저절로 끝난다). 금액이 다르면 반영하지 않고 운영자에게.
     · `subscription_payment.failed` → `past_due`(사용자 화면에 «결제가 실패했어요 — 카드를 확인해 주세요», 이용은 그대로). `isFinal` 이면 유예 종료 시각을 함께 보인다.
     · `subscription.cancel_requested` → `cancel_pending`(«~날짜까지 이용, 그 뒤 끝남» — `serviceEndsAt` 또는 `nextBillingDate`). **이 이벤트로 막지 않는다.**
     · `subscription.terminated` → `ended`, `paid_until = termination.terminatedAt`. 막는 것은 이것뿐.
     · `subscription_payment.refunded` → 기록하고 운영자에게(회차 환불은 해지가 아니다 — 끝낼지는 `terminated` 가 말한다).
     · 같은 사람이 해지 뒤 다시 결제하면 새 정기결제 — 같은 참조값으로 다시 `active`.
   - **손 연결(안전망)**: 운영 화면에서 [30일 연장] · [끝내기] · [이 계정에 연결]. 웹훅이 오래 끊긴 때(그로블은 20건 연속 실패 + 3일이면 엔드포인트를 끈다) 이것으로 메우고 그로블에서 다시 켠다.
5. **비밀번호를 잊었을 때** — 자유 가입에는 «윗사람»이 없다. 처음에는 운영자에게 문의 → 운영자가 재설정 코드 발급(지금 있는 기능). 이메일 재설정은 메일 발송 서비스 계정이 필요하다(사람).
6. **운영 화면 — 고객 · 결제 관리**(2026-10-09 사용자 지시: «고객과 결제 옵션을 조정할 수 있는 관리 페이지») — 최상위 운영자만. 지금의 운영 화면(사용자 · 감사 · 사용량)에 탭을 더한다.
   - **고객**: 가입한 사람 목록(아이디 · 이름 · 가입일 · 이용권 상태 `active | past_due | cancel_pending | ended | 없음` · 이용 기한 · 다음 결제일 · 마지막 결제) — 찾기 · 상태별 거르기.
     한 사람을 열면: 결제 기록(그 사람의 `billing_events`, 전화번호 · 이름은 가려서) · [기간 연장(일수)] · [이용권 끝내기] · [무료 이용 켜기/끄기](운영자가 주는 계정 — 결제 없이 이용) · [계정 정지/풀기] · 메모.
     손으로 바꾼 것은 모두 감사 기록(누가 · 언제 · 무엇을 · 왜)에 남는다. 그로블 쪽 정기결제(카드 청구)는 여기서 끊지 않는다 — 끊으려면 그로블 판매 관리에서(화면에 그 안내).
   - **결제 기록**: 받은 웹훅 전부(시각 · 종류 · 결과 · 연결된 사람) · «확인 필요»(연결 못 한 결제 · 금액이 다른 결제 · 읽지 못한 꼴)를 맨 위에 — [이 계정에 연결] · [무시].
     웹훅 상태: 시크릿 있음/없음 · 마지막으로 받은 시각(오래 끊기면 경고 — 그로블은 20건 연속 실패 + 3일이면 엔드포인트를 끈다).
   - **결제 옵션(요금제)**: 화면의 [결제하기]에 걸 상품 목록 — 이름 · 그로블 결제창 링크 · 가격 · 주기(개월) · 켜짐/꺼짐 · 보이는 차례. 웹훅의 `content.id` 와 짝지어 «이 상품의 이 금액이면 맞는 결제»로 본다.
     **가격을 바꾸려면 그로블에서 새 상품을 만들고 여기 새 줄을 넣은 뒤 옛 줄을 끈다**(그로블 정기결제는 판매된 옵션을 고칠 수 없다). 옛 상품을 쓰던 사람의 갱신은 계속 받는다.
   - **이용 규칙**: 가입 직후 무료 체험 일수(기본 0) · 결제 실패 · 해지 뒤 여유 일수(기본 10) · 이용권이 끝났을 때 막는 범위(새 AI 작업만 — 편집 · 열람 · 내보내기는 늘 된다, 원칙 6과 같이 바꿀 수 없음).
   - 금액 · 매출은 이 화면에만(운영자). 사용자 화면에는 자기 이용권 상태 · 기한 · [결제하기]만.
7. **Replit 에 두 번째 앱** — 같은 GitHub 브랜치 · 다른 DB · Secrets 에 `SE_EDITION=open`. (사람: 앱 만들기 · Secrets · 게시)

## 5. 사람이 할 것 · 정할 것

1. ~~래피드 확인~~ — 끝(2026-10-08): 결제 · 취소 웹훅 있음, 해지는 곧, 결제 단계 설문 있음.
2. ~~결제 대행 확정~~ — 끝(2026-10-09): **그로블 정기결제**. 사업자 없이 가능 · 그로블 멤버십 필요 없음(사용자 확인).
3. **그로블에서 상품 만들기** — 서비스 유형 · 정기결제 · 주기 1개월 · 5,000원 · **결제창**으로(옵션 하나). 진입 페이지 = 자유 가입판 주소, 이동 페이지 = «내 계정» 주소.
   정기결제는 판매된 옵션을 고칠 수 없다 — 가격을 바꾸려면 새 상품을 만든다.
4. 받는 문이 만들어진 뒤: 그로블 «내 스토어 → 연동»에 `https://<자유 가입판 주소>/api/billing/groble` 등록, 이벤트 여덟 모두 켜기 →
   **처음 한 번만 보이는 시크릿 키를 Replit Secrets 의 `GROBLE_WEBHOOK_SECRET` 에 바로 넣기**(대화창에 붙여 넣지 않는다) → [테스트 발송] → **시험 결제 한 번 + 해지 한 번** → 운영 화면 «결제 기록»에서 확인.
5. 이용약관 · 개인정보처리방침(결제 대행에서 받는 이름 · 이메일 · 전화번호를 적는다) · 환불 규정(그로블: 구매 후 7일 안 취소 요청) · 미성년자 가입 기준(SECURITY.md §7).
6. 두 번째 Replit 앱 만들기(4-7).

## 6. 이어 갈 때

새 대화에서: «docs/README.md 와 docs/OPEN_EDITION.md 를 읽고 §4 의 차례대로 자유 가입판 · 그로블 정기결제(§3-3 · §4-4) · 고객 · 결제 관리 화면(§4-6)을 만들어 줘. 한국어로 작업해.»
