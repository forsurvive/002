-- 생성 기록에 «무엇을 보냈나»의 지문(명세 부록 J · docs/ERD.md generation_runs)
-- · prompt_checksum : 시스템 프롬프트(내장 · 고쳐 쓴 · 지어진 에이전트 프롬프트)의 sha256 — 같은 지시로 돌았는지
-- · prompt_sha256   : 보낸 전체(시스템 + 본문)의 sha256 — 본문 원문은 남기지 않고 같은 입력인지만 가린다
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS prompt_checksum text NOT NULL DEFAULT '';
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS prompt_sha256 text NOT NULL DEFAULT '';
