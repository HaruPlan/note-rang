// memo-plugin types가 manifest.json의 settings 스키마에서 생성했다 — 손으로 고치지 마라.
// 정본은 manifest.json이다. 스키마를 바꾼 뒤에는 다시 생성한다:
//   npm run plugin -- types <이 폴더>
//
// main.js에서 이렇게 참조한다(VS Code 등 TS 언어 서버가 붙는 편집기에서 자동완성·오타 검출):
//   memo.settings.getAll().then(function (cfg) {
//     // getAll()은 Record<string, unknown>을 주므로 unknown을 거쳐 이 플러그인 설정 타입으로 좁힌다.
//     var s = /** @type {import("./settings.d.ts").PluginSettings} */ (/** @type {unknown} */ (cfg));
//     // 이제 s.<키>는 타입이 잡혀 편집기가 오타(cfg.greetng)·리터럴 오타(style === "casaul")를 잡는다.
//   });

/** 이 플러그인의 설정 값 맵 — `memo.settings.getAll()`의 반환을 이 타입으로 좁혀 쓴다.
 *  개별 키는 `memo.settings.get({ key: "..." })`의 반환과 같은 타입이다.
 */
export interface PluginSettings {
  /** 경로 앞에 붙일 도장 — 복사할 때 경로 앞에 붙는 문구입니다. */
  stamp: string;
}

/** 설정 키 이름의 닫힌 유니온 — `memo.settings.get({ key })`의 key 자동완성·오타 검출용. */
export type PluginSettingKey = keyof PluginSettings;
