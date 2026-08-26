/**
 * 플러그인 호스트 클라이언트 — 노트 창이 중앙 호스트의 디스크립터 스냅샷을 받아 CM 확장을
 * **로컬에서** 인스턴스화하고, 런타임 특권 호출만 호스트와 왕복한다.
 *
 * 역할: (1) 스냅샷 요청/수신(재시도 폴링 — 호스트가 아직 빌드 중이어도 결국 받는다).
 * (2) 스냅샷 → CM 확장 조립: 패턴 매칭·데코레이션·임베드 게이트 평가 같은 고빈도 경로는
 * 노트 창 로컬에서 돌아 지연이 없다. per-plugin grant가 스냅샷에 실려 오므로 임베드 도메인
 * 게이트(`embed:<domain>`)·데이터 서비스 연결(notes:read/windows) 판정이 기존과 동일하다.
 * (3) 툴바 버튼은 클릭 시 [`EV_BUTTON_INVOKE`]로 호스트에 위임한다(지연 비민감 경로).
 * (4) 호스트가 위임한 창-스코프 호출([`EV_WINDOW_CALL`])을 로컬 서비스로 수행해 회신한다.
 * 왜: 샌드박스 실행(창 N×플러그인 M)을 중앙 호스트 1회로 모으면서도, 에디터 체감 성능과
 * 권한 의미(게이트 동작)를 그대로 유지하기 위한 노트 창 쪽 절반이다.
 */
import { checkPermission } from "./permissions";
import { bridgeError, type MemoErrorCode } from "./host";
import {
  buildInlinePatternExtension,
  buildInlinePatternMeta,
  buildPluginEditorExtension,
  type InlinePatternDescriptor,
} from "./editor-api";
import { renderInlineStyleCss } from "./inline-style";
import type { PluginToolbarButton, WhenTerm } from "./loader";
import {
  EV_BUTTON_INVOKE,
  EV_PLUGIN_EVENT,
  EV_SNAPSHOT,
  EV_SNAPSHOT_GET,
  EV_WINDOW_CALL,
  EV_WINDOW_RESULT,
  type HostEventBus,
  type HostSnapshot,
  type MemoEventName,
  type PluginSnapshot,
  type SnapshotPayload,
  type WindowCallPayload,
} from "./host-protocol";
import { readNoteSelection } from "../note/editor";
import type { SelectionActionItem } from "./selection-action";
import type { PluginGrant } from "./permissions";
import type { Extension } from "@codemirror/state";

/** 스냅샷 요청 재방송 간격(ms) — 호스트가 늦게 뜨거나 빌드 중일 때를 대비한 폴링. */
const SNAPSHOT_RETRY_MS = 250;

/**
 * 스냅샷 대기 총 상한(ms) — 초과 시 플러그인 없이 진행(호스트 웹뷰 이상 등 비정상 상황).
 *
 * export하는 이유: `bootstrap/note.ts`의 재빌드 재조회(`applyHostUpdate`)가 순수 IPC
 * (`getSharedSettings`·`getVaultPath`, 상한이 없다)를 이 스냅샷 조회와 같은 수준으로
 * 감싸는 데 재사용한다 — 셋이 한 `Promise.all`로 묶여 있으므로 상한이 다르면 가장 짧은
 * 쪽이 무의미해진다.
 */
export const SNAPSHOT_BUDGET_MS = 10_000;

/** 스냅샷 요청 옵션(테스트 시 간격·상한 축소 주입). */
interface SnapshotFetchOptions {
  bus: HostEventBus;
  /** 중앙 호스트 창이 살아있는지(없으면 기다리지 않고 즉시 폴백). */
  hostAlive(): Promise<boolean>;
  retryMs?: number;
  budgetMs?: number;
}

/**
 * 중앙 호스트에 디스크립터 스냅샷을 요청한다(재시도 폴링, 실패 시 null).
 *
 * 역할: 호스트 창 존재를 먼저 확인하고(부재 시 즉시 null — Tauri 밖 e2e·비정상 상황
 * 폴백), 존재하면 같은 requestId로 요청을 재방송하며 응답을 기다린다. 호스트는 빌드
 * 중이면 요청을 큐에 쌓았다가 완료 후 응답하므로, 앱 콜드 스타트에서 노트 창이 호스트보다
 * 먼저 떠도 결국 최신 스냅샷을 받는다. 상한 초과면 null(호출자는 플러그인 없이 진행).
 */
export async function fetchHostSnapshot(
  opts: SnapshotFetchOptions,
): Promise<HostSnapshot | null> {
  const alive = await opts.hostAlive().catch(() => false);
  if (!alive) return null;
  const retryMs = opts.retryMs ?? SNAPSHOT_RETRY_MS;
  const budgetMs = opts.budgetMs ?? SNAPSHOT_BUDGET_MS;
  const requestId = `snap-${Math.random().toString(36).slice(2)}`;

  return new Promise<HostSnapshot | null>((resolve) => {
    let done = false;
    /** 타이머·리스너를 정리하고 한 번만 해소한다(중복 응답·지연 응답 무시). */
    const finish = (value: HostSnapshot | null) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(budget);
      unlisten();
      resolve(value);
    };
    const unlisten = opts.bus.listen(EV_SNAPSHOT, (payload) => {
      const p = payload as SnapshotPayload | null;
      if (!p || p.requestId !== requestId) return;
      if (!p.snapshot || !Array.isArray(p.snapshot.plugins)) return;
      finish(p.snapshot);
    });
    const poll = setInterval(
      () => opts.bus.emit(EV_SNAPSHOT_GET, { requestId }),
      retryMs,
    );
    const budget = setTimeout(() => finish(null), budgetMs);
    opts.bus.emit(EV_SNAPSHOT_GET, { requestId });
  });
}

/**
 * 스냅샷 프라미스를 상한(ms)과 레이스한다 — 노트 마운트가 호스트에 블로킹되지 않게.
 *
 * 역할: 상한 안에 스냅샷이 오면 그대로 돌려주고(정상 경로 — 테마 즉시 확정), 늦으면
 * null을 돌려줘 호출자가 기본 테마로 즉시 마운트하게 한다. 원 프라미스는 계속 진행되므로
 * 플러그인 확장·버튼은 늦게 도착해도 적용될 수 있다(도착 시 적용).
 * 왜: 호스트 창이 "살아있지만 웹뷰가 무응답"인 최악 경로에서도 노트 열림이 스냅샷
 * 예산(10s)에 묶이지 않게, 마운트 대기 상한을 분리한다.
 */
