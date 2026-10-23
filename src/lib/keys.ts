// 단축키 표기(툴팁·설정 안내). 맥은 ⌘·⌃⌥ 기호, 윈도우는 Ctrl+·Ctrl+Alt+로 쓴다.

export const IS_MAC = /Mac/i.test(navigator.platform);

/** 앱 화면 단축키(⌘/Ctrl): modKey('L') → 맥 '⌘L', 윈도우 'Ctrl+L' */
export const modKey = (key: string) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`);

/** 전역 단축키(⌃⌥/Ctrl+Alt): globalKey('M') → 맥 '⌃⌥M', 윈도우 'Ctrl+Alt+M' */
export const globalKey = (key: string) => (IS_MAC ? `⌃⌥${key}` : `Ctrl+Alt+${key}`);
