// 글자 색 플러그인 — {{텍스트|#hex}}를 그 hex 색으로 칠한다.
//
// 등록은 **딱 하나**다: open="{{", close="}}"에 파라미터화 꼬리
// param={prefix:"|", format:"hex-color", apply:"color"}를 붙인다. 그러면 호스트가
// "{{" + 캡처 + "|" + <#rgb 또는 #rrggbb> + "}}"로 매칭하고, 캡처한 hex를 그 매치에만
// 붙는 인라인 스타일(color)로 반영한다 — 팔레트에 없는 색이든 3자리든 6자리든 전부
// 그대로 칠해진다.
//
// **색을 고르는 UI는 이 플러그인에 없다.** 노트 창의 선택 툴바(드래그든 키보드든, 선택 수단과
// 무관하게 뜨는 작은 바)가 팔레트 버튼을 그리고, 그 버튼은 이 등록이 살아 있을 때만 나타난다 — 노트 창은
// 호스트 스냅샷에서 "색을 칠하는 파라미터 패턴"의 구분자를 읽어(editor-api.ts의
// colorPatternSyntax facet) 감쌀 문법을 이 등록에서 그대로 가져간다. 예전에는 이 플러그인이
// 우클릭 메뉴 「글자 색」 + pickList를 직접 띄웠는데, 베타 피드백에서 (1) 우클릭 메뉴가
// 이미 길고 (2) 색은 드래그한 자리에서 바로 고르는 편이 자연스럽다는 지적을 받아 옮겼다.
// 그래서 이 플러그인이 지금 요구하는 권한은 "editor" 하나뿐이다(kbd와 같다).
//
// kbd 플러그인과의 관계: kbd도 open="{{" close="}}"(구분자 없이 전부 캡처)를 쓰므로
// "{{텍스트|#hex}}"는 kbd 패턴에도 걸린다(둘 다 같은 처음·끝 위치를 잡는다). 노트 창은 겹치는
// 매치 중 **더 구체적인 쪽**을 그린다(editor-api.ts patternSpecificity — 파라미터 꼬리가 있는
// 이 패턴이 kbd의 포괄 패턴을 이긴다). 반대로 "{{Cmd+C}}"는 이 패턴의 "|#hex" 꼬리가 없어
// 여기 걸리지 않으므로 키캡으로 그대로 남는다. 등록 순서와는 무관하다.

memo.editor
  .registerInlinePattern({
    id: "text-color",
    open: "{{",
    close: "}}",
    // "|" 뒤의 #rgb/#rrggbb 하나를 캡처해 그 값을 color로 반영한다(호스트가 형식을 검증한다).
    param: { prefix: "|", format: "hex-color", apply: "color" },
    label: "first", // 화면에는 안쪽 글자만 남기고 "{{"·"|#hex}}"는 숨긴다.
    action: "none", // 클릭 동작 없음 — 순수 장식(색칠)이다.
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "패턴 등록 실패: " + e.call + " → " + e.code });
  });