export function raceSnapshot(
  snapshot: Promise<HostSnapshot | null>,
  waitMs: number,
): Promise<HostSnapshot | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), waitMs);
    void snapshot.then((s) => {
      clearTimeout(timer);
      resolve(s);
    });
  });
}

/** 노트 창이 CM 확장 배선에 제공하는 데이터 서비스(권한 통과 시에만 연결된다). */
interface SnapshotEditorServices {
  noteTitles(): Promise<string[]>;
  resolveTitleToId(title: string): Promise<string | null>;
  summon(id: string): void;
  /** 링크를 시스템 기본 브라우저로 넘긴다(`browser:open` 승인 플러그인의 패턴 클릭). */
  openUrl(url: string): void;
}

/**
 * 권한이 없어 수행할 수 없는 클릭 동작을 `"none"`으로 낮춘다(순수, 가드 테스트용).
 *
 * 역할: `open-note`는 `notes:read`+`windows`, `open-url`은 `browser:open`이 있어야 한다.
 * 없으면 스타일은 그대로 두되 링크 표식을 떼어, 눌러도 아무 일이 없는 가짜 링크를 없앤다.
 * 왜 여기인가: 등록 시점에는 아직 사용자 승인이 오갈 수 있어 판정이 이르다 — 스냅샷을
 * 소비하는 창이 그 시점의 grant로 정한다(임베드 도메인 게이트와 같은 결).
 */
export function gatePatternActions(
  patterns: InlinePatternDescriptor[],
  grant: PluginGrant,
): InlinePatternDescriptor[] {
  const canOpenNote =
    checkPermission(grant, "notes:read").allowed &&
    checkPermission(grant, "windows").allowed;
  const canOpenUrl = checkPermission(grant, "browser:open").allowed;
  return patterns.map((pattern) => {
    const action = pattern.action ?? "open-note";
    const allowed =
      action === "none" ||
      (action === "open-note" && canOpenNote) ||
      (action === "open-url" && canOpenUrl);
    return { ...pattern, action: allowed ? action : "none" };
  });
}

/**
 * 플러그인 grant로 임베드 도메인 게이트 함수를 만든다(순수, 가드 테스트용).
 *
 * 역할: 최종 임베드 URL의 hostname이 **그 플러그인**의 granted `embed:<domain>`과 정확히
 * 일치할 때만 렌더를 허용한다 — 디스크립터가 중앙 호스트에서 직렬화되어 와도 게이트가
 * per-plugin으로 유지되는 지점이다(다른 플러그인의 부여로는 절대 통과하지 않는다).
 */
export function embedGateFor(grant: PluginGrant): (domain: string) => boolean {
  return (domain) => checkPermission(grant, `embed:${domain}`).allowed;
}

/**
 * 스냅샷의 디스크립터들을 CM 확장으로 로컬 인스턴스화한다(플러그인 실행 없음).
 *
 * 역할: 각 플러그인 스냅샷의 grant로 데이터 서비스 연결 여부(notes:read/windows)를
 * 판정하고, [`buildPluginEditorExtension`]으로 확장을 만든다 — 기존 per-window 로더의
 * 배선 규칙과 동일하다(권한 없으면 무력 서비스, 임베드는 per-plugin 도메인 게이트).
 * 왜: 고빈도 경로(패턴·데코레이션·임베드 게이트)를 노트 창 로컬에 남겨 지연을 없앤다.
 *
 * **인라인 패턴만 예외적으로 전 플러그인을 한 목록으로 합쳐 한 번 만든다**
 * ([`buildInlinePatternExtension`]). 왜: 겹치는 매치의 승자를 가리는 규칙은 한 데코레이션
 * 집합 안에서만 돈다 — 플러그인마다 확장을 따로 만들면 같은 구간을 잡은 두 패턴이 **둘 다**
 * 그려진다(「글자 색」 `{{할일|#f36}}`이 「키 표시」의 키캡 상자까지 함께 뒤집어쓰던 버그).
 * 순서는 스냅샷의 플러그인 순서(= 번들→설치 등록 순서)를 그대로 이어 붙인 것이고, 실제
 * 승패는 그 안에서 [`patternSpecificity`]가 가른다.
 *
 * 합쳐도 권한 경계가 무너지지 않는 이유: 클릭 동작은 이미 [`gatePatternActions`]가
 * 플러그인별 grant로 `"none"`까지 낮춰 놓았고(그 판정 조건이 아래 `canOpen`과 **같은 식**
 * 이다), `"none"`인 패턴은 링크 표식 자체가 붙지 않아 클릭 핸들러에 도달하지 못한다.
 * 즉 합친 뒤 남는 `open-note`/`open-url`은 이미 그 플러그인이 승인받은 것들뿐이다.
 *
 * 결과를 **렌더(`render`)와 메타(`meta`)로 갈라 돌려준다**. 노트 창은 프리뷰를 끄면 렌더만
 * 내리고 메타는 계속 살려 둔다(editor.ts) — 메타는 그리는 것이 아니라 "색을 넣을 때 어떤
 * 구분자로 감싸는가" 같은 사실이라, 원문 모드에서도 입력 도구(선택 툴바 색 버튼)가 알아야 한다.
 * 한 덩어리였을 때는 프리뷰를 끄는 순간 색 버튼이 사라져 색을 넣을 방법이 없었다.
 */
export function buildExtensionsFromSnapshot(
  snapshot: HostSnapshot,
  services: SnapshotEditorServices,
): { render: Extension; meta: Extension } {
  const patterns = snapshot.plugins.flatMap((plugin: PluginSnapshot) =>
    gatePatternActions(plugin.patterns, plugin.grant),
  );
  const render: Extension = [
    buildInlinePatternExtension(patterns, {
      openByTitle: (title) => {
        void services.resolveTitleToId(title).then((id) => {
          if (id) services.summon(id);
        });
      },
      // 동작 게이트가 이미 `browser:open` 없는 패턴을 `"none"`으로 낮췄으므로 여기서
      // 다시 막지 않는다 — 게이트가 한 곳이어야 둘이 어긋나지 않는다.
      openUrl: services.openUrl,
    }),
    ...snapshot.plugins.map((plugin: PluginSnapshot) => {
      const canRead = checkPermission(plugin.grant, "notes:read").allowed;
      const canOpen =
        checkPermission(plugin.grant, "windows").allowed && canRead;
      return buildPluginEditorExtension(
        // 패턴은 위에서 전 플러그인을 합쳐 이미 만들었다(겹침 해소가 한 집합에서만 돈다).
        [],
        plugin.completions,
        plugin.embeds,
        {
          noteTitles: canRead ? services.noteTitles : async () => [],
          openByTitle: canOpen
            ? (title) => {
                void services.resolveTitleToId(title).then((id) => {
                  if (id) services.summon(id);
                });
              }
            : () => {},
          openUrl: services.openUrl,
          allowEmbedDomain: embedGateFor(plugin.grant),
        },
      );
    }),
  ];
  return { render, meta: buildInlinePatternMeta(patterns) };
}

