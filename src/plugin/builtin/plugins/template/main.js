// 템플릿 플러그인 — 미리 만든 텍스트를 키워드 치환해 커서 위치에 삽입하고,
// 현재 메모를 이름 붙여 템플릿으로 저장한다.
// 버튼 위치는 전역 "툴바 배치"(설정)가 정하고, 여기 position은 미배치 시의 기본값(폴백)이다.
//
// 설정 계약: `templates`(list)는 호스트가 파싱해 [{name, body}] 배열로 준다 —
// 직렬화 포맷은 호스트 소유라 여기서 파싱하지도, 이름의 `=`를 지우지도 않는다. select 값은
// 라벨이 아니라 매니페스트가 선언한 value("cursor"·"iso")로 오므로 매핑 테이블도 없다.
// 기본값은 매니페스트 `default`(KO_TEMPLATES와 바이트 동일 — template.test.ts가 대조한다)가
// 정본이고 `getAll()`이 병합해 주므로 그 값 자체는 여기 다시 적지 않는다. 다만 그 기본값은
// 한국어 3종 고정이라, 병합된 `templates`가 KO_TEMPLATES·EN_TEMPLATES(아래) 중 **아무 데도
// 손대지 않은 것과 바이트 동일**하면 활성 로케일 세트로 바꿔 보여준다(로케일화된 기본 예시,
// settings.ts의 같은 이름 로직과 쌍 — 두 파일이 서로 다른 실행 환경이라 부득이 데이터를
// 나눠 갖는다). 한 글자라도 고쳐 저장한 값은 이 두 배열 중 무엇과도 같지 않으므로 그대로(로케일
// 전환과 무관하게) 나간다 — "저장값 없으면 로케일 기본, 한 번이라도 수정·저장하면 영구 유지"
// 규칙이 저절로 지켜진다. 설정 화면의 "기본값으로 되돌리기"는 그 순간의 로케일 세트를 그대로
// 저장하므로(참조 settings.ts) 되돌린 값도 이 판정에 다시 걸린다.
//
// onClick은 바인딩된 memo를 받지 않고 전역 memo를 그대로 쓴다 — 이 플러그인의 두 버튼은 한
// 시점에 한 동작만 하고(연속 창-스코프 호출이 여러 창을 오갈 위험이 낮다), 무엇보다 이
// 버튼들은 단축키로도 별칭되어 핸들러가 인자 없이 불릴 수 있는 경로가 이미 있다.
//
// 사용자 노출 문자열(버튼 타이틀·토스트·pickList/prompt 타이틀)은 이 플러그인 자기 사전에서
// 고른다(축 2). 활성 로케일은 memo.i18n.locale()(무권한, 캐시된 값)로 한 번만 읽어 설정
// 로드와 함께 진행한다(Promise.all — 등록이 그만큼 지연되지 않는다). {weekday} 등 키워드
// 치환 결과(WEEKDAYS)는 **메모 본문에 삽입되는 콘텐츠**라 로케일화 대상이 아니다 — 이 사전은
// 어디까지나 플러그인 자신이 그리는 UI 문구(버튼·토스트·팝업)에만 쓴다.
var WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
var DOW_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

var STRINGS = {
  ko: {
    insertButtonTitle: "템플릿 삽입",
    saveButtonTitle: "현재 메모를 템플릿으로 저장",
    inserted: function (name) {
      return name + " 삽입됨";
    },
    insertFailed: function (code) {
      return "삽입하지 못했습니다 (" + code + ")";
    },
    noTemplates: "템플릿이 없습니다 — ➕로 저장하거나 설정에서 추가하세요",
    pickTitle: "템플릿 선택",
    nothingToSave: "저장할 내용이 없습니다",
    savePromptTitle: "템플릿 이름",
    savePromptPlaceholder: "예: 주간회의",
    saved: function (name) {
      return "'" + name + "' 저장됨";
    },
    saveFailed: function (code) {
      return "저장하지 못했습니다 (" + code + ")";
    },
  },
  en: {
    insertButtonTitle: "Insert template",
    saveButtonTitle: "Save current note as a template",
    inserted: function (name) {
      return name + " inserted";
    },
    insertFailed: function (code) {
      return "Couldn't insert (" + code + ")";
    },
    noTemplates: "No templates yet — save one with ➕ or add one in settings",
    pickTitle: "Choose a template",
    nothingToSave: "Nothing to save",
    savePromptTitle: "Template name",
    savePromptPlaceholder: "e.g. Weekly meeting",
    saved: function (name) {
      return "'" + name + "' saved";
    },
    saveFailed: function (code) {
      return "Couldn't save (" + code + ")";
    },
  },
};
var S = STRINGS.ko;

