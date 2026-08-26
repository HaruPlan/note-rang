/**
 * memo-plugin CLI — 플러그인 `main.js` 정적 스캐너.
 *
 * 역할: 소스 텍스트에서 `memo.<ns>.<method>(...)` 호출 지점을 찾아 이름·인자 텍스트·전후
 * 문맥(대입/반환/await/중첩 인자 여부)·뒤따르는 `.then/.catch/.finally` 체인 정보를 뽑는다.
 * lint.ts의 모든 정적 검사(존재하지 않는 호출·인자 2개 이상·catch 없는 최상위 체인·설정 키
 * 대조)가 이 한 번의 스캔 결과를 공유해서 쓴다 — 검사마다 다시 파싱하지 않는다.
 *
 * 왜 AST 파서가 아니라 정규식 + 괄호 균형 스캔인가: 이 저장소는 이미
 * `src/plugin/drift-guards.test.ts`가 같은 방식(정규식으로 지점을 찾고 중괄호 균형으로 본문을
 * 자르는)으로 번들 코드를 스캔해 왔다(`onClickHandlers` 참고). CLI에 새 파서 의존성을 들이지
 * 않고 그 관행을 그대로 따른다.
 *
 * 알려진 한계(정확도를 지키기 위해 일부러 다루지 않음): 정규식 리터럴(`/.../`) 안의
 * 괄호·따옴표는 별도로 인식하지 않는다 — 저작 플러그인 코드에서 정규식 리터럴 자체가 드물고,
 * `memo.*` 호출 인자에 정규식 리터럴을 직접 쓰는 사례는 지금까지 없다. 오탐 대신 이런 입력은
 * 괄호 불균형으로 감지되면 스캐너가 조용히 그 호출을 건너뛴다(거짓 양성보다 누락이 낫다).
 */

/** 소스 위치 하나(1-기준 줄·열) — 사람이 읽는 보고에 쓴다. */
interface SourceLoc {
  line: number;
  column: number;
}

/** `.then`/`.catch`/`.finally` 체인 추적 결과. */
interface ChainInfo {
  hasThen: boolean;
  hasCatch: boolean;
  hasFinally: boolean;
  /**
   * 체인 추적 중 인식하지 못한 메서드(`then`/`catch`/`finally`가 아닌 다른 체인, 예:
   * `.map(...)`)를 만나 더 진행하지 않은 경우 true. 이후에 `.catch`가 있었을 수도 없었을
   * 수도 있어 판단이 불확실하므로, lint는 uncertain인 체인을 "catch 없음"으로 단정하지
   * 않는다(거짓 양성 방지).
   */
  uncertain: boolean;
}

/** 소스에서 찾은 `memo.<ns>.<method>(...)` 호출 지점 하나. */
interface MemoCallSite {
  /** `"<ns>.<method>"` — `memo.` 접두 없이, host.ts의 CALL_PERMISSIONS 키와 같은 어휘. */
  call: string;
  /** `memo` 토큰이 시작하는 인덱스. */
  matchIndex: number;
  /** 여는 `(`의 인덱스. */
  openParenIndex: number;
  /** 닫는 `)`의 인덱스. 괄호가 끝내 안 닫히면(구문 오류로 추정) -1이고 이 호출은 스킵 대상. */
  closeParenIndex: number;
  /** 괄호 안 원문 그대로(트림 없음). */
  argsText: string;
  /** 최상위(괄호/문자열 밖) 콤마 기준 인자 개수. 빈 인자 목록이면 0. */
  argCount: number;
  /** 바로 앞이 `await` 키워드인가 — 참이면 호출자가 실패를 어떻게 다루는지 CLI가 추적할 수
   * 없으므로(둘러싼 함수 전체를 봐야 함) missing-catch 판정에서 제외한다. */
  precededByAwait: boolean;
  /** 바로 앞이 화살표 함수의 `=>`인가(암묵적 반환) — 반환과 동급으로 취급해 제외한다. */
  precededByArrow: boolean;
  /** 다른 호출의 인자·배열 리터럴 등 "값 위치"에 있는가(`(` `,` `[` `=` 직후). 값으로
   * 쓰이면 그 프라미스의 처리 책임이 바깥 표현식에 있다고 보고 missing-catch에서 제외한다. */
  isNested: boolean;
  /** catch 핸들러(`.catch(fn)`, `.then(ok, err)`의 두 번째 인자, `try{}catch(e){}` 블록) 본문
   * 안에 있는가. 이미 실패를 처리하는 중인 곳에서 부른 `memo.*`에 다시 `.catch`를 요구하는
   * 것은 무의미하므로(실증: 정본 예제 3개의 로그 호출 7건이 이 모양) missing-catch에서
   * 제외한다. 중첩 깊이와 무관하게(중첩 catch·async 함수의 catch 포함) 판정한다. */
  inCatchHandler: boolean;
  chain: ChainInfo;
}