/**
 * 스냅샷의 모든 인라인 패턴 스타일을 네임스페이스 CSS 텍스트로 모은다(순수, 가드 테스트용).
 *
 * 역할: 각 플러그인 패턴의 검증된 style/styleHover를 `.cm-x-<plugin>-<pattern>` 규칙으로
 * 렌더해 이어붙인다(값은 호스트가 이미 화이트리스트로 검증·토큰 해석한 것). 노트 창이 이
 * 텍스트를 `<style>` 요소에 주입해 데코레이션 클래스에 스타일을 입힌다.
 * 왜: 스타일 조립을 순수 함수로 분리해 스냅샷 없이 단위 테스트한다(주입은 노트창의 얇은 side effect).
 */
export function collectPluginStyleCss(snapshot: HostSnapshot): string {
  return snapshot.plugins
    .flatMap((plugin) =>
      plugin.patterns.map((p) =>
        renderInlineStyleCss(p.className, p.style, p.styleHover),
      ),
    )
    .join("");
}

/**
 * 노트 창이 렌더하는 플러그인 항목 하나 — 툴바 버튼(기본) 또는 **메뉴 전용** 명령.
 *
 * 왜 한 타입인가: 둘은 「이 창에서 클릭하면 호스트가 그 플러그인을 역호출한다」는 점이
 * 완전히 같고, 다른 것은 **어디에 그리느냐**뿐이다. 배달 경로를 나누면 노트 창 진입점
 * (`main.ts`)이 두 번째 경로를 잊는 순간 그 기능이 통째로 죽는다 — 이 저장소가 11번 겪은 모양.
 */
export interface PluginWindowItem extends Omit<PluginToolbarButton, "onClick"> {
  /**
   * 클릭/실행 핸들러(호스트 역호출을 방송한다). 툴바 버튼·명령은 인자를 무시하지만, **메뉴
   * 항목**은 `payload.selectedText`(우클릭 순간의 선택 텍스트)를 실어 방송에 넘긴다.
   *
   * 기반 [`PluginToolbarButton.onClick`]을 `Omit`으로 빼고 여기서 넓힌 이유: 인자를 더한 이
   * 시그니처가 툴바 렌더 코드(`onClick()`을 무인자로 부른다)까지 전파되면 안 된다 — 넓힘은 이
   * 노트-창 항목 타입 안에만 가둔다(main.ts→addToolbarButton→note-window 경로만 이 타입을 본다).
   */
  onClick(payload?: { selectedText?: string }): void;
  /** true면 툴바에 자리를 잡지 않고 에디터 컨텍스트 메뉴에만 나타난다. */
  menuOnly?: boolean;
  /**
   * true면 **클릭 버튼이 아니라 상태 표시형 텍스트**로 렌더한다(`ui.addStatusItem`).
   *
   * 버튼과 같은 배달 경로·같은 툴바 배치 키(`plugin:<pluginId>:<id>`)를 쓰되 다른 것은 셋뿐:
   * (1) `<button>`이 아니라 텍스트 요소로 그리고, (2) 컨텍스트 메뉴 항목을 만들지 않으며,
   * (3) 노트 창이 그 요소를 (owner, id)로 들고 있어 `ui.updateStatusItem`(창-스코프)이 라이브
   * 텍스트를 갱신한다. `label`이 초기 텍스트다. 클릭 가능 여부는 [`clickable`]이 정한다
   * (onClick 자체는 저작자가 안 줬어도 no-op으로 항상 존재한다 — 타입을 단순하게 유지하려고).
   */
  status?: boolean;
  /**
   * `status`가 참일 때만 의미 있다 — 저작자가 `ui.addStatusItem`에 `onClick`을 줬는지
   * (클릭 복사 등). 참이면 노트 창이 실제 클릭 리스너·커서·hover를 붙인다(버튼처럼).
   * 거짓/생략이면 `onClick`은 no-op이고 순수 텍스트로만 렌더된다(기존 상태 아이템과 동일).
   */
  clickable?: boolean;
  /**
   * 되돌릴 수 없는 동작(명령의 `destructive`) — 메뉴에서 빨갛게 보인다.
   *
   * 실행 **차단**은 여기서 하지 않는다: 확인 팝업은 이미 중앙 호스트가 `run` 직전에 띄우므로,
   * 창이 하는 일은 "누르기 전에 알아볼 수 있게" 하는 것뿐이다(두 곳에서 막으면 확인이 두 번 뜬다).
   */
  danger?: boolean;
  /**
   * **메뉴 항목**의 표시 조건(창 상태 키 `note.isEmpty`·`note.hasSelection`) — 노트 창이
   * **우클릭 시점에** 라이브 에디터 상태로 판정해 조건이 거짓인 항목은 메뉴에서 뺀다. 툴바
   * 버튼·명령에는 없다(그것들은 항상 메뉴에 보인다 — 명령의 `when`은 호스트가 실행 시 판정).
   */
  menuWhen?: WhenTerm[];
  /**
   * 이 메뉴 항목의 핸들러가 `payload.selectedText`를 받는가 — 호스트가 등록 시점의
   * `notes:read` 부여로 굳혀 스냅샷에 실어 보낸 값. 참이면 노트 창이 우클릭 순간의 선택 텍스트를
   * `onClick`에 넘긴다(거짓이면 넘기지 않는다 — `ui` 권한만으로 본문이 새지 않는 payload 게이트).
   */
  needsSelectedText?: boolean;
  /**
   * 이 항목을 등록한 플러그인이 1st-party 번들(빌트인)인가 — [`PluginSnapshot.builtin`]을
   * 그대로 실은 값이다. 노트 창은 이 값으로 **빌트인 출처 항목만** 컨텍스트 메뉴에서 걸러낸다
   * (빌트인은 툴바 버튼이 이미 있어 이름으로 또 나열하면 중복이다 — 커뮤니티/사이드로드
   * 항목은 그대로 나열된다). 툴바 렌더 자체는 이 값과 무관하다(빌트인 버튼도 툴바에는 그대로
   * 뜬다 — 걸러지는 것은 "이름으로 고르는 메뉴 자리"뿐이다).
   */
  builtin?: boolean;
}

