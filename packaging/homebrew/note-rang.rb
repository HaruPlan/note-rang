# **이 파일은 템플릿이자 정본이다.** version/sha256은 릴리스마다 바뀌며,
# [Homebrew tap 워크플로](../../.github/workflows/homebrew.yml)가 릴리스 게시 시점에 이 두 줄만
# 치환해 tap 리포로 밀어 넣는다. 그래서 아래 두 줄의 **형식**(들여쓰기 2칸 + 큰따옴표)을 바꾸면
# 자동화가 조용히 깨진다. 여기 박힌 sha256 0…0은 자리표시자다(tap의 것이 실제 값).
cask "note-rang" do
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  # 파일명은 번들러가 `{productName}_{version}_{arch}.dmg`로 만든다 — productName이
  # "Note Rang"이라 **공백이 들어가고**, URL에서는 %20으로 인코딩해야 한다. 워크플로가
  # 릴리스 자산의 실제 이름과 이 규칙이 어긋나면 실패하도록 검증한다(어긋난 채 나가면
  # `brew install`이 404로 죽는다).
  url "https://github.com/HaruPlan/note-rang/releases/download/v#{version}/Note.Rang_#{version}_universal.dmg"
  name "Note Rang"
  desc "Floating markdown sticky notes"
  homepage "https://github.com/HaruPlan/note-rang"

  # 앱이 스스로 업데이트한다(Tauri updater). 이 선언이 있으면 Homebrew가 설치된 번들의 버전과
  # cask 버전을 비교해, 설치본이 같거나 더 최신이면 업그레이드를 건너뛴다 — 자체 업데이트로
  # 앞서간 설치본을 brew가 되돌리지 않는다. 빼면 매번 덮어쓰려 든다.
  auto_updates true
  depends_on macos: ">= :catalina"

  app "Note Rang.app"

  postflight do
    system_command "/usr/bin/xattr",
      args: ["-dr", "com.apple.quarantine", "#{appdir}/Note Rang.app"]
  end

  # 노트 본문(vault)은 지우지 않는다 — 사용자 문서이지 앱 상태가 아니다(기본
  # ~/Documents/Memo). 여기서 지우는 것은 기기 고유 설정·캐시뿐이다.
  zap trash: [
    "~/Library/Application Support/com.haruplan.note-rang",
    "~/Library/Caches/com.haruplan.note-rang",
    "~/Library/Saved Application State/com.haruplan.note-rang.savedState",
    "~/Library/WebKit/com.haruplan.note-rang",
  ]
end