/** 여는 괄호 문자에 대응하는 닫는 문자. */
function closingOf(open: string): string {
  return open === "(" ? ")" : open === "[" ? "]" : "}";
}

/**
 * `src[openIndex]`가 `(`/`[`/`{` 중 하나일 때, 그와 균형이 맞는 닫는 괄호의 인덱스를 찾는다.
 * 문자열·템플릿 리터럴·줄/블록 주석 내부의 괄호는 세지 않는다. 못 찾으면 closeIndex: -1.
 * 같은 스캔에서 **가장 바깥 깊이(스택 길이 1)의 콤마 위치**도 함께 모은다 — 인자 개수 세기와
 * 괄호 짝 찾기가 항상 같은 텍스트를 다시 훑게 되므로 한 번에 처리한다.
 */
export function scanBalanced(
  src: string,
  openIndex: number,
): { closeIndex: number; topLevelCommas: number[] } {
  const stack: string[] = [src[openIndex]!];
  const topLevelCommas: number[] = [];
  let i = openIndex + 1;
  while (i < src.length && stack.length > 0) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack[stack.length - 1]!;
      if (stack.length === 1 && c === closingOf(top)) {
        return { closeIndex: i, topLevelCommas };
      }
      stack.pop();
      i++;
      continue;
    }
    if (c === "," && stack.length === 1) topLevelCommas.push(i);
    i++;
  }
  return { closeIndex: -1, topLevelCommas };
}

/** `src[i]`가 여는 따옴표(`quote`)일 때 백슬래시 이스케이프를 존중하며 닫는 인덱스 다음
 * 위치를 반환한다. 못 찾으면(미종결 문자열) 소스 끝. */
function skipQuoted(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    if (src[j] === "\n") return j; // 종결 안 된 문자열 — 더 진행하지 않는다(줄 끝에서 포기).
    j++;
  }
  return j;
}

/** `src[i]`가 여는 백틱일 때 템플릿 리터럴 전체(중첩 `${ ... }` 포함, 재귀적으로 다시
 * 문자열·템플릿·괄호를 포함할 수 있음)를 건너뛰고 닫는 백틱 다음 위치를 반환한다. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "`") return j + 1;
    if (src[j] === "$" && src[j + 1] === "{") {
      const { closeIndex } = scanBalanced(src, j + 1);
      j = closeIndex === -1 ? src.length : closeIndex + 1;
      continue;
    }
    j++;
  }
  return j;
}

/** 주석·문자열·템플릿 리터럴 내용을 같은 길이의 공백으로 지운 사본을 만든다 — 호출 탐지
 * 정규식이 주석/문자열 속 `memo.x.y(` 텍스트를 실제 호출로 오인하지 않게 하는 용도뿐이며,
 * 반환값은 호출 탐지에만 쓰고 실제 인자 텍스트 추출에는 원본 소스를 그대로 쓴다. */
function maskCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      for (let k = i; k < end; k++) out[k] = " ";
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const closeAt = src.indexOf("*/", i + 2);
      const end = closeAt === -1 ? src.length : closeAt + 2;
      for (let k = i; k < end; k++) out[k] = " ";
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(src, i, c);
      for (let k = i; k < end; k++) out[k] = " ";
      i = end;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(src, i);
      for (let k = i; k < end; k++) out[k] = " ";
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** `matchIndex` 직전 문맥(공백 건너뛴 마지막 문자·`await`/`=>` 여부·값 위치 여부)을 읽는다. */
function readPrevContext(
  src: string,
  matchIndex: number,
): {
  prevChar: string | null;
  precededByAwait: boolean;
  precededByArrow: boolean;
  isNested: boolean;
} {
  let i = matchIndex - 1;
  while (i >= 0 && /\s/.test(src[i]!)) i--;
  const prevChar = i >= 0 ? src[i]! : null;
  let precededByAwait = false;
  let precededByReturn = false;
  if (prevChar !== null && /[A-Za-z0-9_$]/.test(prevChar)) {
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j]!)) j--;
    const word = src.slice(j + 1, i + 1);
    precededByAwait = word === "await";
    precededByReturn = word === "return";
  }
  const precededByArrow = prevChar === ">" && src[i - 1] === "=";
  const isNested =
    precededByReturn || (prevChar !== null && "(,[=".includes(prevChar));
  return { prevChar, precededByAwait, precededByArrow, isNested };
}

/** 호출 종료(`closeParenIndex` 다음) 지점부터 `.then`/`.catch`/`.finally` 체인을 따라간다. */
function scanChain(src: string, afterCloseIndex: number): ChainInfo {
  let i = afterCloseIndex;
  let hasThen = false;
  let hasCatch = false;
  let hasFinally = false;
  for (;;) {
    let j = i;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    if (src[j] !== ".") break;
    j++;
    const identStart = j;
    while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
    const ident = src.slice(identStart, j);
    while (j < src.length && /\s/.test(src[j]!)) j++;
    if (src[j] !== "(") {
      // `.foo` 뒤에 호출이 아닌 다른 게 옴 — 더 이상 이 체인의 catch 여부를 확신할 수 없다.
      return { hasThen, hasCatch, hasFinally, uncertain: true };
    }
    const { closeIndex } = scanBalanced(src, j);
    if (closeIndex === -1) {
      return { hasThen, hasCatch, hasFinally, uncertain: true };
    }
    if (ident === "then") hasThen = true;
    else if (ident === "catch") hasCatch = true;
    else if (ident === "finally") hasFinally = true;
    else {
      // 알려지지 않은 체인 메서드(예: .map) — 그 뒤에 catch가 있었을 수도 있어 단정하지 않는다.
      return { hasThen, hasCatch, hasFinally, uncertain: true };
    }
    i = closeIndex + 1;
  }
  return { hasThen, hasCatch, hasFinally, uncertain: false };
}

/** 소스 구간 하나(catch 핸들러 본문의 시작 `{`/식 시작 인덱스 ~ 끝 인덱스, 둘 다 포함). */
interface CatchHandlerSpan {
  start: number;
  end: number;
}

/**
 * `masked[start, end)` 구간에 놓인 인자 하나가 함수 리터럴/화살표 함수인지 보고, 맞다면 그
 * **본문**의 [start, end] 구간(중괄호 블록이면 여는/닫는 중괄호 포함, 식 본문이면 식 전체)을
 * 돌려준다. 이름 있는 참조(`.catch(handleError)`)처럼 본문을 정적으로 볼 수 없으면 null —
 * 그런 경우는 애초에 처리 여부를 판단할 수 없으니 exemption 대상에서도 빠진다(과대 면제 방지).
 */