/**
 * 스냅샷의 직렬화 버튼·명령을 노트 창이 렌더할 항목으로 바꾼다(클릭 → 호스트로 위임).
 *
 * 역할: onClick이 [`EV_BUTTON_INVOKE`]를 방송하게 배선한다 — 호스트가 해당 플러그인
 * 샌드박스의 onClick(명령이면 `run`)을 역호출하고, 이 창 라벨을 창-스코프 호출 컨텍스트로
 * 기록한다.
 *
 * 명령은 `menuOnly`로 함께 실린다. 왜 여기서 합치는가: 명령은 지금까지 **사용자가
 * 단축키를 손수 배정하기 전에는 실행할 방법이 아예 없었다.** 컨텍스트 메뉴가 그 첫 실행
 * 경로이고, 항목 id를 `cmd:<commandId>`로 두어 노트 창이 만드는 `data-action`이
 * `pluginCommandActionId()`(=`plugin:<pluginId>:cmd:<commandId>`)와 **글자 그대로 같아진다**
 * — 단축키 경로와 메뉴 경로가 같은 식별자를 쓰므로 둘이 갈라질 수 없다.
 */
export function snapshotToolbarButtons(
  snapshot: HostSnapshot,
  windowLabel: string,
  bus: HostEventBus,
): PluginWindowItem[] {
  return snapshot.plugins.flatMap((plugin) => [
    ...plugin.buttons.map((button) => ({
      id: button.id,
      pluginId: plugin.pluginId,
      label: button.label,
      title: button.title,
      position: button.position,
      builtin: plugin.builtin === true,
      onClick: () =>
        bus.emit(EV_BUTTON_INVOKE, {
          pluginId: plugin.pluginId,
          buttonId: button.buttonId,
          windowLabel,
        }),
    })),
    // ── 상태 표시형 아이템(`ui.addStatusItem`) ────────────────────────
    // 버튼과 **같은 배달 경로**(main.ts가 이 배열을 addToolbarButton으로 흘린다)를 쓰고
    // `status: true`로 표식한다 — 노트 창이 그것을 보고 클릭 버튼이 아니라 텍스트로 그린다.
    // id에는 `status:`를 접두한다(명령의 `cmd:`, 메뉴의 `menu:`와 같은 이유·같은 방식) —
    // 접두 없이 버튼과 같은 (pluginId, id) 규약을 그대로 쓰면, 한 플러그인이
    // `addToolbarButton({id:"x"})`와 `addStatusItem({id:"x"})`를 함께 등록했을 때
    // `pluginItemKey`가 같은 문자열을 내 `reconcileToolbarItems`의 `next` Map에서 뒤에 오는
    // 쪽(상태 아이템)이 버튼을 무음으로 덮는다(회귀 — note-window.test.ts 참고). **버튼의
    // id는 절대 건드리지 않는다** — 그 키가 사용자의 저장된 `toolbar_layout` 배치와 맞물려
    // 있어, 바꾸면 기존 배치가 깨진다(status 쪽만 접두해도 되는 이유 — `sharedBottom`의
    // word-count 기본 배치 키도 이 접두를 반영해 함께 갱신했다). `ui.updateStatusItem`은
    // 저작자가 준 **원래(무접두) id**로 오므로, 그 조회부(`note-window.ts`의
    // `updateStatusItem`)가 조회 직전에 같은 접두를 붙인다 — 등록·조회 양쪽이 같은 규칙을
    // 따라가지 않으면 갱신이 INVALID_ARGS로 조용히 거부된다.
    // `label`이 초기 텍스트이고, 라이브 갱신은 창-스코프 `ui.updateStatusItem`이 나른다.
    // `item.buttonId`가 있으면(저작자가 onClick을 줬다) 버튼과 **완전히 같은 절차**로
    // EV_BUTTON_INVOKE를 방송한다 — 없으면(대부분) no-op·`clickable: false`로 순수 텍스트다.
    ...(plugin.statusItems ?? []).map((item) => ({
      id: `status:${item.id}`,
      pluginId: plugin.pluginId,
      label: item.text,
      title: item.title,
      position: item.position,
      status: true,
      builtin: plugin.builtin === true,
      clickable: item.buttonId !== undefined && item.buttonId !== "",
      onClick:
        item.buttonId !== undefined && item.buttonId !== ""
          ? () =>
              bus.emit(EV_BUTTON_INVOKE, {
                pluginId: plugin.pluginId,
                buttonId: item.buttonId,
                windowLabel,
              })
          : () => {},
    })),
    ...(plugin.commands ?? []).map((command) => ({
      id: `cmd:${command.id}`,
      pluginId: plugin.pluginId,
      label: command.title,
      title: command.title,
      // 툴바에 놓이지 않으므로 존은 의미가 없다 — 폴백 값을 그대로 둔다.
      position: "top-left" as const,
      menuOnly: true,
      builtin: plugin.builtin === true,
      ...(command.destructive === true ? { danger: true } : {}),
      onClick: () =>
        bus.emit(EV_BUTTON_INVOKE, {
          pluginId: plugin.pluginId,
          commandId: command.id,
          windowLabel,
        }),
    })),
    // ── 메뉴 전용 항목(`ui.addMenuItem`) ──────────────────────────────
    // 버튼·명령과 **같은 배달 경로**(main.ts가 이 배열을 addToolbarButton으로 흘린다)를 쓴다 —
    // 별도 경로를 만들면 main.ts가 그 두 번째 경로를 잊는 순간 통째로 죽는다(이 저장소의 단골).
    // 다른 점은 셋뿐: (1) `menuWhen`을 실어 노트 창이 우클릭 시점에 표시 여부를 판정하고,
    // (2) `needsSelectedText`면 onClick이 선택 텍스트를 방송에 얹으며, (3) 클릭이 `menuItemId`로
    // 방송된다(호스트가 그 id로 `run`을 되짚는다).
    ...(plugin.menuItems ?? []).map((item) => ({
      id: `menu:${item.id}`,
      pluginId: plugin.pluginId,
      label: item.label,
      title: item.label,
      // 툴바에 놓이지 않으므로 존은 의미가 없다(명령과 같은 폴백).
      position: "top-left" as const,
      menuOnly: true,
      builtin: plugin.builtin === true,
      ...(item.when !== undefined ? { menuWhen: item.when } : {}),
      ...(item.needsSelectedText === true ? { needsSelectedText: true } : {}),
      onClick: (payload?: { selectedText?: string }) =>
        bus.emit(EV_BUTTON_INVOKE, {
          pluginId: plugin.pluginId,
          menuItemId: item.id,
          windowLabel,
          // 선택 텍스트는 등록 시점에 `notes:read`로 굳힌 항목만 싣는다(호스트가 다시 확인한다).
          ...(item.needsSelectedText === true &&
          typeof payload?.selectedText === "string"
            ? { selectedText: payload.selectedText }
            : {}),
        }),
    })),
  ]);
}

