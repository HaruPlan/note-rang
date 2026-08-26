/**
 * 샌드박스 부트스트랩 스크립트 원문 + CSP 해시(단일 출처).
 *
 * 역할: iframe 안에서 도는 인라인 부트스트랩 코드를 여기 한 곳에 두고, 그 SHA-256 해시를
 * CSP `script-src`의 `'sha256-...'`로 정확히 1개만 허용한다. 샌드박스(sandbox.ts)와 CSP
 * (tauri.conf.json), 가드 테스트가 **같은 문자열**을 참조해 해시 불일치를 원천 차단한다.
 * 왜: 좁은 CSP(unsafe-inline 없음)에서 인라인 부트스트랩을 안전하게 1개만 통과시키려면
 * 정적 문자열의 고정 해시가 필요하다 — 부트스트랩이 바뀌면 해시 가드가 실패해 CSP 갱신을
 * 강제한다.
 *
 * 보안 구조: 플러그인 코드는 더 이상 `eval`로 실행하지 않는다. 부트스트랩이 `run` 메시지를
 * 받으면 코드로 **불투명 origin 내부에서** blob URL을 만들어(`URL.createObjectURL`)
 * `<script src=blob:...>`로 주입한다 — 같은(불투명) origin이라 로드되고, CSP는 `blob:`만
 * 열면 된다(`'unsafe-eval'` 불필요). 부모(허용 origin)가 만든 blob이 아니라 iframe이 자기
 * origin에서 만들므로 로드가 가능하다.
 */