// 로케일별 기본 예시 템플릿. KO_TEMPLATES는 manifest.json `templates.default`를 parseListBlob으로
// 편 것과 바이트 동일해야 한다(template.test.ts가 "저장값 없음" 시나리오로 대조). EN_TEMPLATES는
// 단순 직역이 아니라 영어 사용자에게 같은 성격(주간회의·데일리·회고)으로 자연스러운 예시다.
var KO_TEMPLATES = [
  {
    name: "📅 주간회의",
    body:
      "# {week}주차 주간회의 ({today} {weekday})\n\n## 지난주 리뷰\n- {cursor}\n\n" +
      "## 이번주 계획\n-\n\n## 논의사항\n-",
  },
  { name: "📝 데일리", body: "## {today} 데일리 노트\n- 오늘 할 일:" },
  {
    name: "✅ 회고",
    body: "# 회고 ({today})\n- Keep:\n- Problem:\n- Try:",
  },
];
// EN_TEMPLATES는 일부러 {weekday}를 쓰지 않는다 — WEEKDAYS(위)가 한국어 고정이라 영어 예시
// 본문에 넣으면 "Week 28 meeting (2026-07-09 목요일)"처럼 언어가 섞여 나온다.
var EN_TEMPLATES = [
  {
    name: "📅 Weekly meeting",
    body:
      "# Week {week} meeting ({today})\n\n## Last week's review\n- {cursor}\n\n" +
      "## This week's plan\n-\n\n## Discussion topics\n-",
  },
  { name: "📝 Daily note", body: "## {today} daily note\n- To do today:" },
  {
    name: "✅ Retro",
    body: "# Retro ({today})\n- Keep:\n- Problem:\n- Try:",
  },
];
var DEFAULT_TEMPLATES_BY_LOCALE = { ko: KO_TEMPLATES, en: EN_TEMPLATES };
var KNOWN_DEFAULT_TEMPLATE_SETS = [KO_TEMPLATES, EN_TEMPLATES];

/** 두 템플릿 배열이 이름·본문까지 정확히 같은가(순서 포함, 얕은 비교). */
function sameTemplateList(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (!a[i] || a[i].name !== b[i].name || a[i].body !== b[i].body) {
      return false;
    }
  }
  return true;
}

// 저장값이 "아직 아무도 손대지 않은 기본 세트"(ko든 en이든 — 다른 로케일에서 되돌리기를 눌러
// 그 언어로 저장됐을 수도 있다)와 바이트 동일하면 활성 로케일 세트로 바꿔 보여준다. 실제로 한
// 글자라도 고쳐 저장한 값은 이 배열들 중 무엇과도 같지 않으므로 그대로 나간다.
function localizeTemplates(list, locale) {
  for (var i = 0; i < KNOWN_DEFAULT_TEMPLATE_SETS.length; i++) {
    if (sameTemplateList(list, KNOWN_DEFAULT_TEMPLATE_SETS[i])) {
      return DEFAULT_TEMPLATES_BY_LOCALE[locale] || list;
    }
  }
  return list;
}

// 런타임 상태(상주 샌드박스 1개가 모든 노트 창을 공유 — 저장 시 로컬도 갱신해 즉시 반영).
var templates = []; // [{ name, body }] — 호스트가 준 그대로(로케일 폴백 적용 후).
var cfg = { insertMode: "", dateFormat: "" }; // getAll()이 채운다(매니페스트 default 병합분).

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function fmtDate(d, fmt) {
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  if (fmt === "dot") return y + "." + pad(m) + "." + pad(day);
  if (fmt === "ko") return y + "년 " + m + "월 " + day + "일";
  return y + "-" + pad(m) + "-" + pad(day); // iso
}