/**
 * 스냅샷의 직렬화 선택 액션을 **이 창에서 실행 가능한** 항목으로 바꾼다(`ui.addSelectionAction`).
 *
 * 왜 `snapshotToolbarButtons`에 섞지 않는가: 그 배열은 노트 창의 **툴바 배치 시스템**으로
 * 흘러간다(배치 키·팔레트·오버플로 메뉴). 선택 액션은 툴바에 상주하지 않고 선택이 있을 때만
 * 뜨는 플로팅 바의 손님이라, 그 배열에 넣으면 사용자의 툴바 배치 편집기에 옮길 수도 숨길 수도
 * 없는 유령 항목이 생긴다. 배달 경로는 나뉘지만 **클릭 채널은 같다**(EV_BUTTON_INVOKE) —
 * 창 컨텍스트 발급·역호출 절차가 두 벌이 되지 않게.
 *
 * `run`은 선택 텍스트를 언제나 받되, 방송에 싣는 것은 **등록 시점에 `notes:read`로 굳힌**
 * 액션뿐이다(호스트가 다시 확인한다 — 메뉴 항목과 같은 심층 방어). 이 판정을 여기 한 곳에
 * 두어, 두 표면(선택 툴바·단축키)이 권한 게이트를 각자 다시 적지 않게 한다.
 */
export function snapshotSelectionActions(
  snapshot: HostSnapshot,
  windowLabel: string,
  bus: HostEventBus,
): SelectionActionItem[] {
  return snapshot.plugins.flatMap((plugin) =>
    (plugin.selectionActions ?? []).map((action) => ({
      pluginId: plugin.pluginId,
      id: action.id,
      label: action.label,
      ...(action.title !== undefined ? { title: action.title } : {}),
      ...(action.match !== undefined ? { match: action.match } : {}),
      run: (payload: { selectedText: string }) =>
        bus.emit(EV_BUTTON_INVOKE, {
          pluginId: plugin.pluginId,
          selectionActionId: action.id,
          windowLabel,
          ...(action.needsSelectedText === true
            ? { selectedText: payload.selectedText }
            : {}),
        }),
    })),
  );
}

/**
 * 이 노트 창의 생명주기 이벤트 발신기를 만든다 — **구독자가 있는 이름만** 방송한다.
 *
 * 역할: 스냅샷의 `subscribedEvents`를 발신 게이트로 써서, 아무도 듣지 않는 이벤트는 IPC
 * 자체가 일어나지 않게 한다. 방송하는 값은 메타데이터뿐이다(본문은 절대 싣지 않는다 —
 * 플러그인이 본문을 원하면 `notes:read`로 게이트된 `notes.current()`를 따로 부른다).
 * 왜: `note:saved`는 타이핑 중 자동저장마다 도는 경로다. 게이트가 없으면 이벤트를 쓰는
 * 플러그인이 하나도 없는 사용자(=대부분)까지 매 저장마다 IPC 비용을 문다. 반대로 호스트
 * 쪽에서 버리는 방식은 이미 트래픽이 발생한 뒤라 늦다.
 *
 * 스로틀·디바운스를 **일부러 넣지 않는다**: 구독 가능한 이름 6종은 전부 저빈도이고
 * (`note:saved`조차 노트 창의 자동저장 디바운스 뒤에 온다), 키 입력마다 나는 텍스트 변경은
 * 이름 집합에서 아예 빠져 있다. 프레임을 삼키는 스로틀은 "저장됐는데 이벤트가 안 왔다"는
 * 더 나쁜 무음 실패를 만든다 — 고빈도 이벤트를 열 때 함께 설계할 일이다.
 */
export function noteEventEmitter(
  snapshot: HostSnapshot,
  windowLabel: string,
  bus: HostEventBus,
): (name: MemoEventName, note: { id: string; path: string | null }) => void {
  const wanted = new Set<MemoEventName>(snapshot.subscribedEvents ?? []);
  return (name, note) => {
    if (!wanted.has(name)) return;
    bus.emit(EV_PLUGIN_EVENT, {
      name,
      windowLabel,
      noteId: note.id,
      path: note.path,
      at: Date.now(),
    });
  };
}