/**
 * iframe 안에서 도는 부트스트랩: memo 브리지 + 메시지 루프 + 플러그인 코드(blob) 로드.
 *
 * 브리지는 기본적으로 sandbox→host 요청/응답이다. 예외는 **함수 인자**다 — postMessage로
 * 직렬화할 수 없으므로 인자 안의 모든 함수 값을 로컬 맵에 보관하고 `<키>$id`(핸들러 id)만
 * 호스트로 보낸다(`swapHandlers` — 호출 이름을 알 필요가 없는 범용 규칙). 호스트는
 * `type:"invoke"`로 그 id와 선택 payload를 되돌려주고, 여기서 보관한 함수를
 * `h(바인딩된 memo, payload)`로 실행한다(host→sandbox 역방향 호출). `ui.addToolbarButton`의
 * `buttonId`는 `onClick$id`의 별칭으로 남는다(하위호환).
 *
 * **인자 정본**: 모든 호출은 `memo.<ns>.<method>(객체 1개)`다. 인자를 2개 이상 주거나
 * 원시값을 주면 **동기 TypeError**로 즉시 죽는다 — 예전에는 두 번째 인자가 조용히 버려졌다.
 * 예외는 하나뿐이다: 문자열을 `{ message }`로 정규화하는 `runtime.log("메시지")`(진단 채널이
 * 저작자의 유일한 피드백 루프라 메시지를 버리지 않는다 — `runtime`도 원시값 검사 자체를
 * 건너뛰지는 않는다). `settings.get`은 더는 예외가 아니다 — 비객체 인자는 다른 호출과 똑같이
 * 동기 TypeError이고, 수행부도 `INVALID_ARGS`로 거부한다.
 *
 * **무권한 네임스페이스 `memo.runtime.*`**: `ready()`는 브리지 왕복 없이 여기서 등록 마감을
 * 확정하고(왕복하면 그 호출이 미해결로 잡혀 자기 마감을 미룬다), `info()`·`log()`는 평범한
 * 호출로 호스트에 나간다. 등록은 **`ready()` 호출 시점 또는 아래 조용-대기 폴백 중 먼저
 * 오는 쪽**에 닫힌다(폴백은 계약이 아니라 편의다). `onDispose(handler)`도 로컬에서 끝난다 —
 * 핸들러는 이 샌드박스 안에 남고, 호스트가 파괴 직전에 보내는 `type: "dispose"`에 반응해
 * 전부 실행한 뒤 `type: "disposed"`로 회신한다(호스트는 상한을 두고 기다린다).
 *
 * **이벤트 역호출**: `events.on`의 `handler`도 다른 함수 인자와 똑같이 `handler$id`로
 * 치환돼 호스트에 등록되고, 호스트가 `type: "invoke"`에 그 id·창 토큰·페이로드를 실어
 * 되돌려준다. 즉 이벤트 콜백의 창 라우팅은 버튼 클릭과 **완전히 같은 경로**를 탄다 —
 * 첫 인자로 오는 바인딩된 `memo`가 그 이벤트가 난 창에 고정된다.
 *
 * 호출 컨텍스트(`ctx`): 호스트는 `invoke`에 불투명 토큰을 함께 실어 보낸다. 왜: 창이 여러 개
 * 열려 있을 때 "이 호출이 어느 창의 클릭에서 나왔는가"를 호스트가 토큰으로 정확히 되짚게
 * 하려는 것(마지막 클릭 창 단일 슬롯은 창을 넘나들며 뒤집혀 A의 응답이 B 본문에 꽂힌다).
 * 토큰을 핸들러의 파생 호출까지 전파하는 길은 **두 겹**이다:
 *
 * 1. **바인딩된 memo(정본)** — 핸들러는 이 클릭에 고정된 `memo`를 **첫 인자**로 받는다
 *    (`onClick: function (memo) { ... }` — 이름이 전역을 가린다). 토큰이 렉시컬 클로저로
 *    잡혀 있어 `Promise.all`·`setTimeout`·비-브리지 `await` 등 **어떤** 비동기 경계를 넘어도
 *    유지된다. 다중 창 라우팅이 필요한 코드는 반드시 이 인자를 쓴다.
 * 2. **전역 memo(최선 노력)** — 전역 `window.memo`는 호출 시점의 `currentToken`을 싣는다.
 *    `currentToken`은 핸들러의 동기 구간 + `callHost`가 돌려주는 **컨텍스트 복원 Promise**(진짜
 *    Promise 인스턴스에 own `then`/`catch`/`finally`를 덮어쓴 것)의
 *    `then`/`catch`/`finally` 콜백 구간에서 살아 있고, 해제(→ null)는 동기가 아니라 **마이크로태스크
 *    한 틱 뒤**라 native `await memo.x()`의 재개(별도 잡)까지 커버한다. 그러나 `Promise.all`처럼
 *    thenable이 네이티브 프라미스로 흡수돼 마이크로태스크를 여러 번 건너뛰는 경로,
 *    `setTimeout`, 브리지가 아닌 프라미스의 `await` 뒤에는 **토큰이 유실된다**(그때는 ctx 없이
 *    나가고 호스트가 폴백한다). 단일 전역 변수로는 동시에 살아 있는 두 활성화를 구분할 수
 *    없어서 생기는 원리적 한계다 — 그래서 1번이 정본이다.
 *
 * **진단 채널(sandbox→host `type: "diagnostic"`)**: 호스트가 관측할 수 있는 실패는 브리지
 * 거부뿐이라, 샌드박스 **안에서** 난 예외(역호출 핸들러의 동기 throw·미처리 rejection)는
 * 예전엔 흔적이 0이었다 — 빈 `catch`가 삼키고, 불투명 origin이라 devtools도 못 붙는다.
 * 그 둘만 이 채널로 올려 「설정 › 플러그인 › 최근 오류」에 쌓는다(호스트가 자기 눈으로 본
 * 종류는 여기서 보고하지 못한다 — `diagnostics.ts`의 `isSandboxDiagnosticKind`가 화이트리스트다).
 *
 * `run` 처리: 플러그인 코드를 blob 스크립트로 주입한다. 스크립트 로드가 끝나도 **바로**
 * ready를 보내지 않는다 — 등록이 `settings.get(...).then(→ 등록)` 형태로 늦게 도착하는
 * 플러그인이 있어서, 미해결 브리지 호출이 0이 되고 한 틱 더 지나도 0일 때 비로소 회신한다
 * (상한 초과·로드 실패·최상위 예외는 즉시 회신 — ready가 영영 안 오는 일은 없다).
 */