function findHandlerBodySpan(
  masked: string,
  start: number,
  end: number,
): CatchHandlerSpan | null {
  let i = start;
  while (i < end && /\s/.test(masked[i]!)) i++;
  if (/^function\b/.test(masked.slice(i, end))) {
    let j = i + "function".length;
    while (j < end && /\s/.test(masked[j]!)) j++;
    while (j < end && /[A-Za-z0-9_$]/.test(masked[j]!)) j++; // 선택적 함수 이름.
    while (j < end && /\s/.test(masked[j]!)) j++;
    if (masked[j] !== "(") return null;
    const { closeIndex: paramsClose } = scanBalanced(masked, j);
    if (paramsClose === -1) return null;
    let k = paramsClose + 1;
    while (k < end && /\s/.test(masked[k]!)) k++;
    if (masked[k] !== "{") return null;
    const { closeIndex: bodyClose } = scanBalanced(masked, k);
    if (bodyClose === -1) return null;
    return { start: k, end: bodyClose };
  }
  // 화살표 함수: 매개변수(`(...)` 또는 단일 식별자) 다음 `=>`.
  let j = i;
  if (masked[j] === "(") {
    const { closeIndex } = scanBalanced(masked, j);
    if (closeIndex === -1) return null;
    j = closeIndex + 1;
  } else if (j < end && /[A-Za-z_$]/.test(masked[j]!)) {
    while (j < end && /[A-Za-z0-9_$]/.test(masked[j]!)) j++;
  } else {
    return null; // 함수 리터럴도 화살표도 아닌 표현식(이름 있는 참조 등) — 판단 보류.
  }
  while (j < end && /\s/.test(masked[j]!)) j++;
  if (masked[j] !== "=" || masked[j + 1] !== ">") return null;
  j += 2;
  while (j < end && /\s/.test(masked[j]!)) j++;
  if (masked[j] === "{") {
    const { closeIndex: bodyClose } = scanBalanced(masked, j);
    if (bodyClose === -1) return null;
    return { start: j, end: bodyClose };
  }
  return { start: j, end }; // 식 본문(암묵 반환) — 인자 끝까지가 본문.
}

/**
 * 소스 전체에서 "이미 실패를 처리 중인" 구간을 모은다: `.catch(fn)` 메서드 체인, `.then(ok,
 * err)`의 두 번째 인자, `try{}catch(e){}`(선택적 바인딩 포함) 블록. 중첩 여부와 무관하게 소스
 * 전체를 훑으므로 중첩 catch·async 함수 안의 catch도 자연히 포함된다.
 */