/** 창-스코프 호출을 실제 수행할 노트 창 로컬 서비스(마운트된 창의 기능에 바인딩). */
interface WindowCallServices {
  /**
   * 토스트를 띄우거나 갱신·닫는다. 새 토스트면 발급된 id, 모르는 id면 null.
   * 인자·반환 형태의 정본은 `note-window.ts`의 `NoteToastSpec`이다.
   *
   * `owner`는 **호스트가 검증한** 호출 주체 플러그인 id다 — 토스트 id를 (창, 플러그인, id)로
   * 격리하는 네임스페이스 키라, 다른 플러그인이 id를 추측해도 남의 토스트에 닿지 않는다.
   */
  showToast(
    spec: {
      id?: string;
      /** 새 토스트에는 필수(여기서 강제), 갱신에서 생략하면 기존 문구를 유지한다(부분 갱신). */
      title?: string;
      message?: string;
      style?: "success" | "failure" | "progress";
      dismiss?: boolean;
    },
    owner: string,
  ): string | null;
  /**
   * 상태 표시형 아이템의 이 창 표시 텍스트/툴팁을 갱신한다 — 갱신한 id, **이 창에 그런
   * 상태 아이템이 없으면 null**(호출부가 `INVALID_ARGS`로 거부한다).
   *
   * `owner`는 **호스트가 검증한** 호출 주체 플러그인 id다 — 상태 아이템 키를
   * `plugin:<owner>:<id>`로 짓는 네임스페이스라, 다른 플러그인이 id를 추측해도 남의 상태
   * 아이템에 닿지 않는다(toast의 owner 격리와 같은 규칙).
   */
  updateStatusItem(
    spec: { id: string; text?: string; title?: string },
    owner: string,
  ): string | null;
  /** 메모 글자 델타(%) 읽기/쓰기 — 호스트가 실효 크기 적용·영속화. */
  getFontDelta(): number;
  /** 델타를 클램프해 적용·영속화하고 **실제 적용된** 델타(%)를 돌려준다(플러그인 토스트용). */
  setFontDelta(deltaPct: number): number;
  /**
   * 커서 위치(또는 문서 끝/전체)에 텍스트를 삽입한다 — 템플릿 등. mode=cursor|append|replace,
   * caret은 삽입된 본문 내 최종 커서 오프셋(없으면 삽입 끝). notes:write로 게이트된다.
   */
  insertText(text: string, mode: string, caret?: number): void;
  /** 텍스트를 클립보드에 쓴다(클릭 직후의 이 창에서 실행 — 사용자 제스처 문맥 유지). */
  writeClipboard(text: string): Promise<void>;
  /** 현재 노트의 id·절대경로·라이브 본문. */
  currentNote(): { id: string; path: string; content: string } | null;
  /** 현재 노트를 복제(내용·설정 동일)해 새 노트 창을 연다(복제 플러그인). */
  duplicateNote(): Promise<void>;
  /** 이 메모만의 override를 전역 기본값으로 되돌린다(옵션 초기화 플러그인 — confirm 게이트). */
  resetOptions(): void;
  /**
   * 목록 팝업으로 (항목, 액션) 쌍을 고르게 한다(취소=null). 대화형(사용자 응답 대기).
   * 선언 형태의 정본은 `plugin-popup.ts`의 `PickListSpec`이다.
   */
  pickList(spec: {
    title: string;
    placeholder?: string;
    items: {
      id: string;
      label: string;
      sublabel?: string;
      actions?: { id: string; label: string; style?: string }[];
    }[];
  }): Promise<{ itemId: string; actionId: string } | null>;
  /**
   * 입력 팝업 — `fields`가 없으면 한 줄 입력(문자열), 있으면 폼(`Record<id, 값>`). 취소=null.
   * 선언 형태의 정본은 `plugin-popup.ts`의 `PromptSpec`이다.
   */
  prompt(spec: {
    title: string;
    placeholder?: string;
    default?: string;
    submitLabel?: string;
    fields?: {
      id: string;
      label: string;
      type: "text" | "textarea" | "toggle" | "select" | "number";
      placeholder?: string;
      default?: unknown;
      options?: (string | { value: string; label?: string })[];
      min?: number;
      max?: number;
      step?: number;
    }[];
  }): Promise<string | Record<string, string | number | boolean> | null>;
}

/**
 * 토스트 상태 어휘의 **정본** — 저작 계약(`api-index.ts`)이 이 배열을 그대로 실어
 * `MemoToastStyle`을 만든다(값을 두 곳에 적으면 반드시 갈라진다).
 *
 * 첫 값이 기본값이다: 모르는 값은 오류가 아니라 여기로 접힌다 — 상태를 지어낸 호출도
 * 토스트는 뜨는 편이, 알림이 통째로 사라지는 것보다 저작자에게 정직하다.
 */
export const TOAST_STYLES = ["success", "failure", "progress"] as const;

/**
 * 폼 필드 타입 어휘의 **정본** — 매니페스트 `settings`의 타입과 같은 것에서 `list`만
 * 뺐다(폼은 한 번의 입력이라 항목을 늘렸다 줄이는 위젯이 들어갈 자리가 아니다).
 */
export const FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "toggle",
  "select",
  "number",
] as const;

/** 폼 필드 타입(=[`FORM_FIELD_TYPES`]의 원소). */
type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** 신뢰 경계 밖 값을 객체로 읽는다(배열·null·원시값은 빈 객체 — 필드 접근이 던지지 않게). */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `ui.pickList` 인자의 항목 배열을 정규화한다(부제·항목별 액션).
 *
 * 액션 id가 비면 그 액션은 **버린다**: 빈 id를 돌려주면 플러그인의 분기가 어느 액션인지
 * 구분하지 못하고 조용히 첫 가지로 떨어진다(무음 오작동).
 */
function normalizePickItems(raw: unknown): {
  id: string;
  label: string;
  sublabel?: string;
  actions?: { id: string; label: string; style?: string }[];
}[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((entry) => {
    const o = asRecord(entry);
    const actionsRaw = Array.isArray(o.actions) ? o.actions : null;
    const actions = actionsRaw
      ?.map((a) => {
        const ao = asRecord(a);
        return {
          id: String(ao.id ?? ""),
          label: String(ao.label ?? ""),
          ...(ao.style === "destructive"
            ? { style: "destructive" as const }
            : {}),
        };
      })
      .filter((a) => a.id !== "");
    return {
      id: String(o.id ?? ""),
      label: String(o.label ?? ""),
      ...(o.sublabel == null ? {} : { sublabel: String(o.sublabel) }),
      ...(actions && actions.length > 0 ? { actions } : {}),
    };
  });
}

/**
 * `ui.prompt`의 `fields` 인자를 정규화한다. 모르는 타입은 `text`로 접지 않고 **버린다**.
 *
 * 왜 버리나: 모르는 타입을 text로 흡수하면 저작자는 폼이 뜨는 것을 보고 성공했다고 믿는데
 * 값의 종류가 다르다(toggle을 기대하고 문자열을 받는다). 필드가 아예 없으면 즉시 눈에 띈다.
 */