function addDays(base, n) {
  var d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

// ISO 주차(월요일 시작).
function isoWeek(base) {
  var t = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  var dayNr = (t.getDay() + 6) % 7; // 월=0..일=6
  t.setDate(t.getDate() - dayNr + 3); // 그 주의 목요일
  var firstThu = new Date(t.getFullYear(), 0, 4);
  var firstNr = (firstThu.getDay() + 6) % 7;
  firstThu.setDate(firstThu.getDate() - firstNr + 3);
  return 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 864e5));
}

// 이번 주(월요일 시작) 특정 요일(0=일..6=토)의 날짜.
function weekdayDate(base, targetDow) {
  var d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  var curIdx = (d.getDay() + 6) % 7; // 월=0..일=6
  var tgtIdx = (targetDow + 6) % 7;
  d.setDate(d.getDate() + (tgtIdx - curIdx));
  return d;
}

function uuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* 보안 컨텍스트 아님 → 아래 폴백 */
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// 파일명(확장자 제외).
function titleFromPath(path) {
  if (!path) return "";
  var base = path.split("/").pop().split("\\").pop();
  return base.replace(/\.md$/i, "");
}

// 키워드 치환. note = { path, content } 또는 null.
function expand(body, note) {
  var now = new Date();
  var fmt = cfg.dateFormat;
  var out = String(body);

  // 오프셋 날짜 {today+N}/{today-N} — 정적 {today}보다 먼저.
  out = out.replace(/\{today([+-]\d+)\}/g, function (_m, off) {
    return fmtDate(addDays(now, parseInt(off, 10)), fmt);
  });
  // 요일 날짜 {monday}..{sunday}.
  for (var i = 0; i < 7; i++) {
    out = out.split("{" + DOW_NAMES[i] + "}").join(fmtDate(weekdayDate(now, i), fmt));
  }

  var hm = pad(now.getHours()) + ":" + pad(now.getMinutes());
  var repl = {
    "{today}": fmtDate(now, fmt),
    "{yesterday}": fmtDate(addDays(now, -1), fmt),
    "{tomorrow}": fmtDate(addDays(now, 1), fmt),
    "{time}": hm,
    "{datetime}": fmtDate(now, fmt) + " " + hm,
    "{now}": fmtDate(now, fmt) + " " + hm + ":" + pad(now.getSeconds()),
    "{year}": "" + now.getFullYear(),
    "{month}": pad(now.getMonth() + 1),
    "{day}": pad(now.getDate()),
    "{weekday}": WEEKDAYS[now.getDay()],
    "{week}": "" + isoWeek(now),
    "{title}": note ? titleFromPath(note.path) : "",
    "{path}": note && note.path ? note.path : "",
    "{uuid}": uuid(),
  };
  for (var k in repl) {
    if (Object.prototype.hasOwnProperty.call(repl, k)) {
      out = out.split(k).join(repl[k]);
    }
  }
  return out;
}

// 템플릿 1개를 현재 노트의 커서 위치에 삽입한다.
function insertTemplate(tpl) {
  memo.notes.current()
    .then(function (note) {
      var expanded = expand(tpl.body, note);
      var caretIdx = expanded.indexOf("{cursor}");
      var text = expanded.split("{cursor}").join("");
      var args = { text: text, mode: cfg.insertMode };
      if (caretIdx >= 0) args.caret = caretIdx;
      return memo.editor.insertText(args).then(function () {
        return memo.ui.toast({ title: S.inserted(tpl.name) });
      });
    })
    .catch(function (e) {
      memo.ui
        .toast({ title: S.insertFailed(e.code) })
        .catch(function (t) {
          memo.runtime.log({ message: "toast 실패: " + t.code });
        });
      memo.runtime.log({ message: e.call + " → " + e.code });
    });
}

