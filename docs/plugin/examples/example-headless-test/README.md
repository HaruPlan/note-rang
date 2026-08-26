# 예제: 헤드리스 테스트 대상

툴바 버튼 하나(📌 `stamp-path`)와 이벤트 구독 하나(`note:saved`)를 등록합니다. 버튼을 누르면 설정 `stamp`를 앞에 붙여 지금 메모의 경로를 클립보드에 복사하고, 메모가 저장되면 토스트로 알립니다.

이 예제의 목적은 **플러그인을 앱 없이 테스트하는 법**을 보이는 것입니다 — `src/plugin/test-host.ts`의 헤드리스 하니스로 버튼 클릭·설정 주입·창-스코프 호출·이벤트 발화를 코드로 단언합니다.

## 설정

| 키      | 뜻                                       |
| ------- | ---------------------------------------- |
| `stamp` | 복사할 때 경로 앞에 붙일 도장(기본 `✓ `) |

## 헤드리스 하니스로 테스트하기

`memo.*` 호출은 격리 iframe 안에서 도므로, 예전에는 플러그인을 **앱을 띄우고 손으로 클릭**해야만 확인할 수 있었습니다. 헤드리스 하니스는 저작자의 진짜 `main.js`를 **실제 권한 게이트키퍼와 등록 수집기에 통과시켜** 같은 프로세스에서 실행하므로, 앱 없이 단언할 수 있습니다.

```ts
import { describe, it, expect } from "vitest";
import { loadPluginFromDir } from "../../../src/plugin/test-host";

describe("example-headless-test", () => {
  it("버튼을 등록하고, 클릭하면 도장+경로를 복사한다", async () => {
    // 폴더를 그대로 로드한다(manifest.json + main.js). 매니페스트가 선언한 권한은
    // 기본적으로 전부 부여된 것으로 본다.
    const plugin = await loadPluginFromDir(__dirname, {
      // 창-스코프·호스트 호출의 응답을 주입한다(실제 노트 창이 없으므로).
      stubs: {
        "notes.current": { id: "n1", path: "/notes/오늘.md", content: "" },
      },
    });

    // 1) 등록 결과를 조회한다.
    expect(plugin.buttons.map((b) => b.id)).toEqual(["stamp-path"]);
    expect(plugin.subscriptions.map((s) => s.name)).toEqual(["note:saved"]);
    expect(plugin.ready).toBe(true); // runtime.ready()로 마감을 선언했다
    expect(plugin.rejections).toEqual([]); // 거부된 호출이 없다(권한·인자 정상)

    // 2) 설정을 주입하고 버튼을 누른다.
    plugin.setSetting("stamp", "★ ");
    await plugin.clickButton("stamp-path");

    // 3) 클릭이 낸 창-스코프 호출을 단언한다.
    expect(plugin.callsTo("clipboard.write")[0].args.text).toBe(
      "★ /notes/오늘.md",
    );
    expect(plugin.callsTo("ui.toast")[0].args.title).toBe(
      "도장과 경로를 복사했습니다",
    );
  });

  it("note:saved 이벤트가 나면 토스트한다", async () => {
    const plugin = await loadPluginFromDir(__dirname);
    await plugin.emitEvent("note:saved", { id: "n1" });
    expect(plugin.callsTo("ui.toast").map((c) => c.args.title)).toEqual([
      "저장됨",
    ]);
  });
});
```

### 하니스가 주는 것

| 무엇                       | 어떻게                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| 등록 조회                  | `plugin.buttons` · `patterns` · `commands` · `subscriptions` · `theme` 등  |
| 실행                       | `plugin.clickButton(id)` · `runCommand(id)` · `emitEvent(name)`            |
| 창-스코프 호출 가로채 단언 | `plugin.calls` · `plugin.callsTo("ui.toast")` · `stub(call, 값\|함수)`     |
| 설정 주입/조회             | `plugin.setSetting(k, v)` · `getSetting(k)` (또는 로드 시 `settings` 옵션) |
| 거부·마감 검사             | `plugin.rejections`(권한·인자 오류) · `plugin.ready`(runtime.ready 여부)   |

### 무엇을 검사하지 못하나 (정직한 경계)

하니스는 **단일 창 컨텍스트**를 모델링합니다. iframe·postMessage·CSP 격리 자체와 **다중 창 토큰 라우팅**("A 창에서 눌렀는데 B 창에 삽입")은 재현하지 않습니다 — 그 경계는 앱 단위 테스트(`central-host.test.ts`)와 e2e가 지킵니다. 하니스가 검증하는 것은 "무엇이 등록됐고, 클릭·이벤트가 어떤 호출 시퀀스를 냈고, 무엇이 권한·인자 때문에 거부됐는가"입니다.

## 무엇을 보여주나

### `events.on` — 이벤트 구독

```js
memo.events.on({
  name: "note:saved", // 닫힌 열거 — 오타는 INVALID_ARGS로 거부된다
  handler: function (memo) {
    // ★ handler의 첫 인자도 onClick과 같은 규약: 그 이벤트가 난 창에 바인딩된 memo다.
    memo.ui.toast({ title: "저장됨" });
  },
});
```

`note:saved` 같은 노트 이벤트는 이름별 추가 권한(`notes:read`)을 요구합니다 — 게이트키퍼의 바닥 권한(`settings`)만으로는 구독이 거부됩니다. 가능한 이벤트 이름과 권한은 [`../../authoring.md`](../../authoring.md)와 [`../../api-reference.json`](../../api-reference.json)에 있습니다.
