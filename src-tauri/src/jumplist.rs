//! 작업 표시줄 점프 리스트(앱 버튼 우클릭 메뉴)의 **Tasks** 섹션 — Windows 전용.
//!
//! 역할: 크롬의 "새 창"처럼, 작업 표시줄 버튼을 우클릭했을 때 앱 이름·고정·창 닫기만 있던
//! 표준 메뉴 위에 앱 작업 세 개(새 노트 · 노트 목록·검색 · 설정)를 얹는다. 트레이 메뉴의 앞
//! 세 항목과 **같은 동작·같은 순서**다([`crate::tray`]) — 트레이 아이콘이 Windows에서 기본적으로
//! 겹침 목록("^")에 숨겨지는 탓에 찾기 어렵다는 문제의 두 번째 진입점이다.
//!
//! 이 모듈은 두 가지 일을 한다. 둘은 짝이다:
//!
//! 1. **등록**([`refresh`]) — 셸 COM(`ICustomDestinationList`)으로 Tasks 목록을 커밋한다.
//!    각 항목은 "현재 exe를 특정 인자와 함께 실행"하는 바로가기(`IShellLinkW`)다.
//! 2. **인자 처리**([`action_from_args`] · [`dispatch`]) — 그래서 항목을 누르면 앱이 **다시
//!    실행된다**. 이 앱은 싱글 인스턴스(이슈 #27)라 그 실행은 보통 기존 인스턴스의
//!    `handle_second_instance`로 흡수되지만, 앱이 꺼져 있었다면 그냥 최초 실행이다. 두 경로
//!    **모두** 같은 인자를 같은 동작으로 풀어야 하므로 파싱을 순수 함수로 떼어 한 곳에 둔다
//!    (`lib.rs`가 두 지점에서 이 함수를 부른다).
//!
//! macOS/Linux에는 대응 개념이 없어 [`refresh`]가 no-op이다. 반면 인자 파싱·디스패치는
//! 플랫폼과 무관한 순수 로직이라 `cfg`로 가르지 않는다 — 그래야 유닛 테스트가 어느 OS의 CI
//! 에서도 그대로 돈다.
//!
//! **AppUserModelID를 설정하지 않는 이유**: 셸은 명시적 AUMID가 없는 프로세스에 대해 exe
//! 경로에서 암묵적 AUMID를 유도하고, `ICustomDestinationList`는 `SetAppID`를 부르지 않으면
//! 호출 프로세스의 그 AUMID를 그대로 쓴다. 작업 표시줄 버튼도 같은 값으로 묶이므로 둘이
//! 자동으로 맞는다. 여기서 AUMID를 새로 박으면 그룹핑 기준이 바뀌어(설치본의 바로가기가 가진
//! AUMID와 어긋나면) 실행 중인 창이 고정된 아이콘과 따로 노는 부작용만 생긴다.

use crate::i18n::Strings;
use crate::window_manager;

/// 점프 리스트 항목이 exe에 넘기는 인자 — 이 세 문자열이 곧 이 모듈의 대외 계약이다
/// (등록한 바로가기가 넘기고, [`action_from_args`]가 되읽는다).
const ARG_NEW_NOTE: &str = "--new-note";
const ARG_PANEL: &str = "--panel";
const ARG_SETTINGS: &str = "--settings";

/// 점프 리스트 Tasks 항목이 요청하는 동작.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchAction {
    /// 새 노트를 만들고 연다(트레이 「새 노트」와 같은 동작).
    NewNote,
    /// 노트 목록·검색 패널을 연다.
    Panel,
    /// 설정·플러그인 매니저 창을 연다.
    Settings,
}

impl LaunchAction {
    /// 이 동작을 나타내는 CLI 인자.
    const fn arg(self) -> &'static str {
        match self {
            Self::NewNote => ARG_NEW_NOTE,
            Self::Panel => ARG_PANEL,
            Self::Settings => ARG_SETTINGS,
        }
    }

    /// 지금 언어로 된 표시 제목(점프 리스트에 보이는 글자).
    ///
    /// Windows 밖에서는 아무도 부르지 않는다([`refresh`]가 no-op이고, 테스트는 dead_code 분석의
    /// 시작점이 아니다). 그 빌드에서만 경고를 끈다 — 이 메서드와 그것이 읽는
    /// `Strings::jumplist_*` 세 필드가 통째로 "쓰이지 않음"으로 보이기 때문이다. 제거하지 않는
    /// 이유: Windows 빌드의 유일한 라벨 공급원이고, 두 언어 라벨은 테스트가 지키고 있다.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    const fn title(self, strings: &'static Strings) -> &'static str {
        match self {
            Self::NewNote => strings.jumplist_new_note,
            Self::Panel => strings.jumplist_panel,
            Self::Settings => strings.jumplist_settings,
        }
    }
}