// 📄 삽입: 0개→안내, 1개→바로, 2개↑→선택 팝업.
function onInsertClick() {
  if (templates.length === 0) {
    memo.ui
      .toast({ title: S.noTemplates })
      .catch(function (e) {
        memo.runtime.log({ message: e.call + " → " + e.code });
      });
    return;
  }
  if (templates.length === 1) {
    insertTemplate(templates[0]);
    return;
  }
  var items = templates.map(function (t, i) {
    return { id: "" + i, label: t.name };
  });
  memo.ui.pickList({ title: S.pickTitle, items: items })
    .then(function (id) {
      if (id === null || id === undefined) return;
      var idx = parseInt(id, 10);
      if (idx >= 0 && idx < templates.length) insertTemplate(templates[idx]);
    })
    .catch(function (e) {
      memo.runtime.log({ message: e.call + " → " + e.code });
    });
}

// ➕ 저장: 현재 메모 본문을 이름 붙여 템플릿 목록 끝에 덧붙인다.
function onSaveClick() {
  memo.notes.current()
    .then(function (note) {
      var content = note && note.content ? note.content : "";
      if (content.replace(/\s+/g, "") === "") {
        return memo.ui.toast({ title: S.nothingToSave });
      }
      return memo.ui.prompt({ title: S.savePromptTitle, placeholder: S.savePromptPlaceholder })
        .then(function (raw) {
          if (raw === null || raw === undefined) return null;
          var name = String(raw).replace(/^\s+|\s+$/g, "");
          if (name === "") return null;
          // 항목 배열을 그대로 넘긴다 — 직렬화도, 이름 살균(헤더 문법 충돌)도 호스트가 한다.
          var next = templates.concat([{ name: name, body: content }]);
          return memo.settings.set({ key: "templates", value: next })
            .then(function () {
              templates = next; // 즉시 반영(상주 샌드박스 공유).
              return memo.ui.toast({ title: S.saved(name) });
            });
        });
    })
    .catch(function (e) {
      memo.ui
        .toast({ title: S.saveFailed(e.code) })
        .catch(function (t) {
          memo.runtime.log({ message: "toast 실패: " + t.code });
        });
      memo.runtime.log({ message: e.call + " → " + e.code });
    });
}

function activeLocale() {
  return memo.i18n && typeof memo.i18n.locale === "function"
    ? memo.i18n.locale()
    : Promise.resolve("ko");
}

// 초기화: 로케일 + 설정 전체를 함께 읽고(기본값은 매니페스트가 정본) 툴바 버튼 2개를 등록한다.
Promise.all([activeLocale(), memo.settings.getAll()])
  .then(function (r) {
    S = STRINGS[r[0]] || STRINGS.ko;
    var s = r[1];
    templates = localizeTemplates(s.templates, r[0]);
    cfg.insertMode = s.insertMode;
    cfg.dateFormat = s.dateFormat;
    // 아이콘: 새 메모 버튼(core:new-note, note-toolbar.ts)의 "+" 강조와 혼동되지 않도록
    // 점선 문서/색인 느낌의 글리프를 쓴다(베타 피드백 2건) — 📑는 저장해 둔 여러 템플릿 중
    // 하나를 "골라 꽂아 넣는다"는 인덱스 탭 이미지라 ➕(추가)와 뚜렷이 다르다.
    return memo.ui.addToolbarButton({
      id: "template-insert",
      label: "📑",
      title: S.insertButtonTitle,
      position: "top-right",
      onClick: onInsertClick,
    });
  })
  .then(function () {
    // 이전엔 ➕였다 — "새 메모 만들기"(core:new-note)와 같은 "+" 계열이라 두 버튼이 혼동된다는
    // 베타 피드백(#2)을 받아 "이 메모를 보관함에 챙겨 넣는다"는 파일함 글리프로 바꿨다.
    return memo.ui.addToolbarButton({
      id: "template-save",
      label: "🗃️",
      title: S.saveButtonTitle,
      position: "top-right",
      onClick: onSaveClick,
    });
  })
  .then(function () {
    // memo.runtime은 항상 있는 무권한 네임스페이스이지만, 이 파일을 실행하는 일부 테스트
    // 하니스가 흉내 내지 않는다 — 방어적으로 감싼다(실제 호스트에서는 늘 있다).
    if (memo.runtime && typeof memo.runtime.ready === "function") {
      return memo.runtime.ready();
    }
    return null;
  })
  .catch(function (e) {
    if (memo.runtime && typeof memo.runtime.log === "function") {
      memo.runtime.log({ message: "초기화 실패: " + e.call + " → " + e.code });
    }
  });
