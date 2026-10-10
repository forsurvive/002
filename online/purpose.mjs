// 용도 축 — 코드는 하나, 용도는 둘(docs/EBOOK_EDITION.md §8). 환경 변수 SE_PURPOSE 하나로 고른다. 판(SE_EDITION)과는 따로 돈다.
//   novel(기본) — 지금 그대로: 새 작품은 «이야기 만들기» 단계 · 이름 «스토리 엔진».
//   ebook       — 전자책 오토: 새 책은 전자책 단계(config/workflows/ebook.json) · 이름 «전자책 오토» · 화면 말(작품 → 책 · 화 → 장).
// 모르는 값은 novel 로 읽는다(지금 앱이 저절로 바뀌지 않게).

export const PURPOSES = ['novel', 'ebook'];

const SHAPE = {
  novel: { name: '스토리 엔진', template: 'story_creation' },
  ebook: { name: '전자책 오토', template: 'ebook' },
};

export function purposeOf(env = process.env) {
  return String(env.SE_PURPOSE || '').trim().toLowerCase() === 'ebook' ? 'ebook' : 'novel';
}
// 화면 · 로그인 · 탭 제목에 보일 이름
export const purposeName = (purpose) => (SHAPE[purpose] || SHAPE.novel).name;
// 새 작품(책)이 쓸 단계 템플릿의 열쇠(config/workflows/<열쇠>.json)
export const purposeTemplate = (purpose) => (SHAPE[purpose] || SHAPE.novel).template;
