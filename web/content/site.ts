export const SITE = {
  name: "RLPlayer",
  // TODO: The GitHub repo may not exist yet. Update these URLs once it is published.
  repo: "https://github.com/rohyunsang/RLPlayer",
  download: "https://github.com/rohyunsang/RLPlayer/releases/latest",
  issues: "https://github.com/rohyunsang/RLPlayer/issues",
  license: "https://github.com/rohyunsang/RLPlayer/blob/main/LICENSE",
  notice: "https://github.com/rohyunsang/RLPlayer/blob/main/NOTICE.md",
  url: "https://rlplayer.vercel.app",
} as const;

export type Verdict = "good" | "mixed" | "bad";

export type Row = {
  label: string;
  rl: [Verdict, string];
  pot: [Verdict, string];
  vlc: [Verdict, string];
};

export const ko = {
  htmlLang: "ko",
  nav: {
    why: "왜",
    compare: "비교",
    features: "기능",
    keys: "단축키",
    faq: "FAQ",
    download: "다운로드",
    langLabel: "English",
    themeLabel: "테마 전환",
    menuLabel: "메뉴",
  },
  hero: {
    badge: "오픈소스 · MIT · Windows 10/11",
    titleA: "가만히 놔두는",
    titleB: "동영상 플레이어",
    lede: "켜면 그냥 영상이 나옵니다. 업데이트 알림도, 광고도, 번들도, 텔레메트리도 없습니다. mpv 엔진을 내장해서 웬만한 파일은 그대로 재생됩니다.",
    primary: "Windows용 다운로드",
    primarySub: "무료 · 설치 프로그램 & 포터블",
    secondary: "GitHub에서 코드 보기",
    meta: "MIT 라이선스 · 계정 없음 · 결제 없음",
  },
  stats: [
    { value: "0", label: "시작 시 네트워크 요청" },
    { value: "0", label: "광고 · 번들 제안" },
    { value: "0", label: "수집하는 데이터" },
    { value: "MIT", label: "라이선스" },
  ],
  manifesto: {
    kicker: "왜 만들었나",
    titleA: "영상 보려고 켰는데,",
    titleB: "업데이트 창이 먼저 떴습니다.",
    body: [
      "쓰던 플레이어는 켤 때마다 새 버전이 있다고 알려줬습니다. 나중에 하기를 눌러도 다음 날 또 물어봤고, 가끔은 설치 화면에 처음 보는 프로그램이 미리 체크돼 있었습니다.",
      "필요한 건 그런 게 아니었습니다. 파일을 더블클릭하면 영상이 나오고, 껐다 켜면 보던 자리에서 이어지고, 기능 목록이 거기서 끝나는 프로그램이 필요했습니다.",
      "그래서 RLPlayer는 스스로 업데이트를 확인하지 않습니다. 실행할 때 어떤 서버에도 연결하지 않습니다. 새 버전이 궁금해지면 그때 GitHub을 열면 됩니다.",
    ],
    quote: "또 하나의 플레이어가 아니라, 가만히 놔두는 플레이어.",
  },
  compare: {
    kicker: "솔직한 비교",
    title: "RLPlayer가 항상 정답은 아닙니다",
    lede: "잘하는 것과 못하는 것을 같이 적었습니다. 아래 표에서 초록색이 전부 RLPlayer 칸에 있지는 않습니다.",
    cols: ["RLPlayer", "PotPlayer", "VLC"],
    rows: [
      {
        label: "가격",
        rl: ["good", "무료 · 오픈소스"],
        pot: ["mixed", "무료 · 비공개 소스"],
        vlc: ["good", "무료 · 오픈소스"],
      },
      {
        label: "설치 시 번들 제안",
        rl: ["good", "없음"],
        pot: ["bad", "버전 · 배포처에 따라 있음"],
        vlc: ["good", "없음"],
      },
      {
        label: "자동 업데이트 알림",
        rl: ["good", "없음 (직접 확인)"],
        pot: ["bad", "기본 켜짐"],
        vlc: ["mixed", "기본 켜짐 · 끌 수 있음"],
      },
      {
        label: "시작 시 네트워크 요청",
        rl: ["good", "0건"],
        pot: ["bad", "업데이트 확인 등"],
        vlc: ["mixed", "업데이트 확인 (해제 가능)"],
      },
      {
        label: "텔레메트리 · 분석",
        rl: ["good", "없음"],
        pot: ["mixed", "공개된 정책 없음"],
        vlc: ["good", "없음"],
      },
      {
        label: "코덱 · 포맷 범위",
        rl: ["good", "넓음 (mpv · FFmpeg)"],
        pot: ["good", "넓음"],
        vlc: ["good", "넓음"],
      },
      {
        label: "이어보기",
        rl: ["good", "기본 켜짐"],
        pot: ["good", "지원"],
        vlc: ["mixed", "지원 (설정 필요)"],
      },
      {
        label: "지원 플랫폼",
        rl: ["bad", "Windows 전용"],
        pot: ["bad", "Windows 전용"],
        vlc: ["good", "Windows · macOS · Linux · 모바일"],
      },
      {
        label: "기능의 폭",
        rl: ["bad", "기본기 위주 · 이제 시작"],
        pot: ["good", "매우 풍부 (필터 · 녹화 · 캡처)"],
        vlc: ["good", "매우 풍부 (스트리밍 · 변환)"],
      },
      {
        label: "스킨 · 고급 커스터마이징",
        rl: ["bad", "제한적"],
        pot: ["good", "강력함"],
        vlc: ["mixed", "보통"],
      },
      {
        label: "개발 성숙도",
        rl: ["bad", "신생 프로젝트"],
        pot: ["good", "10년 이상"],
        vlc: ["good", "20년 이상"],
      },
    ] as Row[],
    verdictTitle: "정리하면",
    verdicts: [
      {
        who: "RLPlayer를 쓰세요",
        what: "조용히 영상만 보고 싶고, 프로그램이 나를 방해하지 않기를 바란다면.",
        primary: true,
      },
      {
        who: "PotPlayer가 낫습니다",
        what: "정밀한 영상 필터, 스킨, 방송 녹화 같은 고급 기능을 실제로 쓰고 있다면.",
        primary: false,
      },
      {
        who: "VLC가 낫습니다",
        what: "Mac이나 리눅스에서도 같은 걸 쓰고 싶거나, 스트리밍 · 변환 기능이 필요하다면.",
        primary: false,
      },
    ],
    disclaimer:
      "PotPlayer · VLC 항목은 2026년 8월 기준 각 프로그램의 기본 설정과 공개된 정보를 바탕으로 정리했습니다. 버전과 배포처에 따라 다를 수 있으며, 잘못된 내용이 있으면 이슈로 알려주시면 고치겠습니다.",
  },
  features: {
    kicker: "기능",
    title: "있어야 할 것만, 제대로",
    items: [
      {
        icon: "bell",
        title: "업데이트 알림 없음",
        body: "켜면 그냥 영상이 나옵니다. 시작할 때 네트워크 요청 0건. 새 버전 확인은 원할 때 직접 하면 됩니다.",
      },
      {
        icon: "shield",
        title: "광고 · 번들 · 텔레메트리 없음",
        body: "설치할 때 딸려오는 게 없습니다. 다음 버튼을 누르기 전에 체크박스를 하나하나 확인할 일이 없습니다.",
      },
      {
        icon: "film",
        title: "뭐든 재생됨",
        body: "mpv 엔진 내장. MKV, HEVC/H.265, AV1, VP9, DTS, AC3, ASS 자막까지 코덱팩 없이 그대로.",
      },
      {
        icon: "resume",
        title: "이어보기",
        body: "껐다 켜면 보던 자리부터. 파일마다 따로 기억하고, 그 기록은 내 PC 밖으로 나가지 않습니다.",
      },
      {
        icon: "code",
        title: "오픈소스 (MIT)",
        body: "코드가 전부 공개돼 있습니다. 읽어보고, 고치고, 직접 빌드해서 써도 라이선스가 막지 않습니다.",
      },
      {
        icon: "bolt",
        title: "가볍고 즉시 실행",
        body: "스플래시 화면도, 로딩 바도 없습니다. 더블클릭하면 첫 프레임이 이미 떠 있습니다.",
      },
    ],
  },
  keys: {
    kicker: "단축키",
    title: "손이 기억하는 그대로",
    lede: "쓰던 플레이어의 키를 거의 그대로 씁니다. 새로 외울 게 없습니다.",
    groups: [
      {
        name: "재생",
        items: [
          { k: ["Space"], d: "재생 / 일시정지" },
          { k: ["←", "→"], d: "5초 뒤로 / 앞으로" },
          { k: ["J", "L"], d: "10초 뒤로 / 앞으로" },
          { k: [",", "."], d: "이전 / 다음 프레임" },
          { k: ["[", "]"], d: "재생 속도 조절" },
        ],
      },
      {
        name: "화면",
        items: [
          { k: ["F"], d: "전체화면" },
          { k: ["Esc"], d: "전체화면 해제" },
          { k: ["S"], d: "스크린샷 저장" },
          { k: ["Ctrl", "0"], d: "원본 크기" },
        ],
      },
      {
        name: "소리 · 자막",
        items: [
          { k: ["↑", "↓"], d: "볼륨 조절" },
          { k: ["M"], d: "음소거" },
          { k: ["V"], d: "자막 켜기 / 끄기" },
          { k: ["A"], d: "오디오 트랙 전환" },
        ],
      },
      {
        name: "파일",
        items: [
          { k: ["Ctrl", "O"], d: "파일 열기" },
          { k: ["Enter"], d: "다음 파일" },
          { k: ["Tab"], d: "재생목록 열기 / 닫기" },
          { k: ["Ctrl", "Q"], d: "종료" },
        ],
      },
    ],
  },
  mockup: {
    caption: "실제 화면에 가까운 인터페이스 미리보기입니다. 정식 스크린샷은 첫 릴리스와 함께 올라갑니다.",
    playlist: "재생목록",
    toast: "12:04 부터 이어서 재생합니다",
    items: [
      "여행 기록 2026 — 1일차.mkv",
      "인터뷰 원본 04.mp4",
      "밤바다 타임랩스.mov",
      "강의 03 — 자막 포함.mkv",
    ],
    title: "여행 기록 2026 — 1일차.mkv",
    badges: ["HEVC", "4K", "DTS", "ASS 자막"],
    subtitle: "바다가 보이는 창가에 앉아 한참을 있었다.",
  },
  faq: {
    kicker: "FAQ",
    title: "자주 묻는 것들",
    items: [
      {
        q: "정말 무료인가요? 나중에 프로 버전 같은 게 생기나요?",
        a: "네, 무료입니다. MIT 라이선스 오픈소스라 유료 버전이나 기능 잠금이 생겨도 붙어 있을 수가 없습니다. 계정도, 결제도, 체험 기간도 없습니다. 소스가 공개돼 있으니 직접 빌드해서 써도 됩니다.",
      },
      {
        q: "왜 자동 업데이트를 안 넣었나요?",
        a: "영상을 보려고 켰는데 업데이트 창이 먼저 뜨는 게 싫어서 만든 프로그램이기 때문입니다. RLPlayer는 스스로 버전을 확인하지 않고, 실행할 때 어떤 서버에도 연결하지 않습니다. 새 버전은 GitHub Releases에 올라가니 원할 때 직접 받으면 됩니다. 보안 문제가 생기면 릴리스 노트와 README 맨 위에 눈에 띄게 적어두겠습니다.",
      },
      {
        q: "제 사용 기록을 수집하나요?",
        a: "아니요. 텔레메트리, 사용 통계, 크래시 리포트 자동 전송이 전부 없습니다. 설정과 재생 위치, 최근 파일 목록은 내 PC 안에만 저장되고 밖으로 나가지 않습니다. 온라인 자막 검색처럼 네트워크가 필요한 기능은 앞으로도 내가 직접 눌렀을 때만 동작합니다.",
      },
      {
        q: "어떤 포맷을 지원하나요? 코덱팩을 따로 깔아야 하나요?",
        a: "따로 깔 필요 없습니다. mpv와 FFmpeg를 내장해서 컨테이너는 MKV · MP4 · AVI · MOV · WebM · TS · FLV, 영상 코덱은 H.264 · HEVC(H.265) · AV1 · VP9 · MPEG-2, 소리는 AAC · DTS · AC3 · E-AC3 · FLAC · Opus, 자막은 SMI · SRT · ASS/SSA · VTT · PGS를 재생합니다.",
      },
      {
        q: "PotPlayer에서 그냥 넘어와도 되나요?",
        a: "일반적인 영상 감상이라면 문제 없습니다. 단축키도 거의 같습니다. 다만 PotPlayer의 고급 기능 — 정밀한 영상 필터, 스킨, 방송 녹화, 캡처 장치 입력 같은 것들은 아직 없습니다. 그런 기능을 실제로 쓰고 있다면 PotPlayer를 계속 쓰시는 게 맞습니다.",
      },
      {
        q: "설치해야 하나요? 포터블 버전도 있나요?",
        a: "둘 다 있습니다. 설치 프로그램과 압축만 풀면 되는 포터블 zip을 함께 배포합니다. 포터블 버전은 레지스트리를 건드리지 않고 설정을 자기 폴더 안에 저장하니 USB에 넣어 다녀도 됩니다.",
      },
      {
        q: "Mac이나 리눅스 버전도 나오나요?",
        a: "계획에 없습니다. 현재는 Windows 10 · 11 (x64)만 지원합니다. macOS에는 IINA, 리눅스에는 mpv라는 좋은 선택지가 이미 있고, 그쪽에서는 이 플레이어가 해결하려는 문제를 겪을 일이 별로 없습니다.",
      },
    ],
  },
  cta: {
    title: "지금 켜고, 바로 보세요",
    body: "설치하고 파일 하나 열어보면 5초 안에 차이를 알 수 있습니다.",
    primary: "Windows용 다운로드",
    secondary: "GitHub 저장소",
    note: "Windows 10 · 11 (x64) · 설치 프로그램 및 포터블",
  },
  footer: {
    tagline: "가만히 놔두는 동영상 플레이어.",
    productTitle: "제품",
    projectTitle: "프로젝트",
    download: "다운로드",
    features: "기능",
    compare: "비교",
    faq: "FAQ",
    source: "소스 코드",
    issues: "버그 신고",
    license: "MIT 라이선스",
    notice: "서드파티 고지",
    licenseLine: "MIT 라이선스로 배포됩니다.",
    thirdParty:
      "mpv, FFmpeg, libass 등 오픈소스 구성요소를 사용합니다. 각 구성요소의 라이선스 전문은 서드파티 고지 문서에서 확인할 수 있습니다.",
    disclaimer:
      "PotPlayer와 VLC는 각 권리자의 상표이며, RLPlayer는 이들과 아무 관련이 없습니다.",
  },
};