/// Tasks 섹션에 넣는 항목과 그 순서 — 트레이 고정 메뉴의 앞 세 항목과 같게 맞춘다.
const TASKS: [LaunchAction; 3] = [
    LaunchAction::NewNote,
    LaunchAction::Panel,
    LaunchAction::Settings,
];

/// 프로세스 인자에서 점프 리스트 동작을 읽는다(순수 함수 — GUI·OS 없이 테스트 가능).
///
/// 인자가 여러 개 섞여 있으면 **먼저 나온 것 하나**만 쓴다: 점프 리스트가 만드는 실행은 항상
/// 인자 하나짜리라 실제로는 발생하지 않는 상황이고, 그렇더라도 창을 여러 개 여는 것보다
/// 하나만 여는 쪽이 덜 놀랍다.
///
/// 호출부는 `argv[0]`(실행 파일 경로)을 떼지 않고 그대로 넘겨도 된다 — 경로 문자열이 위
/// 세 상수와 정확히 같을 수 없어 무해하게 지나간다.
pub fn action_from_args<I, S>(args: I) -> Option<LaunchAction>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().find_map(|arg| match arg.as_ref() {
        ARG_NEW_NOTE => Some(LaunchAction::NewNote),
        ARG_PANEL => Some(LaunchAction::Panel),
        ARG_SETTINGS => Some(LaunchAction::Settings),
        _ => None,
    })
}

/// 읽어낸 동작을 실행한다 — 트레이 메뉴의 같은 항목들과 **정확히 같은 함수**를 부른다
/// (두 진입점의 동작이 갈라지지 않게 한다). 실패는 비치명적으로 로깅만 한다.
pub fn dispatch(app: &tauri::AppHandle, action: LaunchAction) {
    let result = match action {
        LaunchAction::NewNote => window_manager::create_and_open(app),
        LaunchAction::Panel => window_manager::open_panel(app).map_err(|e| e.to_string()),
        LaunchAction::Settings => window_manager::open_settings(app).map_err(|e| e.to_string()),
    };
    if let Err(e) = result {
        eprintln!("[memo] 점프 리스트 동작 실패({}): {e}", action.arg());
    }
}

/// 지금 언어로 점프 리스트 Tasks를 (다시) 등록한다. Windows 밖에서는 아무것도 하지 않는다.
///
/// 부팅 시 1회(`lib.rs`의 `setup`)와 언어 변경 시([`crate::tray::refresh_for_language_change`])
/// 불린다. 언어 문자열은 **호출한 스레드에서** 확정하고(그 시점의 `SharedSettings.language`),
/// 셸 COM 왕복과 디스크 커밋은 워커로 넘긴다 — 이 앱이 반복해서 고쳐 온 부류의 결함(이슈 #22:
/// 메인 스레드 IO = "응답 없음")을 새로 만들지 않기 위함이다.
#[cfg(target_os = "windows")]
pub fn refresh(app: &tauri::AppHandle) {
    let strings = crate::i18n::resolve(app);
    let tasks: Vec<(&'static str, &'static str)> = TASKS
        .iter()
        .map(|action| (action.arg(), action.title(strings)))
        .collect();
    tauri::async_runtime::spawn_blocking(move || match std::env::current_exe() {
        Ok(exe) => {
            if let Err(e) = win::commit_tasks(&exe, &tasks) {
                // 실패는 비치명적이다 — 점프 리스트는 트레이/단축키와 중복된 진입점이고,
                // 「최근 항목 표시」를 끈 시스템에서는 셸이 커밋 자체를 거절한다(설정 문제라
                // 앱이 할 수 있는 일이 없다).
                eprintln!("[memo] 점프 리스트 등록 실패: {e}");
            }
        }
        Err(e) => eprintln!("[memo] 점프 리스트: 실행 파일 경로 조회 실패: {e}"),
    });
}

/// Windows 밖: 점프 리스트라는 개념이 없어 no-op(인자를 소비해 미사용 경고만 막는다).
#[cfg(not(target_os = "windows"))]
pub fn refresh(app: &tauri::AppHandle) {
    let _ = app;
    let _ = TASKS;
}

