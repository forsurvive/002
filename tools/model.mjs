// 원소의 순수 동작은 core/domain/model.mjs 로 옮겼다(온라인화 Phase 1 — Core 분리).
// 이 파일은 개인판이 그것을 쓰는 자리다: 작법서 그릇(tools/books.mjs)을 잇고, 판·휴지통 상한을 환경 변수에서 읽어 꽂고, 지금까지의 이름을 그대로 내보낸다.

import { useBookSource, configureLimits } from '../core/domain/model.mjs';
import { bookText } from './books.mjs';

useBookSource(bookText);
configureLimits({ keepVersions: process.env.SE2_KEEP_VERSIONS, trashDays: process.env.SE2_TRASH_DAYS });

export * from '../core/domain/model.mjs';