function normalizeFormFields(raw: unknown): {
  id: string;
  label: string;
  type: FormFieldType;
  placeholder?: string;
  default?: unknown;
  options?: (string | { value: string; label?: string })[];
  min?: number;
  max?: number;
  step?: number;
}[] {
  const list = Array.isArray(raw) ? raw : [];
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return list
    .map((entry) => {
      const o = asRecord(entry);
      const type = String(o.type ?? "text");
      if (
        !(FORM_FIELD_TYPES as readonly string[]).includes(type) ||
        String(o.id ?? "") === ""
      ) {
        return null;
      }
      const options = Array.isArray(o.options)
        ? (o.options as (string | { value: string; label?: string })[])
        : undefined;
      return {
        id: String(o.id),
        label: String(o.label ?? ""),
        type: type as FormFieldType,
        ...(o.placeholder == null
          ? {}
          : { placeholder: String(o.placeholder) }),
        ...(o.default === undefined ? {} : { default: o.default }),
        ...(options ? { options } : {}),
        ...(num(o.min) === undefined ? {} : { min: num(o.min) }),
        ...(num(o.max) === undefined ? {} : { max: num(o.max) }),
        ...(num(o.step) === undefined ? {} : { step: num(o.step) }),
      };
    })
    .filter((f) => f !== null);
}

/**
 * 호스트가 위임한 창-스코프 호출 하나를 로컬 서비스로 수행한다(순수, 가드 테스트용).
 *
 * 역할: toast·글자 델타·클립보드·현재 노트만 처리하고, 그 밖의 호출은 던진다(호스트가
 * 오류 응답으로 회신). setFontDelta의 비수치 값은 NaN이 아니라 0으로 정규화하고(NaN이 글자
 * 크기·영속화로 새지 않게), **실제 적용된**(클램프된) 델타를 회신해 플러그인이 정직한 %를
 * 토스트하게 한다(기존 per-window 수행부와 같은 방어).
 * 왜: 권한 검사는 이미 중앙 호스트 게이트키퍼가 마쳤다 — 여기는 신뢰된 위임의 수행부다.
 *
 * `pluginId`는 페이로드에 실려 온 **호스트 검증 값**이다(플러그인이 인자로 자칭할 수 없다) —
 * 토스트 id의 플러그인별 네임스페이스에 쓴다.
 */
export async function executeWindowCall(
  services: WindowCallServices,
  call: string,
  args: Record<string, unknown>,
  pluginId = "",
): Promise<unknown> {
  if (call === "ui.toast") {
    // **주지 않은 필드는 싣지 않는다**: 계약이 "닫기·부분 갱신에서는 title을 안 줘도 된다"고
    // 약속하므로, 빈 문자열·기본 style을 채워 보내면 `{ id, style: "success" }` 한 번에
    // 진행 토스트의 문구가 지워지고(빈 알림) 자동 소멸 타이머까지 걸린다. `{ text }` 축약형은
    // 제거됐다 — `title`만 받는다(엄격).
    const given = args.id == null ? undefined : String(args.id);
    const title = args.title == null ? undefined : String(args.title);
    const style =
      args.style == null
        ? undefined
        : (TOAST_STYLES as readonly string[]).includes(String(args.style))
          ? (args.style as (typeof TOAST_STYLES)[number])
          : // 모르는 값은 거부가 아니라 기본값으로 접는다(기존 계약 문구 그대로).
            TOAST_STYLES[0];
    if (given === undefined && args.dismiss !== true && title === undefined) {
      // 새 토스트에는 문구가 있어야 한다 — 없으면 사용자에게 빈 알약이 뜨고 저작자는
      // 왜 아무 글자도 없는지 알 방법이 없다(갱신과 달리 유지할 이전 값도 없다).
      throw bridgeError(
        "INVALID_ARGS",
        "ui.toast: 새 토스트에는 title이 필요합니다",
      );
    }
    const id = services.showToast(
      {
        ...(given === undefined ? {} : { id: given }),
        ...(title === undefined ? {} : { title }),
        ...(args.message == null ? {} : { message: String(args.message) }),
        ...(style === undefined ? {} : { style }),
        ...(args.dismiss === true ? { dismiss: true } : {}),
      },
      // 호스트가 검증한 호출 주체 — 이 값이 네임스페이스라 다른 플러그인이 id(순번)를
      // 추측해도 남의 진행·실패 토스트를 닫거나 바꿔치지 못한다.
      pluginId,
    );
    if (id === null) {
      // 무음 무시가 아니라 거부다 — "갱신했는데 아무 일도 없었다"는 저작자가 관측할 수
      // 없는 실패라, 이미 닫힌 핸들을 쓴 코드가 조용히 계속 돌지 않게 한다.
      throw bridgeError(
        "INVALID_ARGS",
        given === undefined
          ? "ui.toast: dismiss에는 id가 필요합니다"
          : `ui.toast: 이미 닫혔거나 없는 토스트 id입니다: ${given}`,
      );
    }
    return { id };
  }
  if (call === "ui.updateStatusItem") {
    // id는 필수다 — 없으면 어느 상태 아이템을 갱신할지 알 수 없다(toast의 dismiss와 같은 결).
    const id = args.id == null ? "" : String(args.id);
    if (id === "") {
      throw bridgeError(
        "INVALID_ARGS",
        "ui.updateStatusItem: 갱신할 상태 아이템 id가 필요합니다",
      );
    }
    // **주지 않은 필드는 갱신하지 않는다**(부분 갱신 — toast와 같은 규칙): text만 주면 텍스트만,
    // title만 주면 툴팁만 바뀐다. 문자열로 강제해 구조화 값이 DOM 텍스트로 새지 않게 한다.
    const patch: { id: string; text?: string; title?: string } = { id };
    if (args.text != null) patch.text = String(args.text);
    if (args.title != null) patch.title = String(args.title);
    const updated = services.updateStatusItem(patch, pluginId);
    if (updated === null) {
      // 무음 무시가 아니라 거부다 — "갱신했는데 아무 일도 없었다"는 저작자가 관측할 수 없는
      // 실패라, 등록 전에 갱신하거나(순서 뒤집힘) 이 창에 없는 아이템을 가리킨 코드가 조용히
      // 계속 돌지 않게 한다(toast의 모르는 id 거부와 같은 계약).
      throw bridgeError(
        "INVALID_ARGS",
        `ui.updateStatusItem: 이 창에 그 id의 상태 아이템이 없습니다(등록은 addStatusItem으로 runtime.ready() 전에 하세요): ${id}`,
      );
    }
    return { id: updated };
  }
  if (call === "editor.getFontDelta") {
    return services.getFontDelta();
  }
  if (call === "editor.setFontDelta") {
    const v = Number(args.value);
    // 적용된(클램프된) 델타를 그대로 회신 — 플러그인은 이 값으로 토스트하고, 한계에선 값이
    // 더 자라지 않아 "글자 +N%"가 정직해진다.
    return services.setFontDelta(Number.isFinite(v) ? v : 0);
  }
  if (call === "editor.insertText") {
    const caret = Number(args.caret);
    services.insertText(
      String(args.text ?? ""),
      String(args.mode ?? "cursor"),
      Number.isFinite(caret) && caret >= 0 ? caret : undefined,
    );
    return null;
  }
  if (call === "clipboard.write") {
    await services.writeClipboard(String(args.text ?? ""));
    return null;
  }
  if (call === "notes.current") {
    const note = services.currentNote();
    // 선택 영역은 본문의 일부라 `notes.current`와 **같은 게이트**(notes:read) 아래 둔다 —
    // 전용 호출을 새로 열면 같은 데이터에 권한 경로가 둘이 되고, 저작자는 "본문을 읽을 수
    // 있는데 선택은 못 읽는" 조합을 상상하게 된다. 되쓰기는 오프셋을 받는 API 없이
    // `editor.insertText({ mode: "cursor" })` 하나로만 간다(오프셋 경합은 CM 트랜잭션이 흡수).
    return note === null ? null : { ...note, selection: readNoteSelection() };
  }
  if (call === "notes.duplicate") {
    await services.duplicateNote();
    return null;
  }
  // 정본 이름은 복수형 `notes.resetOptions` 하나다 — 단수 `note.resetOptions`는 중앙 게이트
  // (host.ts의 CALL_PERMISSIONS)에 없어 UNKNOWN_CALL로 먼저 거부되므로 여기 도달하지 않는다.
  if (call === "notes.resetOptions") {
    services.resetOptions();
    return null;
  }
  if (call === "ui.pickList") {
    const items = normalizePickItems(args.items);
    // 액션을 하나도 안 쓴 호출은 **문자열 id**를 그대로 돌려준다 — 그래야 현행 호출이
    // 이 API의 부분집합이 되고, 반환 형태가 넓어졌다는 이유로 기존 플러그인이 깨지지 않는다.
    const plain = items.every((it) => it.actions === undefined);
    const picked = await services.pickList({
      title: String(args.title ?? ""),
      ...(args.placeholder == null
        ? {}
        : { placeholder: String(args.placeholder) }),
      items,
    });
    if (picked === null) return null;
    return plain ? picked.itemId : picked;
  }
  if (call === "ui.prompt") {
    // 배열이 아닌 truthy fields(객체 map·문자열 — 흔한 저작 실수)는 아래에서 []로 접혀
    // 「전부 걸러짐」 가드마저 통과해 버린다 — 그 조용한 한 줄 입력 폴백이 정확히 이 가드가
    // 막으려는 결함이므로 타입부터 거부한다(null/undefined = "안 줬다"는 그대로 한 줄 입력).
    if (args.fields != null && !Array.isArray(args.fields)) {
      throw bridgeError(
        "INVALID_ARGS",
        "ui.prompt: fields는 배열이어야 합니다 — 객체·문자열은 한 줄 입력으로 폴백하지 않습니다",
      );
    }
    const rawFields = Array.isArray(args.fields) ? args.fields : [];
    const fields = normalizeFormFields(args.fields);
    // 필드를 줬는데 전부 걸러졌다(모르는 타입·id 없음) — 여기서 한 줄 입력으로 폴백하면
    // 계약과 다른 UI가 뜨고 반환형까지 달라진다(Record 대신 문자열). 조용한 폴백 대신
    // 거부한다 — 게이트키퍼가 이 코드를 응답에 싣고 call-reject 진단으로도 남긴다.
    if (rawFields.length > 0 && fields.length === 0) {
      throw bridgeError(
        "INVALID_ARGS",
        `ui.prompt: fields에 유효한 필드가 하나도 없습니다(타입은 ${FORM_FIELD_TYPES.join("·")}, id 필수) — 한 줄 입력으로 폴백하지 않습니다`,
      );
    }
    return services.prompt({
      title: String(args.title ?? ""),
      placeholder: String(args.placeholder ?? ""),
      default: String(args.default ?? ""),
      ...(args.submitLabel == null
        ? {}
        : { submitLabel: String(args.submitLabel) }),
      // 빈 배열은 폼이 아니라 "필드를 안 줬다"로 읽는다 — 필드 0개짜리 폼은 확인 버튼만 있는
      // 빈 카드라 사용자에게 아무 의미가 없다(한 줄 입력으로 떨어지는 편이 낫다).
      ...(fields.length > 0 ? { fields } : {}),
    });
  }
  throw bridgeError("UNKNOWN_CALL", `지원하지 않는 창-스코프 호출: ${call}`);
}