export type Dict = typeof ko;

export const en: Dict = {
  htmlLang: "en",
  nav: {
    why: "Why",
    compare: "Compare",
    features: "Features",
    keys: "Shortcuts",
    faq: "FAQ",
    download: "Download",
    langLabel: "한국어",
    themeLabel: "Toggle theme",
    menuLabel: "Menu",
  },
  hero: {
    badge: "Open source · MIT · Windows 10/11",
    titleA: "The video player",
    titleB: "that leaves you alone",
    lede: "Open a file and the video plays. No update prompts, no ads, no bundled extras, no telemetry. The mpv engine is built in, so almost anything just plays.",
    primary: "Download for Windows",
    primarySub: "Free · Installer & portable",
    secondary: "View source on GitHub",
    meta: "MIT licensed · No account · No payment",
  },
  stats: [
    { value: "0", label: "Network calls at startup" },
    { value: "0", label: "Ads & bundled offers" },
    { value: "0", label: "Data points collected" },
    { value: "MIT", label: "License" },
  ],
  manifesto: {
    kicker: "Why this exists",
    titleA: "I opened it to watch something.",
    titleB: "It showed me an update prompt.",
    body: [
      "The player I used announced a new version every single launch. Choosing “later” only meant it would ask again tomorrow, and once in a while the installer had something unfamiliar already checked.",
      "That was never what I wanted. I wanted a program where double-clicking a file plays the video, closing and reopening picks up where I left off, and the feature list ends there.",
      "So RLPlayer never checks for its own updates. It contacts no server when it starts. If you get curious about a new version, you open GitHub then.",
    ],
    quote: "Not another player — the player that leaves you alone.",
  },
  compare: {
    kicker: "An honest comparison",
    title: "RLPlayer is not always the right answer",
    lede: "What it does well and what it does not, side by side. The green marks are not all in the RLPlayer column.",
    cols: ["RLPlayer", "PotPlayer", "VLC"],
    rows: [
      {
        label: "Price",
        rl: ["good", "Free · open source"],
        pot: ["mixed", "Free · closed source"],
        vlc: ["good", "Free · open source"],
      },
      {
        label: "Bundled offers in installer",
        rl: ["good", "None"],
        pot: ["bad", "Present in some builds"],
        vlc: ["good", "None"],
      },
      {
        label: "Update nagging",
        rl: ["good", "None (check manually)"],
        pot: ["bad", "On by default"],
        vlc: ["mixed", "On by default · can disable"],
      },
      {
        label: "Network calls at startup",
        rl: ["good", "Zero"],
        pot: ["bad", "Update check and more"],
        vlc: ["mixed", "Update check (can disable)"],
      },
      {
        label: "Telemetry & analytics",
        rl: ["good", "None"],
        pot: ["mixed", "No published policy"],
        vlc: ["good", "None"],
      },
      {
        label: "Codec & format coverage",
        rl: ["good", "Broad (mpv · FFmpeg)"],
        pot: ["good", "Broad"],
        vlc: ["good", "Broad"],
      },
      {
        label: "Resume playback",
        rl: ["good", "On by default"],
        pot: ["good", "Supported"],
        vlc: ["mixed", "Supported (needs setup)"],
      },
      {
        label: "Platforms",
        rl: ["bad", "Windows only"],
        pot: ["bad", "Windows only"],
        vlc: ["good", "Windows · macOS · Linux · mobile"],
      },
      {
        label: "Breadth of features",
        rl: ["bad", "Essentials only · brand new"],
        pot: ["good", "Very rich (filters · capture)"],
        vlc: ["good", "Very rich (streaming · convert)"],
      },
      {
        label: "Skins & deep customization",
        rl: ["bad", "Limited"],
        pot: ["good", "Extensive"],
        vlc: ["mixed", "Moderate"],
      },
      {
        label: "Project maturity",
        rl: ["bad", "New project"],
        pot: ["good", "10+ years"],
        vlc: ["good", "20+ years"],
      },
    ] as Row[],
    verdictTitle: "In short",
    verdicts: [
      {
        who: "Pick RLPlayer",
        what: "if you want to watch something quietly and never be interrupted by the program itself.",
        primary: true,
      },
      {
        who: "PotPlayer is better",
        what: "if you actually use the advanced tools — precise filters, skins, broadcast capture.",
        primary: false,
      },
      {
        who: "VLC is better",
        what: "if you need the same player on macOS or Linux, or you rely on streaming and conversion.",
        primary: false,
      },
    ],
    disclaimer:
      "The PotPlayer and VLC rows describe default settings and publicly available information as of August 2026. Details vary by version and distribution channel. If something here is wrong, open an issue and it will be corrected.",
  },
  features: {
    kicker: "Features",
    title: "Only what belongs, done properly",
    items: [
      {
        icon: "bell",
        title: "No update prompts",
        body: "Launch it and the video plays. Zero network calls at startup. You check for new versions when you want to.",
      },
      {
        icon: "shield",
        title: "No ads, bundles, or telemetry",
        body: "Nothing rides along with the installer. There are no checkboxes to inspect before you click Next.",
      },
      {
        icon: "film",
        title: "Plays everything",
        body: "The mpv engine is built in: MKV, HEVC/H.265, AV1, VP9, DTS, AC3 and ASS subtitles, with no codec pack.",
      },
      {
        icon: "resume",
        title: "Resume where you stopped",
        body: "Close it and come back to the same second. Positions are stored per file, and never leave your machine.",
      },
      {
        icon: "code",
        title: "Open source (MIT)",
        body: "Every line is public. Read it, change it, build it yourself — the license does not get in your way.",
      },
      {
        icon: "bolt",
        title: "Light and instant",
        body: "No splash screen, no loading bar. Double-click a file and the first frame is already on screen.",
      },
    ],
  },
  keys: {
    kicker: "Shortcuts",
    title: "The keys your hands already know",
    lede: "Most bindings match what you were using before, so there is nothing to relearn.",
    groups: [
      {
        name: "Playback",
        items: [
          { k: ["Space"], d: "Play / pause" },
          { k: ["←", "→"], d: "Seek 5 seconds" },
          { k: ["J", "L"], d: "Seek 10 seconds" },
          { k: [",", "."], d: "Previous / next frame" },
          { k: ["[", "]"], d: "Playback speed" },
        ],
      },
      {
        name: "Display",
        items: [
          { k: ["F"], d: "Fullscreen" },
          { k: ["Esc"], d: "Exit fullscreen" },
          { k: ["S"], d: "Save screenshot" },
          { k: ["Ctrl", "0"], d: "Original size" },
        ],
      },
      {
        name: "Audio & subtitles",
        items: [
          { k: ["↑", "↓"], d: "Volume" },
          { k: ["M"], d: "Mute" },
          { k: ["V"], d: "Toggle subtitles" },
          { k: ["A"], d: "Cycle audio track" },
        ],
      },
      {
        name: "Files",
        items: [
          { k: ["Ctrl", "O"], d: "Open file" },
          { k: ["Enter"], d: "Next file" },
          { k: ["Tab"], d: "Toggle playlist" },
          { k: ["Ctrl", "Q"], d: "Quit" },
        ],
      },
    ],
  },
  mockup: {
    caption: "An interface preview close to the real thing. Actual screenshots land with the first release.",
    playlist: "Playlist",
    toast: "Resuming from 12:04",
    items: [
      "Travel log 2026 — day 1.mkv",
      "Interview raw 04.mp4",
      "Night sea timelapse.mov",
      "Lecture 03 — subtitled.mkv",
    ],
    title: "Travel log 2026 — day 1.mkv",
    badges: ["HEVC", "4K", "DTS", "ASS subs"],
    subtitle: "We sat by the window facing the sea for a long while.",
  },
  faq: {
    kicker: "FAQ",
    title: "Questions people ask",
    items: [
      {
        q: "Is it really free? Will there be a pro version later?",
        a: "Yes, it is free, and no. It is MIT-licensed open source, which means a paid tier or a locked feature could not stick even if someone tried. There is no account, no payment, no trial period. The source is public, so you can always build it yourself.",
      },
      {
        q: "Why is there no auto-update?",
        a: "Because being shown an update prompt instead of a video is the exact thing this player was written to avoid. RLPlayer never checks its own version and contacts no server when it starts. New builds go to GitHub Releases and you download them when you feel like it. If a security issue ever comes up, it will be stated plainly in the release notes and at the top of the README.",
      },
      {
        q: "Does it collect anything about how I use it?",
        a: "No. There is no telemetry, no usage analytics, and no automatic crash reporting. Settings, resume positions, and your recent files list are stored on your PC and never leave it. Anything that genuinely needs the network, like online subtitle search, will only ever run when you press the button yourself.",
      },
      {
        q: "Which formats work? Do I need a codec pack?",
        a: "No codec pack. mpv and FFmpeg are built in, covering MKV · MP4 · AVI · MOV · WebM · TS · FLV containers, H.264 · HEVC (H.265) · AV1 · VP9 · MPEG-2 video, AAC · DTS · AC3 · E-AC3 · FLAC · Opus audio, and SMI · SRT · ASS/SSA · VTT · PGS subtitles.",
      },
      {
        q: "Can I switch from PotPlayer without missing anything?",
        a: "For ordinary watching, yes, and the shortcuts are nearly identical. But PotPlayer's advanced side — fine-grained video filters, skins, broadcast recording, capture device input — is not here yet. If you genuinely use those, staying on PotPlayer is the right call.",
      },
      {
        q: "Do I have to install it, or is there a portable build?",
        a: "Both are published: a normal installer and a portable zip you just unpack. The portable build touches no registry keys and keeps its settings inside its own folder, so it travels fine on a USB stick.",
      },
      {
        q: "Will there be a Mac or Linux version?",
        a: "Not planned. Today it targets Windows 10 and 11 (x64) only. macOS has IINA and Linux has mpv itself — both excellent, and neither platform really suffers from the problem this player was built to solve.",
      },
    ],
  },
  cta: {
    title: "Open a file and see",
    body: "Install it, play one video, and the difference is obvious within five seconds.",
    primary: "Download for Windows",
    secondary: "GitHub repository",
    note: "Windows 10 · 11 (x64) · Installer and portable build",
  },
  footer: {
    tagline: "The video player that leaves you alone.",
    productTitle: "Product",
    projectTitle: "Project",
    download: "Download",
    features: "Features",
    compare: "Compare",
    faq: "FAQ",
    source: "Source code",
    issues: "Report a bug",
    license: "MIT license",
    notice: "Third-party notices",
    licenseLine: "Distributed under the MIT license.",
    thirdParty:
      "Built on open source components including mpv, FFmpeg and libass. Full license texts for each are listed in the third-party notices.",
    disclaimer:
      "PotPlayer and VLC are trademarks of their respective owners. RLPlayer is not affiliated with either project.",
  },
};

export const DICTS = { ko, en };
export type Lang = keyof typeof DICTS;
