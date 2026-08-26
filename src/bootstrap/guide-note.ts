/**
 * 「시작 가이드」 메모 배선 — 첫 실행에 한 장 만들고, 설정에서 언제든 다시 연다.
 *
 * 역할: 본문 조립(`note/guide-note.ts`)과 코어의 원자적 선점(`claim_guide_note`)을 이어,
 * 창 부트스트랩이 부를 수 있는 두 동작으로 묶는다 — [`ensureGuideNote`](시작 시 1회)와
 * [`showGuideNote`](설정 「도움말」의 다시 보기). IO는 전부 주입받아 순수 판정만 남긴다.
 *
 * **왜 프론트가 만드는가**(Rust 부팅 시점이 아니라): 본문이 UI 문자열이라 언어팩이 번역할 수
 * 있어야 하고(`note/guide-note.ts` 모듈 주석), 이 기기의 전역 단축키 표기도 함께 넣어야 한다.
 * 대신 "정확히 한 장"은 프론트가 지키지 못하므로(창이 동시에 뜬다) 그 판정만 코어에 맡긴다.
 *
 * **어느 창이 부르는가**: 패널과 설정 창이다. 노트 창은 부르지 않는다 — 노트 창은 사용자가
 * 지금 **타이핑하는** 표면이라 가이드 창을 그 위에 띄우면 포커스를 뺏고, 그렇다고 안 띄우면
 * 선점 경쟁에서 노트 창이 이긴 실행에서만 가이드가 조용히 숨는다(누가 이기느냐에 따라 첫
 * 실행 경험이 갈린다). 시작 흐름은 자동시작·점프리스트가 아닌 한 **패널을 항상** 연다
 * (`lib.rs`의 `startup_plan` D1)이므로, 진짜 첫 실행은 패널이 반드시 이 함수를 부른다.
 * 자동시작으로 조용히 뜬 경우에는 사용자가 목록이나 설정을 처음 열 때 만들어진다.
 */
import { buildGuideNoteBody } from "../note/guide-note";
import {
  claimGuideNote,
  getGlobalHotkey,
  getPlatform,
  getSharedSettings,
  noteRead,
  summonNote,
} from "../shared/tauri";

/** [`ensureGuideNote`]·[`showGuideNote`]가 쓰는 IO(테스트 시 주입). */
export interface GuideNoteIO {
  /** 활성 로케일·이 기기의 단축키로 가이드 본문(마크다운)을 만든다. */
  buildBody(): Promise<string>;
  /** 가이드 자리를 선점하고 만든다 — 새로 만들었으면 그 id, 이미 있으면 null. */
  claim(body: string, force: boolean): Promise<string | null>;
  /** 기록된 가이드 노트 id(없으면 null). */
  guideNoteId(): Promise<string | null>;
  /** 그 id의 노트가 아직 있는지(사용자가 지웠을 수 있다). */
  noteExists(id: string): Promise<boolean>;
  /** 노트 창을 열고 앞으로 가져온다(보관돼 있었으면 함께 풀린다). */
  summon(id: string): Promise<void>;
}

/**
 * 첫 실행이면 가이드 메모를 한 장 만든다(이미 있으면 아무 일도 하지 않는다).
 *
 * `options.summon`이 true면 만든 직후 그 창을 연다 — 만들지 못했을 때(이미 있음)는 열지
 * 않는다. "이미 있는 가이드를 창 열 때마다 앞으로 끌어올리는" 동작이 되면 안 되기 때문이다.
 *
 * 실패를 삼키고 로그만 남기는 이유: 이 함수는 창 부트스트랩이 곁다리로 부르는 부가 기능이라,
 * vault 쓰기 실패 하나가 패널·설정 창의 마운트를 깨뜨려서는 안 된다. 선점만 되고 생성이
 * 실패한 경우는 코어가 기록을 되돌리므로(`claim_guide_note`) 다음 기회에 다시 시도된다.
 *
 * 돌려주는 값은 **이번 호출이 만든** 노트 id(안 만들었으면 null) — 테스트가 판정을 볼 수 있게.
 */
export async function ensureGuideNote(
  io: GuideNoteIO,
  options: { summon: boolean },
): Promise<string | null> {
  try {
    // 본문은 선점 전에 만든다 — 코어가 "선점 + 본문 기록"을 한 번에 하므로(빈 노트를 만들어
    // 두고 나중에 채우는 2단계가 아니므로) 본문이 먼저 있어야 한다.
    const body = await io.buildBody();
    const id = await io.claim(body, false);
    if (!id) return null;
    if (options.summon) await io.summon(id);
    return id;
  } catch (err: unknown) {
    console.error("[guide-note] ensure failed", err);
    return null;
  }
}

/**
 * 가이드 메모를 연다 — 있으면 그대로 소환하고, 없으면(지웠거나 기록이 남의 vault 것이면)
 * 새로 만들어 연다. 설정 「도움말 › 시작 가이드 다시 보기」의 알맹이.
 *
 * 실패는 **삼키지 않는다**(ensureGuideNote와 반대): 여기서는 사용자가 버튼을 눌러 결과를
 * 기다리므로, 조용히 아무 일도 안 일어나는 것보다 설정 화면이 실패를 말하는 편이 낫다.
 */
export async function showGuideNote(io: GuideNoteIO): Promise<void> {
  const existing = await io.guideNoteId();
  if (existing && (await io.noteExists(existing))) {
    await io.summon(existing);
    return;
  }
  // 기록이 있어도 노트가 없으면 `force`로 새로 만든다 — 없는 id를 그대로 두면 이 버튼이
  // 영영 아무 일도 하지 않는다.
  const id = await io.claim(await io.buildBody(), true);
  if (!id) throw new Error("guide note claim returned null");
  await io.summon(id);
}

/** 실제 IPC로 [`GuideNoteIO`]를 채운다(창 부트스트랩이 쓰는 배선). */
export function tauriGuideNoteIO(): GuideNoteIO {
  return {
    buildBody: async () => {
      // 단축키·플랫폼은 "모르면 안 쓴다"로 폴백한다(빈 문자열이면 본문이 조합 대신 "설정 ›
      // 단축키에서 확인"으로 바뀐다) — 지어낸 기본값으로 틀린 키를 안내하지 않는다.
      const [accel, platform] = await Promise.all([
        getGlobalHotkey().catch(() => ""),
        getPlatform().catch(() => ""),
      ]);
      return buildGuideNoteBody({
        newNoteAccel: accel,
        isMac: platform === "macos",
      });
    },
    claim: (body, force) => claimGuideNote(body, force),
    guideNoteId: () =>
      getSharedSettings().then(
        (s) => s.guide_note_id ?? null,
        () => null,
      ),
    // 존재 판정은 패널과 같은 관용구다 — `noteRead`가 없는 id에 reject하는 것을 그대로 쓴다.
    noteExists: (id) =>
      noteRead(id).then(
        () => true,
        () => false,
      ),
    summon: (id) => summonNote(id),
  };
}