/// 셸 COM으로 Tasks 목록을 커밋하는 부분 — 이 모듈에서 유일하게 플랫폼에 묶인 코드다.
#[cfg(target_os = "windows")]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{Interface, Result, GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{E_OUTOFMEMORY, PROPERTYKEY, RPC_E_CHANGED_MODE};
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    /// `System.Title`(propkey.h의 `PKEY_Title`) — 점프 리스트에 **보이는 글자**를 정하는 키.
    ///
    /// 직접 적는 이유: windows 크레이트는 `PKEY_*` 상수를 생성하지 않는다(메타데이터에 없다).
    /// `IShellLinkW::SetDescription`은 툴팁일 뿐이라 이 키가 없으면 셸이 항목 이름을 exe
    /// 파일명 등으로 알아서 채워 버린다.
    const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xf29f_85e0_4ff9_1068_ab91_0800_2b27_b3d9),
        pid: 2,
    };

    /// 이 스레드의 COM 아파트 수명을 RAII로 묶는다(초기화한 만큼만 정확히 해제).
    ///
    /// 워커 스레드에서 도는 코드이므로 아파트를 우리가 연다. STA를 고르는 이유: 셸 in-proc
    /// 객체(`ShellLink`·`DestinationList`)의 등록 스레딩 모델이 Apartment라, STA에서는 마샬링
    /// 없이 직접 호출된다(메시지 펌프가 필요 없다).
    struct ComScope {
        /// `CoUninitialize`를 짝지어야 하는가. 초기화가 **실패**한 경우엔 부르면 안 된다.
        needs_uninit: bool,
    }

    impl ComScope {
        fn enter() -> Result<Self> {
            // SAFETY: 인자 없는 초기화 호출이고, 반환 HRESULT로 성공/실패를 모두 분기한다.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr == RPC_E_CHANGED_MODE {
                // 이 스레드가 이미 MTA로 초기화돼 있다(우리 워커에선 일어나지 않지만, 호출
                // 지점이 바뀌어도 안전하도록 다룬다). 아파트를 바꿀 수는 없어도 in-proc 셸
                // 객체는 그대로 쓸 수 있다. 초기화가 실패했으니 해제는 짝짓지 않는다.
                return Ok(Self {
                    needs_uninit: false,
                });
            }
            // S_FALSE(이미 같은 모드로 초기화됨)도 성공이며, 그 경우에도 참조 계수가 올라가므로
            // 해제를 짝지어야 한다.
            hr.ok()?;
            Ok(Self { needs_uninit: true })
        }
    }

    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.needs_uninit {
                // SAFETY: 위에서 성공한 CoInitializeEx와 정확히 1:1로 짝지어진 호출이다.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// 널 종료 UTF-16 버퍼로 바꾼다(Win32 문자열 인자용).
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 경로를 널 종료 UTF-16 버퍼로 바꾼다(손실 변환 없이 — Windows 경로의 정본은 UTF-16이다).
    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// `VT_LPWSTR` PROPVARIANT를 만든다. 문자열은 **COM 할당기**로 복사하므로, 호출부는 다 쓴 뒤
    /// 반드시 [`PropVariantClear`]로 풀어야 한다(그래야 같은 할당기로 해제된다).
    fn lpwstr_propvariant(text: &str) -> Result<PROPVARIANT> {
        let source = wide(text);
        let bytes = std::mem::size_of_val(&source[..]);
        // SAFETY: 크기를 넘겨 받는 순수 할당 호출. 실패는 널로 돌아오며 아래에서 걸러낸다.
        let buffer = unsafe { CoTaskMemAlloc(bytes) }.cast::<u16>();
        if buffer.is_null() {
            return Err(E_OUTOFMEMORY.into());
        }
        let mut value = PROPVARIANT::default();
        // SAFETY: `buffer`는 방금 `source`와 같은 바이트 수로 잡은 유효한 쓰기 가능 메모리이고,
        // 두 영역은 겹치지 않는다. 이어지는 유니온 필드 쓰기는 `vt`가 선언하는 표현
        // (VT_LPWSTR ↔ `pwszVal`)과 일치하므로, 나중에 이 값을 읽는 쪽(셸)과 해제하는 쪽
        // (`PropVariantClear`)이 모두 같은 해석을 본다.
        unsafe {
            std::ptr::copy_nonoverlapping(source.as_ptr(), buffer, source.len());
            let inner = &mut value.Anonymous.Anonymous;
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = PWSTR(buffer);
        }
        Ok(value)
    }

    /// 항목의 표시 이름을 `PKEY_Title`로 박는다.
    fn set_link_title(link: &IShellLinkW, title: &str) -> Result<()> {
        let store: IPropertyStore = link.cast()?;
        let mut value = lpwstr_propvariant(title)?;
        // SAFETY: `store`는 살아 있는 인터페이스이고, `value`는 방금 만든 유효한 PROPVARIANT다.
        // `SetValue`는 값을 **복사**하므로, 성공했든 실패했든 우리가 잡은 COM 메모리는 여기서
        // 반드시 되돌린다(성공 경로에서만 풀면 실패 시 누수가 된다).
        let result = unsafe { store.SetValue(&PKEY_TITLE, &value) };
        unsafe {
            let _ = PropVariantClear(&mut value);
        }
        result?;
        // SAFETY: 위와 같다 — 쓴 속성을 링크에 반영한다.
        unsafe { store.Commit() }
    }

    /// Tasks 항목 하나를 만든다: "이 exe를 `arg`와 함께 실행"하는 바로가기.
    fn make_task_link(exe: &[u16], arg: &str, title: &str) -> Result<IShellLinkW> {
        // SAFETY: in-proc 셸 클래스를 생성한다. 아파트는 호출부([`commit_tasks`])가 열어 둔다.
        let link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }?;
        let arg_w = wide(arg);
        let title_w = wide(title);
        // SAFETY: 넘기는 세 포인터 모두 이 스코프가 소유한 널 종료 UTF-16 버퍼를 가리키고,
        // 호출이 끝날 때까지 살아 있다(셸이 값을 복사해 간다).
        unsafe {
            link.SetPath(PCWSTR(exe.as_ptr()))?;
            link.SetArguments(PCWSTR(arg_w.as_ptr()))?;
            // 아이콘은 exe에 박힌 첫 번째 아이콘(인덱스 0) — 앱 아이콘과 같은 그림이라 별도
            // 리소스를 만들거나 번들에 파일을 더 넣지 않아도 된다.
            link.SetIconLocation(PCWSTR(exe.as_ptr()), 0)?;
            // 툴팁. 표시 이름은 이게 아니라 PKEY_Title이 정한다([`set_link_title`]).
            link.SetDescription(PCWSTR(title_w.as_ptr()))?;
        }
        set_link_title(&link, title)?;
        Ok(link)
    }

    /// Tasks 목록을 통째로 다시 커밋한다(`(인자, 제목)` 쌍을 받은 순서대로).
    ///
    /// COM 흐름: `DestinationList` 생성 → `BeginList`(편집 세션 시작) → `EnumerableObjectCollection`
    /// 에 `IShellLinkW` 3개 적재 → `AddUserTasks` → `CommitList`. 중간에 실패하면 `AbortList`로
    /// 세션을 닫아, 다음 등록이 깨끗한 상태에서 시작하게 한다.
    pub fn commit_tasks(exe: &Path, tasks: &[(&str, &str)]) -> Result<()> {
        let _com = ComScope::enter()?;
        let exe = wide_path(exe);
        // SAFETY: in-proc 셸 클래스 생성 — 위에서 아파트를 열었다.
        let list: ICustomDestinationList =
            unsafe { CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER) }?;
        let mut min_slots = 0u32;
        // `BeginList`가 돌려주는 "사용자가 제거한 항목" 배열은 쓰지 않는다 — Tasks는 사용자가
        // 개별 항목을 지울 수 없는 섹션이라 늘 비어 있다. 그래도 호출은 필수다(편집 세션의 시작).
        // 최소 슬롯 수(`min_slots`)도 참고값일 뿐이다: Tasks는 그 예산과 별개로 표시된다.
        // SAFETY: `min_slots`는 유효한 쓰기 가능 지역 변수이고, 요청 인터페이스 타입을
        // `IObjectArray`로 못박아 반환값 해석이 어긋나지 않는다.
        let _removed: IObjectArray = unsafe { list.BeginList(&mut min_slots) }?;
        match build_and_commit(&list, &exe, tasks) {
            Ok(()) => Ok(()),
            Err(e) => {
                // SAFETY: 위에서 연 편집 세션을 닫는다. 실패해도 더 할 일이 없다.
                unsafe {
                    let _ = list.AbortList();
                }
                Err(e)
            }
        }
    }

    /// [`commit_tasks`]의 `BeginList` 이후 절반 — 실패 시 호출부가 `AbortList`를 걸 수 있도록
    /// 따로 뺀다.
    fn build_and_commit(
        list: &ICustomDestinationList,
        exe: &[u16],
        tasks: &[(&str, &str)],
    ) -> Result<()> {
        // SAFETY: in-proc 셸 클래스 생성 — 호출부가 아파트를 열어 둔 상태다.
        let collection: IObjectCollection =
            unsafe { CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER) }?;
        for (arg, title) in tasks {
            let link = make_task_link(exe, arg, title)?;
            // SAFETY: 방금 만든 살아 있는 링크를 컬렉션에 넘긴다(컬렉션이 참조를 잡는다).
            unsafe { collection.AddObject(&link) }?;
        }
        let array: IObjectArray = collection.cast()?;
        // SAFETY: `array`는 위 컬렉션의 다른 인터페이스이고, `list`는 편집 세션이 열린 상태다.
        unsafe {
            list.AddUserTasks(&array)?;
            list.CommitList()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 세 인자가 각각 맞는 동작으로 해석된다(점프 리스트 링크가 넘기는 값 그대로).
    #[test]
    fn parses_each_known_argument() {
        assert_eq!(
            action_from_args(["--new-note"]),
            Some(LaunchAction::NewNote)
        );
        assert_eq!(action_from_args(["--panel"]), Some(LaunchAction::Panel));
        assert_eq!(
            action_from_args(["--settings"]),
            Some(LaunchAction::Settings)
        );
    }

    /// 가드: 등록에 쓰는 인자([`LaunchAction::arg`])와 되읽는 파서가 항상 왕복한다 —
    /// 한쪽만 고치면 점프 리스트가 조용히 아무 일도 안 하게 되므로 그 조합을 고정한다.
    #[test]
    fn every_task_argument_round_trips() {
        for action in TASKS {
            assert_eq!(action_from_args([action.arg()]), Some(action));
        }
    }

    /// 가드: 인자가 없거나(평범한 실행) 모르는 인자만 있으면 아무 동작도 요청하지 않는다 —
    /// 그래야 `handle_second_instance`가 기존 동작(모두 보기/패널 폴백)을 그대로 탄다.
    #[test]
    fn unknown_or_empty_arguments_request_nothing() {
        let empty: [&str; 0] = [];
        assert_eq!(action_from_args(empty), None);
        assert_eq!(action_from_args(["--verbose", "-h", "note.md", ""]), None);
    }

    /// 가드: `argv[0]`(실행 파일 경로)이 그대로 섞여 들어와도 오인되지 않고, 그 뒤의 진짜
    /// 인자를 찾아낸다 — 호출부가 `skip(1)`을 잊어도 안전해야 한다.
    #[test]
    fn ignores_executable_path_in_argv() {
        assert_eq!(
            action_from_args([r"C:\Program Files\Note Rang\note-rang.exe", "--panel"]),
            Some(LaunchAction::Panel)
        );
        assert_eq!(
            action_from_args([r"C:\Program Files\Note Rang\note-rang.exe"]),
            None
        );
    }

    /// 가드: 인자가 여러 개 섞이면 먼저 나온 하나만 고른다(창을 여러 개 열지 않는다).
    #[test]
    fn first_argument_wins() {
        assert_eq!(
            action_from_args(["--settings", "--new-note", "--panel"]),
            Some(LaunchAction::Settings)
        );
    }

    /// 가드: 세 인자가 서로 다르다(같은 값을 실수로 두 번 쓰면 한 항목이 다른 동작을 한다).
    #[test]
    fn task_arguments_are_distinct() {
        let args: Vec<&str> = TASKS.iter().map(|a| a.arg()).collect();
        let mut unique = args.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(args.len(), unique.len());
    }

    /// 가드: 두 언어 모두에서 세 제목이 채워져 있고 서로 다르다(빈 라벨·중복 라벨이면
    /// 점프 리스트에서 어느 항목인지 구분할 수 없다).
    #[test]
    fn titles_present_and_distinct_in_both_languages() {
        for language in [Some("ko"), Some("en")] {
            let strings = crate::i18n::strings(language);
            let titles: Vec<&str> = TASKS.iter().map(|a| a.title(strings)).collect();
            assert!(titles.iter().all(|t| !t.trim().is_empty()));
            let mut unique = titles.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(titles.len(), unique.len());
        }
    }
}