export const SANDBOX_BOOTSTRAP = `
  var pending = new Map(); var seq = 0; var handlers = new Map();
  var disposeHandlers = []; var disposeRan = false;
  var currentToken = null;
  function inCtx(token, fn) {
    return function (v) {
      currentToken = token;
      try { return fn(v); } finally {
        // 해제는 동기가 아니라 마이크로태스크 한 틱 뒤에: native await의 재개는 이 콜백이
        // 예약한 잡에서 일어나므로 동기 해제면 이미 늦다. 그 사이 더 새 컨텍스트가
        // 들어섰으면(다른 창의 클릭) 건드리지 않는다.
        // 해제는 "진입 시점 값 복원"이 아니라 **null로 비우기**다: 서로 다른 토큰의 체인 둘이
        // 한 드레인에서 돌면 뒤엣것이 볼 "이전 값"은 앞엣것이 방금 세운 남의 토큰이라, 그걸
        // 되설치하면 전역이 낡은 토큰에 영구 고정돼 이후 모든 폴백 호출이 그 창으로 오배달된다.
        // 최악이 "컨텍스트 조기 소실 → 문서화된 폴백"인 쪽이 안전하다(클릭 동기 구간의 중첩은
        // invoke 핸들러의 동기 save/restore가 이미 처리한다).
        Promise.resolve().then(function () {
          if (currentToken === token) currentToken = null;
        });
      }
    };
  }
  // 반환값은 **진짜 Promise**여야 한다: 저작 타입 선언(plugin-api.d.ts)이 Promise를 단언하고,
  // 맨 thenable은 Promise.prototype.then.call 같은 내부 슬롯 경로에서 TypeError로 죽는다.
  // 그래서 native 프라미스 인스턴스에 own then/catch/finally만 덮어써 파생 체인이 토큰을 물고
  // 가게 한다. constructor를 파생 클래스로 바꾸는 것이 핵심이다 — PromiseResolve는 constructor가
  // %Promise%인 native 프라미스를 **그대로 통과**시켜 own then을 건너뛰고, 그러면 native
  // \`await memo.x()\`의 재개에서 토큰이 끊긴다. 다르게 두면 await·Promise.resolve/all이
  // thenable 흡수 경로를 타 own then이 반드시 불린다(예전 맨 객체와 같은 잡 수).
  var CtxPromise = class extends Promise {};
  var nativeThen = Promise.prototype.then;
  var nativeFinally = Promise.prototype.finally;
  function own(obj, key, value) {
    Object.defineProperty(obj, key, { value: value, writable: true, configurable: true });
  }
  function withCtx(p, token) {
    var chain = {
      // p의 own then을 다시 타면 무한 재귀이므로 프로토타입 메서드를 직접 부른다.
      then: function (onOk, onErr) {
        return withCtx(nativeThen.call(p,
          onOk ? inCtx(token, onOk) : undefined,
          onErr ? inCtx(token, onErr) : undefined), token);
      },
      catch: function (onErr) { return chain.then(undefined, onErr); },
      finally: function (onEnd) {
        return withCtx(nativeFinally.call(p, onEnd ? inCtx(token, onEnd) : undefined), token);
      }
    };
    own(p, "then", chain.then);
    own(p, "catch", chain.catch);
    own(p, "finally", chain.finally);
    own(p, "constructor", CtxPromise);
    return p;
  }
  // bound: 이 브리지가 고정으로 실을 토큰(바인딩된 memo). null이면 호출 시점의 currentToken.
  function callHost(name, args, bound) {
    var token = bound == null ? currentToken : bound;
    var p = new Promise(function (resolve, reject) {
      var id = ++seq; pending.set(id, { resolve: resolve, reject: reject, call: name });
      var msg = { __memo: true, type: "call", id: id, call: name, args: args || {} };
      if (token) msg.ctx = token;
      parent.postMessage(msg, "*");
    });
    return withCtx(p, token);
  }
  // 인자 안의 **모든 함수 값**을 핸들러 id로 치환한다(범용 프리미티브). 함수는 postMessage로
  // 직렬화되지 않으므로 로컬 맵에 보관하고 \`<키>$id\`만 호스트로 보낸다. 호스트는 그 id를
  // invoke로 되돌려주고 여기서 역호출한다. 함수가 하나도 없으면 원본을 그대로 통과시킨다
  // (배열 등 객체 형태를 건드리지 않기 위함).
  function swapHandlers(args) {
    var out = null;
    for (var k in args) {
      if (typeof args[k] !== "function") continue;
      if (out === null) { out = {}; for (var j in args) out[j] = args[j]; }
      var hid = "h:" + (++seq);
      handlers.set(hid, args[k]);
      delete out[k];
      out[k + "$id"] = hid;
    }
    return out === null ? args : out;
  }
  // runtime.*는 무권한 네임스페이스다. ready만 로컬에서 가로챈다 — 등록 마감은 브리지 왕복이
  // 아니라 이 부트스트랩의 신호이기 때문(왕복하면 그 호출 자체가 미해결로 잡혀 자기 마감을
  // 미룬다). 나머지(info·log)는 평범한 호출로 나간다. 인자 검사는 호출부(makeMemo)에서
  // 이미 끝난 뒤다 — 여기 오는 args는 항상 객체다.
  function runtimeCall(method, args, bound) {
    if (method === "ready") {
      sendReady();
      return withCtx(Promise.resolve(null), bound == null ? currentToken : bound);
    }
    // onDispose도 ready처럼 **로컬에서 끝난다**: 정리 콜백은 이 샌드박스 안에서 돌아야 하고
    // (호스트는 함수를 받을 수 없다), 호스트는 죽이기 직전에 type:"dispose"를 보내 여기서
    // 실행시키기만 하면 된다. 브리지로 보내면 핸들러가 id로만 남아 호스트가 dispose 도중
    // 역호출-응답을 또 왕복해야 하는데, 그 시점엔 이미 파괴 대기 중이라 왕복이 위험하다.
    if (method === "onDispose") {
      if (typeof args.handler === "function") disposeHandlers.push(args.handler);
      return withCtx(Promise.resolve(null), bound == null ? currentToken : bound);
    }
    return callHost("runtime." + method, swapHandlers(args || {}), bound);
  }
  function makeMemo(bound) {
    return new Proxy({}, { get: function (_t, ns) {
      return new Proxy({}, { get: function (_t2, method) {
        return function (args) {
          var call = String(ns) + "." + String(method);
          // 정본은 "객체 인자 1개"다. 예전엔 두 번째 인자가 조용히 버려져
          // memo.settings.set("k", v)가 String(undefined) 키로 저장을 시도했다(무음 손상).
          if (arguments.length > 1) {
            throw new TypeError("memo." + call + "은(는) 객체 인자 1개만 받습니다(받은 인자 " + arguments.length + "개)");
          }
          if (args == null) args = {};
          if (typeof args !== "object") {
            // 원시값 예외는 runtime.log 하나뿐이다. **runtime도 검사를 건너뛰지 않는다** —
            // 예전엔 runtime 분기가 이 검사보다 앞에 있어 memo.runtime.log("문자열")이 조용히
            // 통과했고, 호스트는 args.message를 읽으므로 진단에 **빈 줄**만 쌓였다(저작자의
            // 유일한 피드백 채널이 메시지를 통째로 잃었다).
            //  - runtime.log("메시지"): 정규화한다(로그는 문자열로 부르는 것이 자연스럽고,
            //    던져 봐야 catch 핸들러 안에서는 그 예외도 조용히 사라진다 — 값을 살린다).
            //    settings.get은 더는 예외가 아니다 — 다른 호출과 똑같이 아래에서 던진다.
            if (call === "runtime.log") args = { message: String(args) };
            else {
              throw new TypeError("memo." + call + "은(는) 객체 인자 1개만 받습니다(받은 인자: " + typeof args + ")");
            }
          }
          if (ns === "runtime") return runtimeCall(String(method), args, bound);
          var out = swapHandlers(args);
          // buttonId는 onClick$id의 별칭 — 호스트·스냅샷·노트 창이 이 이름으로 역호출한다.
          if (call === "ui.addToolbarButton" && out["onClick$id"]) out.buttonId = out["onClick$id"];
          // handlerId는 events.on의 handler$id 별칭(위와 같은 규칙) — 호스트가 이벤트마다
          // 이 id로 역호출한다. 별칭을 두는 이유는 하나 더 있다: 인덱스 가드가 "저작자가 주는
          // 함수 인자의 이름"을 아는 유일한 곳이 여기라, 이 줄이 있어야 handler라는 이름이
          // 계약과 대조된다(없으면 인덱스에서 이름을 바꿔도 아무도 못 잡는다).
          if (call === "events.on" && out["handler$id"]) out.handlerId = out["handler$id"];
          return callHost(call, out, bound);
        };
      }});
    }});
  }
  window.memo = makeMemo(null);
  // 샌드박스 **내부**에서 난 실패를 호스트 진단 채널로 올린다(sandbox→host 네 번째 메시지
  // 타입). 인자는 절대 싣지 않는다 — 노트 본문이 인자로 흘러 나가는 경로를 만들지 않는다.
  function errText(e) {
    return e && typeof e.message === "string" ? e.message : String(e);
  }
  function sendDiagnostic(kind, e) {
    var msg = { __memo: true, type: "diagnostic", kind: kind, message: errText(e) };
    // 브리지 오류는 호출명·안정 코드를 달고 온다 — 있으면 그대로 실어 「최근 오류」에서
    // "어느 호출이 왜"까지 보이게 한다.
    if (e && typeof e.call === "string") msg.call = e.call;
    if (e && typeof e.code === "string") msg.code = e.code;
    parent.postMessage(msg, "*");
  }
  // 아무도 .catch를 걸지 않은 거부 — 저작 문서가 경고하고 lint가 MISSING_CATCH로 잡는 그
  // 실패가 실제로 났을 때의 유일한 흔적이다.
  window.addEventListener("unhandledrejection", function (e) {
    sendDiagnostic("unhandled-rejection", e && e.reason);
  });
  var readySent = false;
  function sendReady(err) {
    if (readySent) return; readySent = true;
    var msg = { __memo: true, type: "ready" };
    if (err) msg.error = String(err);
    parent.postMessage(msg, "*");
  }
  // 등록이 조용해질 때까지 기다렸다 ready: 미해결 호출이 0이고 한 틱(macrotask) 뒤에도
  // 0이면 등록 완료로 본다(응답의 .then에서 나오는 후속 등록까지 잡는다). 절대 상한 3초.
  var quietDeadline = 0;
  function waitQuiet() {
    if (readySent) return;
    if (Date.now() > quietDeadline) { sendReady("등록 대기 시간 초과"); return; }
    if (pending.size > 0) { setTimeout(waitQuiet, 4); return; }
    setTimeout(function () {
      if (readySent) return;
      if (pending.size > 0) { waitQuiet(); return; }
      sendReady();
    }, 0);
  }
  function runCode(code) {
    // 핸들러 맵은 여기서 비우지 않는다: 샌드박스 하나에 run은 정확히 한 번만 오고(재빌드는
    // iframe을 버리고 새로 만든다) 실행 전에 등록될 핸들러도 없다. 비우면 "run 이전에 만든
    // 핸들러"를 쓰는 테스트 하니스만 깨질 뿐 실제 누수는 막지 못한다.
    // 플러그인 코드를 blob 스크립트로 주입한다(불투명 origin 내부 생성 → same-origin 로드).
    // eval을 쓰지 않아 CSP는 script-src에 blob:만 열면 된다('unsafe-eval' 불필요).
    var url;
    try {
      var blob = new Blob([String(code)], { type: "text/javascript" });
      url = URL.createObjectURL(blob);
    } catch (err) { sendReady(err); return; }
    var s = document.createElement("script");
    s.src = url;
    // 로드 성공: 동기 등록은 끝났지만 늦은(.then) 등록이 남아 있을 수 있다 → 조용해지면 ready.
    s.onload = function () {
      URL.revokeObjectURL(url);
      quietDeadline = Date.now() + 3000;
      waitQuiet();
    };
    s.onerror = function () { URL.revokeObjectURL(url); sendReady("스크립트 로드 실패"); };
    (document.head || document.documentElement).appendChild(s);
  }
  // 플러그인 코드가 최상위에서 던지면 load 대신 window error가 온다 → 그때도 ready 회신
  // (등록은 예외 이전까지 동기로 수집됨 — eval try/catch 시절과 동일 계약).
  window.addEventListener("error", function () { sendReady("스크립트 실행 오류"); });
  window.addEventListener("message", function (e) {
    var d = e.data; if (!d || !d.__memo) return;
    if (d.type === "response") {
      var p = pending.get(d.id); if (!p) return; pending.delete(d.id);
      if (d.ok) p.resolve(d.result);
      else {
        // 사람용 문구(.message)는 그대로 두고 기계용 안정 코드를 얹는다 — 저작자·AI가 한국어
        // 문자열을 매칭하는 대신 err.code로 분기한다. 코드가 없는 경로는 "UNKNOWN"으로
        // 채워 "code가 늘 있다"를 계약으로 만든다(있다/없다를 다시 분기하지 않게).
        var err = new Error(d.error || "거부됨");
        err.code = typeof d.code === "string" && d.code ? d.code : "UNKNOWN";
        err.call = p.call;
        p.reject(err);
      }
    } else if (d.type === "invoke") {
      // handlerId가 정본, buttonId는 옛 이름의 별칭(툴바 버튼 경로가 계속 쓴다).
      var hid = typeof d.handlerId === "string" ? d.handlerId : d.buttonId;
      var h = handlers.get(hid);
      // 이 클릭의 토큰을 (1) 핸들러 인자로 **바인딩된 memo**로 넘기고(정본 — 어떤 비동기
      // 경계도 넘는다), (2) 동기 구간 동안 전역 currentToken으로도 세운다(전역 memo용
      // 최선 노력 경로 — .then 체인과 브리지 호출 await까지 커버).
      if (h) {
        var prev = currentToken;
        var tok = typeof d.token === "string" ? d.token : null;
        currentToken = tok;
        // 예외는 삼키되(핸들러 하나가 죽어도 샌드박스는 계속 산다) **반드시 남긴다** —
        // 예전엔 빈 catch라, 버튼을 눌러도 아무 일이 안 일어나는 이유를 볼 창구가 앱 안팎
        // 어디에도 없었다(불투명 origin이라 devtools도 못 붙는다).
        try { h(makeMemo(tok), d.payload); }
        catch (err) { sendDiagnostic("onclick-throw", err); }
        finally { currentToken = prev; }
      }
    } else if (d.type === "run") {
      runCode(d.code);
    } else if (d.type === "dispose") {
      // 죽기 직전 통지. 호스트는 ack("disposed")를 **상한과 함께** 기다렸다가 iframe을
      // 파괴한다 — 그래서 여기서는 (1) 핸들러를 전부 돌리고, (2) 반환된 thenable이 있으면
      // 그것들이 정착한 뒤에 ack한다(정착 전에 ack하면 호스트가 곧바로 죽인다).
      // 핸들러가 하나도 없어도 **반드시 ack한다**: 호스트가 상한만큼 헛기다리면 설정 변경
      // 한 번에 재빌드가 그만큼 느려진다.
      if (disposeRan) return; disposeRan = true;
      var waits = [];
      for (var i = 0; i < disposeHandlers.length; i++) {
        // 첫 인자는 다른 역호출과 같은 규약(바인딩된 memo)이지만 dispose에는 창 컨텍스트가
        // 없다 — 토큰 없이 넘겨 창-스코프 호출은 호스트의 폴백 규칙을 타게 한다.
        try {
          var r = disposeHandlers[i](makeMemo(null));
          if (r && typeof r.then === "function") waits.push(r);
        } catch (err) { sendDiagnostic("onclick-throw", err); }
      }
      var ack = function () { parent.postMessage({ __memo: true, type: "disposed" }, "*"); };
      if (waits.length === 0) { ack(); return; }
      Promise.all(waits.map(function (p) {
        // 거부는 삼키되 남긴다 — 여기서 던지면 Promise.all이 끊겨 ack가 영영 안 나간다.
        return Promise.resolve(p).catch(function (e) { sendDiagnostic("unhandled-rejection", e); });
      })).then(ack);
    }
  });
  parent.postMessage({ __memo: true, type: "boot" }, "*");
`;

/**
 * 부트스트랩 인라인 스크립트의 CSP 소스 토큰(`'sha256-<base64>'` — **작은따옴표 포함**).
 *
 * 역할: tauri.conf.json의 `script-src`에 들어가는 토큰과 **정확히 같아야** 한다(따옴표까지) —
 * 가드 테스트(sandbox-bootstrap.test.ts)가 [`SANDBOX_BOOTSTRAP`]의 SHA-256을 재계산해 이
 * 상수와 tauri.conf.json 양쪽을 대조한다. 부트스트랩을 수정하면 해시가 바뀌어 가드가
 * 실패하므로, CSP를 함께 갱신하도록 강제한다.
 * 왜: "부트스트랩 원문 ↔ CSP 허용 해시"의 드리프트를 컴파일/테스트 시점에 잡기 위함.
 */
export const SANDBOX_BOOTSTRAP_CSP_HASH =
  "'sha256-LG7npS7t+5ihhHjKkO++L1+HpYqasfM20oWuxyfEOpk='";