function findCatchHandlerSpans(masked: string): CatchHandlerSpan[] {
  const spans: CatchHandlerSpan[] = [];

  // try/catch 절 — 메서드 호출(`.catch(`)이 아닌 키워드 `catch`만 노린다.
  const catchClauseRe = /(^|[^.\w$])catch\b/g;
  for (const m of masked.matchAll(catchClauseRe)) {
    const kwStart = m.index + m[1]!.length;
    let i = kwStart + "catch".length;
    while (i < masked.length && /\s/.test(masked[i]!)) i++;
    if (masked[i] === "(") {
      const { closeIndex } = scanBalanced(masked, i);
      if (closeIndex === -1) continue;
      i = closeIndex + 1;
      while (i < masked.length && /\s/.test(masked[i]!)) i++;
    }
    if (masked[i] !== "{") continue; // catch 블록이 없는 형태(구문 이상) — 스킵.
    const { closeIndex: bodyClose } = scanBalanced(masked, i);
    if (bodyClose === -1) continue;
    spans.push({ start: i, end: bodyClose });
  }

  // `.catch(handler)` 메서드 체인.
  const dotCatchRe = /\.\s*catch\s*\(/g;
  for (const m of masked.matchAll(dotCatchRe)) {
    const openParenIndex = m.index + m[0].length - 1;
    const { closeIndex } = scanBalanced(masked, openParenIndex);
    if (closeIndex === -1) continue;
    const span = findHandlerBodySpan(masked, openParenIndex + 1, closeIndex);
    if (span !== null) spans.push(span);
  }

  // `.then(onFulfilled, onRejected)`의 두 번째 인자 — 인자가 정확히 2개일 때만.
  const dotThenRe = /\.\s*then\s*\(/g;
  for (const m of masked.matchAll(dotThenRe)) {
    const openParenIndex = m.index + m[0].length - 1;
    const { closeIndex, topLevelCommas } = scanBalanced(masked, openParenIndex);
    if (closeIndex === -1 || topLevelCommas.length !== 1) continue;
    const secondArgStart = topLevelCommas[0]! + 1;
    const span = findHandlerBodySpan(masked, secondArgStart, closeIndex);
    if (span !== null) spans.push(span);
  }

  return spans;
}

/**
 * 점 앞뒤의 공백·개행을 허용한다 — prettier가 긴 호출을 `memo.ui\n  .addToolbarButton({`로
 * 줄바꿈하기 때문이다. 붙여 쓴 형태만 잡으면 **정본 예제 자신이 스캔에서 빠져** 없는 호출·
 * 인자 개수 검사가 통째로 건너뛰어지고, 쓰고 있는 권한이 "미사용 권한" 경고로 뜬다(실증).
 */
const MEMO_CALL_RE =
  /\bmemo\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * 소스 전체에서 `memo.<ns>.<method>(...)` 호출 지점을 모두 찾는다.
 *
 * `something.memo.x.y()`처럼 `memo`가 프로퍼티 접근으로 나타나는 경우(바로 앞 문자가 `.`)는
 * 전역 브리지 호출이 아니라고 보고 제외한다 — 이 저장소의 규약상 전역 `memo`는 프로퍼티로
 * 감싸이지 않는다.
 */
export function findMemoCallSites(src: string): MemoCallSite[] {
  const masked = maskCommentsAndStrings(src);
  const catchSpans = findCatchHandlerSpans(masked);
  const sites: MemoCallSite[] = [];
  for (const m of masked.matchAll(MEMO_CALL_RE)) {
    const matchIndex = m.index;
    const ns = m[1]!;
    const method = m[2]!;
    const openParenIndex = matchIndex + m[0].length - 1;
    // 앞뒤 문맥은 **마스킹된 소스**로 읽는다(길이가 같아 인덱스는 그대로 통한다). 원문으로
    // 읽으면 바로 위 줄의 주석이 문맥으로 새어 든다 — 이 저장소의 주석은 한국어 문장이라
    // 마침표로 끝나는 일이 흔한데, 그러면 `prevChar === "."`가 되어 그 호출 전체가 "프로퍼티
    // 접근"으로 오인돼 스캔에서 통째로 빠졌다(정본 예제 두 곳에서 실증).
    const { prevChar, precededByAwait, precededByArrow, isNested } =
      readPrevContext(masked, matchIndex);
    if (prevChar === ".") continue; // 프로퍼티 접근 — 전역 브리지 호출이 아니다.
    const { closeIndex, topLevelCommas } = scanBalanced(src, openParenIndex);
    if (closeIndex === -1) continue; // 미종결 — 구문 오류로 추정, 스킵(거짓 양성 방지).
    const argsText = src.slice(openParenIndex + 1, closeIndex);
    const argCount = argsText.trim() === "" ? 0 : topLevelCommas.length + 1;
    // 체인 추적도 마스킹본으로 — 호출 끝과 `.catch` 사이에 주석이 끼면 원문에서는 `/`를
    // 만나 체인이 끊긴 것으로 오판한다(있는 catch를 못 보고 MISSING_CATCH 경고).
    const chain = scanChain(masked, closeIndex + 1);
    const inCatchHandler = catchSpans.some(
      // start 경계 포함: 화살표 함수 식 본문(`e => memo.foo()`)은 본문 시작이 곧 호출
      // 시작이라 등호 비교가 필요하다. end는 닫는 중괄호 인덱스라 항상 호출 끝보다 뒤다.
      (s) => matchIndex >= s.start && matchIndex <= s.end,
    );
    sites.push({
      call: `${ns}.${method}`,
      matchIndex,
      openParenIndex,
      closeParenIndex: closeIndex,
      argsText,
      argCount,
      precededByAwait,
      precededByArrow,
      isNested,
      inCatchHandler,
      chain,
    });
  }
  return sites;
}

/** 인덱스를 1-기준 (줄, 열)로 바꾼다. */
export function lineColOf(src: string, index: number): SourceLoc {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      lastNl = i;
    }
  }
  return { line, column: index - lastNl };
}