/**
 * 이 창을 향한 창-스코프 호출([`EV_WINDOW_CALL`])을 구독해 수행·회신한다.
 *
 * 역할: windowLabel이 내 라벨과 일치하는 호출만 [`executeWindowCall`]로 수행하고
 * 결과/오류를 [`EV_WINDOW_RESULT`]로 회신한다. 해제 함수를 돌려준다.
 */
export function attachWindowCallHandler(
  bus: HostEventBus,
  windowLabel: string,
  services: WindowCallServices,
): () => void {
  return bus.listen(EV_WINDOW_CALL, (payload) => {
    const p = payload as WindowCallPayload | null;
    if (!p || p.windowLabel !== windowLabel) return;
    // pluginId는 호스트가 검증해 실은 값이다 — 창 쪽 수행부의 플러그인별 네임스페이스 키.
    void executeWindowCall(
      services,
      String(p.call),
      p.args ?? {},
      typeof p.pluginId === "string" ? p.pluginId : "",
    )
      .then((result) =>
        bus.emit(EV_WINDOW_RESULT, {
          requestId: p.requestId,
          ok: true,
          result,
        }),
      )
      .catch((e: unknown) => {
        // 안정 코드를 회신에 함께 싣는다 — 창 쪽에서 난 거부도 샌드박스가 문구가 아니라
        // 코드로 분기할 수 있게. 중앙 호스트가 이 필드를 브리지 응답으로 이어 실어야 최종
        // 도달한다(요청사항).
        const code = (e as { code?: unknown } | null)?.code;
        bus.emit(EV_WINDOW_RESULT, {
          requestId: p.requestId,
          ok: false,
          ...(typeof code === "string" && code !== ""
            ? { code: code as MemoErrorCode }
            : {}),
          error: e instanceof Error ? e.message : String(e),
        });
      });
  });
}
