// User Status for Marinara — v2.1.0
(function (marinara) {
  "use strict";

  // ── Marinara 런타임 호환 계층 ──────────────────────────────
  // v2.2.x: 페이지 런타임이 addStyle/apiFetch/on/observe 를 직접 제공한다.
  // v2.4.x: 승인된 Full page 확장은 identity/storage/timer/cleanup 만 제공하므로
  //          페이지 권한 안에서 누락된 레거시 helper 를 좁게 복원한다.
  function createCrossVersionApi(hostApi) {
    const host = hostApi && typeof hostApi === "object" ? hostApi : {};
    const cleanupFns = [];
    const timeoutIds = new Set();
    const intervalIds = new Set();
    let disposed = false;

    function once(fn) {
      let called = false;
      return () => {
        if (called) return;
        called = true;
        try { return fn(); } catch (error) { console.warn("[User Status] cleanup failed", error); }
      };
    }
    function addCleanup(fn) {
      if (typeof fn !== "function") throw new TypeError("onCleanup requires a function");
      const cleanup = once(fn);
      if (disposed) { cleanup(); return cleanup; }
      cleanupFns.push(cleanup);
      if (typeof host.onCleanup === "function") host.onCleanup(cleanup);
      return cleanup;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanupFns.splice(0).reverse()) cleanup();
    }

    addCleanup(() => {
      for (const id of timeoutIds) window.clearTimeout(id);
      for (const id of intervalIds) window.clearInterval(id);
      timeoutIds.clear();
      intervalIds.clear();
    });

    async function pageApiFetch(path, options) {
      const normalized = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
      const url = new URL(`/api${normalized}`, window.location.origin);
      const apiPath = url.pathname.replace(/^\/api(?=\/|$)/, "");
      if (apiPath === "/extensions" || apiPath.startsWith("/extensions/") ||
          apiPath === "/personal-extensions" || apiPath.startsWith("/personal-extensions/") ||
          apiPath === "/admin" || apiPath.startsWith("/admin/")) {
        throw new Error(`apiFetch denied: User Status cannot reach ${apiPath}`);
      }
      const init = options && typeof options === "object" ? options : {};
      const method = String(init.method || "GET").toUpperCase();
      const headers = new Headers(init.headers || undefined);
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        headers.set("x-marinara-csrf", "1");
        if (init.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      }
      const response = await window.fetch(`${url.pathname}${url.search}`, {
        ...init,
        headers,
        credentials: "same-origin",
      });
      const text = response.status === 204 ? "" : await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch (_) { payload = text; }
      }
      if (!response.ok) {
        const detail = payload && typeof payload === "object" && (payload.error || payload.message);
        throw new Error(detail ? String(detail) : `Marinara API request failed (${response.status})`);
      }
      return payload;
    }

    const apiFetch = typeof host.apiFetch === "function" ? host.apiFetch.bind(host) : pageApiFetch;
    const api = {
      ...host,
      extensionId: host.extensionId || (host.extension && host.extension.id) || "user-status",
      extensionName: host.extensionName || (host.extension && host.extension.name) || "User Status",
      apiFetch,
      addStyle(css) {
        let style = null;
        if (typeof host.addStyle === "function") style = host.addStyle(css);
        else {
          style = document.createElement("style");
          style.textContent = String(css || "");
          document.head.appendChild(style);
        }
        if (style && typeof style.remove === "function") addCleanup(() => style.remove());
        return style;
      },
      on(target, event, handler, options) {
        if (!target || typeof target.addEventListener !== "function") return null;
        target.addEventListener(event, handler, options);
        addCleanup(() => target.removeEventListener(event, handler, options));
        return handler;
      },
      observe(target, callback, options) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        if (!element || typeof callback !== "function") return null;
        const observer = new MutationObserver(callback);
        observer.observe(element, options || { childList: true, subtree: true });
        addCleanup(() => observer.disconnect());
        return observer;
      },
      setTimeout(callback, delay, ...args) {
        const schedule = typeof host.setTimeout === "function" ? host.setTimeout.bind(host) : window.setTimeout.bind(window);
        const id = schedule(() => { timeoutIds.delete(id); callback(...args); }, delay);
        timeoutIds.add(id);
        return id;
      },
      clearTimeout(id) {
        timeoutIds.delete(id);
        if (typeof host.clearTimeout === "function") host.clearTimeout(id);
        else window.clearTimeout(id);
      },
      setInterval(callback, delay, ...args) {
        const schedule = typeof host.setInterval === "function" ? host.setInterval.bind(host) : window.setInterval.bind(window);
        const id = schedule(() => callback(...args), delay);
        intervalIds.add(id);
        return id;
      },
      clearInterval(id) {
        intervalIds.delete(id);
        if (typeof host.clearInterval === "function") host.clearInterval(id);
        else window.clearInterval(id);
      },
      onCleanup: addCleanup,
    };
    return { api, dispose, mode: typeof host.apiFetch === "function" ? "legacy-page" : "full-page-compat" };
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    const message = "User Status는 DOM 접근이 필요합니다. 마리나라 설정에서 서드파티(외부) 확장 사용을 허용한 뒤 다시 불러오세요.";
    try { marinara && marinara.log && marinara.log.error(message); } catch (_) {}
    throw new Error(message);
  }

  const previousRuntime = window.__marinaraUserStatusRuntime;
  if (previousRuntime && typeof previousRuntime.dispose === "function") previousRuntime.dispose();
  const runtime = createCrossVersionApi(marinara);
  marinara = runtime.api;
  const runtimeMarker = { version: "2.1.0", dispose: runtime.dispose };
  window.__marinaraUserStatusRuntime = runtimeMarker;
  marinara.onCleanup(() => {
    if (window.__marinaraUserStatusRuntime === runtimeMarker) delete window.__marinaraUserStatusRuntime;
  });

  // ── 상수/키 ──
  const NS = "us";
  const STORE_CONFIG = "us-config-v1";
  const VALUES_PREFIX = "us-values-v1-";          // 구버전 localStorage 값(마이그레이션 소스)
  const META_VALUES_KEY = "userStatusValues";     // chat.metadata 안에 저장할 키
  const META_SKIN_KEY = "userStatusSkinSnapshot"; // 현재 채팅에 적용한 스킨 1개(기기 간 복원용)
  const ACTIVE_CHAT_KEY = "marinara-active-chat-id";
  const PANEL_ID = "us-panel";
  const MODAL_ID = "us-modal";
  const STATUS_MANAGER_ID = "us-status-manager";
  const FLOAT_ID = "us-float";
  const INLINE_STATUS_ATTR = "data-us-inline-status";
  const INLINE_SLOT_ATTR = "data-us-inline-status-slot";
  const FLOAT_NOTICE_ID = "us-float-notice"; // 플로팅 창 위에 뜨는 알림 레이어
  const PROMPT_BUBBLE_ID = "us-prompt-bubble-window";
  const WINDOW_CSS_STYLE_ID = "us-window-css";
  const USER_LABEL = "{{user}}";

  // 모바일 OS/브라우저의 이모지 폰트에 따라 모양이 바뀌지 않도록 동작 아이콘을
  // currentColor 기반 인라인 SVG로 고정한다. 문자열은 버튼 안에 그대로 삽입한다.
  const iconSvg = (body, viewBox = "0 0 24 24") => `<svg class="us-icon-svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICON = Object.freeze({
    chevronRight: iconSvg('<path d="m9 18 6-6-6-6"/>'),
    chevronDown: iconSvg('<path d="m6 9 6 6 6-6"/>'),
    edit: iconSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    prompt: iconSvg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    refresh: iconSvg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
    settings: iconSvg('<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34A1.7 1.7 0 0 0 14 20.96V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.04V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.96 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/>'),
    scan: iconSvg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/><path d="m14 9 3 3-3 3"/>'),
    status: iconSvg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h3M14 9h3M7 14h5M15 14h2"/>'),
    close: iconSvg('<path d="M18 6 6 18M6 6l12 12"/>'),
    power: iconSvg('<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>'),
    search: iconSvg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>'),
    copy: iconSvg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    clipboard: iconSvg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h4"/>'),
    star: iconSvg('<path d="m12 2.5 2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94Z" fill="currentColor"/>'),
    cloud: iconSvg('<path d="M7 18.5h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.3 4.6 4.6 0 0 0 7 18.5Z"/>'),
    cloudOff: iconSvg('<path d="M7 18.5h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.3 4.6 4.6 0 0 0 7 18.5Z"/><path d="m3.5 3.5 17 17"/>'),
    starOutline: iconSvg('<path d="m12 2.5 2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94Z"/>'),
    trash: iconSvg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 15H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
    grip: iconSvg('<circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/>'),
  });

  const REQ = { start: "[[STATUS-REQ]]", end: "[[/STATUS-REQ]]" };
  const STATUS_SRC = "\\[\\[\\s*STATUS(?::\\s*([^\\]\\n]+?))?\\s*\\]\\]([\\s\\S]*?)\\[\\[\\s*\\/\\s*STATUS\\s*\\]\\]";
  const STATUS_BLOCK_SRC = "\\[\\[\\s*STATUS(?::[^\\]\\n]*)?\\s*\\]\\][\\s\\S]*?\\[\\[\\s*\\/\\s*STATUS\\s*\\]\\]";
  const SCENE_SRC = "\\[\\[\\s*SCENE\\s*\\]\\]([\\s\\S]*?)\\[\\[\\s*\\/\\s*SCENE\\s*\\]\\]";
  const SCENE_BLOCK_SRC = "\\[\\[\\s*SCENE\\s*\\]\\][\\s\\S]*?\\[\\[\\s*\\/\\s*SCENE\\s*\\]\\]";
  const RE_REQ = /\[\[\s*STATUS-REQ\s*\]\][\s\S]*?\[\[\s*\/\s*STATUS-REQ\s*\]\]/gi;
  const JSON_BLOCK_LANG = "us-status";
  const RE_JSON_BLOCK = /```us-status\r?\n([\s\S]*?)\r?\n```/gi;

  const DATA_MODES = { inline: "inline", api: "api" };
  const FLOAT_W = 340;
  const BODY_MAX_H = 520;
  const DESIGN_MAX_W = FLOAT_W - 24;
  const DEFAULT_HISTORY_DEPTH = 50;
  // '채팅 요약'을 켤 때 히스토리 범위가 '전체'면 이 값으로 함께 좁힌다.
  //   요약을 켜는 목적 자체가 '긴 히스토리를 짧은 요약으로 대신하기'이므로 둘은 짝으로 움직이는 게 맞다.
  const SUMMARY_HISTORY_TURNS = 20;
  // 채팅 히스토리를 끈 캡처에서 '마지막 상태 기록 이후' 대화를 직접 넣을 때의 최대 턴 수.
  const GAP_CONTEXT_MAX_TURNS = 10;
  // 기록(byMsg) 보관 개수. 초과분은 선입선출(오래된 턴부터) 삭제. 0 = 무제한(전부 보관).
  const DEFAULT_RECORD_LIMIT = 100;
  const STORE_ORDER_TAIL = 200; // store.order 압축 시 최소한 유지할 최근 ID 수
  const FLOAT_EDGE_GAP = 8;
  const STATUS_ITEM_EXPORT_TYPE = "marinara-user-status-item";
  const HISTORY_LAYOUT_BREAKPOINT = 820;
  const HISTORY_TURN_PAGE_SIZE = 5;
  const HISTORY_PREVIEW_KEY = "__history__";
  const PREVIEW_KEY = "__preview__";
  const DEFAULT_TAB_TEMPLATE = "{{이름}}";
  const DEFAULT_SCENE_BUTTON_TEMPLATE = "장면";

  // 공용 기본 연속성 규칙 — 상태창에 개별 규칙이 없을 때 폴백
  const DEFAULT_CONTINUITY_PROMPT = [
    "Continue from the previous state instead of inventing new values; update only what the scene actually changed.",
    "Keep unmentioned fields at their prior value, and let numbers or relationships drift gradually rather than spiking in a single reply.",
    "When a field looks empty, infer a sensible value from the character card and earlier context; leave it blank only when it is genuinely unknowable.",
    "Every {{char}} and {{user}} present in the scene must always appear in the output and must never be dropped, even in multi-character chats with several {{char}}, and even if their name is not repeated in every message.",
    "If a subject appeared in the previous status state, keep outputting them by referencing that prior state — unless the narrative clearly shows they have permanently left or can no longer appear (e.g. death, departure).",
    "If a {{char}} or {{user}} is simply elsewhere, still output them and state where they are, inferring their location from prior messages and earlier status values.",
    "Treat each stat's established baseline as its maximum, and only apply increases or decreases driven by events such as damage, healing, or the passage of time.",
    "For the scene block, keep time/location/posture consistent with the previous scene state; only change what the narrative actually changed (e.g. time passing, moving to a new place, characters changing posture).",
    "Never output values that are character-for-character identical to the previous state; even when the situation is stable, at least the most dynamic field (mood, activity, or posture) should reflect the current moment.",
  ].join(" ");

  // ── 네온 터미널 (스타터 · 손대지 않은 옛 판 갈아끼우기에 같이 씀) ──
  const NEON_MONO = "'D2Coding','JetBrains Mono','Cascadia Mono',Consolas,ui-monospace,monospace";
  const NEON_TERMINAL_CSS = `.term{--bg:#0c1311;--line:#1f2e29;--fg:#d3e9df;--dim:#6f8d81;--acc:#62e8a8;--track:#18251f;
 font-family:${NEON_MONO};width:100%;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;
 padding:12px 14px 13px;font-size:12.5px;line-height:1.55}
.thd{display:flex;align-items:center;gap:7px;padding-bottom:8px;margin-bottom:5px;border-bottom:1px solid var(--line);font-size:13px;font-weight:700}
.tp{color:var(--acc);text-shadow:0 0 8px rgba(98,232,168,.35)}
.tc{flex:none;width:7px;height:13px;background:var(--acc);opacity:.8}
.tln{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;align-items:baseline;padding:3px 0}
.tk{color:var(--dim);font-size:10.5px;letter-spacing:.12em}
.tsy{display:flex;align-items:center;gap:9px;min-width:0}
.tbar{flex:1;min-width:0;height:6px;background:repeating-linear-gradient(90deg,var(--track) 0 5px,transparent 5px 7px)}
.tfill{display:block;height:100%;max-width:100%;background:repeating-linear-gradient(90deg,var(--acc) 0 5px,transparent 5px 7px)}
.tnum{flex:none;min-width:4ch;text-align:right;color:var(--acc);font-variant-numeric:tabular-nums}`;
  const NEON_TERMINAL_TEMPLATE = `<div class="term">
  <div class="thd"><span class="tp">&gt;</span><span>{{이름}}</span><span class="tc"></span></div>
  <div class="tln"><span class="tk">STATUS</span><span>{{상태}}</span></div>
  <div class="tln"><span class="tk">SYNC</span><span class="tsy"><span class="tbar"><span class="tfill" style="width:{{동기화}}%"></span></span><span class="tnum">{{동기화}}%</span></span></div>
  <div class="tln"><span class="tk">LINK</span><span>{{관계}}</span></div>
  <div class="tln"><span class="tk">PROC</span><span>{{행동}}</span></div>
</div>`;
  const NEON_TERMINAL_SCENE_CSS = `.scene{--bg:#0c1311;--line:#1f2e29;--fg:#d3e9df;--dim:#6f8d81;--acc:#62e8a8;
 font-family:${NEON_MONO};width:100%;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;
 padding:10px 14px 12px;font-size:12px;line-height:1.6}
.head{display:flex;flex-wrap:wrap;gap:3px 16px;padding-bottom:7px;margin-bottom:7px;border-bottom:1px solid var(--line)}
.head b{margin-right:7px;color:var(--dim);font-weight:400;font-size:10.5px;letter-spacing:.12em}
.sub{color:var(--fg)}
.sub+.sub{margin-top:4px;color:var(--dim)}
.sub i{font-style:normal;color:var(--acc);margin-right:6px}`;
  const NEON_TERMINAL_SCENE_TEMPLATE = `<div class="scene">
  <div class="head"><span><b>TIME</b>{{시간}}</span><span><b>LOC</b>{{장소}}</span></div>
  <div class="sub">{{장면 묘사}}</div>
  <div class="sub"><i>&gt;</i>{{자세/동작}}</div>
</div>`;
  const NEON_TERMINAL_WINDOW_CSS = `/* ══ 네온 터미널 · 윈도우(창 틀) 테마 ══
   #us-float / #us-prompt-bubble-window → 플로팅 상태창·요청창 (변수 --us-float-*)
   .us-box → 설정·편집 창 (변수 --us-box-*)
   ※ 상태창 카드 내용의 색·폰트는 편집기의 "카드 CSS / 장면 CSS" 칸에서 바꿉니다. */

/* ① 플로팅 상태창 + 추가 요청사항 창 ─ 변수: --us-float-* */
#us-float, #us-prompt-bubble-window {
  border-radius: 10px;
  box-shadow: 0 0 0 1px #1f2e29, 0 10px 28px rgba(0,0,0,.45);
  --us-float-bg: #0c1311;        /* 창 배경 */
  --us-float-fg: #d3e9df;        /* 주 텍스트 */
  --us-float-border: #1f2e29;    /* 테두리 */
  --us-float-muted: #6f8d81;     /* 보조 텍스트 (레이블·힌트) */
  --us-float-primary: #62e8a8;   /* 강조색 (활성 탭·아이콘 on 등) */
  --us-float-primary-fg: #06120d;
  --us-float-secondary: #131e1a; /* 버튼·장면 버튼 배경 */
  --us-float-accent: #1a2a24;    /* 호버 배경 */
}
/* 모노스페이스 폰트 통일 (font-family 는 변수로 제어 안 됨) */
#us-float .us-f-title,
#us-float .us-tab,
#us-float .us-scene-button { font-family: ${NEON_MONO}; }

/* ② 설정창·편집기 창 ─ 변수: --us-box-* */
.us-box {
  --us-box-bg: #0c1311;          /* 창 배경 */
  --us-box-fg: #d3e9df;          /* 주 텍스트 */
  --us-box-border: #1f2e29;      /* 테두리·구분선 */
  --us-box-muted: #6f8d81;       /* 보조 텍스트 (섹션 제목·노트) */
  --us-box-input-bg: #080e0c;    /* 입력 필드 배경 */
  --us-box-secondary: #131e1a;   /* 일반 버튼 배경 */
  --us-box-accent: #1a2a24;      /* 버튼 호버 배경 */
  --us-box-primary: #62e8a8;     /* 강조 버튼·활성 탭·토글 */
  --us-box-primary-fg: #06120d;
  --us-box-switch-off: #2a3c35;  /* 토글 미선택 트랙 색 */
  --us-box-switch-on: #62e8a8;   /* 토글 선택(켜짐) 트랙 색 */
  --us-box-switch-thumb: #06120d; /* 토글 손잡이 색 (어두운 배경) */
  /* 일반 체크박스(impersonate·기록 전환 등)의 체크·호버 강조색은 위 --us-box-primary 를 자동으로 따라갑니다 */
}`;

  // ── 스타터(샘플) ──
  const STARTERS = [
    {
      name: "💗 핑크 로맨스",
      description: "분홍 그라데이션 연애 카드\n인물: 기분 · 호감도(게이지) · 관계 · 상태\n장면: 시간 · 장소 · 장면 묘사 · 자세",
      fields: [
        { key: "기분", instruction: "대상의 현재 기분을 한 단어로. 예: 설렘, 차분함" },
        { key: "호감도", instruction: "대상이 상대에게 느끼는 호감도 0~100 숫자. 예: 72" },
        { key: "관계", instruction: "상대와의 현재 관계를 짧게. 예: 친구, 연인, 썸" },
        { key: "상태", instruction: "대상의 현재 상태/행동을 짧게. 예: 커피 마시는 중" },
      ],
      sceneFields: [
        { key: "시간", instruction: "현재 시각/날짜. 예: 오후 3시, 12월 5일 밤" },
        { key: "장소", instruction: "현재 장면의 위치. 예: 학교 옥상, 비 오는 골목" },
        { key: "장면 묘사", instruction: "지금 벌어지는 상황을 1~2문장으로. 예: 둘은 우산 하나를 나눠 쓰고 걷는 중" },
        { key: "자세/동작", instruction: "등장 캐릭터들의 현재 자세·동작. 예: A는 벤치에 앉아 있고, B는 그 앞에 서 있음" },
      ],
      css: `.card{font-family:system-ui,-apple-system,sans-serif;width:100%;box-sizing:border-box;border-radius:16px;
 padding:14px 16px;color:#5b2b40;background:linear-gradient(135deg,#ffe1ec,#ffd0e0);
 border:1px solid #ffb3cd;box-shadow:0 4px 14px rgba(255,120,160,.25);
 overflow-wrap:break-word;word-break:keep-all;}
.nm{font-weight:700;font-size:14px;margin-bottom:8px}
.row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;font-size:13px;padding:4px 0;line-height:1.45}
.lab{opacity:.7;flex:none}.val{font-weight:600;text-align:right;overflow-wrap:break-word;word-break:keep-all}
.bar{height:8px;border-radius:6px;background:#ffffff80;overflow:hidden;margin-top:2px;width:120px;flex:none}
.fill{display:block;height:100%;background:linear-gradient(90deg,#ff7eb3,#ff4d8d)}`,
      template: `<div class="card">
  <div class="nm">💗 {{이름}}</div>
  <div class="row"><span class="lab">기분</span><span class="val">{{기분}}</span></div>
  <div class="row"><span class="lab">호감도</span><span class="val">{{호감도}}</span></div>
  <div class="row"><span class="lab"></span><span class="bar"><span class="fill" style="width:{{호감도}}%"></span></span></div>
  <div class="row"><span class="lab">관계</span><span class="val">{{관계}}</span></div>
  <div class="row"><span class="lab">상태</span><span class="val">{{상태}}</span></div>
</div>`,
      sceneCss: `.scene{font-family:system-ui,-apple-system,sans-serif;width:100%;box-sizing:border-box;border-radius:12px;padding:10px 12px;border:1px solid #ffb3cd;background:linear-gradient(135deg,#fff5fa,#ffe9f2);color:#6a2f49;box-shadow:0 2px 10px rgba(255,120,160,.15)}
.head{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;font-weight:700}
.sub{margin-top:6px;font-size:11px;opacity:.86;line-height:1.5}`,
      sceneTemplate: `<div class="scene">
  <div class="head"><span>🕒 {{시간}}</span><span>📍 {{장소}}</span></div>
  <div class="sub">{{장면 묘사}}</div>
  <div class="sub">🧍 {{자세/동작}}</div>
</div>`,
      tabTemplate: DEFAULT_TAB_TEMPLATE,
      tabCss: "",
      sceneButtonTemplate: DEFAULT_SCENE_BUTTON_TEMPLATE,
      sceneButtonCss: "",
      instructions: "",
      windowCssMode: "custom",
      windowCss: `/* ══ 핑크 로맨스 · 윈도우(창 틀) 테마 ══════════════════
   이 CSS는 상태창을 감싸는 "창(틀)"만 꾸밉니다.
   ─ 어디에 무엇? ────────────────────────────────────
   #us-float                → 화면에 떠 있는 플로팅 상태창 (틀·탭·버튼·테두리)
   #us-prompt-bubble-window → 추가 요청사항 입력 창 (플로팅과 같은 --us-float-* 변수 공유)
   .us-box                  → 설정창·상태창 편집기 창
   ─ 변수 접두사 ─────────────────────────────────────
   --us-float-* : 위 플로팅/요청창에 적용   (아래 #us-float 블록)
   --us-box-*   : 설정/편집 창에 적용        (아래 .us-box 블록)
   변수만 바꾸면 그 안의 탭·버튼·입력칸·테두리·텍스트가 모두 따라옵니다.
   ─ 주의 ────────────────────────────────────────────
   상태창 카드(이름/호감도 등 내용 카드) 자체의 색·폰트는 여기가 아니라
   편집기의 "카드 CSS"·"장면 CSS" 칸에서 바꿉니다. (카드는 독립 영역이라 이 창 CSS가 닿지 않음)
*/

/* ① 플로팅 상태창 + 추가 요청사항 창 ─ 변수: --us-float-* */
#us-float, #us-prompt-bubble-window {
  border-radius: 14px;
  box-shadow: 0 6px 24px rgba(255,120,160,.25);
  --us-float-bg: #fff0f5;        /* 창 배경 */
  --us-float-fg: #3b0a1a;        /* 주 텍스트 */
  --us-float-border: #ffb3cd;    /* 테두리 */
  --us-float-muted: #9b7080;     /* 보조 텍스트 (레이블·힌트) */
  --us-float-primary: #e91e8c;   /* 강조색 (활성 탭·아이콘 on 등) */
  --us-float-primary-fg: #fff;
  --us-float-secondary: #fce4ec; /* 버튼·장면 버튼 배경 */
  --us-float-accent: #f8bbd0;    /* 호버 배경 */
}

/* 설정창·편집기 창 */
.us-box {
  --us-box-bg: #fff8fb;          /* 창 배경 */
  --us-box-fg: #3b0a1a;          /* 주 텍스트 */
  --us-box-border: #f9aec7;      /* 테두리·구분선 */
  --us-box-muted: #9b7080;       /* 보조 텍스트 (섹션 제목·노트) */
  --us-box-input-bg: #fff8fb;    /* 입력 필드 배경 */
  --us-box-secondary: #fce4ec;   /* 일반 버튼 배경 */
  --us-box-accent: #f8bbd0;      /* 버튼 호버 배경 */
  --us-box-primary: #e91e8c;     /* 강조 버튼·활성 탭·토글 */
  --us-box-primary-fg: #fff;
  --us-box-switch-off: #f9aec7;  /* 토글 미선택 트랙 색 */
  --us-box-switch-on: #e91e8c;   /* 토글 선택(켜짐) 트랙 색 */
  --us-box-switch-thumb: #fff;   /* 토글 손잡이 색 */
  /* 일반 체크박스(impersonate·기록 전환 등)의 체크·호버 강조색은 위 --us-box-primary 를 자동으로 따라갑니다 */
}`,
    },
    {
      name: "🗡 다크 골드 판타지",
      description: "금테 두른 어두운 판타지 판\n인물: HP · MP(현재/최대) · 상태 · 장비\n장면: 시간 · 장소 · 장면 묘사 · 자세",
      fields: [
        { key: "HP", instruction: "대상의 현재 HP 를 현재/최대 형식으로. 예: 84/100" },
        { key: "MP", instruction: "대상의 현재 MP 를 현재/최대 형식으로. 예: 30/50" },
        { key: "상태", instruction: "대상의 상태 이상/컨디션. 예: 정상, 부상, 피로" },
        { key: "장비", instruction: "대상이 현재 들고 있는 주요 장비. 예: 강철검" },
      ],
      sceneFields: [
        { key: "시간", instruction: "현재 시각/날짜. 예: 오후 3시, 12월 5일 밤" },
        { key: "장소", instruction: "현재 장면의 위치. 예: 학교 옥상, 비 오는 골목" },
        { key: "장면 묘사", instruction: "지금 벌어지는 상황을 1~2문장으로. 예: 둘은 우산 하나를 나눠 쓰고 걷는 중" },
        { key: "자세/동작", instruction: "등장 캐릭터들의 현재 자세·동작. 예: A는 벤치에 앉아 있고, B는 그 앞에 서 있음" },
      ],
      css: `.f{font-family:Georgia,serif;width:100%;box-sizing:border-box;color:#e8d7a8;
 background:radial-gradient(circle at 30% 0%,#3a2f1c,#1a160f);border:1px solid #b8923f;
 border-radius:10px;padding:14px 16px;box-shadow:0 0 0 1px #00000060,0 6px 16px #00000070;
 overflow-wrap:break-word;word-break:keep-all;}
.ttl{font-size:13px;letter-spacing:1px;color:#d8b85a;margin-bottom:8px;border-bottom:1px solid #6b5526;padding-bottom:6px;font-weight:700}
.line{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;font-size:13px;padding:4px 0;line-height:1.45}
.k{color:#b39a5e;flex:none}.v{color:#f3e6bf;font-weight:600;text-align:right;overflow-wrap:break-word;word-break:keep-all}`,
      template: `<div class="f">
  <div class="ttl">⚜ {{이름}}</div>
  <div class="line"><span class="k">HP</span><span class="v">{{HP}}</span></div>
  <div class="line"><span class="k">MP</span><span class="v">{{MP}}</span></div>
  <div class="line"><span class="k">상태</span><span class="v">{{상태}}</span></div>
  <div class="line"><span class="k">장비</span><span class="v">{{장비}}</span></div>
</div>`,
      sceneCss: `.scene{font-family:Georgia,serif;width:100%;box-sizing:border-box;border-radius:10px;padding:10px 12px;border:1px solid #9f7a2d;background:radial-gradient(circle at 0% 0%,#342713,#17130d);color:#e4d3a0;box-shadow:0 0 0 1px #00000066}
.head{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;font-weight:700;color:#d8b85a}
.sub{margin-top:6px;font-size:11px;line-height:1.55;color:#cdbb8c}`,
      sceneTemplate: `<div class="scene">
  <div class="head"><span>⌛ {{시간}}</span><span>🜂 {{장소}}</span></div>
  <div class="sub">{{장면 묘사}}</div>
  <div class="sub">⚔ {{자세/동작}}</div>
</div>`,
      tabTemplate: DEFAULT_TAB_TEMPLATE,
      tabCss: "",
      sceneButtonTemplate: DEFAULT_SCENE_BUTTON_TEMPLATE,
      sceneButtonCss: "",
      instructions: "",
      windowCssMode: "custom",
      windowCss: `/* ══ 다크 골드 판타지 · 윈도우(창 틀) 테마 ══════════════
   이 CSS는 상태창을 감싸는 "창(틀)"만 꾸밉니다.
   ─ 어디에 무엇? ────────────────────────────────────
   #us-float                → 화면에 떠 있는 플로팅 상태창 (틀·탭·버튼·테두리)
   #us-prompt-bubble-window → 추가 요청사항 입력 창 (플로팅과 같은 --us-float-* 변수 공유)
   .us-box                  → 설정창·상태창 편집기 창
   ─ 변수 접두사 ─────────────────────────────────────
   --us-float-* : 위 플로팅/요청창에 적용   (아래 #us-float 블록)
   --us-box-*   : 설정/편집 창에 적용        (아래 .us-box 블록)
   변수만 바꾸면 그 안의 탭·버튼·입력칸·테두리·텍스트가 모두 따라옵니다.
   ─ 주의 ────────────────────────────────────────────
   상태창 카드(HP/MP 등 내용 카드) 자체의 색·폰트는 여기가 아니라
   편집기의 "카드 CSS"·"장면 CSS" 칸에서 바꿉니다. (카드는 독립 영역이라 이 창 CSS가 닿지 않음)
   font-family 처럼 변수로 제어되지 않는 속성은 #us-float 안의 요소를 직접 지정합니다(아래 폰트 블록 참고).
*/

/* ① 플로팅 상태창 + 추가 요청사항 창 ─ 변수: --us-float-* */
#us-float, #us-prompt-bubble-window {
  border-radius: 10px;
  box-shadow: 0 0 0 1px #00000060, 0 6px 16px #00000070;
  --us-float-bg: radial-gradient(circle at 30% 0%,#2a2010,#12100a); /* 창 배경 */
  --us-float-fg: #e8d7a8;        /* 주 텍스트 */
  --us-float-border: #b8923f;    /* 테두리 */
  --us-float-muted: #b39a5e;     /* 보조 텍스트 (레이블·힌트) */
  --us-float-primary: #d8b85a;   /* 강조색 (활성 탭·아이콘 on 등) */
  --us-float-primary-fg: #1a160f;
  --us-float-secondary: #2a1f0e; /* 버튼·장면 버튼 배경 */
  --us-float-accent: #3a2f1c;    /* 호버 배경 */
}
/* 타이틀·탭(캐릭터명)·장면 버튼 폰트 통일 — font-family 는 변수로 제어되지 않아 별도 지정.
   탭/장면 버튼 글자는 shadow host 안에서 font-family:inherit 라 부모에 지정하면 그대로 따라옵니다. */
#us-float .us-f-title,
#us-float .us-tab,
#us-float .us-scene-button { font-family: Georgia, serif; }

/* 설정창·편집기 창 */
.us-box {
  --us-box-bg: #1a160f;          /* 창 배경 */
  --us-box-fg: #e8d7a8;          /* 주 텍스트 */
  --us-box-border: #9f7a2d;      /* 테두리·구분선 */
  --us-box-muted: #b39a5e;       /* 보조 텍스트 (섹션 제목·노트) */
  --us-box-input-bg: #12100a;    /* 입력 필드 배경 */
  --us-box-secondary: #2a1f0e;   /* 일반 버튼 배경 */
  --us-box-accent: #3a2f1c;      /* 버튼 호버 배경 */
  --us-box-primary: #d8b85a;     /* 강조 버튼·활성 탭·토글 */
  --us-box-primary-fg: #1a160f;
  --us-box-switch-off: #9f7a2d;  /* 토글 미선택 트랙 색 */
  --us-box-switch-on: #d8b85a;   /* 토글 선택(켜짐) 트랙 색 */
  --us-box-switch-thumb: #1a160f; /* 토글 손잡이 색 (어두운 배경) */
  /* 일반 체크박스(impersonate·기록 전환 등)의 체크·호버 강조색은 위 --us-box-primary 를 자동으로 따라갑니다 */
}`,
    },
    {
      name: "🟢 네온 터미널",
      description: "초록 글씨 해커 단말\n인물: 상태 · 동기화(게이지) · 관계 · 행동\n장면: 시간 · 장소 · 장면 묘사 · 자세\n호감도 대신 동기화로 친밀도를 보여 줌",
      fields: [
        { key: "상태", instruction: "대상의 현재 상태/컨디션을 짧게. 예: 정상, 대기, 과부하" },
        { key: "동기화", instruction: "대상이 상대에게 동조·신뢰하는 정도 0~100 숫자. 예: 64" },
        { key: "관계", instruction: "상대와의 연결 상태를 짧게. 예: 미인증, 링크됨, 신뢰" },
        { key: "행동", instruction: "대상이 지금 실행 중인 행동을 짧게. 예: 데이터 분석 중" },
      ],
      sceneFields: [
        { key: "시간", instruction: "현재 시각/날짜. 예: 오후 3시, 12월 5일 밤" },
        { key: "장소", instruction: "현재 장면의 위치. 예: 학교 옥상, 비 오는 골목" },
        { key: "장면 묘사", instruction: "지금 벌어지는 상황을 1~2문장으로. 예: 둘은 우산 하나를 나눠 쓰고 걷는 중" },
        { key: "자세/동작", instruction: "등장 캐릭터들의 현재 자세·동작. 예: A는 벤치에 앉아 있고, B는 그 앞에 서 있음" },
      ],
      css: NEON_TERMINAL_CSS,
      template: NEON_TERMINAL_TEMPLATE,
      sceneCss: NEON_TERMINAL_SCENE_CSS,
      sceneTemplate: NEON_TERMINAL_SCENE_TEMPLATE,
      tabTemplate: DEFAULT_TAB_TEMPLATE,
      tabCss: "",
      sceneButtonTemplate: DEFAULT_SCENE_BUTTON_TEMPLATE,
      sceneButtonCss: "",
      instructions: "",
      windowCssMode: "custom",
      windowCss: NEON_TERMINAL_WINDOW_CSS,
    },
    {
      name: "📱 모던 폰",
      description: "흰 바탕 휴대폰 화면\n인물: 기분 · 호감도(게이지) · 관계 · 상태\n장면: 시간 · 장소 · 장면 묘사 · 자세",
      fields: [
        { key: "기분", instruction: "대상의 현재 기분을 한 단어로. 예: 설렘, 차분함" },
        { key: "호감도", instruction: "대상이 상대에게 느끼는 호감도 0~100 숫자. 예: 72" },
        { key: "관계", instruction: "상대와의 현재 관계를 짧게. 예: 친구, 연인, 썸" },
        { key: "상태", instruction: "대상의 현재 상태/행동을 짧게. 예: 메시지 확인 중" },
      ],
      sceneFields: [
        { key: "시간", instruction: "현재 시각/날짜. 예: 오후 3시, 12월 5일 밤" },
        { key: "장소", instruction: "현재 장면의 위치. 예: 학교 옥상, 비 오는 골목" },
        { key: "장면 묘사", instruction: "지금 벌어지는 상황을 1~2문장으로. 예: 둘은 우산 하나를 나눠 쓰고 걷는 중" },
        { key: "자세/동작", instruction: "등장 캐릭터들의 현재 자세·동작. 예: A는 벤치에 앉아 있고, B는 그 앞에 서 있음" },
      ],
      css: `.ph{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;width:100%;box-sizing:border-box;color:#1c1c1e;
 background:#ffffff;border:1px solid #e5e5ea;border-radius:20px;padding:14px 16px;
 box-shadow:0 8px 24px rgba(0,0,0,.10);overflow-wrap:break-word;word-break:keep-all;}
.phn{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:10px}
.phdot{width:10px;height:10px;border-radius:50%;background:#34c759;flex:none;box-shadow:0 0 0 3px rgba(52,199,89,.18)}
.phrow{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;font-size:13px;padding:6px 0;border-top:1px solid #f2f2f7;line-height:1.45}
.phrow.first{border-top:none}
.phk{color:#8e8e93;flex:none}.phv{color:#1c1c1e;font-weight:600;text-align:right;overflow-wrap:break-word;word-break:keep-all}
.phbar{height:6px;border-radius:999px;background:#e5e5ea;overflow:hidden;margin-top:4px;width:130px;flex:none}
.phfill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#0a84ff,#34c759)}`,
      template: `<div class="ph">
  <div class="phn"><span class="phdot"></span>{{이름}}</div>
  <div class="phrow first"><span class="phk">기분</span><span class="phv">{{기분}}</span></div>
  <div class="phrow"><span class="phk">호감도</span><span class="phv">{{호감도}}</span></div>
  <div class="phrow"><span class="phk"></span><span class="phbar"><span class="phfill" style="width:{{호감도}}%"></span></span></div>
  <div class="phrow"><span class="phk">관계</span><span class="phv">{{관계}}</span></div>
  <div class="phrow"><span class="phk">상태</span><span class="phv">{{상태}}</span></div>
</div>`,
      sceneCss: `.scene{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;width:100%;box-sizing:border-box;border-radius:16px;padding:10px 14px;border:1px solid #e5e5ea;background:#f2f2f7;color:#1c1c1e;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.head{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;font-weight:700;color:#0a84ff}
.sub{margin-top:6px;font-size:11px;line-height:1.5;color:#3a3a3c}`,
      sceneTemplate: `<div class="scene">
  <div class="head"><span>🕒 {{시간}}</span><span>📍 {{장소}}</span></div>
  <div class="sub">{{장면 묘사}}</div>
  <div class="sub">🧍 {{자세/동작}}</div>
</div>`,
      tabTemplate: DEFAULT_TAB_TEMPLATE,
      tabCss: "",
      sceneButtonTemplate: DEFAULT_SCENE_BUTTON_TEMPLATE,
      sceneButtonCss: "",
      instructions: "",
      windowCssMode: "custom",
      windowCss: `/* ══ 모던 폰 · 윈도우(창 틀) 테마 ══
   #us-float / #us-prompt-bubble-window → 플로팅 상태창·요청창 (변수 --us-float-*)
   .us-box → 설정·편집 창 (변수 --us-box-*)
   ※ 상태창 카드 내용의 색·폰트는 편집기의 "카드 CSS / 장면 CSS" 칸에서 바꿉니다. */

/* ① 플로팅 상태창 + 추가 요청사항 창 ─ 변수: --us-float-* */
#us-float, #us-prompt-bubble-window {
  border-radius: 20px;
  box-shadow: 0 10px 30px rgba(0,0,0,.18);
  --us-float-bg: #ffffff;        /* 창 배경 */
  --us-float-fg: #1c1c1e;        /* 주 텍스트 */
  --us-float-border: #e5e5ea;    /* 테두리 */
  --us-float-muted: #8e8e93;     /* 보조 텍스트 (레이블·힌트) */
  --us-float-primary: #0a84ff;   /* 강조색 (활성 탭·아이콘 on 등) */
  --us-float-primary-fg: #ffffff;
  --us-float-secondary: #f2f2f7; /* 버튼·장면 버튼 배경 */
  --us-float-accent: #e5e5ea;    /* 호버 배경 */
}
/* 시스템 폰트 통일 (font-family 는 변수로 제어 안 됨) */
#us-float .us-f-title,
#us-float .us-tab,
#us-float .us-scene-button { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; }

/* ② 설정창·편집기 창 ─ 변수: --us-box-* */
.us-box {
  --us-box-bg: #ffffff;          /* 창 배경 */
  --us-box-fg: #1c1c1e;          /* 주 텍스트 */
  --us-box-border: #e5e5ea;      /* 테두리·구분선 */
  --us-box-muted: #8e8e93;       /* 보조 텍스트 (섹션 제목·노트) */
  --us-box-input-bg: #f2f2f7;    /* 입력 필드 배경 */
  --us-box-secondary: #f2f2f7;   /* 일반 버튼 배경 */
  --us-box-accent: #e5e5ea;      /* 버튼 호버 배경 */
  --us-box-primary: #0a84ff;     /* 강조 버튼·활성 탭·토글 */
  --us-box-primary-fg: #ffffff;
  --us-box-switch-off: #c7c7cc;  /* 토글 미선택 트랙 색 */
  --us-box-switch-on: #34c759;   /* 토글 선택(켜짐) 트랙 색 (iOS 초록) */
  --us-box-switch-thumb: #ffffff; /* 토글 손잡이 색 */
  /* 일반 체크박스(impersonate·기록 전환 등)의 체크·호버 강조색은 위 --us-box-primary 를 자동으로 따라갑니다 */
}`,
    },
    {
      name: "👾 다마고치",
      description: "보라 테두리 다마고치 화면\n인물: 기분 · 애정(게이지) · 관계 · 컨디션\n장면: 시간 · 장소 · 장면 묘사 · 자세",
      fields: [
        { key: "기분", instruction: "대상의 현재 기분을 한 단어로. 예: 신남, 졸림, 시무룩" },
        { key: "호감도", instruction: "대상이 상대에게 느끼는 애정 0~100 숫자. 예: 80" },
        { key: "관계", instruction: "상대와의 현재 관계를 짧게. 예: 주인, 친구, 단짝" },
        { key: "상태", instruction: "대상의 현재 컨디션/행동을 짧게. 예: 배고픔, 노는 중" },
      ],
      sceneFields: [
        { key: "시간", instruction: "현재 시각/날짜. 예: 오후 3시, 12월 5일 밤" },
        { key: "장소", instruction: "현재 장면의 위치. 예: 학교 옥상, 비 오는 골목" },
        { key: "장면 묘사", instruction: "지금 벌어지는 상황을 1~2문장으로. 예: 둘은 우산 하나를 나눠 쓰고 걷는 중" },
        { key: "자세/동작", instruction: "등장 캐릭터들의 현재 자세·동작. 예: A는 벤치에 앉아 있고, B는 그 앞에 서 있음" },
      ],
      css: `.tg{font-family:'Courier New',ui-monospace,monospace;width:100%;box-sizing:border-box;color:#1a1a1a;
 background:#fffef5;border:3px solid #c084fc;border-radius:14px;padding:12px 14px;
 box-shadow:inset 0 0 0 2px #f0d9ff;overflow-wrap:break-word;word-break:keep-all;}
.tgn{font-weight:700;font-size:14px;margin-bottom:8px;text-align:center;letter-spacing:1px;border-bottom:2px dotted #c084fc;padding-bottom:6px}
.tgrow{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;font-size:13px;padding:3px 0;line-height:1.4}
.tgk{color:#9333ea;flex:none;font-weight:700}.tgv{color:#1a1a1a;font-weight:700;text-align:right;overflow-wrap:break-word;word-break:keep-all}
.tgbar{height:9px;border-radius:2px;background:#f0d9ff;overflow:hidden;margin-top:3px;width:118px;flex:none;border:1px solid #c084fc}
.tgfill{display:block;height:100%;background:repeating-linear-gradient(90deg,#1a1a1a 0 6px,#9333ea 6px 9px)}`,
      template: `<div class="tg">
  <div class="tgn">👾 {{이름}}</div>
  <div class="tgrow"><span class="tgk">기분</span><span class="tgv">{{기분}}</span></div>
  <div class="tgrow"><span class="tgk">애정</span><span class="tgv">{{호감도}}</span></div>
  <div class="tgrow"><span class="tgk"></span><span class="tgbar"><span class="tgfill" style="width:{{호감도}}%"></span></span></div>
  <div class="tgrow"><span class="tgk">관계</span><span class="tgv">{{관계}}</span></div>
  <div class="tgrow"><span class="tgk">상태</span><span class="tgv">{{상태}}</span></div>
</div>`,
      sceneCss: `.scene{font-family:'Courier New',ui-monospace,monospace;width:100%;box-sizing:border-box;border-radius:12px;padding:10px 12px;border:3px solid #c084fc;background:#fffef5;color:#1a1a1a;box-shadow:inset 0 0 0 2px #f0d9ff}
.head{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;font-weight:700;color:#1a1a1a}
.sub{margin-top:6px;font-size:11px;line-height:1.5;color:#1a1a1a}`,
      sceneTemplate: `<div class="scene">
  <div class="head"><span>⏰ {{시간}}</span><span>📍 {{장소}}</span></div>
  <div class="sub">{{장면 묘사}}</div>
  <div class="sub">🐾 {{자세/동작}}</div>
</div>`,
      tabTemplate: DEFAULT_TAB_TEMPLATE,
      tabCss: "",
      sceneButtonTemplate: DEFAULT_SCENE_BUTTON_TEMPLATE,
      sceneButtonCss: "",
      instructions: "",
      windowCssMode: "custom",
      windowCss: `/* ══ 다마고치 · 윈도우(창 틀) 테마 ══
   #us-float / #us-prompt-bubble-window → 플로팅 상태창·요청창 (변수 --us-float-*)
   .us-box → 설정·편집 창 (변수 --us-box-*)
   ※ 상태창 카드 내용의 색·폰트는 편집기의 "카드 CSS / 장면 CSS" 칸에서 바꿉니다. */

/* ① 플로팅 상태창 + 추가 요청사항 창 ─ 변수: --us-float-* */
#us-float, #us-prompt-bubble-window {
  border-radius: 28px;
  box-shadow: 0 8px 0 #d4a0f0, 0 12px 32px rgba(160,80,230,.28);
  --us-float-bg: linear-gradient(160deg,#fce8ff,#ead5ff,#ffdff8); /* 파스텔 라벤더·핑크 그라디언트 */
  --us-float-fg: #1a1a1a;        /* 주 텍스트 */
  --us-float-border: #c084fc;    /* 테두리 */
  --us-float-muted: #9333ea;     /* 보조 텍스트 (레이블·힌트) */
  --us-float-primary: #9333ea;   /* 강조색 (활성 탭·아이콘 on 등) */
  --us-float-primary-fg: #fff;
  --us-float-secondary: #f3d9ff; /* 버튼·장면 버튼 배경 */
  --us-float-accent: #e8c8ff;    /* 호버 배경 */
}
/* 픽셀/모노스페이스 느낌 폰트 통일 (font-family 는 변수로 제어 안 됨) */
#us-float .us-f-title,
#us-float .us-tab,
#us-float .us-scene-button { font-family: 'Courier New', ui-monospace, monospace; }

/* ② 설정창·편집기 창 ─ 변수: --us-box-* */
.us-box {
  --us-box-bg: #fdf4ff;          /* 창 배경 */
  --us-box-fg: #1a1a1a;          /* 주 텍스트 */
  --us-box-border: #c084fc;      /* 테두리·구분선 */
  --us-box-muted: #9333ea;       /* 보조 텍스트 (섹션 제목·노트) */
  --us-box-input-bg: #f9f0ff;    /* 입력 필드 배경 */
  --us-box-secondary: #f3d9ff;   /* 일반 버튼 배경 */
  --us-box-accent: #e8c8ff;      /* 버튼 호버 배경 */
  --us-box-primary: #9333ea;     /* 강조 버튼·활성 탭·토글 */
  --us-box-primary-fg: #fff;
  --us-box-switch-off: #e0c4ff;  /* 토글 미선택 트랙 색 */
  --us-box-switch-on: #9333ea;   /* 토글 선택(켜짐) 트랙 색 */
  --us-box-switch-thumb: #fff;   /* 토글 손잡이 색 */
  /* 일반 체크박스(impersonate·기록 전환 등)의 체크·호버 강조색은 위 --us-box-primary 를 자동으로 따라갑니다 */
}`,
    },
  ];

  const DEFAULT_SETTINGS = {
    enabled: false,
    dataMode: DATA_MODES.api,
    apiConnectionId: null,
    stripFromMessage: true,
    injectCurrentValues: true,
    allowImpersonate: false,
    historyDepth: DEFAULT_HISTORY_DEPTH,
    recordLimit: DEFAULT_RECORD_LIMIT, // 기록 보관 개수(턴 기준). 0 = 전부 보관
    defaultInstructions: DEFAULT_CONTINUITY_PROMPT,
    incHistory: false,    // 채팅 히스토리 참조 (기본 OFF)
    historyTurns: 0,      // 히스토리를 켰을 때 보낼 최근 답변 수 (0 = 제한 없음/전체)
    historyTurnsAuto: false, // 위 값이 '채팅 요약'을 켜며 자동으로 들어간 값인지 (사용자가 직접 넣은 값은 되돌리지 않는다)
    incChatSummary: false, // 마리나라 채팅 요약 참조 (기본 OFF) — 히스토리를 끈 채 이전 흐름을 짧게 넘길 때
    incLorebook: false,   // 로어북 참조 (기본 OFF)
    incCharacters: true,  // 캐릭터 카드 참조 (기본 ON — 등장인물·설명 컨텍스트 제공)
    incPersona: false,    // 유저 페르소나 참조 (기본 OFF)
    
    hiddenExcludeFromPrompt: false, // 눈으로 숨긴 캐릭터를 캡처 프롬프트에서도 제외 (이름 목록 + 캐릭터 카드)
  };
  const DEFAULT_UI = { floatCollapsed: false, floatPos: null, panelTab: "status", sceneCollapsed: {}, charCollapsed: {}, charCollapseEnabled: false, historyHoverPreview: true, windowCss: "", windowCssMode: "marinara", applyWindowCssToPanels: false, dynamicWindowCss: true, floatMinimizeMode: "bar", displayMode: "inline", inlineFullWidth: false, inlineShowTitle: true, inlineWindowCollapsed: {}, inlineWindowDefaultCollapsed: false, inlineSceneDefaultCollapsed: true, inlineCharDefaultCollapsed: true, firstCaptureAskedChats: {}, iconPos: null,
    // 제목 바(상단 바)로 접기/펼치기: "click"(기본) | "off"
    barToggleMode: "click" }; // 디자인 탭의 상태창 윈도우 커스텀 CSS
  function sanitizeWindowCss(cssLike) {
    let css = (cssLike || "").toString();
    css = css.replace(/@import[\s\S]*?(;|$)/gi, "");
    css = css.replace(/[^{};]+:\s*[^;{}]*url\s*\([^;{}]*\)[^;{}]*;?/gi, "");
    return css;
  }

  // 미리보기 위젯(.us-hist-widget)에 status.windowCss 의 #us-float 블록 변수를 inline 으로 적용.
  // #us-float 를 건드리지 않으므로 플로팅 창이 변하지 않는다.
  // inline style 은 모든 class 규칙보다 specificty 가 높아 확실하게 덮어쓴다.
  const WIDGET_FLOAT_VARS = ["--us-float-bg","--us-float-fg","--us-float-border","--us-float-muted",
                             "--us-float-primary","--us-float-primary-fg","--us-float-secondary","--us-float-accent"];
  const WIDGET_ROOT_PROPS = ["background","background-color","color","border","border-color","border-width",
                             "border-style","border-radius","box-shadow","font-family","font-size","line-height","padding"];
  const WIDGET_SKIN_ATTR = "data-us-window-skin";
  let widgetSkinSeq = 0;
  function splitCssSelectorList(text) {
    const out = [];
    let start = 0, depth = 0, quote = "", escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
  }
  function scopeFloatCssForWidget(css, widgetSelector) {
    const scopeSelectors = (selectorText) => splitCssSelectorList(selectorText)
      .filter((selector) => /#us-float\b/.test(selector))
      .map((selector) => selector.replace(/#us-float\b/g, widgetSelector));
    try {
      // 현재 문서에 원본 규칙을 잠깐이라도 전역 적용하지 않도록 분리된 문서에서 CSSOM만 파싱한다.
      const scratchDoc = document.implementation.createHTMLDocument("");
      const scratchStyle = scratchDoc.createElement("style");
      scratchStyle.textContent = css;
      scratchDoc.head.appendChild(scratchStyle);
      if (!scratchStyle.sheet) throw new Error("Detached CSSOM unavailable");
      const walk = (rules) => {
        let out = "";
        for (const rule of Array.from(rules || [])) {
          if (typeof rule.selectorText === "string" && rule.style) {
            const selectors = scopeSelectors(rule.selectorText);
            if (selectors.length) out += `${selectors.join(",")}{${rule.style.cssText}}`;
            continue;
          }
          // @media/@supports 같은 그룹 규칙만 보존한다. @keyframes·@font-face 등 전역 규칙은
          // 과거 위젯마다 중복 주입하면 다른 스킨에 누출되므로 의도적으로 제외한다.
          if (rule.cssRules) {
            const prelude = String(rule.cssText || "").split("{", 1)[0].trim();
            if (!/^@(media|supports|container|layer|scope|starting-style)\b/i.test(prelude)) continue;
            const inner = walk(rule.cssRules);
            if (inner) out += `${prelude}{${inner}}`;
          }
        }
        return out;
      };
      return walk(scratchStyle.sheet.cssRules);
    } catch (_) {
      // 구형 WebView의 분리 문서 CSSOM 폴백: 평면 #us-float 규칙만 안전하게 가져온다.
      let out = "";
      const flatRule = /([^{}]+)\{([^{}]*)\}/g;
      let match;
      while ((match = flatRule.exec(css)) !== null) {
        const selectors = scopeSelectors(match[1]);
        if (selectors.length) out += `${selectors.join(",")}{${match[2]}}`;
      }
      return out;
    }
  }
  function applyWidgetWindowCss(el, status) {
    for (const v of WIDGET_FLOAT_VARS) el.style.removeProperty(v);
    for (const p of WIDGET_ROOT_PROPS) el.style.removeProperty(p);
    const oldStyle = el.querySelector(':scope > style[data-us-widget-window-css]');
    if (oldStyle) oldStyle.remove();
    let cssSource = "";
    if (status && status.windowCssMode === "custom" && status.windowCss) cssSource = status.windowCss;
    if (!cssSource && config && config.ui && config.ui.windowCssMode === "custom") cssSource = config.ui.windowCss || "";
    if (!cssSource) { el.removeAttribute(WIDGET_SKIN_ATTR); return; }
    const css = sanitizeWindowCss(cssSource);
    // #us-float { ... } 첫 번째 블록만 추출
    const m = css.match(/#us-float\b[^{]*\{([^}]*)\}/);
    if (!m) return;
    const block = m[1];
    for (const v of WIDGET_FLOAT_VARS) {
      const re = new RegExp(v.replace(/-/g, "\\-") + "\\s*:\\s*([^;\\n}]+)");
      const vm = block.match(re);
      if (vm) el.style.setProperty(v, vm[1].trim());
    }
    // 위치·폭은 채팅 레이아웃이 책임진다. 그 외 루트 외형은 Window CSS 선언을 그대로 복사한다.
    const parsed = document.createElement("div").style;
    parsed.cssText = block;
    for (const p of WIDGET_ROOT_PROPS) {
      const value = parsed.getPropertyValue(p);
      if (value) el.style.setProperty(p, value.trim(), parsed.getPropertyPriority(p));
    }
    // #us-float 관련 모든 규칙을 순회해 font-family 추출 → 위젯 루트에 적용하면 자식이 inherit 로 따라옴
    // (font-family 는 대부분 #us-float .us-f-title, .us-tab, ... 의 별도 규칙에 있어 첫 블록 매칭 불가)
    const fontRuleRe = /#us-float\b[^{]*\{([^}]+)\}/g;
    let fontRuleMatch;
    let extractedFont = null;
    while ((fontRuleMatch = fontRuleRe.exec(css)) !== null) {
      const blockFm = fontRuleMatch[1].match(/font-family\s*:\s*([^;}\n]+)/);
      if (blockFm) { extractedFont = blockFm[1].trim(); break; }
    }
    if (extractedFont) el.style.fontFamily = extractedFont;

    // 과거 인라인/기록 미리보기에도 #us-float 전용 Window CSS 전체를 적용한다.
    // 위젯마다 고유 선택자로 바꿔 서로 다른 과거 스킨의 규칙이 섞이지 않게 한다.
    const skinToken = el.getAttribute(WIDGET_SKIN_ATTR) || `usw-${++widgetSkinSeq}`;
    el.setAttribute(WIDGET_SKIN_ATTR, skinToken);
    const widgetSelector = `[${WIDGET_SKIN_ATTR}="${skinToken}"]`;
    const scopedCss = scopeFloatCssForWidget(css, widgetSelector);
    const style = document.createElement("style");
    style.setAttribute("data-us-widget-window-css", "");
    style.textContent = `:where(${widgetSelector}){` +
      `--background:#232323;--card:#1c1c1c;--card-foreground:#eeeeee;--foreground:#eeeeee;` +
      `--border:#333333;--muted-foreground:#999999;--primary:#6c8cff;--primary-foreground:#ffffff;` +
      `--secondary:#232323;--accent:#333333;--input:#111111;}` + scopedCss;
    el.appendChild(style);
  }
  function normalizeUi(uiLike) {
    const ui = { ...DEFAULT_UI, ...((uiLike && typeof uiLike === "object" && !Array.isArray(uiLike)) ? uiLike : {}) };
    if (!ui.sceneCollapsed || typeof ui.sceneCollapsed !== "object" || Array.isArray(ui.sceneCollapsed)) ui.sceneCollapsed = {};
    if (!ui.charCollapsed || typeof ui.charCollapsed !== "object" || Array.isArray(ui.charCollapsed)) ui.charCollapsed = {};
    if (!ui.inlineWindowCollapsed || typeof ui.inlineWindowCollapsed !== "object" || Array.isArray(ui.inlineWindowCollapsed)) ui.inlineWindowCollapsed = {};
    if (typeof ui.inlineWindowDefaultCollapsed !== "boolean") ui.inlineWindowDefaultCollapsed = false;
    if (typeof ui.inlineSceneDefaultCollapsed !== "boolean") ui.inlineSceneDefaultCollapsed = true;
    if (typeof ui.inlineCharDefaultCollapsed !== "boolean") ui.inlineCharDefaultCollapsed = true;
    if (typeof ui.inlineShowTitle !== "boolean") ui.inlineShowTitle = true;
    if (typeof ui.charCollapseEnabled !== "boolean") ui.charCollapseEnabled = false;
    if (typeof ui.historyHoverPreview !== "boolean") ui.historyHoverPreview = true;
    if (typeof ui.applyWindowCssToPanels !== "boolean") ui.applyWindowCssToPanels = false;
    if (typeof ui.dynamicWindowCss !== "boolean") ui.dynamicWindowCss = true;
    if (ui.floatMinimizeMode !== "icon") ui.floatMinimizeMode = "bar";
    if (ui.barToggleMode !== "off") ui.barToggleMode = "click";
    if (ui.displayMode !== "floating") ui.displayMode = "inline";
    if (typeof ui.inlineFullWidth !== "boolean") ui.inlineFullWidth = false;
    if (!ui.firstCaptureAskedChats || typeof ui.firstCaptureAskedChats !== "object" || Array.isArray(ui.firstCaptureAskedChats)) ui.firstCaptureAskedChats = {};
    ui.windowCss = sanitizeWindowCss(ui.windowCss);
    // 기존 저장값에 windowCssMode 없으면: windowCss 있으면 custom, 없으면 marinara
    if (ui.windowCssMode !== "custom" && ui.windowCssMode !== "marinara") {
      ui.windowCssMode = ui.windowCss ? "custom" : "marinara";
    }
    return ui;
  }

  // ── 저장소(설정·상태창 = localStorage) ──
  function uid() { return NS + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // 파일 · 채팅에 담을 때는 기기 설정(서버 연동 여부)을 뺀다
  function shareableStatus(w) {
    const n = normalizeStatus(w);
    if (n) delete n.localOnly;
    return n;
  }
  function normalizeStatus(w) {
    if (!w || typeof w !== "object") return null;
    const nFields = Array.isArray(w.fields)
      ? w.fields.map((f) => ({ key: (f.key || "").toString().trim(), instruction: (f.instruction || "").toString() })).filter((f) => f.key)
      : [];
    const nSceneFields = Array.isArray(w.sceneFields)
      ? w.sceneFields.map((f) => ({ key: (f.key || "").toString().trim(), instruction: (f.instruction || "").toString() })).filter((f) => f.key)
      : [];
    return {
      id: w.id || uid(),
      name: (w.name || "상태창").toString(),
      // 스킨 설명 — 목록에서 이름을 누르면 펼쳐 보이는 짧은 글. 표시 전용(프롬프트·렌더와 무관)
      description: (w.description || "").toString(),
      fields: nFields,
      // 접기 그룹: 상태값 사이에 끼워 넣는 '마커'. { name, at } 의 at 은 그룹이 시작되는 fields 인덱스.
      //   그룹은 다음 마커 앞(또는 끝)까지의 상태값을 묶는다. 편집기/값 수정 화면에서 접었다 펼 때만
      //   쓰이며, AI 프롬프트·템플릿·저장 값에는 전혀 영향을 주지 않는다(= fields 는 순수 값 목록 유지).
      folds: Array.isArray(w.folds)
        ? w.folds.map((g) => ({
            name: ((g && g.name) || "").toString().trim(),
            at: Math.max(0, Math.min(nFields.length, Math.floor(Number(g && g.at)) || 0)),
          })).filter((g) => g.name).sort((a, b) => a.at - b.at)
        : [],
      // 장면 필드용 접기 마커 (구조는 folds 와 동일, at 은 sceneFields 인덱스)
      sceneFolds: Array.isArray(w.sceneFolds)
        ? w.sceneFolds.map((g) => ({
            name: ((g && g.name) || "").toString().trim(),
            at: Math.max(0, Math.min(nSceneFields.length, Math.floor(Number(g && g.at)) || 0)),
          })).filter((g) => g.name).sort((a, b) => a.at - b.at)
        : [],
      sceneFields: nSceneFields,
      template: (w.template || "").toString(),
      css: (w.css || "").toString(),
      sceneTemplate: (w.sceneTemplate || "").toString(),
      sceneCss: (w.sceneCss || "").toString(),
      tabTemplate: (w.tabTemplate || DEFAULT_TAB_TEMPLATE).toString(),
      tabCss: (w.tabCss || "").toString(),
      sceneButtonTemplate: (w.sceneButtonTemplate || DEFAULT_SCENE_BUTTON_TEMPLATE).toString(),
      sceneButtonCss: (w.sceneButtonCss || "").toString(),
      sceneDefaultCollapsed: w.sceneDefaultCollapsed === true,
      // true 면 이 기기에만 저장 — 서버 동기화에서 빠진다
      localOnly: w.localOnly === true,
      // 캐릭터 접기 버튼 스킨별 설정: "global"=전역 설정 따름(기본) · "on"=이 스킨은 항상 표시 · "off"=이 스킨은 항상 숨김
      charCollapseMode: (w.charCollapseMode === "on" || w.charCollapseMode === "off") ? w.charCollapseMode : "global",
      // 캐릭터 필드 토글을 껐을 때(장면 전용 전환) 필드 정의를 보존해 두는 백업.
      //   토글을 다시 켜면 편집기가 여기서 복원한다 — 껐다 켜도 필드가 날아가지 않게.
      charFieldsBackup: Array.isArray(w.charFieldsBackup)
        ? w.charFieldsBackup.map((f) => ({ key: (f.key || "").toString().trim(), instruction: (f.instruction || "").toString() })).filter((f) => f.key)
        : [],
      // 값 표시 방식 — 기본은 예전 동작(줄바꿈 무시 + 태그를 글자로)
      valueLineBreaks: (w.valueLineBreaks === "br" || w.valueLineBreaks === "div") ? w.valueLineBreaks : "off",
      valueHtml: w.valueHtml === true,
      instructions: (w.instructions || "").toString(),
      windowCss: sanitizeWindowCss(w.windowCss || ""),
      windowCssMode: (w.windowCssMode === "custom" || w.windowCssMode === "marinara") ? w.windowCssMode : "marinara",
    };
  }
  // 상태값 목록을 접기 그룹 단위로 자른다. name:null 은 첫 마커 앞의 '항상 보이는' 구간.
  //   반환: [{ name, from, to }] — fields.slice(from, to) 가 그 구간의 상태값.
  function fieldSegments(fields, folds) {
    const list = Array.isArray(fields) ? fields : [];
    const marks = (Array.isArray(folds) ? folds : [])
      .map((g) => ({ name: ((g && g.name) || "").toString().trim(), at: Math.max(0, Math.min(list.length, Math.floor(Number(g && g.at)) || 0)) }))
      .filter((g) => g.name)
      .sort((a, b) => a.at - b.at);
    if (!marks.length) return [{ name: null, from: 0, to: list.length }];
    const segs = [];
    if (marks[0].at > 0) segs.push({ name: null, from: 0, to: marks[0].at });
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].at : list.length;
      segs.push({ name: m.name, from: m.at, to: Math.max(end, m.at) });
    });
    return segs;
  }
  // 상태값 + 접기 마커를 한 줄짜리 목록으로 합친다 (편집기의 드래그 정렬이 마커까지 함께 다루도록).
  function buildFieldItems(fields, folds) {
    const list = (Array.isArray(fields) ? fields : []).map((f) => ({ key: f.key || "", instruction: f.instruction || "" }));
    const marks = (Array.isArray(folds) ? folds : [])
      .map((g) => ({ name: ((g && g.name) || "").toString(), at: Math.max(0, Math.min(list.length, Math.floor(Number(g && g.at)) || 0)) }))
      .sort((a, b) => a.at - b.at);
    const items = []; let mi = 0;
    for (let i = 0; i <= list.length; i++) {
      while (mi < marks.length && marks[mi].at === i) { items.push({ fold: true, name: marks[mi].name }); mi++; }
      if (i < list.length) items.push(list[i]);
    }
    return items;
  }
  function migrateSettings(s) {
    const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
    if (s && s.dataMode === "off") { out.enabled = false; out.dataMode = DATA_MODES.inline; }
    if (typeof out.historyDepth !== "number" || out.historyDepth < 1) out.historyDepth = DEFAULT_HISTORY_DEPTH;
    if (typeof out.historyTurns !== "number" || !(out.historyTurns >= 0)) out.historyTurns = 0;
    out.historyTurns = Math.min(200, Math.floor(out.historyTurns));
    out.historyTurnsAuto = out.historyTurnsAuto === true;
    // recordLimit: 0 = 무제한. 음수/비정상은 기본값으로.
    if (typeof out.recordLimit !== "number" || !Number.isFinite(out.recordLimit) || out.recordLimit < 0) out.recordLimit = DEFAULT_RECORD_LIMIT;
    out.recordLimit = Math.floor(out.recordLimit);
    if (out.dataMode !== DATA_MODES.api) out.dataMode = DATA_MODES.inline;
    if (typeof out.defaultInstructions !== "string") out.defaultInstructions = DEFAULT_CONTINUITY_PROMPT;
    out.stripFromMessage = true; // always on — no longer user-configurable
    return out;
  }
  function loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(STORE_CONFIG) || "{}");
      const settings = migrateSettings(c.settings);
      const ui = normalizeUi(c.ui);
      const perChatTitle = c.perChatTitle && typeof c.perChatTitle === "object" && !Array.isArray(c.perChatTitle) ? c.perChatTitle : {};
      const perChatSettings = {};
      if (c.perChatSettings && typeof c.perChatSettings === "object") {
        for (const k of Object.keys(c.perChatSettings)) perChatSettings[k] = migrateSettings(c.perChatSettings[k]);
      }
      const cfg = {
        statuses: Array.isArray(c.statuses) ? c.statuses.map(normalizeStatus).filter(Boolean) : [],
        activeId: c.activeId || null,
        settings,
        perChatSettings,
        perChatTitle,
        perChat: c.perChat && typeof c.perChat === "object" ? c.perChat : {},
        perChatHidden: c.perChatHidden && typeof c.perChatHidden === "object" && !Array.isArray(c.perChatHidden) ? c.perChatHidden : {},
        perChatDropped: c.perChatDropped && typeof c.perChatDropped === "object" && !Array.isArray(c.perChatDropped) ? c.perChatDropped : {},
        ui,
        seeded: c.seeded === true,
        starterDescFilled: c.starterDescFilled === true,
      };
      if (cfg.activeId && !cfg.statuses.some((w) => w.id === cfg.activeId)) cfg.activeId = cfg.statuses[0]?.id || null;
      return cfg;
    } catch { return { statuses: [], activeId: null, settings: { ...DEFAULT_SETTINGS }, perChatSettings: {}, perChatTitle: {}, perChat: {}, perChatHidden: {}, perChatDropped: {}, ui: { ...DEFAULT_UI }, seeded: false }; }
  }
  function saveConfig() { try { localStorage.setItem(STORE_CONFIG, JSON.stringify(config)); } catch {} scheduleServerConfigSync(); }
  let config = loadConfig();

  /* ══════════════════════════════════════════════════════════
   * 설정 서버 동기화 (us-config-v1 → marinara.storage)
   *  - Marinara 2.4 이상은 Full page 확장에 marinara.storage 를 준다.
   *    (/api/personal-extensions/<id>/storage, 확장당 1MB, 서버 DB 저장)
   *  - 저장 대상: us-config-v1 전체에서 "기기별 UI 상태"만 뺀 것. localStorage 는 캐시로 유지.
   *  - 규칙: 같은 ID 는 서버 우선, 이 브라우저에만 있는 스킨은 서버에 추가
   *  - 저장: saveConfig() 때마다 0.7초 묶어서 patch, 30초마다 다른 기기 변경 pull
   *  - marinara.storage 가 없으면(2.3 이하) 아무것도 하지 않는다. 서버 장애 시에도 localStorage 로 계속.
   * ══════════════════════════════════════════════════════════ */
  const SERVER_STORAGE_KEY = "config";
  const SERVER_MAX_BYTES = 950_000; // 서버 한도 1,000,000 바이트에 여유를 둔 값
  const SERVER_LOCAL_UI_KEYS = ["floatCollapsed", "floatPos", "iconPos", "panelTab", "sceneCollapsed", "charCollapsed",
    "inlineWindowCollapsed", "editCharFold", "editSceneFold", "promptFirstCapture", "advFoldOverride"];
  let _srvReady = false, _srvBusy = false, _srvApplying = false, _srvTimer = null;
  let _srvUpdatedAt = null, _srvLastError = "";
  let _srvSeededThisLoad = false; // 이 페이지 로드에서 기본 스킨을 자동 생성했으면 true (새 기기)

  function serverSyncAvailable() {
    return !!(marinara.storage && typeof marinara.storage.get === "function" && typeof marinara.storage.patch === "function");
  }
  function serverConfigSnapshotWithUi() {
    const ui = {};
    for (const k of Object.keys(config.ui || {})) if (!SERVER_LOCAL_UI_KEYS.includes(k)) ui[k] = config.ui[k];
    return {
      statuses: (config.statuses || []).filter((w) => !w.localOnly),
      // 연동을 끈 스킨 ID — 다른 기기는 이 스킨을 지우지 않고 자기 사본으로 남긴다
      unsyncedIds: (config.statuses || []).filter((w) => w.localOnly).map((w) => w.id),
      activeId: config.activeId || null,
      settings: config.settings || {}, perChatSettings: config.perChatSettings || {},
      perChatTitle: config.perChatTitle || {}, perChat: config.perChat || {},
      perChatHidden: config.perChatHidden || {}, perChatDropped: config.perChatDropped || {}, seeded: true, ui,
    };
  }
  const STARTER_BAR_FIXES = [
    ["💗 핑크 로맨스", ".fill{height:100%;background:linear-gradient(90deg,#ff7eb3,#ff4d8d)}", ".fill{display:block;height:100%;background:linear-gradient(90deg,#ff7eb3,#ff4d8d)}"],
    ["📱 모던 폰", ".phfill{height:100%;border-radius:999px;background:linear-gradient(90deg,#0a84ff,#34c759)}", ".phfill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#0a84ff,#34c759)}"],
    ["👾 다마고치", ".tgfill{height:100%;background:repeating-linear-gradient(90deg,#1a1a1a 0 6px,#9333ea 6px 9px)}", ".tgfill{display:block;height:100%;background:repeating-linear-gradient(90deg,#1a1a1a 0 6px,#9333ea 6px 9px)}"],
  ];
  // 손대지 않은 옛 네온 터미널에 새 디자인을 입힌다. 옛 판과 글자까지 같은 묶음만 바꾼다
  //   (카드 CSS+템플릿, 장면 CSS+템플릿, 창 CSS 묶음별로. 고친 묶음은 그대로). 바꾼 게 있으면 true.
  function upgradeNeonTerminal() {
    const fp = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36) + "." + s.length; };
    const same = (w, k, v) => fp((w[k] || "").toString()) === v;
    let changed = false;
    for (const w of config.statuses) {
      if (w.name !== "🟢 네온 터미널") continue;
      if (same(w, "css", "1xl6fvt.946") && same(w, "template", "1ewmkvz.529")) { w.css = NEON_TERMINAL_CSS; w.template = NEON_TERMINAL_TEMPLATE; changed = true; }
      if (same(w, "sceneCss", "d4l0e.408") && same(w, "sceneTemplate", "1n3vqvu.176")) { w.sceneCss = NEON_TERMINAL_SCENE_CSS; w.sceneTemplate = NEON_TERMINAL_SCENE_TEMPLATE; changed = true; }
      if (same(w, "windowCss", "taa8ly.1631")) { w.windowCss = NEON_TERMINAL_WINDOW_CSS; changed = true; }
    }
    // 게이지 칸이 인라인이라 폭이 안 먹던 스타터 — 그 규칙 한 줄만 고친다
    for (const [name, from, to] of STARTER_BAR_FIXES) {
      for (const w of config.statuses) {
        if (w.name === name && (w.css || "").includes(from)) { w.css = w.css.replace(from, to); changed = true; }
      }
    }
    return changed;
  }
  function applyServerConfig(data) {
    if (!data || typeof data !== "object") return false;
    let upgraded = false;
    _srvApplying = true;
    try {
      const localUi = {};
      for (const k of SERVER_LOCAL_UI_KEYS) if (config.ui && k in config.ui) localUi[k] = config.ui[k];
      const prevStatuses = config.statuses || [], prevActive = config.activeId;
      config.statuses = Array.isArray(data.statuses) ? data.statuses.map(normalizeStatus).filter(Boolean) : [];
      // 이 기기에만 둔 스킨(+ 다른 기기에서 연동을 끈 스킨)은 서버 목록에 없어도 원래 자리에 남긴다
      const unsynced = new Set(Array.isArray(data.unsyncedIds) ? data.unsyncedIds : []);
      prevStatuses.forEach((w, i) => {
        if (!w.localOnly && !unsynced.has(w.id)) return;
        config.statuses = config.statuses.filter((x) => x.id !== w.id);
        config.statuses.splice(Math.min(i, config.statuses.length), 0, { ...w, localOnly: true });
      });
      upgraded = upgradeNeonTerminal();
      config.activeId = data.activeId || null;
      if (prevActive && config.statuses.some((w) => w.id === prevActive && w.localOnly)) config.activeId = prevActive;
      if (config.activeId && !config.statuses.some((w) => w.id === config.activeId)) config.activeId = config.statuses[0]?.id || null;
      config.settings = migrateSettings(data.settings);
      config.perChatSettings = {};
      if (data.perChatSettings && typeof data.perChatSettings === "object") {
        for (const k of Object.keys(data.perChatSettings)) config.perChatSettings[k] = migrateSettings(data.perChatSettings[k]);
      }
      config.perChat = data.perChat && typeof data.perChat === "object" ? { ...data.perChat } : {};
      config.perChatTitle = data.perChatTitle && typeof data.perChatTitle === "object" ? { ...data.perChatTitle } : {};
      config.perChatHidden = data.perChatHidden && typeof data.perChatHidden === "object" ? { ...data.perChatHidden } : {};
      config.perChatDropped = data.perChatDropped && typeof data.perChatDropped === "object" ? { ...data.perChatDropped } : {};
      config.ui = normalizeUi({ ...(data.ui && typeof data.ui === "object" ? data.ui : {}), ...localUi });
      config.seeded = true;
      try { localStorage.setItem(STORE_CONFIG, JSON.stringify(config)); } catch {}
    } finally { _srvApplying = false; }
    try {
      applyWindowCss(); invalidateFloat();
      if (typeof syncDefaultSelInPanel === "function") syncDefaultSelInPanel();
      if (panelSelectTab && document.getElementById(PANEL_ID)) panelSelectTab(config.ui.panelTab || "status");
    } catch (e) { console.warn("[User Status] 서버 자료 반영 후 화면 갱신 실패", e); }
    return upgraded;
  }
  // 첫 연결: 서버 자료와 이 브라우저 자료를 합친다 (같은 ID 는 서버 우선, 브라우저 전용은 서버에 추가)
  function mergeLocalIntoServer(server) {
    const merged = JSON.parse(JSON.stringify(server));
    merged.statuses = Array.isArray(merged.statuses) ? merged.statuses : [];
    let addedFromLocal = 0;
    // 새 기기(방금 기본 스킨을 자동 생성한 경우)는 로컬 스킨을 올리지 않는다 — 다른 기기에서 이름을 바꾼 기본 스킨과 중복되는 것을 막는다
    for (const st of _srvSeededThisLoad ? [] : (config.statuses || [])) {
      if (!st || !st.id || st.localOnly) continue;
      if (merged.statuses.some((x) => x && x.id === st.id)) continue;
      // 자동 생성된 기본 스킨이 기기마다 중복되지 않도록: 이름+템플릿이 같으면 같은 스킨으로 본다
      if (merged.statuses.some((x) => x && x.name === st.name && x.template === st.template && x.css === st.css)) continue;
      merged.statuses.push(st); addedFromLocal++;
    }
    for (const key of ["perChat", "perChatTitle", "perChatHidden", "perChatDropped", "perChatSettings"]) {
      merged[key] = merged[key] && typeof merged[key] === "object" ? merged[key] : {};
      for (const k of Object.keys(config[key] || {})) if (!(k in merged[key])) { merged[key][k] = config[key][k]; addedFromLocal++; }
    }
    if (!merged.activeId || !merged.statuses.some((x) => x && x.id === merged.activeId)) merged.activeId = merged.statuses[0]?.id || null;
    return { merged, addedFromLocal };
  }
  async function putServerConfigNow() {
    if (!_srvReady || _srvApplying) return false;
    if (_srvTimer) { marinara.clearTimeout(_srvTimer); _srvTimer = null; }
    const snapshot = serverConfigSnapshotWithUi();
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    if (bytes > SERVER_MAX_BYTES) {
      _srvLastError = `설정이 서버 한도를 넘어 서버 저장을 건너뜀 (${bytes} bytes)`;
      console.warn("[User Status] " + _srvLastError + " — 안 쓰는 스킨을 지우면 다시 동기화됩니다");
      return false;
    }
    const updatedAt = new Date().toISOString();
    const patch = {}; patch[SERVER_STORAGE_KEY] = snapshot; patch.updatedAt = updatedAt;
    await marinara.storage.patch(patch);
    _srvUpdatedAt = updatedAt;
    _srvLastError = "";
    return true;
  }
  function scheduleServerConfigSync() {
    if (!_srvReady || _srvApplying) return;
    if (_srvTimer) marinara.clearTimeout(_srvTimer);
    _srvTimer = marinara.setTimeout(() => {
      _srvTimer = null;
      putServerConfigNow().catch((e) => { _srvLastError = e?.message || String(e); console.warn("[User Status] 서버 저장 실패 — localStorage 에는 보존됨:", e); });
    }, 700);
  }
  async function connectServerConfigSync() {
    if (_srvBusy || _srvReady || !serverSyncAvailable()) return;
    _srvBusy = true;
    try {
      const remote = await marinara.storage.get();
      const data = remote && typeof remote === "object" ? remote[SERVER_STORAGE_KEY] : null;
      if (data && typeof data === "object") {
        const { merged, addedFromLocal } = mergeLocalIntoServer(data);
        const upgraded = applyServerConfig(merged);
        _srvUpdatedAt = remote.updatedAt || null;
        _srvReady = true;
        if (addedFromLocal > 0 || upgraded) await putServerConfigNow();
        console.log(`[User Status] 설정 서버 동기화 연결 — 서버 스킨 ${config.statuses.length}개, 이 기기에서 추가 ${addedFromLocal}건`);
      } else {
        _srvReady = true;
        await putServerConfigNow();
        console.log(`[User Status] 설정 서버 동기화 연결 — 이 기기의 설정을 서버에 처음 저장 (스킨 ${config.statuses.length}개)`);
      }
      _srvLastError = "";
    } catch (e) {
      _srvReady = false;
      _srvLastError = e?.message || String(e);
      console.warn("[User Status] 설정 서버 동기화 연결 실패 — localStorage 로 계속, 30초 뒤 재시도:", _srvLastError);
    } finally { _srvBusy = false; }
  }
  async function pullServerConfigChanges() {
    if (!_srvReady || _srvBusy || _srvApplying) return;
    _srvBusy = true;
    try {
      if (_srvTimer) await putServerConfigNow(); // 직전 로컬 수정을 먼저 올려야 pull 이 되돌리지 않는다
      const remote = await marinara.storage.get();
      const data = remote && typeof remote === "object" ? remote[SERVER_STORAGE_KEY] : null;
      if (data && remote.updatedAt && remote.updatedAt !== _srvUpdatedAt) {
        if (applyServerConfig(data)) scheduleServerConfigSync();
        _srvUpdatedAt = remote.updatedAt;
        console.log("[User Status] 다른 기기의 설정 변경을 받아왔습니다");
      }
      _srvLastError = "";
    } catch (e) {
      _srvReady = false;
      _srvLastError = e?.message || String(e);
      console.warn("[User Status] 설정 서버 동기화 일시 중단 — localStorage 로 계속:", _srvLastError);
    } finally { _srvBusy = false; }
  }
  function startServerConfigSync() {
    if (!serverSyncAvailable()) { console.log("[User Status] 설정 서버 동기화 없음 (marinara.storage 미제공) — localStorage 만 사용"); return; }
    connectServerConfigSync();
    marinara.setInterval(() => { if (_srvReady) pullServerConfigChanges(); else connectServerConfigSync(); }, 30000);
    marinara.onCleanup(() => {
      if (_srvTimer) { marinara.clearTimeout(_srvTimer); _srvTimer = null; putServerConfigNow().catch(() => {}); }
    });
  }
  window.__usServerSync = () => ({ ready: _srvReady, updatedAt: _srvUpdatedAt, lastError: _srvLastError, available: serverSyncAvailable() });
  const WINDOW_CSS_PANEL_OVERRIDE_ID = "us-window-css-panel-override";
  let historyWindowCssOverride = null; // dynamicWindowCss 켜짐 시 기록 탭에서 선택된 statusId
  // 과거 메시지 포커스 판정 — renderFloat(값 템플릿)과 applyWindowCss(윈도우 CSS)가
  //  '반드시 같은 기준'을 쓰도록 공용화. (전에는 renderFloat 쪽에만 !isBusy 조건이 있어
  //  생성 도중 과거 메시지를 보면 CSS는 과거 스킨, 값 템플릿은 현재 스킨으로 어긋났다.)
  function pastFocusNow(chatId) {
    if (isInlineDisplayMode()) return false;
    const focused = focusedMsgByChat[chatId];
    const latest = latestVisibleAssistantMeta(chatId);
    return config.ui.historyHoverPreview !== false &&
      !!(focused && latest && latest.id && focused.id !== latest.id && !latestMessageVisible(chatId));
  }
  function applyWindowCss() {
    const chatId = getChatId();
    // 윈도우 CSS 기준 선택:
    //   dynamicWindowCss OFF → statusForChat (현재 활성 스킨 고정)
    //   dynamicWindowCss ON  → historyWindowCssOverride(기록 탭 스크롤 포커스) 또는 displayedStatus(채팅 스크롤)
    //
    // 이전에 dynamicWindowCss 와 무관하게 displayedStatus 를 쓰도록 바꿨으나, 그렇게 하면
    // dynamicWindowCss 가 꺼진 상태에서도 과거 메시지로 포커스될 때마다 #us-float 전체가 그 스킨으로 변하는
    // 부작용이 생긴다. 기록 미리보기 위젯은 applyWidgetWindowCss 로 처리하므로
    // 여기서는 항상 현재 활성 스킨(statusForChat)을 기본으로 한다.
    // historyWindowCssOverride: 기록 탭에서 항목을 클릭했을 때 drawPreview 가 설정.
    // dynamicWindowCss 와 무관하게 클릭 시 항상 해당 스킨으로 전환, 해제 시 복원.
    // historyWindowCssOverride: 기록 탭 "적용" 버튼 클릭 시에만 세팅 (preview 클릭은 세팅 안 함)
    let status = null;
    if (historyWindowCssOverride) {
      status = statusById(historyWindowCssOverride);
    } else if (config.ui.dynamicWindowCss) {
      // dynamicWindowCss ON 일 때만 과거 메시지 포커스 시 해당 스킨 CSS 로 전환.
      // OFF 이면 항상 현재 스킨 고정 — 과거 포커스마다 창 전체가 깜빡이는 부작용 방지.
      // 판정은 renderFloat 와 공용(pastFocusNow) — 두 경로의 기준이 달라 CSS/값이 어긋나던 문제 방지.
      status = isInlineDisplayMode()
        ? (displayedStatus(chatId) || statusForChat(chatId))
        : (pastFocusNow(chatId) ? (displayedStatus(chatId) || statusForChat(chatId)) : statusForChat(chatId));
    }
    if (!status) status = statusForChat(chatId);
    // 우선순위: 해당 상태창의 맞춤 CSS → (모드가 marinara 거나 맞춤인데 내용이 비었으면) 전역 디자인탭 CSS 로 폴백
    let finalCss = "";
    if (status && status.windowCssMode === "custom") {
      finalCss = sanitizeWindowCss(status.windowCss || "");
    }
    if (!finalCss) {
      // Global fallback (디자인 탭의 전역 윈도우 CSS, 또는 마이그레이션 이전 사용자)
      const globalMode = (config && config.ui && config.ui.windowCssMode) || "marinara";
      if (globalMode === "custom") {
        finalCss = sanitizeWindowCss((config && config.ui && typeof config.ui.windowCss === "string") ? config.ui.windowCss.trim() : "");
      }
    }
    let styleEl = document.getElementById(WINDOW_CSS_STYLE_ID);
    if (!finalCss) {
      document.documentElement.classList.remove("us-custom-css-active");
      if (styleEl) styleEl.remove();
      const ov = document.getElementById(WINDOW_CSS_PANEL_OVERRIDE_ID); if (ov) ov.remove();
      return;
    }
    // 맞춤 CSS가 일부 변수만 지정해도 나머지가 Marinara 라이트/다크 테마를 따라가지 않게
    // 확장 고정 팔레트를 활성화한다. 사용자 CSS는 뒤에 삽입되어 명시한 값만 정상적으로 덮는다.
    document.documentElement.classList.add("us-custom-css-active");
    let styleCreated = false;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = WINDOW_CSS_STYLE_ID;
      styleCreated = true;
    }
    // .us-hist-widget 은 기록별 상태창이 다를 수 있으므로 전역 applyWindowCss 로 일괄 적용하면 안 된다.
    // 각 위젯에 맞는 스킨 CSS 는 applyWidgetWindowCss()로 생성 시점에 고유 선택자로 범위화한다.
    const styleChanged = styleEl.textContent !== finalCss;
    if (styleChanged) styleEl.textContent = finalCss;
    // base 스타일(marinara.addStyle)과 윈도우 CSS 는 #us-float / .us-box 선택자 specificity 가 같아
    // source-order(나중에 삽입된 쪽)로 승부가 난다. 그래서 윈도우 CSS <style> 을 <head> 마지막에 둬야 한다.
    // 단, '새로 만들거나 내용이 바뀐 경우에만' 옮긴다 — dynamicWindowCss 로 매 렌더마다 옮기면
    // CSSOM 재삽입이 일어나 스크롤 중 이전 스킨이 1초쯤 깜빡이고 위치가 재조정되던 잔상의 원인이 된다.
    // !isLast: base 스타일이 비동기로 이 요소보다 뒤에 삽입됐을 때 재앵커링.
    // 이미 마지막이면 appendChild 를 건너뛰어 CSSOM thrash 방지.
    if (styleCreated || styleChanged || document.head.lastElementChild !== styleEl) document.head.appendChild(styleEl);
    // 패널 창에 windowCss 미적용 토글
    let panelOverrideEl = document.getElementById(WINDOW_CSS_PANEL_OVERRIDE_ID);
    if (config.ui && config.ui.applyWindowCssToPanels === false) {
      let ovCreated = false;
      if (!panelOverrideEl) {
        panelOverrideEl = document.createElement("style");
        panelOverrideEl.id = WINDOW_CSS_PANEL_OVERRIDE_ID;
        ovCreated = true;
      }
      // 단순히 .us-box 의 background/color/border 만 되돌리면 윈도우 CSS 가 설정한 --us-box-* 변수가 남아
      // 내부 요소(아이템 테두리·활성 테두리·토글·스위치 외곽선·버튼 호버 등)가 계속 맞춤 테마색을 따라갑니다.
      // 따라서 --us-box-* 변수 전체를 마리나라 기본값으로 !important 재정의해 패널을 완전히 되돌립니다.
      const ovCss = `.us-box{
  --us-box-bg:var(--card,#1c1c1c)!important;
  --us-box-fg:var(--card-foreground,#eee)!important;
  --us-box-border:var(--border,#333)!important;
  --us-box-muted:var(--muted-foreground,#999)!important;
  --us-box-input-bg:var(--input,#111)!important;
  --us-box-secondary:var(--secondary,#2a2a2a)!important;
  --us-box-accent:var(--accent,#333)!important;
  --us-box-primary:var(--primary,#6c8cff)!important;
  --us-box-primary-fg:var(--primary-foreground,#fff)!important;
  --us-box-switch-off:var(--border,#333)!important;
  --us-box-switch-on:var(--primary,#6c8cff)!important;
  --us-box-switch-thumb:#fff!important;
  background:var(--card,#1c1c1c)!important;color:var(--card-foreground,#eee)!important;
  border:1px solid var(--border,#333)!important;}`;
      const ovChanged = panelOverrideEl.textContent !== ovCss;
      if (ovChanged) panelOverrideEl.textContent = ovCss;
      // styleEl 보다 뒤(=우선)에 와야 패널이 마리나라로 되돌아간다. 생성/변경 시에만 옮겨 매 렌더 thrash 방지.
      if (ovCreated || ovChanged) document.head.appendChild(panelOverrideEl);
    } else {
      if (panelOverrideEl) panelOverrideEl.remove();
      // 패널 따라가기 ON: 윈도우 CSS가 #us-float 색만 지정했고 .us-box 변수는 안 줬을 수 있다.
      //   그러면 설정창 폰트색·토글·스크롤바·드롭다운이 마리나라 기본값으로 남는다.
      //   → #us-float 에 정의된 색 변수를 읽어 대응하는 --us-box-* 로 자동 복사(브리지).
      try { applyPanelBridgeFromFloat(finalCss); } catch (e) {}
    }
  }

  // #us-float 변수 → .us-box 변수 매핑 테이블 (의미가 대응되는 것끼리)
  const FLOAT_TO_BOX_VAR = {
    "--us-float-bg": "--us-box-bg",
    "--us-float-fg": "--us-box-fg",
    "--us-float-border": ["--us-box-border", "--us-box-switch-off"],
    "--us-float-muted": "--us-box-muted",
    "--us-float-secondary": ["--us-box-secondary", "--us-box-input-bg"],
    "--us-float-accent": "--us-box-accent",
    "--us-float-primary": ["--us-box-primary", "--us-box-switch-on"],
    "--us-float-primary-fg": ["--us-box-primary-fg", "--us-box-switch-thumb"],
  };
  const PANEL_BRIDGE_STYLE_ID = "us-panel-bridge-css";
  function applyPanelBridgeFromFloat(finalCss) {
    let bridgeEl = document.getElementById(PANEL_BRIDGE_STYLE_ID);
    const cssText = finalCss || "";
    // 설정창 색은 항상 플로팅 창(#us-float)에 완전히 맞춘다 — 프리셋이 .us-box 에 따로 정의한 값도 덮어써서
    // 설정창·편집기 창이 언제나 플로팅 창과 같은 색을 쓰도록 한다.
    // #us-float 의 실제 계산값을 읽는다 (윈도우 CSS 적용 후).
    const floatEl = document.getElementById(FLOAT_ID);
    let cs = null;
    if (floatEl) { try { cs = getComputedStyle(floatEl); } catch (e) {} }
    // 플로팅 창이 아직 없으면, 윈도우 CSS 텍스트에서 직접 #us-float 변수 선언을 파싱.
    const parsedFromCss = {};
    if (!cs) {
      const m = cssText.match(/#us-float\b[^{]*\{([^}]+)\}/);
      if (m) {
        const body = m[1];
        Object.keys(FLOAT_TO_BOX_VAR).forEach((fv) => {
          const vm = body.match(new RegExp(fv.replace(/[-]/g, "\\-") + "\\s*:\\s*([^;}]+)"));
          if (vm) parsedFromCss[fv] = vm[1].trim();
        });
      }
    }
    const decls = [];
    Object.keys(FLOAT_TO_BOX_VAR).forEach((floatVar) => {
      let val = "";
      if (cs) { val = (cs.getPropertyValue(floatVar) || "").trim(); }
      if (!val && parsedFromCss[floatVar]) val = parsedFromCss[floatVar];
      if (!val) return;
      const boxVars = FLOAT_TO_BOX_VAR[floatVar];
      (Array.isArray(boxVars) ? boxVars : [boxVars]).forEach((bv) => {
        // 프리셋 .us-box 까지 덮기 위해 !important 사용.
        decls.push(bv + ":" + val + " !important;");
      });
    });
    if (!decls.length) { if (bridgeEl) bridgeEl.remove(); return; }
    const bridgeCss = ".us-box{" + decls.join("") + "}";
    if (!bridgeEl) { bridgeEl = document.createElement("style"); bridgeEl.id = PANEL_BRIDGE_STYLE_ID; }
    if (bridgeEl.textContent !== bridgeCss) bridgeEl.textContent = bridgeCss;
    // 윈도우 CSS(styleEl) 보다 '뒤'에 와야 프리셋이 .us-box 에 준 값을 덮는다.
    document.head.appendChild(bridgeEl);
  }

  if (!config.seeded && config.statuses.length === 0) {
    for (const s of STARTERS) config.statuses.push(normalizeStatus({ ...clone(s), id: uid() }));
    config.activeId = config.statuses[0]?.id || null;
    config.seeded = true;
    saveConfig();
    _srvSeededThisLoad = true;
  }
  // 설명이 생기기 전에 받은 스타터에 설명을 한 번만 채운다 (이름이 그대로이고 설명이 빈 것만).
  //   한 번 채운 뒤에는 사용자가 지워도 다시 넣지 않는다.
  if (!config.starterDescFilled) {
    for (const w of config.statuses) {
      const s = STARTERS.find((x) => x.name === w.name);
      if (s && s.description && !(w.description || "").trim()) w.description = s.description;
    }
    config.starterDescFilled = true;
    saveConfig();
  }
  if (upgradeNeonTerminal()) saveConfig();
  startServerConfigSync();
  // applyWindowCss() 호출은 아래 상태 캐시 const(latestAsstByChat 등) 선언 이후로 이동했습니다.
  // dynamicWindowCss 가 켜진 채 새로고침하면 여기서 resolveDisplayEntry→currentRenderMeta→latestAsstByChat
  // 를 선언 전에 참조(TDZ ReferenceError)하여 스크립트 전체가 죽고 창이 통째로 사라지던 버그를 막기 위함입니다.

  // ── 채팅 모드 캐시 ──
  const chatModeCache = {};
  function getChatModeCached(chatId) { return chatId ? (chatModeCache[chatId] ?? null) : null; }
  const chatNameCache = {}; // chatId → 채팅방 이름 (기본 타이틀 fallback용)

  // ── 상태창 값 저장소(채팅 metadata) ──
  const valuesCache = {};   // chatId -> { statusId, byMsg }
  const valuesReady = {};   // chatId -> Promise (metadata 1회 hydrate)
  const valuesHydrated = {};   // chatId -> true (hydrate Promise가 resolve 완료됐는지 동기 추적)
  const skinSnapshotCache = {}; // chatId -> 서버 metadata에서 읽은 스킨 스냅샷
  const savePending = {};   // chatId -> debounce timer
  const branchHealDone = {};      // chatId -> true (이번 세션에서 브랜치 재매핑 시도 완료 — 재조회 방지)
  const branchHealInFlight = {};  // chatId -> true (재매핑 진행 중 — 중복 실행 방지)

  function loadStore(chatId) {
    return valuesCache[chatId] || { statusId: null, byMsg: {}, order: [] };
  }
  function saveStore(chatId, store) {
    if (!Array.isArray(store.order)) store.order = [];
    valuesCache[chatId] = store;
    clearTimeout(savePending[chatId]);
    savePending[chatId] = setTimeout(() => {
      const titleVal = (config.perChatTitle && config.perChatTitle[chatId]) || null;
      marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ [META_VALUES_KEY]: { statusId: store.statusId, byMsg: store.byMsg, order: store.order, ts: Date.now(), title: titleVal } }),
      }).catch(() => {});
    }, 600);
  }
  // 디바운스 없이 즉시 저장하고 완료를 기다릴 수 있는 버전 (가져오기/복원용).
  // saveStore 는 600ms 디바운스라, 저장이 나가기 전에 hydrate 가 돌면 값이 되돌아간다.
  function saveStoreNow(chatId, store) {
    if (!Array.isArray(store.order)) store.order = [];
    valuesCache[chatId] = store;
    clearTimeout(savePending[chatId]);
    delete savePending[chatId];
    const titleVal = (config.perChatTitle && config.perChatTitle[chatId]) || null;
    return marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ [META_VALUES_KEY]: { statusId: store.statusId, byMsg: store.byMsg, order: store.order, ts: Date.now(), title: titleVal } }),
    });
  }
  // 제목만 메타데이터에 별도 저장 (값 변경 없이 제목만 바뀔 때)
  function saveTitleToMeta(chatId, title) {
    if (!chatId) return;
    const store = loadStore(chatId);
    marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ [META_VALUES_KEY]: { statusId: store.statusId, byMsg: store.byMsg, order: store.order || [], ts: Date.now(), title: title || null } }),
    }).catch(() => {});
  }
  const ownershipChecked = {};   // chatId -> true (채팅당 1회만 검사)
  // 이 채팅의 기록이 정말 이 채팅 것인지 확인하고, 아니면 서버에서 우리 키를 제거한다.
  //  자동 삭제는 '오판 여지가 없는' 경우로만 한정한다:
  //    · 메시지가 0개인데 기록이 있다  → 복사돼 온 것이 확실 (새 방은 기록이 생길 수 없다)
  //    · 메시지는 있는데 저장된 msgId 가 단 하나도 이 방에 없다 → 남의 방 기록
  //  일부만 어긋나는 경우(메시지 일부 삭제 등)는 건드리지 않는다.
  async function verifyStoreOwnership(chatId) {
    if (!chatId || ownershipChecked[chatId]) return;
    const store = valuesCache[chatId];
    if (!store || !store.byMsg) return;
    const ids = Object.keys(store.byMsg).filter((k) => k.indexOf("__") !== 0);
    if (!ids.length) return;
    delete _importMsgIdSetCache[chatId];
    const set = await chatMsgIdSet(chatId);
    if (!set) return;                       // 메시지 조회 실패 → 판단 보류 (검사 표시도 남기지 않음)
    ownershipChecked[chatId] = true;
    const hit = ids.reduce((a, id) => a + (set.has(id) ? 1 : 0), 0);
    if (hit > 0) return;                    // 하나라도 맞으면 이 방 기록으로 인정
    const why = set.size === 0
      ? `메시지가 0개인 채팅에 기록 ${ids.length}개`
      : `메시지 ${set.size}개 중 일치하는 기록이 0개 (저장된 기록 ${ids.length}개)`;
    try { console.log(`[User Status] 복사돼 온 기록으로 판단해 제거: ${chatId} — ${why}`); } catch (_) {}
    clearTimeout(savePending[chatId]); delete savePending[chatId];
    valuesCache[chatId] = { statusId: null, byMsg: {}, order: [] };
    delete latestAsstByChat[chatId]; delete focusedMsgByChat[chatId];
    delete lastMsgCountByChat[chatId]; delete branchHealDone[chatId];
    try {
      await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/metadata`, {
        method: "PATCH", body: JSON.stringify({ [META_VALUES_KEY]: null }),
      });
    } catch (_) {}
    lastFloatSig = null; invalidateFloat();
  }
  const chatGroupOrderCache = {}; // chatId → chat.metadata.groupResponseOrder (상태창 주입 통로 선택용)
  async function hydrateChatValues(chatId, opts = {}) {
    const { migrateLocal = true, render = true } = opts;
    let chat = null;
    try { chat = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}`); } catch {}
    if (chat) {
      chatModeCache[chatId] = chat.mode || null;
      chatGroupOrderCache[chatId] = readGroupResponseOrder(chat);
      // 채팅방 이름을 캐시 — 사용자가 별도 제목을 설정하지 않은 경우 기본 타이틀로 사용
      if (typeof chat.name === "string" && chat.name.trim()) chatNameCache[chatId] = chat.name.trim();
    }
    let meta = chat && chat.metadata;
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = {}; } }
    const v = meta && meta[META_VALUES_KEY];
    if (v && v.byMsg && typeof v.byMsg === "object") {
      valuesCache[chatId] = { statusId: v.statusId || v.widgetId || null, byMsg: v.byMsg, order: Array.isArray(v.order) ? v.order : [] };
      // 메타데이터에 저장된 제목 복원 (로컬에 없을 때만)
      if (typeof v.title === "string" && v.title && !config.perChatTitle[chatId]) {
        config.perChatTitle[chatId] = v.title;
        saveConfig();
      }
    } else if (migrateLocal) {
      try {
        const old = JSON.parse(localStorage.getItem(VALUES_PREFIX + chatId) || "null");
        if (old && old.byMsg && typeof old.byMsg === "object") {
          valuesCache[chatId] = { statusId: old.statusId || old.widgetId || null, byMsg: old.byMsg, order: Array.isArray(old.order) ? old.order : [] };
          saveStore(chatId, valuesCache[chatId]);
          try { localStorage.removeItem(VALUES_PREFIX + chatId); } catch {}
        } else {
          valuesCache[chatId] = { statusId: null, byMsg: {}, order: [] };
        }
      } catch { valuesCache[chatId] = { statusId: null, byMsg: {}, order: [] }; }
    } else {
      valuesCache[chatId] = { statusId: null, byMsg: {}, order: [] };
    }
    // 채팅 metadata에는 '어떤 상태창을 쓰던 채팅인지'(ID)만 저장한다.
    //   로컬에 그 상태창이 있으면 자동으로 연결하고, 없으면 안내만 한다.
    //   (정의를 통째로 저장하면 스킨을 고칠 때마다 채팅 수만큼 낡은 사본이 남는다)
    const remoteSkin = meta && meta[META_SKIN_KEY];
    if (remoteSkin) {
      skinSnapshotCache[chatId] = remoteSkin;
      const res = importChatSkinSnapshot(chatId, remoteSkin, { force: false });
      if (res.missingId) missingSkinByChat[chatId] = res.missingId;
      else delete missingSkinByChat[chatId];
    } else {
      // 예전 채팅은 스냅샷 키가 없을 수 있다. 기록의 statusId가 로컬에 있으면 우선 연결하고,
      // 현재 적용 스킨 1개만 metadata에 심어 다음 기기부터 자동으로 읽히게 한다.
      const storedStatus = statusById(valuesCache[chatId] && valuesCache[chatId].statusId);
      if (storedStatus && !Object.prototype.hasOwnProperty.call(config.perChat, chatId)) {
        config.perChat[chatId] = storedStatus.id;
        saveConfig();
      }
      const localStatus = storedStatus || statusForChat(chatId);
      if (localStatus) saveChatSkinSnapshot(chatId, localStatus).catch(() => {});
    }
    valuesHydrated[chatId] = true;
    // 브랜치(분기)로 생성된 채팅이면: 복사돼 온 상태값의 '옛(원본) 메시지 ID' 키를
    //  이 브랜치의 새 메시지 ID로 재매핑해 브랜치별로 독립 관리되게 한다.
    //  (비동기·fire-and-forget. 대상 아니면 즉시 return, 실패해도 무시)
    if (chat) { maybeHealBranchValues(chatId, chat).catch(() => {}); }
    // 마리나라가 새 채팅을 만들 때 기존 채팅의 metadata 를 통째로 복사해 오는 경우가 있다.
    //  (우리 키뿐 아니라 gameJournal / archivedCharacterSnapshots 같은 남의 키까지 함께 딸려온다)
    //  그러면 이 방에 존재하지도 않는 메시지 ID 의 기록이 '삭제된 턴'으로 눌러앉는다.
    //  → 확실한 케이스만 자동으로 걷어낸다. 판단은 verifyStoreOwnership 참조.
    verifyStoreOwnership(chatId).catch(() => {});
    if (render) { invalidateFloat(); }
    return valuesCache[chatId];
  }
  // 브랜치 재매핑 전용: 공유 캐시(lastMsgListByChat/diag)를 건드리지 않는 순수 조회.
  async function fetchMsgsRawForHeal(chatId) {
    try { const list = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/messages?limit=2000`); return Array.isArray(list) ? list : null; }
    catch (_) { return null; }
  }
  // createdAt 오름차순(가장 오래된 것부터) 정렬된 메시지 ID 배열.
  //  브랜치는 원본의 '앞부분'을 순서·createdAt 그대로 복사하므로, 오름차순으로 맞추면
  //  source[i] ↔ branch[i] 가 정확히 대응한다.
  function orderedMsgIds(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((m, i) => ({ id: m && m.id, t: Date.parse((m && m.createdAt) || "") || 0, i }))
      .filter((x) => x.id)
      .sort((a, b) => (a.t - b.t) || (a.i - b.i))
      .map((x) => x.id);
  }
  // 브랜치로 복사돼 온 상태값(byMsg)의 키를 이 브랜치의 실제 메시지 ID로 재매핑한다.
  //  - 그룹(브랜치)에 속하지 않으면 대상 아님
  //  - 저장된 키가 이미 이 채팅 메시지와 겹치면(자기 데이터) 아무것도 안 함
  //  - 저장된 키(원본 메시지 ID)를 '모두 포함'하는 형제 채팅 = 원본으로 보고 위치기반 재매핑
  async function maybeHealBranchValues(chatId, chat) {
    try {
      if (!chatId || !chat) return;
      const groupId = chat.groupId || (chat.metadata && chat.metadata.groupId) || null;
      if (!groupId) return;                       // 브랜치 그룹이 아니면 대상 아님
      if (branchHealDone[chatId] || branchHealInFlight[chatId]) return;
      const cur = valuesCache[chatId];
      if (!cur || !cur.byMsg) { branchHealDone[chatId] = true; return; }
      const storedIds = Object.keys(cur.byMsg).filter((k) => k.indexOf("__") !== 0);
      if (!storedIds.length) { branchHealDone[chatId] = true; return; }  // 옮길 값 없음

      branchHealInFlight[chatId] = true;

      // 이 채팅(브랜치)의 메시지 순서(all-role) 확보
      const branchList = await fetchMsgsRawForHeal(chatId);
      const branchAllIds = orderedMsgIds(branchList);
      const branchIdSet = new Set(branchAllIds);

      // 저장 키가 이미 이 채팅 메시지와 겹치면(=이 채팅 자기 데이터) 재매핑 불필요
      const overlap = storedIds.filter((id) => branchIdSet.has(id));
      if (overlap.length) { branchHealDone[chatId] = true; branchHealInFlight[chatId] = false; return; }

      // 그룹 내 형제(원본 후보) 채팅 조회
      let siblings = [];
      try { siblings = await marinara.apiFetch(`/chats/group/${encodeURIComponent(groupId)}`); } catch (_) {}
      if (!Array.isArray(siblings)) siblings = [];

      // 저장된 키(원본 메시지 ID)를 '모두 포함'하는 형제 = 원본
      let source = null, sourceAllIds = null;
      for (const sib of siblings) {
        const sid = sib && sib.id;
        if (!sid || sid === chatId) continue;
        let sList = null;
        try { sList = await fetchMsgsRawForHeal(sid); } catch (_) {}
        const sIds = orderedMsgIds(sList);
        if (!sIds.length) continue;
        const sSet = new Set(sIds);
        if (storedIds.every((id) => sSet.has(id))) { source = sib; sourceAllIds = sIds; break; }
      }
      if (!source || !sourceAllIds) { branchHealDone[chatId] = true; branchHealInFlight[chatId] = false; return; }

      // 위치 기반 remap: sourceAllIds[i] → branchAllIds[i]
      const idxInSource = {};
      for (let i = 0; i < sourceAllIds.length; i++) idxInSource[sourceAllIds[i]] = i;

      const newByMsg = {};
      let mappedCount = 0;
      for (const k of Object.keys(cur.byMsg)) {
        if (k.indexOf("__") === 0) { newByMsg[k] = cur.byMsg[k]; continue; } // __latest__ 등 특수키 유지
        const i = idxInSource[k];
        if (i == null) continue;                 // 원본에 없는 키 → 버림
        const mapped = branchAllIds[i];
        if (!mapped) continue;                    // 분기점 이후(브랜치에 없는 메시지) → 버림
        newByMsg[mapped] = cur.byMsg[k];
        mappedCount++;
      }

      // order(시간순 assistant ID)도 같은 규칙으로 remap. 매핑 실패한 ID는 버린다.
      const prevOrder = Array.isArray(cur.order) ? cur.order : [];
      const newOrder = [];
      for (const k of prevOrder) {
        const i = idxInSource[k];
        if (i == null) continue;
        const mapped = branchAllIds[i];
        if (mapped) newOrder.push(mapped);
      }
      saveStore(chatId, { statusId: cur.statusId || null, byMsg: newByMsg, order: newOrder }); // 브랜치 메타에 영구 저장

      // 설정(로컬 config, chatId 키)도 원본→브랜치 복사 (브랜치에 값이 없을 때만)
      const srcId = source.id;
      let cfgChanged = false;
      if (config.perChat && Object.prototype.hasOwnProperty.call(config.perChat, srcId) && !Object.prototype.hasOwnProperty.call(config.perChat, chatId)) {
        config.perChat[chatId] = config.perChat[srcId]; cfgChanged = true;
      }
      if (config.perChatTitle && config.perChatTitle[srcId] && !config.perChatTitle[chatId]) {
        config.perChatTitle[chatId] = config.perChatTitle[srcId]; cfgChanged = true;
      }
      if (config.perChatSettings && config.perChatSettings[srcId] && !config.perChatSettings[chatId]) {
        config.perChatSettings[chatId] = { ...config.perChatSettings[srcId] }; cfgChanged = true;
      }
      if (config.ui && config.ui.sceneCollapsed && (srcId in config.ui.sceneCollapsed) && !(chatId in config.ui.sceneCollapsed)) {
        config.ui.sceneCollapsed[chatId] = config.ui.sceneCollapsed[srcId]; cfgChanged = true;
      }
      if (config.ui && config.ui.charCollapsed && (srcId in config.ui.charCollapsed) && !(chatId in config.ui.charCollapsed)) {
        config.ui.charCollapsed[chatId] = config.ui.charCollapsed[srcId]; cfgChanged = true;
      }
      if (config.ui && config.ui.inlineWindowCollapsed && (srcId in config.ui.inlineWindowCollapsed) && !(chatId in config.ui.inlineWindowCollapsed)) {
        config.ui.inlineWindowCollapsed[chatId] = config.ui.inlineWindowCollapsed[srcId]; cfgChanged = true;
      }
      if (cfgChanged) saveConfig();

      branchHealDone[chatId] = true;
      branchHealInFlight[chatId] = false;
      invalidateFloat();
      try { console.log(`[User Status] branch remap: ${mappedCount} entries → ${chatId} (source ${srcId})`); } catch (_) {}
    } catch (e) {
      branchHealInFlight[chatId] = false;
      branchHealDone[chatId] = true; // 오류 시 세션 내 재시도 안 함(반복 조회 방지)
      try { console.log("[User Status] branch remap skipped:", (e && e.message) || e); } catch (_) {}
    }
  }
  function ensureChatValues(chatId) {
    if (!chatId) return Promise.resolve();
    ensureCardRoster(chatId); // 카드 캐릭터 로스터도 함께 미리 조회(캐시) — 실패해도 값 로딩은 계속 진행
    if (valuesReady[chatId]) return valuesReady[chatId];
    valuesReady[chatId] = hydrateChatValues(chatId);
    return valuesReady[chatId];
  }

  // ── 설정(채팅별 독립) ──
  // 채팅별 설정 항목(perChatSettings[chatId])의 followDefault:
  //   true  → 이 채팅은 '공용'을 따른다. 켜짐/꺼짐(enabled)만 채팅 것을 쓴다.
  //   false → '해당 채팅 전용' 값을 쓴다.
  //   설정창의 범위 버튼을 마지막에 누른 쪽이 그대로 적용되게 하려고 둔다.
  //   (예전엔 켜기/끄기만 해도 전용 사본이 생겨 공용을 고쳐도 반영되지 않았고,
  //    '공용' 버튼은 편집 대상만 바꿔서 다시 열면 전용으로 돌아갔다)
  //   전용 값은 지우지 않고 남겨 두므로 다시 '전용'을 누르면 예전 전용 값이 돌아온다.
  function getSettings(chatId) {
    const own = chatId ? config.perChatSettings[chatId] : null;
    if (own && !own.followDefault) return own;
    const base = { ...DEFAULT_SETTINGS, ...config.settings };
    delete base.followDefault;
    if (own) base.enabled = own.enabled;
    else if (chatId && getChatModeCached(chatId) === "conversation") base.enabled = false;
    return base;
  }
  // 채팅별 항목을 만든다. 켜기/끄기처럼 '전용'을 고른 게 아닌 곳에서 부르므로 공용 따름으로 만든다.
  function ensureChatSettings(chatId) {
    if (!chatId) return config.settings;
    if (!config.perChatSettings[chatId]) {
      const seed = { ...DEFAULT_SETTINGS, ...config.settings, followDefault: true, neverCustom: true };
      if (getChatModeCached(chatId) === "conversation") seed.enabled = false;
      config.perChatSettings[chatId] = seed;
    }
    return config.perChatSettings[chatId];
  }
  function chatUsesOwnSettings(chatId) {
    const own = chatId ? config.perChatSettings[chatId] : null;
    return !!(own && !own.followDefault);
  }
  function S() { return getSettings(getChatId()); }

  // ── 상태창 선택 ──
  function statusForChat(chatId) {
    if (chatId && Object.prototype.hasOwnProperty.call(config.perChat, chatId)) {
      const id = config.perChat[chatId];
      if (id === null) return null;
      const w = statusById(id);
      if (w) return w;
    }
    if (!config.activeId) return null;
    return statusById(config.activeId);
  }
  function statusById(id) {
    if (!id) return null;
    return config.statuses.find((x) => x.id === id) || null;
  }
  // 스냅샷에서 '스킨 ID'만 읽는다. 예전 버전은 스킨 정의를 통째로 넣어 두었으므로
  //   그 형식도 읽을 수 있게 두되(하위호환), 정의 자체는 더 이상 쓰지 않는다.
  function skinIdFromSnapshot(raw) {
    if (!raw || typeof raw !== "object") return null;
    const direct = typeof raw.statusId === "string" ? raw.statusId.trim() : "";
    if (direct) return direct;
    const legacy = raw.status || raw.widget || raw.skin;
    const id = legacy && typeof legacy.id === "string" ? legacy.id.trim() : "";
    return id || null;
  }
  // 채팅에 저장된 스킨 ID를 로컬 라이브러리와 맞춰 본다.
  //   스킨 정의는 저장하지 않으므로, 로컬에 그 ID가 없으면 '없음'으로만 알린다.
  //   (스킨 파일 관리는 사용자 몫 — 채팅마다 CSS 사본을 박제하면 스킨을 고칠 때마다
  //    채팅 수만큼 낡은 사본이 남고, 값 저장 때마다 그 덩어리가 함께 실린다)
  function importChatSkinSnapshot(chatId, raw, { force = false } = {}) {
    if (!chatId) return { found: false, changed: false, missingId: null };
    const incomingId = skinIdFromSnapshot(raw);
    if (!incomingId) return { found: false, changed: false, missingId: null };
    const local = statusById(incomingId);
    if (!local) return { found: false, changed: false, missingId: incomingId };
    let changed = false;
    if (force || !Object.prototype.hasOwnProperty.call(config.perChat, chatId)) {
      if (config.perChat[chatId] !== incomingId) {
        config.perChat[chatId] = incomingId;
        changed = true;
      }
    }
    if (changed) saveConfig();
    return { found: true, changed, missingId: null, status: local };
  }
  async function saveChatSkinSnapshot(chatId, status) {
    if (!chatId || !status) return false;
    const clean = shareableStatus(status);
    if (!clean) return false;
    const prev = skinSnapshotCache[chatId];
    if (prev && skinIdFromSnapshot(prev) === clean.id) return false;
    const snapshot = { version: 2, statusId: clean.id, ts: Date.now() };
    skinSnapshotCache[chatId] = snapshot;
    try {
      await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ [META_SKIN_KEY]: snapshot }),
      });
      return true;
    } catch (_) {
      if (skinSnapshotCache[chatId] === snapshot) delete skinSnapshotCache[chatId];
      return false;
    }
  }
  async function recognizeChatSkin(chatId) {
    if (!chatId) { alert("채팅 화면에서 열어주세요."); return; }
    let chat = null;
    try { chat = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}`); }
    catch (_) { alert("채팅의 스킨 정보를 읽지 못했습니다."); return; }
    let meta = chat && chat.metadata;
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
    const raw = meta && meta[META_SKIN_KEY];
    if (!raw) {
      const current = statusForChat(chatId) || displayedStatus(chatId);
      if (!current) { alert("이 채팅에서 인식하거나 등록할 상태창 스킨이 없습니다."); return; }
      const saved = await saveChatSkinSnapshot(chatId, current);
      alert(saved ? "현재 상태창을 이 채팅에 등록했습니다. 다른 기기에서 같은 상태창을 갖고 있으면 채팅을 열 때 자동으로 연결됩니다." : "이미 같은 상태창이 이 채팅에 등록되어 있습니다.");
      return;
    }
    const incomingId = skinIdFromSnapshot(raw);
    if (!incomingId) { alert("채팅에 저장된 상태창 정보를 인식하지 못했습니다."); return; }
    const result = importChatSkinSnapshot(chatId, raw, { force: true });
    skinSnapshotCache[chatId] = raw;
    if (!result.found) {
      // 스킨 정의는 채팅에 저장하지 않는다 — 로컬에 없으면 어떤 걸 넣어야 하는지만 알려준다.
      alert(`이 채팅이 쓰던 상태창이 이 기기에 없습니다.\n\nID: ${incomingId}\n\n해당 상태창 JSON 파일을 '상태창 가져오기'로 넣으면 자동으로 연결됩니다.`);
      return;
    }
    invalidateFloat(); applyWindowCss();
    const list = document.querySelector("#us-wlist"); if (list) renderStatusList(list);
    alert(`채팅 상태창 \"${result.status.name}\"을(를) 인식해 적용했습니다.`);
  }
  function getChatId() {
    try { return localStorage.getItem(ACTIVE_CHAT_KEY) || fetchDetectedChatId || null; }
    catch { return fetchDetectedChatId || null; }
  }

  const latestAsstByChat = {};
  const focusedMsgByChat = {};
  // 현재 턴의 캡처 결과. 다른 턴/스와이프의 실패 문구가 따라오지 않도록 대상까지 함께 기록한다.
  // { [chatId]: { status:"noformat"|"empty"|"error"|"aborted", msgId, swipe, ts } }
  const captureNoticeByChat = {};
  // generation-complete 직후 서버 메타를 다시 읽기 전까지 이전 턴/이전 스와이프를 현재 값처럼
  // 보여주지 않기 위한 즉시 표시 차단. 메시지 메타 동기화와 이번 턴의 파싱/캡처 판정이 끝나면 해제한다.
  // targetId: "__latest__" = 새 답변, 그 외 = 재생성 대상 메시지 ID.
  const pendingTurnDisplayByChat = {};
  // API 캡처에서 출력은 받았으나 상태창 형식으로 인식하지 못한 마지막 "원문"을 채팅별로 보관.
  // RAM 전용(휘발성): 페이지 리로드 시 사라지고, 다음 정상 인식 캡처 시 자동으로 비워진다.
  // 구조: { [chatId]: { text, msgId, swipe, ts } }
  const lastRawOutputByChat = {};
  // 채팅이 쓰던 상태창 ID가 이 기기에 없을 때 그 ID를 기록 (안내용)
  const missingSkinByChat = {};
  // 출력이 중간에서 끊겨 '완결된 부분까지만' 복구 저장한 채팅 표시 (안내 문구용, 1회성)
  const salvagedNoticeByChat = {};
  const assistantIdsByChat = {};
  // 메시지의 "AI에게 숨김" 상태는 저장된 상태값과 분리한다.
  // 기록은 metadata에 그대로 보존하되, hiddenFromAI가 켜진 메시지는 인라인/플로팅 표시와
  // 다음 상태의 연속성 탐색에서 제외한다. v2.4의 캐릭터별 부분 숨김도 같은 규칙으로 본다.
  const hiddenMessageStateByChat = {}; // chatId → Map(msgId, { all, partial })
  const swipeByMsgByChat = {};
  const lastLatestSwipeByChat = {};
  // __latest__ placeholder 이전 신선도 가드용:
  //   seenLatestIdsByChat — 이 채팅에서 '최신'으로 확정됐던 메시지 ID 집합(목록 후퇴 감지)
  const seenLatestIdsByChat = {};
  const manualIds = {};

  function parseMessageExtra(messageOrExtra) {
    let extra = messageOrExtra && Object.prototype.hasOwnProperty.call(messageOrExtra, "extra")
      ? messageOrExtra.extra : messageOrExtra;
    if (typeof extra === "string") {
      try { extra = JSON.parse(extra); } catch (_) { extra = null; }
    }
    return extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  }
  function hiddenStateFromExtra(messageOrExtra) {
    const extra = parseMessageExtra(messageOrExtra);
    return {
      all: extra.hiddenFromAI === true,
      partial: Array.isArray(extra.hiddenFromAICharacterIds) && extra.hiddenFromAICharacterIds.length > 0,
    };
  }
  function syncHiddenMessageStates(chatId, list) {
    if (!chatId || !Array.isArray(list)) return;
    const map = hiddenMessageStateByChat[chatId] || (hiddenMessageStateByChat[chatId] = new Map());
    for (const message of list) {
      if (!message || !message.id) continue;
      const state = hiddenStateFromExtra(message);
      if (state.all || state.partial) map.set(message.id, state);
      else map.delete(message.id);
    }
  }
  function patchHiddenMessageState(chatId, msgId, patch) {
    if (!chatId || !msgId || !patch || typeof patch !== "object") return;
    const map = hiddenMessageStateByChat[chatId] || (hiddenMessageStateByChat[chatId] = new Map());
    const prev = map.get(msgId) || { all: false, partial: false };
    const next = {
      all: Object.prototype.hasOwnProperty.call(patch, "hiddenFromAI") ? patch.hiddenFromAI === true : prev.all,
      partial: Object.prototype.hasOwnProperty.call(patch, "hiddenFromAICharacterIds")
        ? (Array.isArray(patch.hiddenFromAICharacterIds) && patch.hiddenFromAICharacterIds.length > 0)
        : prev.partial,
    };
    if (next.all || next.partial) map.set(msgId, next);
    else map.delete(msgId);
    // 이미 받아 둔 메시지 캐시도 맞춰 두어 다음 부분 PATCH가 기존 값을 잃지 않게 한다.
    const cached = typeof lastMsgListByChat !== "undefined" && lastMsgListByChat[chatId];
    const message = Array.isArray(cached) ? cached.find((m) => m && m.id === msgId) : null;
    if (message) message.extra = { ...parseMessageExtra(message), ...patch };
    if (focusedMsgByChat[chatId] && isStatusMessageHidden(chatId, focusedMsgByChat[chatId].id)) {
      delete focusedMsgByChat[chatId];
    }
    invalidateFloat();
  }
  function isStatusMessageHidden(chatId, msgId) {
    if (!chatId || !msgId) return false;
    const state = hiddenMessageStateByChat[chatId] && hiddenMessageStateByChat[chatId].get(msgId);
    return !!(state && (state.all || state.partial));
  }
  function latestVisibleAssistantMeta(chatId) {
    const latest = latestAsstByChat[chatId];
    if (latest && latest.id && !isStatusMessageHidden(chatId, latest.id)) return latest;
    const list = lastMsgListByChat[chatId];
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const message = list[i];
      if (message && message.role === "assistant" && message.id && !isStatusMessageHidden(chatId, message.id)) {
        return { id: message.id, swipe: message.activeSwipeIndex || 0 };
      }
    }
    return null;
  }

  function setCaptureNotice(chatId, status, msgId, swipe) {
    if (!chatId) return;
    if (!status) { delete captureNoticeByChat[chatId]; return; }
    captureNoticeByChat[chatId] = {
      status,
      msgId: msgId || "__latest__",
      swipe: Number.isFinite(swipe) ? swipe : 0,
      ts: Date.now(),
    };
  }
  function captureNoticeForMeta(chatId, meta) {
    const n = captureNoticeByChat[chatId];
    if (!n || !meta) return null;
    if (n.msgId !== (meta.id || "__latest__")) return null;
    return n.swipe === (Number.isFinite(meta.swipe) ? meta.swipe : 0) ? n : null;
  }
  function markPendingTurnDisplay(chatId, targetId) {
    if (!chatId) return;
    pendingTurnDisplayByChat[chatId] = { targetId: targetId || "__latest__", ts: Date.now() };
  }
  function clearPendingTurnDisplay(chatId) {
    if (chatId) delete pendingTurnDisplayByChat[chatId];
  }
  function isPendingTurnDisplay(chatId, meta) {
    const p = pendingTurnDisplayByChat[chatId];
    if (!p || !meta) return false;
    if (p.targetId === "__latest__") return meta.source === "latest";
    return meta.id === p.targetId;
  }

  // 초기 윈도우 CSS 적용은 IIFE 끝(아래 marinara.addStyle base 스타일 삽입 이후 + 첫 renderFloat 직전)에서 한다.
  // base 스타일보다 먼저 적용하면 같은 specificity 라 base 에 덮여서 스킨이 안 먹는다(아래 init 구간 참고).

  function normalizeMsgEntry(entry, fallbackStatusId) {
    if (Array.isArray(entry)) return { statusId: fallbackStatusId || null, scene: null, subjects: entry };
    if (!entry || typeof entry !== "object") return { statusId: fallbackStatusId || null, scene: null, subjects: [] };
    const subjects = Array.isArray(entry.subjects) ? entry.subjects : [];
    const scene = entry.scene && typeof entry.scene === "object" ? entry.scene : null;
    return { statusId: entry.statusId || entry.widgetId || fallbackStatusId || null, scene, subjects };
  }
  function stampStoreEntriesStatus(byMsg, statusId) {
    if (!statusId || !byMsg || typeof byMsg !== "object") return;
    for (const msgId of Object.keys(byMsg)) {
      const bySwipe = byMsg[msgId];
      if (!bySwipe || typeof bySwipe !== "object") continue;
      for (const key of Object.keys(bySwipe)) {
        bySwipe[key] = normalizeMsgEntry(bySwipe[key], statusId);
      }
    }
  }
  function getMsgEntry(chatId, msgId, swipe) {
    const store = loadStore(chatId);
    const m = store.byMsg[msgId];
    if (!m || typeof m !== "object") return null;
    // 표시 시에는 현재 활성 스와이프의 기록만 사용한다. 다른 스와이프가 비어 있을 때
    // 0번 기록으로 폴백하면 사용자가 넘긴 답변에 과거 상태가 잘못 붙는다.
    const key = String(Number.isFinite(swipe) ? swipe : 0);
    const raw = Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
    if (raw == null) return null;
    return normalizeMsgEntry(raw, store.statusId || null);
  }
  function setMsgEntry(chatId, statusId, msgId, swipe, entry) {
    const store = loadStore(chatId);
    const prevStoreStatusId = store.statusId || null;
    if (prevStoreStatusId) stampStoreEntriesStatus(store.byMsg, prevStoreStatusId);
    const key = String(swipe);
    if (!store.byMsg[msgId] || typeof store.byMsg[msgId] !== "object") store.byMsg[msgId] = {};
    const next = normalizeMsgEntry(entry, statusId || prevStoreStatusId || null);
    const prev = store.byMsg[msgId][key] ? normalizeMsgEntry(store.byMsg[msgId][key], prevStoreStatusId) : null;
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return false;
    store.statusId = statusId || prevStoreStatusId || null;
    store.byMsg[msgId][key] = next; saveStore(chatId, store);
    const usedStatus = statusById(next.statusId || store.statusId);
    if (usedStatus) saveChatSkinSnapshot(chatId, usedStatus).catch(() => {});
    // 값이 실제로 바뀐 경우에만 여기 도달한다(위에서 동일하면 early return).
    //  tick(3초 주기)까지 기다리면 새 값이 화면에 늦게 뜨고 그동안 직전 값이 남아 보인다.
    //  저장 시점에 곧바로 한 번 다시 그려서 그 지연을 없앤다. (지금 보고 있는 채팅일 때만)
    if (chatId === getChatId()) { lastFloatSig = null; renderFloat(); }
    return true;
  }
  function setMsgValues(chatId, statusId, msgId, swipe, subjects) {
    const prev = getMsgEntry(chatId, msgId, swipe) || { scene: null, subjects: [] };
    return setMsgEntry(chatId, statusId, msgId, swipe, { scene: prev.scene, subjects });
  }
  function getMsgValues(chatId, msgId, swipe) {
    const entry = getMsgEntry(chatId, msgId, swipe);
    if (!entry) return null;
    const subs = entry.subjects;
    return Array.isArray(subs) && subs.length ? subs : null;
  }
  function setMsgScene(chatId, statusId, msgId, swipe, scene) {
    const prev = getMsgEntry(chatId, msgId, swipe) || { scene: null, subjects: [] };
    return setMsgEntry(chatId, statusId, msgId, swipe, { scene: scene && typeof scene === "object" ? scene : null, subjects: prev.subjects });
  }
  function getMsgScene(chatId, msgId, swipe) {
    const entry = getMsgEntry(chatId, msgId, swipe);
    return entry ? entry.scene : null;
  }
  // 특정 기록(턴·스와이프) 하나만 삭제. 해당 msgId 의 스와이프가 모두 사라지면 msgId 키도 정리.
  function deleteMsgEntry(chatId, msgId, swipe) {
    const store = loadStore(chatId);
    const m = store.byMsg[msgId];
    if (!m || typeof m !== "object") return false;
    const key = String(swipe);
    if (!Object.prototype.hasOwnProperty.call(m, key)) return false;
    delete m[key];
    if (!Object.keys(m).length) delete store.byMsg[msgId];
    saveStore(chatId, store);
    return true;
  }
  // ── 기록 보관 순서(store.order) & 선입선출 정리 ────────────────────────────
  //  기존 버그: pruneStore가 "이번에 fetch한 메시지 창(limit=historyDepth=50개 메시지)"에
  //  들어온 assistant ID만 남기고 나머지를 전부 지웠다. 50개 메시지 = assistant 약 25~28개 →
  //  실제로 기록이 28개 근처에서 잘려나갔다.
  //  이제는 fetch 창과 무관하게 store.order(지금까지 본 assistant ID 시간순)를 누적하고,
  //  recordLimit(기본 100, 0=무제한)을 넘을 때만 가장 오래된 것부터 삭제한다.

  // 새로 관측한 assistant ID 목록(항상 '최근 꼬리')을 기존 order에 병합.
  function mergeStoreOrder(store, tailIds) {
    const prev = Array.isArray(store.order) ? store.order : [];
    if (!Array.isArray(tailIds) || !tailIds.length) {
      if (!Array.isArray(store.order)) { store.order = []; return true; }
      return false;
    }
    const set = new Set(tailIds);
    const next = prev.filter((id) => !set.has(id)).concat(tailIds);
    if (next.length === prev.length && next.every((v, i) => v === prev[i])) return false;
    store.order = next;
    return true;
  }
  // order가 무한정 커지지 않도록 압축: 값이 남아 있는 ID + 최근 꼬리만 유지.
  function compactStoreOrder(store, limit) {
    const arr = Array.isArray(store.order) ? store.order : [];
    const keepTail = Math.max(STORE_ORDER_TAIL, (limit > 0 ? limit : 0) + 50);
    if (arr.length <= keepTail) return false;
    const tailStart = arr.length - keepTail;
    const next = arr.filter((id, i) => i >= tailStart || Object.prototype.hasOwnProperty.call(store.byMsg, id));
    if (next.length === arr.length) return false;
    store.order = next;
    return true;
  }
  // 기록 개수 제한 적용. limit <= 0 이면 전부 보관(삭제 없음).
  function pruneStore(chatId, orderedAsstIds, limit) {
    const store = loadStore(chatId);
    let changed = mergeStoreOrder(store, orderedAsstIds || []);
    const lim = (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) ? Math.floor(limit) : DEFAULT_RECORD_LIMIT;
    if (lim > 0) {
      const ids = Object.keys(store.byMsg).filter((k) => k.indexOf("__") !== 0);
      if (ids.length > lim) {
        const pos = {};
        (store.order || []).forEach((id, i) => { pos[id] = i; });
        // order를 모르는 ID(= 목록에서 사라진 아주 오래된 기록)는 가장 오래된 것으로 취급 → 먼저 제거
        ids.sort((a, b) => {
          const pa = pos[a] === undefined ? -1 : pos[a];
          const pb = pos[b] === undefined ? -1 : pos[b];
          return pa - pb;
        });
        const drop = ids.slice(0, ids.length - lim); // 선입선출: 오래된 것부터
        for (const id of drop) { delete store.byMsg[id]; changed = true; }
      }
    }
    if (compactStoreOrder(store, lim)) changed = true;
    if (changed) saveStore(chatId, store);
  }
  // 메시지 DOM 안의 스와이프 카운터(SwipeJumpControl)에서 현재 활성 스와이프(0-based)를 읽는다.
  // Marinara는 활성 스와이프를 메시지 노드의 data 속성으로 노출하지 않는다 — 이 카운터 input(value=활성+1)이
  // 유일한 DOM 소스. 스와이프가 1개뿐이면 컨트롤이 렌더되지 않으므로 null(→ 0으로 폴백)을 반환.
  function readActiveSwipeFromNode(node) {
    if (!node || !node.querySelector) return null;
    // ① 기본: 스와이프 점프 입력 (aria-label="Jump to swipe N")
    let inp = node.querySelector('input[type="number"][aria-label^="Jump to swipe"]');
    // ② 라벨 문구가 다른 버전 대비 — 스와이프 컨트롤 안의 숫자 입력이면 같은 의미
    if (!inp) inp = node.querySelector('.mari-message-swipes input[type="number"]');
    if (!inp) inp = node.querySelector('input[type="number"][aria-label*="swipe" i]');
    if (inp) {
      const v = Number.parseInt(inp.value, 10);
      if (Number.isFinite(v) && v >= 1) return v - 1;
    }
    // ③ 입력 없이 "3 / 7" 같은 표시만 있는 레이아웃
    const swipes = node.querySelector(".mari-message-swipes");
    if (swipes) {
      const m = (swipes.textContent || "").match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        const cur = Number.parseInt(m[1], 10);
        if (Number.isFinite(cur) && cur >= 1) return cur - 1;
      }
    }
    return null;
  }
  // 스와이프 추적 상태 (선언은 checkChatSwitch 보다 앞에 있어야 한다 — TDZ 방지)
  let lastSwipeSig = null;
  let lastSwipeSyncTs = 0;
  // 메시지 DOM 노드 전수조회 캐시 (40ms TTL).
  // renderFloat → floatSignature → currentRenderMeta → resolveSwipeForMsg 경로에서 같은 스캔이
  // 한 프레임에 여러 번 일어나므로, 짧은 TTL로 중복 querySelectorAll 비용을 줄인다.
  let _msgNodesCache = null, _msgNodesTs = 0;
  function getMsgNodes() {
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (_msgNodesCache && (now - _msgNodesTs) < 40) return _msgNodesCache;
    _msgNodesCache = document.querySelectorAll("[data-message-id]");
    _msgNodesTs = now;
    return _msgNodesCache;
  }
  function resolveSwipeForMsg(chatId, msgId, fallback, node) {
    // node 미제공 시 msgId로 DOM 노드를 찾아 스와이프 카운터를 읽는다 → 저장/표시가 같은 소스를 보게 통일.
    let n = node;
    if (!n && msgId && msgId !== "__latest__") {
      const all = getMsgNodes();
      for (const el of all) { if (el.getAttribute("data-message-id") === msgId) { n = el; break; } }
    }
    const fromDom = readActiveSwipeFromNode(n);
    if (Number.isFinite(fromDom) && fromDom >= 0) return fromDom;
    const byMap = swipeByMsgByChat[chatId] && Number.parseInt(swipeByMsgByChat[chatId][msgId], 10);
    if (Number.isFinite(byMap) && byMap >= 0) return byMap;
    // 서버 메타(byMap)·DOM 모두 못 읽을 때만 fallback 사용.
    return Number.isFinite(fallback) ? fallback : 0;
  }
  // 어시스턴트 메시지의 턴 번호 (1-based). 기록 탭과 동일하게 "전체 메시지 목록에서 assistant를 만난 누적 수"로 센다.
  function computeTurn(chatId, msgId) {
    if (!msgId || msgId === "__latest__") return null;
    const tm = turnMapByChat[chatId];
    if (tm && tm.map && tm.map[msgId]) return tm.map[msgId];
    // 맵에 없으면: 마지막 목록이 '대화 전체'로 확인된 경우에만 직접 센다.
    //   잘린 꼬리를 세면 1부터 다시 시작해 잘못된 번호가 나오므로 그럴 땐 null(표시 생략).
    if (tm && tm.complete) {
      const list = lastMsgListByChat[chatId];
      if (Array.isArray(list)) {
        let turn = 0;
        for (const m of list) if (m && m.role === "assistant") { turn++; if (m.id === msgId) return turn; }
      }
    }
    return null;
  }
  function currentRenderMeta(chatId) {
    const actualLatest = latestAsstByChat[chatId];
    const latest = latestVisibleAssistantMeta(chatId)
      || (actualLatest && actualLatest.id ? { id: null, swipe: 0 } : { id: "__latest__", swipe: 0 });
    const focused = focusedMsgByChat[chatId];
    if (!isInlineDisplayMode() && focused && focused.id && !isStatusMessageHidden(chatId, focused.id) && (!latest.id || focused.id !== latest.id)) {
      return { id: focused.id, swipe: resolveSwipeForMsg(chatId, focused.id, focused.swipe || 0), source: "focus" };
    }
    if (!latest.id) return { id: null, swipe: 0, source: "hidden" };
    // 최신 메시지: 저장(captureApiInner)과 동일하게 resolveSwipeForMsg로 해석.
    // latest.swipe(서버 메타)만 쓰면, DOM 카운터가 먼저 갱신된 재생성 직후에
    // 저장된 스와이프와 표시 스와이프가 어긋나 값이 비어 보이는 문제가 생긴다.
    const mid = latest.id || "__latest__";
    return { id: mid, swipe: resolveSwipeForMsg(chatId, mid, latest.swipe || 0), source: "latest" };
  }
  function pickEntryForSwipe(entryMap, swipe, fallbackStatusId) {
    if (!entryMap || typeof entryMap !== "object") return null;
    const key = String(Number.isFinite(swipe) ? swipe : 0);
    const raw = entryMap[key] ?? entryMap["0"] ?? Object.values(entryMap)[0];
    return raw == null ? null : normalizeMsgEntry(raw, fallbackStatusId || null);
  }
  function fallbackEntrySameMessage(chatId, msgId, swipe) {
    const store = loadStore(chatId);
    const bySwipe = store.byMsg[msgId];
    if (!bySwipe || typeof bySwipe !== "object") return null;
    const keys = Object.keys(bySwipe).filter((k) => k !== String(swipe));
    if (!keys.length) return null;
    keys.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
    return pickEntryForSwipe(bySwipe, Number.parseInt(keys[0], 10), store.statusId || null);
  }
  function latestConservativeFallback(chatId, meta) {
    if (!meta || meta.source !== "latest") return null;
    // 직전 상태 임시 표시는 실제 채팅 답변 '생성 중'일 때만 허용한다.
    // 상태 캡처(dryRun) 중에도 이전 값을 보여주면 새 턴 값처럼 오인되므로 captureBusy는 제외한다.
    // 진행 중이 아닌데 최신 턴에 값이 없으면 → 진짜 값 없음(예: 확장 꺼진 채 생성된 턴, 백업이 최신 턴을 못 덮은 경우 등)
    //  → 빈 값 표시가 맞다. (예전엔 이 경우도 지난 기록을 대신 보여줬는데, 그러면 몇 턴이나 지난 옛 값이
    //   라벨 없이 계속 떠서 실시간 값처럼 보이는 게 더 큰 문제였다 — 빈 화면이 차라리 정직하다)
    if (!isGeneratingByChat[chatId]) return null;
    const store = loadStore(chatId);
    if (meta.id && store.byMsg[meta.id] && typeof store.byMsg[meta.id] === "object") return null;
    const placeholder = pickEntryForSwipe(store.byMsg["__latest__"], meta.swipe, store.statusId || null);
    if (placeholder) return placeholder;
    const ids = Object.keys(store.byMsg).filter((k) => k.indexOf("__") !== 0);
    // 현재 메시지 목록에 없는 고아 엔트리(삭제된 턴)는 유령 데이터로 표시되므로 건너뜀
    const validIds = assistantIdsByChat[chatId];
    for (let i = ids.length - 1; i >= 0; i--) {
      if (validIds && validIds.size > 0 && !validIds.has(ids[i])) continue;
      const entry = pickEntryForSwipe(store.byMsg[ids[i]], meta.swipe, store.statusId || null);
      if (entry && (entry.scene || entry.subjects.length)) return entry;
    }
    return null;
  }
  function migrateLatestPlaceholder(chatId, latestMsgId, latestSwipe) {
    if (!chatId || !latestMsgId) return false;
    const store = loadStore(chatId);
    const placeholder = store.byMsg && store.byMsg["__latest__"];
    if (!placeholder || typeof placeholder !== "object") return false;
    const key = String(Number.isFinite(latestSwipe) ? latestSwipe : 0);
    const existing = store.byMsg[latestMsgId] && typeof store.byMsg[latestMsgId] === "object" ? store.byMsg[latestMsgId][key] : null;
    if (existing != null) return false;
    const src = pickEntryForSwipe(placeholder, latestSwipe, store.statusId || null);
    if (src == null) return false;
    if (!store.byMsg[latestMsgId] || typeof store.byMsg[latestMsgId] !== "object") store.byMsg[latestMsgId] = {};
    store.byMsg[latestMsgId][key] = normalizeMsgEntry(src, store.statusId || null);
    delete store.byMsg["__latest__"];
    saveStore(chatId, store);
    return true;
  }
  function resolveDisplayEntry(chatId) {
    chatId = chatId || getChatId();
    if (!chatId) return null;
    const meta = currentRenderMeta(chatId);
    // 생성 완료를 받은 순간부터 새 메시지 메타가 확정될 때까지는 이전 값을 즉시 가린다.
    if (isPendingTurnDisplay(chatId, meta)) return null;
    let entry = getMsgEntry(chatId, meta.id, meta.swipe);
    if (entry) return entry;
    // 같은 메시지의 이전 스와이프 값은 실제 채팅 생성 중에만 임시 표시한다.
    // 완료 뒤 새 스와이프가 미인식된 경우에는 이전 스와이프를 현재 값처럼 보여주지 않는다.
    if (isGeneratingByChat[chatId]) {
      entry = fallbackEntrySameMessage(chatId, meta.id, meta.swipe);
      if (entry && (entry.scene || entry.subjects.length)) return entry;
    }
    if (meta.source === "focus") return null;
    entry = latestConservativeFallback(chatId, meta);
    if (entry && (entry.scene || entry.subjects.length)) return entry;
    // latestAsstByChat 에 이미 값이 잡혀 있다 = 이 채팅의 '진짜 최신 턴'이 확정됐다는 뜻.
    //  그런데 그 턴에 캡처된 값이 없다 → 몇 턴 전 옛 값을 라벨 없이 계속 보여주면 실시간처럼 오인되므로
    //  여기서 빈 값으로 확정한다. (아래 store 순회 폴백은 '아직 최신 턴이 뭔지도 모르는' 초기 로드 구간 전용)
    if (chatId in latestAsstByChat) return null;
    const store = loadStore(chatId);
    const ids = Object.keys(store.byMsg).filter((k) => k.indexOf("__") !== 0);
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = store.byMsg[ids[i]];
      if (!m || typeof m !== "object") continue;
      const any = m["0"] || Object.values(m)[0];
      entry = normalizeMsgEntry(any, store.statusId || null);
      if (entry.scene || entry.subjects.length) return entry;
    }
    return getMsgEntry(chatId, "__latest__", 0);
  }
  function statusForEntry(chatId, entry) {
    return statusById(entry && entry.statusId)
      || statusForChat(chatId)
      || statusById(loadStore(chatId).statusId)
      || null;
  }
  function displayedStatus(chatId) {
    return statusForEntry(chatId, resolveDisplayEntry(chatId));
  }
  function currentSubjects(chatId) {
    chatId = chatId || getChatId();
    if (!chatId) return null;
    const entry = resolveDisplayEntry(chatId);
    if (!entry || !entry.subjects.length) return null;
    // 캐릭터 카드에 배정된 캐릭터는 이번 장면에 없어도 기본적으로 항상 탭에 표시한다.
    // (카드 로스터는 비동기로 채워지므로, 아직 조회 전이면 이번엔 그냥 넘어가고 도착 시 invalidateFloat로 재반영됨)
    return dedupeSubs(dropDeleted(chatId, mergeCardRosterIntoSubs(entry.subjects, getCardRosterSync(chatId), chatId)));
  }
  function currentScene(chatId) {
    chatId = chatId || getChatId();
    if (!chatId) return null;
    const entry = resolveDisplayEntry(chatId);
    return entry ? entry.scene : null;
  }

  // ── 캐릭터 로스터 유지(이월) & 표시 숨김(눈 토글) 헬퍼 ──────────────────────
  // 라벨 정규화: 눈에 같아 보이는 이름은 같은 캐릭터로 취급한다.
  //   공백·대소문자만 보던 예전 판정으로는 아래가 전부 '다른 캐릭터'라 탭이 중복 생성됐다.
  //     · 폭 없는 문자(U+200B~200D, U+2060, BOM) — \s 에 걸리지 않아 육안으로 구분 불가
  //     · 마크다운 장식(**이름**, _이름_, `이름`)
  //     · 전각/반각 차이(ＡＢＣ vs ABC) → NFKC 로 흡수
  function normLabel(s) {
    let t = (s == null ? "" : String(s));
    try { t = t.normalize("NFKC"); } catch (_) {}
    return t
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }
  // 괄호 수식을 뗀 '본체 이름' 키. "루시안(부상)" → "루시안"
  //   AI 가 상태를 괄호로 덧붙이면 매 턴 새 캐릭터로 쌓이므로, 이월 때 본체로 한 번 더 비교한다.
  //   끝에 붙은 괄호는 연속으로 여러 개여도 모두 떼어낸다.
  function baseLabel(s) {
    let t = (s == null ? "" : String(s)).trim();
    let prev = null;
    while (t !== prev) {
      prev = t;
      t = t.replace(/[（(\[【][^（()）\[\]【】]*[）)\]】]\s*$/, "").trim();
    }
    return normLabel(t) || normLabel(s);
  }
  // 같은 라벨이 두 번 이상 들어 있으면 첫 항목만 남긴다 (라벨 없는 항목은 그대로 통과).
  function dedupeSubs(arr) {
    const seen = new Set();
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach((s) => {
      const k = normLabel(s && s.label);
      if (!k) { out.push(s); return; }
      if (seen.has(k)) return;
      seen.add(k); out.push(s);
    });
    return out;
  }

  // 이전 로스터(prevSubs)에 이번 출력(newSubs)을 병합한다.
  //   · 이번에 나온 캐릭터 → 새 값으로 갱신
  //   · 이번에 '안 나온' 캐릭터 → 이전 값 그대로 유지 (장면에 안 나온다고 삭제하지 않음)
  //   · 새로 등장한 캐릭터 → 뒤에 추가
  //   라벨이 없는 항목(단일 캐릭터 상태)은 이월 대상에서 제외하고 이번 출력을 그대로 쓴다.
  function mergeSubjectsCarryOver(prevSubs, newSubs) {
    const prev = Array.isArray(prevSubs) ? prevSubs : [];
    const next = Array.isArray(newSubs) ? newSubs : [];
    if (!next.length) return dedupeSubs(prev);   // 이번 메시지에 상태 블록이 없음 → 이전 로스터 전체 유지
    if (!prev.length) return dedupeSubs(next);
    const nextByLabel = new Map();
    // 본체 이름(괄호 제거) 색인. 같은 본체가 둘 이상이면(병사(A)/병사(B)) 진짜 별개 인물이므로
    //   본체 매칭을 적용하지 않는다 — 서로 다른 인물이 한 탭으로 합쳐지는 사고를 막는 안전장치.
    const nextByBase = new Map();
    const nextBaseCount = new Map();
    const prevBaseCount = new Map();
    next.forEach((s) => {
      const k = normLabel(s && s.label); if (!k) return;
      if (!nextByLabel.has(k)) nextByLabel.set(k, s);
      const b = baseLabel(s && s.label); if (!b) return;
      nextBaseCount.set(b, (nextBaseCount.get(b) || 0) + 1);
      if (!nextByBase.has(b)) nextByBase.set(b, s);
    });
    prev.forEach((p) => {
      const b = normLabel(p && p.label) ? baseLabel(p && p.label) : "";
      if (b) prevBaseCount.set(b, (prevBaseCount.get(b) || 0) + 1);
    });
    const out = [];
    const emitted = new Set();
    // 1) 이전 로스터 순서를 뼈대로: 이번에 나온 캐릭터는 갱신, 안 나온 캐릭터는 이전 값 유지
    prev.forEach((p) => {
      const k = normLabel(p && p.label);
      if (!k) return; // 라벨 없는 이전 항목은 건너뜀 (단일 캐릭터 케이스는 아래 next가 담당)
      if (emitted.has(k)) return;
      let pick = nextByLabel.get(k) || null;
      if (!pick) {
        // 정확히 같은 라벨이 없을 때만 본체 매칭: "루시안" 탭이 "루시안(부상)"으로 갱신된다(추가 아님).
        const b = baseLabel(p && p.label);
        if (b && nextBaseCount.get(b) === 1 && prevBaseCount.get(b) === 1) {
          const cand = nextByBase.get(b);
          const ck = cand ? normLabel(cand.label) : "";
          if (cand && ck && !emitted.has(ck)) { pick = cand; emitted.add(ck); }
        }
      }
      out.push(pick || p);
      emitted.add(k);
    });
    // 2) 이전에 없던 새 캐릭터(+라벨 없는 항목)를 순서대로 추가
    next.forEach((s) => {
      const k = normLabel(s && s.label);
      if (k) { if (!emitted.has(k)) { out.push(s); emitted.add(k); } }
      else { out.push(s); }
    });
    return out;
  }

  // target 메시지 '직전' 턴까지의 가장 최근 저장된 subjects(로스터)를 찾는다.
  // 새 메시지 캡처 시 이 로스터를 이월 기준으로 삼아 캐릭터 누락을 막는다.
  // statusId 를 받으면 '같은 상태창(스킨)으로 저장된 기록'을 먼저 훑고, 없을 때만 전체를 훑는다.
  //   예전엔 스킨 구분이 아예 없어서, 상태창을 바꾸면 직전 스킨에서 쓰던 캐릭터가 통째로
  //   새 탭 줄에 딸려 들어왔다 (resolvePromptEntry 는 이미 같은 규칙을 쓰고 있었다).
  function priorRosterSubjects(chatId, targetMsgId, statusId, targetSwipe) {
    if (!chatId) return null;
    const store = loadStore(chatId);
    if (!store || !store.byMsg) return null;
    const scan = (wantStatusId) => {
      const pickFrom = (id) => {
        const m = store.byMsg[id];
        if (!m || typeof m !== "object") return null;
        // 활성 스와이프 항목을 우선으로 읽는다 (예전엔 무조건 swipe 0 우선 → 재생성으로
        // 스와이프를 넘긴 메시지에서 옛 스와이프 0 값이 이월 뼈대로 쓰이던 문제).
        const activeSw = Number(resolveSwipeForMsg(chatId, id, 0));
        const e = pickEntryForStatus(m, activeSw, wantStatusId || null, store.statusId || null);
        return e && Array.isArray(e.subjects) && e.subjects.length ? e.subjects : null;
      };
      // 우선순위 0: 대상 메시지의 '같은 스와이프'에 이미 저장된 로스터.
      //  → 같은 스와이프를 다시 캡처(새로고침)할 때, 사용자가 바꾼 탭 순서·수동 편집이
      //    '직전 턴'의 옛 순서로 되돌아가던 문제를 막는다.
      //  ※ 여기서 다른 스와이프로 폴백하면 안 된다. 리롤로 만든 새 스와이프에 형제 스와이프(주로 0번)의
      //    캐릭터·값이 그대로 딸려와 "리롤을 돌렸는데 이전 기록이 남는" 증상이 된다.
      //    새 스와이프는 형제가 아니라 '이전 턴'을 이어받아야 한다 (아래 우선순위 1).
      const own = (() => {
        const m = store.byMsg[targetMsgId];
        if (!m || typeof m !== "object") return null;
        const sw = Number.isFinite(Number(targetSwipe))
          ? Number(targetSwipe)
          : Number(resolveSwipeForMsg(chatId, targetMsgId, 0));
        const key = String(Number.isFinite(sw) ? sw : 0);
        if (!Object.prototype.hasOwnProperty.call(m, key)) return null;
        const e = normalizeMsgEntry(m[key], store.statusId || null);
        if (wantStatusId && e.statusId !== wantStatusId) return null;
        return Array.isArray(e.subjects) && e.subjects.length ? e.subjects : null;
      })();
      if (own) return own;
      // 우선순위 1: 실제 메시지 목록 순서(시간순)에서 target 직전 어시스턴트 메시지들
      //   (창 밖의 옛 대상이면 목록에서 못 찾아 '전체 중 최근' = 대상보다 뒤 턴 로스터를 쓰던 문제 → assistantChrono)
      const orderedAsst = assistantChrono(chatId, targetMsgId);
      if (orderedAsst.length) {
        const ti = orderedAsst.indexOf(targetMsgId);
        const upto = ti >= 0 ? ti : orderedAsst.length; // target 못 찾으면 전체 중 최근
        for (let i = upto - 1; i >= 0; i--) { const subs = pickFrom(orderedAsst[i]); if (subs) return subs; }
      }
      // 폴백: 저장소의 실제 msgId 엔트리들 중 target 제외 가장 최근
      const ids = Object.keys(store.byMsg).filter((k) => k.indexOf("__") !== 0 && k !== targetMsgId);
      for (let i = ids.length - 1; i >= 0; i--) { const subs = pickFrom(ids[i]); if (subs) return subs; }
      return null;
    };
    return (statusId ? scan(statusId) : null) || scan(null);
  }

  // 표시 숨김(눈 토글): 데이터는 유지하되 플로팅 창 탭에서만 감춘다. 채팅별로 config에 보관.
  function getHiddenArr(chatId) {
    if (!chatId) return [];
    if (!config.perChatHidden || typeof config.perChatHidden !== "object") config.perChatHidden = {};
    const a = config.perChatHidden[chatId];
    return Array.isArray(a) ? a : [];
  }
  function getHiddenSet(chatId) { return new Set(getHiddenArr(chatId).map(normLabel)); }
  function isLabelHidden(chatId, label) { return getHiddenSet(chatId).has(normLabel(label)); }
  function setLabelHidden(chatId, label, hidden) {
    if (!chatId) return;
    if (!config.perChatHidden || typeof config.perChatHidden !== "object") config.perChatHidden = {};
    const key = normLabel(label);
    const cur = getHiddenSet(chatId);
    if (hidden) cur.add(key); else cur.delete(key);
    if (cur.size) config.perChatHidden[chatId] = Array.from(cur); else delete config.perChatHidden[chatId];
    saveConfig();
  }
  // 숨김 목록을 시그니처에 넣기 위한 안정 문자열
  function hiddenSig(chatId) { const a = getHiddenArr(chatId); return a.length ? a.slice().sort().join(",") : ""; }

  // ── 삭제 제외 목록: 사용자가 '이 캐릭터 삭제'로 지운 이름 ────────────────────
  //   캐릭터 카드 로스터 병합(mergeCardRosterIntoSubs)은 카드에 배정된 이름을 매 렌더마다
  //   빈 값으로 다시 끼워 넣는다. 그래서 카드가 있는 캐릭터는 지우고 저장해도 곧바로
  //   되살아나 "삭제가 안 되는" 것처럼 보였다. 지운 이름을 채팅별로 기록해 병합에서 뺀다.
  //   ＋로 같은 이름을 다시 추가하고 저장하면 자동으로 해제된다.
  function getDroppedArr(chatId) {
    if (!chatId) return [];
    if (!config.perChatDropped || typeof config.perChatDropped !== "object") config.perChatDropped = {};
    const a = config.perChatDropped[chatId];
    return Array.isArray(a) ? a : [];
  }
  function getDroppedSet(chatId) { return new Set(getDroppedArr(chatId).map(normLabel)); }
  function isLabelDropped(chatId, label) {
    const k = normLabel(label);
    return !!k && getDroppedSet(chatId).has(k);
  }
  function setLabelDropped(chatId, label, dropped) {
    if (!chatId) return;
    const key = normLabel(label);
    if (!key) return;
    if (!config.perChatDropped || typeof config.perChatDropped !== "object") config.perChatDropped = {};
    const cur = getDroppedSet(chatId);
    if (dropped) cur.add(key); else cur.delete(key);
    if (cur.size) config.perChatDropped[chatId] = Array.from(cur); else delete config.perChatDropped[chatId];
    saveConfig();
  }
  // 제외 목록에 있는 캐릭터를 로스터에서 걷어낸다 (표시·저장 양쪽 공용).
  function dropDeleted(chatId, subsArr) {
    const set = getDroppedSet(chatId);
    if (!set.size) return subsArr;
    return (Array.isArray(subsArr) ? subsArr : []).filter((s) => {
      const k = normLabel(s && s.label);
      return !(k && set.has(k));
    });
  }

  // ── 캐릭터 카드 로스터: 채팅에 배정된 캐릭터 카드는 기본적으로 항상 탭에 있어야 한다 ──
  //   GET /chats/:id 의 characterIds + GET /characters 로 이름을 가져와 캐시한다.
  //   (한 번 가져오면 재사용 — 매 캡처마다 API를 다시 부르지 않음. 채팅 전환/새로고침 시 재조회)
  const cardRosterByChat = {};        // chatId → string[] (카드 캐릭터 이름, {{user}} 제외)
  const cardDataByChat = {};          // chatId → [{name, description, personality}] (프롬프트 주입용)
  const cardRosterPromiseByChat = {}; // chatId → 진행 중인 fetch Promise (중복 요청 방지)
  // '숨긴 캐릭터 프롬프트 제외' 설정용: 숨긴 캐릭터의 카드를 뺀 나머지 카드 본문 블록을 만든다.
  //  서버 includeCharacters는 전체 카드를 통째로 넣는 옵션뿐이라(개별 제외 불가),
  //  includeCharacters를 끄고 여기서 만든 블록을 extensionBlocks로 직접 주입한다.
  async function buildCardBlocksExcludingHidden(chatId) {
    await ensureCardRoster(chatId); // cardDataByChat 채움 (캐시되어 있으면 즉시)
    const cards = cardDataByChat[chatId];
    if (!Array.isArray(cards) || !cards.length) return [];
    const out = [];
    for (const c of cards) {
      if (!c || !c.name || isLabelHidden(chatId, c.name)) continue;
      const parts = [];
      if (c.description) parts.push(c.description);
      if (c.personality) parts.push(`성격: ${c.personality}`);
      out.push({ role: "system", content: `[캐릭터 카드: ${c.name}]\n${parts.join("\n") || "(설명 없음)"}` });
    }
    return out;
  }
  const cardRosterEmptyTsByChat = {}; // chatId → 빈 로스터/실패를 받은 시각 (짧은 TTL 재시도용)
  async function ensureCardRoster(chatId, opts) {
    if (!chatId) return [];
    const cached = cardRosterByChat[chatId];
    // 비어 있지 않은 로스터만 확정 캐시로 인정한다.
    //  기존 버그: 빈 배열([])도 truthy 라 캐시 히트로 처리 → 채팅 진입 직후 요청이 한 번
    //  실패하거나 characterIds 가 아직 로드 전이면 빈 로스터가 '영구' 고착됐고,
    //  그 채팅에서는 페이지 새로고침 전까지 카드 캐릭터가 값/필수 출력 목록에서 계속 누락됐다.
    if (Array.isArray(cached) && cached.length) return cached;
    const force = !!(opts && opts.force);
    if (Array.isArray(cached) && !force) {
      // 빈 결과는 30초 TTL 로만 유지 — 일시 오류/로딩 타이밍이면 곧 재시도해 스스로 복구된다.
      const ts = cardRosterEmptyTsByChat[chatId] || 0;
      if (ts && Date.now() - ts < 30000) return cached;
    }
    if (cardRosterPromiseByChat[chatId]) return cardRosterPromiseByChat[chatId];
    const p = (async () => {
      try {
        const chatInfo = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}`);
        const rawIds = chatInfo && chatInfo.characterIds;
        const charIds = Array.isArray(rawIds)
          ? rawIds
          : (() => { try { return JSON.parse(rawIds || "[]"); } catch { return []; } })();
        if (!charIds.length) {
          cardRosterByChat[chatId] = [];
          cardRosterEmptyTsByChat[chatId] = Date.now();
          return [];
        }
        const allChars = await marinara.apiFetch("/characters");
        const cards = [];
        const names = (Array.isArray(allChars) ? allChars : [])
          .filter((c) => charIds.includes(c.id))
          .map((c) => {
            try {
              let d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
              if (d && d.data && typeof d.data === "object") d = d.data; // V2 카드 {spec, data:{...}} 대응
              if (d && d.name) cards.push({ name: d.name, description: d.description || "", personality: d.personality || "" });
              return (d && d.name) || null;
            }
            catch { return null; }
          })
          .filter(Boolean);
        cardRosterByChat[chatId] = names;
        if (names.length) {
          delete cardRosterEmptyTsByChat[chatId];
          cardDataByChat[chatId] = cards; // 프롬프트용 카드 본문 캐시 (숨김 캐릭터 제외 주입에 사용)
          invalidateFloat(); // 나중에 도착해도 화면에 즉시 반영
        } else {
          cardRosterEmptyTsByChat[chatId] = Date.now();
        }
        return names;
      } catch {
        // 실패 시: 기존 캐시가 있으면 보존(덮어쓰지 않음), TTL 만 기록해 잠시 후 재시도.
        if (!Array.isArray(cardRosterByChat[chatId])) cardRosterByChat[chatId] = [];
        cardRosterEmptyTsByChat[chatId] = Date.now();
        return cardRosterByChat[chatId];
      }
      finally { delete cardRosterPromiseByChat[chatId]; }
    })();
    cardRosterPromiseByChat[chatId] = p;
    return p;
  }
  function getCardRosterSync(chatId) { return (chatId && cardRosterByChat[chatId]) || []; }
  // 카드에 있는데 subs에 없는 캐릭터를 빈 값으로 채워 넣는다 (순서는 subs 우선, 새 카드 캐릭터는 뒤에 추가).
  function mergeCardRosterIntoSubs(subsArr, cardNames, chatId) {
    if (!Array.isArray(cardNames) || !cardNames.length) return subsArr;
    const list = Array.isArray(subsArr) ? subsArr.slice() : [];
    const have = new Set(list.map((s) => normLabel(s && s.label)));
    const dropped = chatId ? getDroppedSet(chatId) : null;
    cardNames.forEach((name) => {
      const k = normLabel(name);
      if (!k || have.has(k)) return;
      if (dropped && dropped.has(k)) return; // 사용자가 지운 캐릭터는 카드가 있어도 되살리지 않는다
      list.push({ label: name, values: {} }); have.add(k);
    });
    return list;
  }

  function pickEntryForStatus(entryMap, preferredSwipe, statusId, fallbackStatusId) {
    if (!entryMap || typeof entryMap !== "object") return null;
    const seen = new Set();
    const order = [];
    const push = (key) => {
      if (!Object.prototype.hasOwnProperty.call(entryMap, key) || seen.has(key)) return;
      seen.add(key);
      order.push(key);
    };
    if (Number.isFinite(preferredSwipe)) push(String(preferredSwipe));
    push("0");
    Object.keys(entryMap)
      .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))
      .forEach(push);
    for (const key of order) {
      const entry = normalizeMsgEntry(entryMap[key], fallbackStatusId || null);
      if (statusId && entry.statusId !== statusId) continue;
      if (entry.scene || entry.subjects.length) return entry;
    }
    return null;
  }
  // opts.includeAnchor: anchor 메시지 자신의 값까지 후보에 넣는다.
  //   캡처는 "N 의 직전 값" 이 필요하므로 N 을 제외한다(기본). 채팅 답변 생성 주입은
  //   "지금 화면의 값" 이 필요하므로 최신 메시지 N 을 포함해야 한다 — 제외하면 한 턴 뒤처진
  //   값이 프롬프트로 나간다.
  function resolvePromptEntry(chatId, statusId, anchorMsgId, opts) {
    const src = resolvePromptSource(chatId, statusId, anchorMsgId, opts);
    return src ? src.entry : null;
  }
  // 어시스턴트 메시지 ID 시간순 목록. anchor 가 들어 있는 목록을 고른다.
  //   assistantIdsByChat 는 최근 historyDepth(기본 50) 메시지 창뿐이라, 창 밖의 옛 턴을 기준으로
  //   '직전 값'을 찾으면 anchor 를 못 찾아 목록 전체(= 대상보다 '뒤' 턴 값까지)를 훑었다.
  //   → 전체 목록 캐시(fullAsstChronoByChat) → 저장소 순서(store.order) 순으로 anchor 를 찾는다.
  function assistantChrono(chatId, anchorId) {
    const idsSet = assistantIdsByChat[chatId];
    const recent = idsSet instanceof Set && idsSet.size ? Array.from(idsSet) : null;
    if (!anchorId || String(anchorId).indexOf("__") === 0) {
      if (recent) return recent;
    } else {
      if (recent && recent.indexOf(anchorId) >= 0) return recent;
      const full = fullAsstChronoByChat[chatId];
      if (Array.isArray(full) && full.indexOf(anchorId) >= 0) return full;
      const store = loadStore(chatId);
      const order = Array.isArray(store.order) ? store.order : [];
      if (order.indexOf(anchorId) >= 0) return order.slice();
      if (recent) return recent;
    }
    const store = loadStore(chatId);
    return Object.keys(store.byMsg).filter((k) => k.indexOf("__") !== 0);
  }
  // resolvePromptEntry 의 본체. 값과 함께 '그 값이 어느 메시지에서 왔는지'와
  //   anchor 사이에 기록 없이 건너뛴 어시스턴트 턴 수(skipped)를 돌려준다.
  //   skipped > 0 이면 넘겨주는 '직전 값'이 실제로는 몇 턴 전 값이라는 뜻이다.
  function resolvePromptSource(chatId, statusId, anchorMsgId, opts) {
    chatId = chatId || getChatId();
    if (!chatId || !statusId) return null;
    const store = loadStore(chatId);
    const visited = new Set();
    // 메시지 하나에서 항목 고르기: 같은 스킨(statusId) 항목을 우선하되, 그 메시지에 다른
    // 스킨으로 저장된 항목뿐이면 그거라도 쓴다 — '가장 가까운 턴'이 항상 이긴다.
    //   (스킨을 교체/재가져오기(id 재발급)한 채팅에서, statusId 필터가 직전 턴 기록을
    //    통째로 건너뛰고 훨씬 옛 값(또는 무값)으로 점프하던 문제의 수정.
    //    키가 안 맞는 필드는 buildCurrentStateText/buildChatContextText 가 현재 스킨의
    //    필드 키로 걸러내므로 다른 스킨 항목을 써도 오염되지 않는다)
    const tryMsg = (msgId, swipe) => {
      if (!msgId || visited.has(msgId)) return null;
      visited.add(msgId);
      const map = store.byMsg[msgId];
      const strict = pickEntryForStatus(map, swipe, statusId, store.statusId || null);
      if (strict) return strict;
      return pickEntryForStatus(map, swipe, null, store.statusId || null);
    };
    const meta = currentRenderMeta(chatId);
    const latest = latestAsstByChat[chatId];
    // 기준점(anchor) = "이 메시지의 직전 값을 찾아라" 의 그 메시지.
    //   캡처 시에는 캡처 대상 메시지를 명시적으로 넘겨받는다. 넘겨받지 못하면 화면 기준
    //   (currentRenderMeta = 포커스/스크롤된 메시지)으로 폴백.
    //   ※ 예전엔 항상 화면 기준이라, 사용자가 위로 스크롤해 과거 메시지를 보고 있으면
    //     '직전 값'을 그 과거 지점에서 찾아 훨씬 오래된 호감도·시간이 주입됐다.
    const anchorId = anchorMsgId || meta.id;
    // 프롬프트 주입용 "직전 값"은 현재 메시지(meta.id)의 상태가 아니라
    // 그 이전 턴(turn - 1)의 assistant 메시지 상태여야 한다.
    // swipe 0 으로 재생성해도 현재 메시지의 swipe 0 상태를 반환하면 안 되므로
    // meta.id 는 탐색에서 완전히 제외하고 그 앞 메시지부터 찾는다.
    // assistantIdsByChat 는 Set(DOM 삽입 순서 = 시간순) — Array.isArray 가 false 이므로
    // Array.from 으로 변환.
    const allChrono = assistantChrono(chatId, anchorId);
    const includeAnchor = !!(opts && opts.includeAnchor);
    const currentIdx = anchorId ? allChrono.indexOf(anchorId) : -1;
    const priorChrono = currentIdx >= 0
      ? allChrono.slice(0, includeAnchor ? currentIdx + 1 : currentIdx)
      : allChrono;
    let skipped = 0;
    for (const msgId of priorChrono.slice().reverse()) {
      if (isStatusMessageHidden(chatId, msgId)) continue;
      // 이전 턴은 그 메시지의 '활성 스와이프' 기준으로 읽는다.
      //   (예전엔 무조건 swipe 0 을 읽어서, 이전 턴을 재생성해 스와이프 1·2 를 쓰고 있으면
      //    옛 스와이프 0 의 캐릭터 값이 "직전 상태"로 프롬프트에 주입됐다 → AI 가 그 옛 값을
      //    이어받아 캐릭터를 안 바뀐 채로 출력. 장면은 대화 본문을 보고 쓰니 갱신됨 →
      //    '장면은 바뀌는데 캐릭터는 안 바뀜' 증상의 원인)
      const sw = latest && latest.id === msgId ? latest.swipe : resolveSwipeForMsg(chatId, msgId, 0);
      const entry = tryMsg(msgId, sw);
      if (entry) return { entry, msgId, skipped };
      skipped++;
    }
    const ph = pickEntryForStatus(store.byMsg["__latest__"], meta.swipe, statusId, store.statusId || null)
      || pickEntryForStatus(store.byMsg["__latest__"], meta.swipe, null, store.statusId || null);
    return ph ? { entry: ph, msgId: "__latest__", skipped: 0 } : null;
  }

  // 이 채팅에 저장된 상태값이 하나라도 있는지 (첫 캡처 판정)
  function hasAnyStoredValues(chatId) {
    const store = loadStore(chatId);
    if (!store || !store.byMsg) return false;
    for (const k of Object.keys(store.byMsg)) {
      const m = store.byMsg[k];
      if (m && typeof m === "object") {
        for (const sw of Object.keys(m)) {
          const e = m[sw];
          if (e && (e.scene || (Array.isArray(e.subjects) && e.subjects.length))) return true;
        }
      }
    }
    return false;
  }
  // 첫 상태창 생성 시 "풀 컨텍스트로 시작할까요?" 확인.
  // force=true(수동 새로고침): 저장값이 없으면 항상 묻는다.
  // force 미지정(자동 캡처): 저장값이 없고 이 세션에서 아직 안 물었을 때만 묻는다
  //   → 추출이 계속 실패해도 매 턴 팝업이 반복되지 않도록 세션당 1회로 제한.
  const firstCapturePromptedByChat = {};
  function maybeAskFirstCapture(chatId, opts) {
    opts = opts || {};
    // 고급 설정에서 '첫 생성 확인'이 꺼져 있으면 묻지 않고 false 반환 (토글 설정대로 진행)
    if (config.ui && config.ui.promptFirstCapture === false) return false;
    // 값 캐시가 아직 metadata에서 로드되지 않았으면(=hydrate 미완료) 첫 생성 여부를 판정할 수 없다.
    //   이 상태에서 hasAnyStoredValues는 빈 캐시를 보고 false를 반환해 "첫 생성"으로 오판한다.
    //   → 기록 탭에 값이 있어도(metadata에 저장됨) 확인창이 뜨는 버그. 준비 전엔 묻지 않고 보류한다.
    if (chatId && !valuesHydrated[chatId]) { ensureChatValues(chatId); return false; }
    if (hasAnyStoredValues(chatId)) return false;
    // 영구 기록: 이 채팅에서 한 번이라도 첫 생성 확인을 띄웠으면 다시 묻지 않는다.
    //   (메모리 전용 firstCapturePromptedByChat는 새로고침마다 초기화돼 매번 떴음 → config에 저장)
    const asked = config.ui && config.ui.firstCaptureAskedChats;
    if (chatId && asked && asked[chatId]) return false;
    if (!opts.force && firstCapturePromptedByChat[chatId]) return false;
    firstCapturePromptedByChat[chatId] = true;
    if (chatId && config.ui) {
      if (!config.ui.firstCaptureAskedChats || typeof config.ui.firstCaptureAskedChats !== "object") config.ui.firstCaptureAskedChats = {};
      config.ui.firstCaptureAskedChats[chatId] = true;
      saveConfig();
    }
    return confirm("이번이 첫 상태창 생성입니다.\n채팅 히스토리 · 로어북 · 캐릭터 카드 · 유저 페르소나를 모두 포함해서 시작할까요?\n\n확인: 전부 포함\n취소: 데이터 설정의 참조 토글대로");
  }
  // 이전 상태값 + 캐릭터 카드 로스터를 합쳐 AI에게 넘길 "등장 인물" 목록을 만든다.
  //   기존 버그: 이전 캡처값이 하나라도 있으면 카드 로스터를 아예 무시해서, 캡처된 적 없는
  //   카드 캐릭터는 이 목록에 영영 안 들어가 AI가 그 캐릭터를 계속 출력하지 않는 문제가 있었다.
  //   → 항상 '이전 라벨 ∪ 카드 로스터'로 합쳐서 넘긴다 (라벨 중복은 제거).
  async function resolveSubjectNames(chatId, status, anchorMsgId) {
    const prevEntry = resolvePromptEntry(chatId, status && status.id, anchorMsgId);
    const prevLabels = (prevEntry && Array.isArray(prevEntry.subjects))
      ? prevEntry.subjects.map((s) => s.label).filter(Boolean)
      : [];
    let cardNames = await ensureCardRoster(chatId);
    if (!cardNames.length) cardNames = await ensureCardRoster(chatId, { force: true }); // 빈 로스터면 즉시 1회 재조회 (일시 오류 복구)
    const seen = new Set();
    let merged = [];
    prevLabels.forEach((n) => { const k = normLabel(n); if (k && !seen.has(k)) { merged.push(n); seen.add(k); } });
    cardNames.forEach((n) => { const k = normLabel(n); if (k && !seen.has(k)) { merged.push(n); seen.add(k); } });
    // 삭제한 캐릭터는 AI 에게 "반드시 출력하라"고 시키지 않는다 — 안 그러면 다음 턴에 되살아난다.
    merged = merged.filter((n) => !isLabelDropped(chatId, n));
    // '숨긴 캐릭터 프롬프트 제외' ON: 눈으로 숨긴 캐릭터는 필수 출력 목록에서도 뺀다.
    //  (저장된 값은 그대로 유지 — 이월 로직이 기존 값을 보존한다)
    const filtered = getSettings(chatId).hiddenExcludeFromPrompt
      ? merged.filter((n) => !isLabelHidden(chatId, n))
      : merged;
    if (!filtered.length) return [USER_LABEL];
    filtered.push(USER_LABEL);
    diag.lastSubjectNames = filtered.slice(); // 진단: 프롬프트에 주입된 필수 인물 목록
    return filtered;
  }

  // ── 진단 ──
  const connNameCache = {};
  const diag = {
    injectOk: null, injectField: null, injectTs: 0, injectSkipped: null,
    fetchOkTs: 0, fetchErr: null, msgCount: 0,
    asstFound: null, blockFound: null, captureTs: 0, subjectCount: 0,
    apiTs: 0, apiErr: null, patchTs: 0, patchCount: 0, swipe: 0,
    lastOutChars: 0, lastInChars: 0, // 마지막 캡처 출력/입력(추정) 글자수
  };

  // ── 텍스트 안전화 ──
  const HTML_ENTITIES = [
    [/&/g, "&amp;"], [/</g, "&lt;"], [/>/g, "&gt;"],
    [/"/g, "&quot;"], [/'/g, "&#39;"],
  ];
  function esc(input) {
    let out = input == null ? "" : String(input);
    for (const [re, ent] of HTML_ENTITIES) out = out.replace(re, ent);
    return out;
  }
  function escAttr(input) { return esc(input).split("\n").join(" "); }

  function saveFile(name, body, mime) {
    const data = new Blob([body], { type: (mime || "text/plain") + ";charset=utf-8" });
    const href = URL.createObjectURL(data);
    const link = Object.assign(document.createElement("a"), { href, download: name });
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1500);
  }

  // ── 입력 주입 (inline 모드) ──
  let fetchDetectedChatId = null;
  // 가져오기/전체삭제/전체내보내기처럼 '여러 채팅을 훑는' 내부 작업 중에는 활성 채팅 감지를 멈춘다.
  // (안 그러면 스캔 대상 채팅이 활성 채팅으로 오인돼 다른 방 기록이 딸려 들어온다)
  let internalChatScanDepth = 0;
  async function withInternalChatScan(fn) {
    internalChatScanDepth++;
    try { return await fn(); } finally { internalChatScanDepth = Math.max(0, internalChatScanDepth - 1); }
  }
  const suppressPhaseByChat = {};
  // ── message_saved 조기 캡처 상태 ──
  //   엔진은 채팅 답변을 서버에 저장한 '뒤' 같은 SSE 스트림에서 에이전트 파이프라인을 돌리고,
  //   marinara:generation-complete 는 스트림이 전부 끝나야 발생한다. 그래서 완료 이벤트만
  //   기다리면 상태창 생성이 에이전트 전체 실행 시간만큼 늦어진다. message_saved 를 응답
  //   스트림에서 직접 감지해 캡처를 앞당기고, 여기 표식을 남겨 complete 의 중복 캡처를 막는다.
  //   { stale, msgId } — stale=true 면 같은 스트림에서 메시지가 추가 저장/재작성되어
  //   조기 캡처 결과가 낡았다는 뜻 → complete 시점에 정상 캡처를 다시 돈다.
  const earlyCaptureByChat = {};
  (function installFetchHook() {
    const prev = globalThis.fetch;
    if (prev && prev.__usWrapped) return;
    const wrapped = async function (url, opts) {
      let hiddenPatchInfo = null;
      let hiddenListChatId = null;
      let genWatchChatId = null;
      try {
        const target = typeof url === "string" ? url : (url && url.url) || "";
        // 활성 채팅 감지: 예전에는 최초 1회만 래치했는데(fetchDetectedChatId == null),
        // 그러면 새 방을 만들어도 페이지 로드 직후 본 첫 채팅에 계속 고정돼
        // 새 방에서 이전 방 기록이 보이고 캡처도 그쪽에 저장된다. 매번 갱신한다.
        if (!internalChatScanDepth) {
          const seg = target.split("/api/chats/")[1];
          if (seg) {
            const id = seg.split(/[/?#]/)[0];
            if (id && id.length >= 6 && id !== "group" && id !== "personas") fetchDetectedChatId = id;
          }
        }
        const method = (opts && opts.method ? opts.method : (url && url.method) || "GET").toUpperCase();
        // 메시지 눈 토글은 메시지 수/스와이프를 바꾸지 않으므로 기존 3초 동기화 조건으로는
        // 즉시 감지되지 않는다. 성공한 extra PATCH를 직접 추적해 인라인·플로팅을 바로 갱신한다.
        let path = "";
        try { path = new URL(target, window.location.origin).pathname; } catch (_) {}
        const extraMatch = path.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/extra\/?$/);
        const listMatch = path.match(/^\/api\/chats\/([^/]+)\/messages\/?$/);
        if (method === "PATCH" && extraMatch && opts && typeof opts.body === "string") {
          let patch = null;
          try { patch = JSON.parse(opts.body); } catch (_) {}
          if (patch && (Object.prototype.hasOwnProperty.call(patch, "hiddenFromAI") || Object.prototype.hasOwnProperty.call(patch, "hiddenFromAICharacterIds"))) {
            hiddenPatchInfo = { chatId: decodeURIComponent(extraMatch[1]), msgId: decodeURIComponent(extraMatch[2]), patch };
          }
        } else if (method === "GET" && listMatch) {
          hiddenListChatId = decodeURIComponent(listMatch[1]);
        }
        // 본편 채팅 생성(POST /api/generate)만 잡는다. 하위 경로(/raw, /dryRun, 앞으로 생길 것들)는
        //   다른 확장·기능의 통로이고 그 요청 스키마는 strict 라 모르는 키가 하나만 붙어도 400 이 난다.
        //   예전 정규식은 (?![A-Za-z]) 였던 탓에 "/api/generate/raw" 까지 잡아 Side B 생성을 깨뜨렸다.
        //   target 원문이 아니라 위에서 구한 path(pathname)로 비교한다 — 쿼리·절대 URL에 흔들리지 않는다.
        const looksLikeGenerate = method === "POST" && /^\/api\/generate\/?$/.test(path);
        if (looksLikeGenerate && opts && typeof opts.body === "string") {
          const st = S();
          let reqBody = null;
          try { reqBody = JSON.parse(opts.body); } catch (_) {}
          const impersonating = !!(reqBody && reqBody.impersonate === true);
          const reqChatId = (reqBody && typeof reqBody.chatId === "string" && reqBody.chatId) || getChatId();
          const blockedByImpersonate = impersonating && !st.allowImpersonate;
          // ── 에이전트 등 보조 생성 감지 ──
          //   마리나라의 에이전트 호출도 /api/generate 계열 POST 로 나가지만 채팅 답변이 아니다.
          //   이를 채팅 생성으로 오인하면 ①상태창 지시문이 에이전트 프롬프트에 주입되고(토큰 낭비)
          //   ②완료 시 자동 캡처(API 모드 dryRun = 토큰 소모)가 돌아간다. 감지되면 전부 건너뛴다.
          //   판정은 '확실한 신호'만 쓴다: URL 하위 경로(/api/generate/agent*, /api/agent*/)와
          //   명시적 isAgent 플래그. (v1.62~v1.64에서 썼던 agentId/agent/agentType 등 바디 필드
          //   추측은 일반 채팅 생성 바디에도 비슷한 필드가 있을 수 있어 정상 생성을 에이전트로
          //   오인 → 주입·자동 캡처가 통째로 건너뛰어지는 회귀를 만들 수 있으므로 제거.
          //   바디로만 구분되는 에이전트 호출은 아래 '메시지 무변화 백스톱'이 안전하게 걸러낸다)
          const isAgentGen = /\/api\/generate\/agents?(?![A-Za-z])/i.test(target)
            || /\/api\/agents?\//i.test(target)
            || !!(reqBody && reqBody.isAgent === true);
          // ── 미러링/다른 채팅 가드 ──
          //   현재 활성(롤플레잉) 채팅과 다른 chatId로 오는 generate 요청은
          //   미러링 확장 등 외부 도구가 보낸 것일 수 있다. 활성 채팅이 아니면
          //   상태창 캡처/첫 생성/주입을 일절 건드리지 않는다.
          const activeChatId = getChatId();
          const isForeignChat = !!reqChatId && !!activeChatId && reqChatId !== activeChatId;
          if (reqChatId && !isForeignChat) {
            if (blockedByImpersonate || isAgentGen) suppressPhaseByChat[reqChatId] = true;
            else delete suppressPhaseByChat[reqChatId];
            // 재생성 대상 메시지를 요청 바디에서 정확히 읽는다 (포커스/스크롤 추측 불필요).
            //   regenerateMessageId 있음 → 그 과거/특정 메시지에 저장
            //   없음(새 답변 생성)        → null = 최신 메시지
            if (!blockedByImpersonate && !isAgentGen) {
              const regenId = reqBody && typeof reqBody.regenerateMessageId === "string" && reqBody.regenerateMessageId
                ? reqBody.regenerateMessageId : null;
              genTargetByChat[reqChatId] = regenId;
              genTargetExplicit[reqChatId] = true; // mari-phase의 포커스 추측이 덮어쓰지 않도록 표시
              // 새 생성 결과에는 새 판정이 붙어야 하므로 이전 턴의 미인식/오류 표시는 즉시 비운다.
              setCaptureNotice(reqChatId, null);
              clearPendingTurnDisplay(reqChatId);
              // 스피너를 '생성 시작(요청 가로채기)'에서 켠다 — mari-phase가 불안정한 환경 대비.
              //   끄는 건 generation-complete/error(안정) → 켜기/끄기 신호를 모두 안정적으로 페어링.
              //   ※ invalidateFloat(전체 재렌더·DOM 순회)는 동기로 돌리면 생성 요청 전송이 그만큼
              //     늦어진다(체감 딜레이). 상태 플래그만 동기로 세우고 렌더는 다음 틱으로 미룬다.
              if (st.enabled && !isGeneratingByChat[reqChatId]) { isGeneratingByChat[reqChatId] = true; genStartTsByChat[reqChatId] = Date.now(); marinara.setTimeout(() => invalidateFloat(), 0); }
              // 에이전트 백스톱용 기준 스냅샷 — 감지 못한 보조 생성이 완료돼도, 채팅 메시지가
              //   실제로 안 바뀌었으면 자동 캡처(dryRun)를 건너뛸 수 있게 생성 직전 상태를 찍어둔다.
              if (st.enabled && (st.dataMode === DATA_MODES.api || st.dataMode === DATA_MODES.inline)) {
                void snapshotGenBaseline(reqChatId, regenId);
                // 응답 SSE에서 message_saved를 감시해 에이전트 완료를 기다리지 않고 캡처를 시작한다.
                genWatchChatId = reqChatId;
                delete earlyCaptureByChat[reqChatId];
              }
              // 첫 생성 confirm을 생성 시작(요청 가로채기) 시점에 띄운다.
              //  → mari-phase 이벤트가 없는 환경에서도 동작하고, 스피너 돌기 전이라 타이밍도 자연스럽다.
              //  여기서 받은 응답을 보관했다가 scheduleAutoCapture가 그대로 사용한다.
              if (st.enabled && st.dataMode === DATA_MODES.api && !(reqChatId in pendingForceFullByChat)) {
                pendingForceFullByChat[reqChatId] = maybeAskFirstCapture(reqChatId);
              }
            }
          }
          if (!isForeignChat && !isAgentGen && st.enabled && blockedByImpersonate && st.injectCurrentValues) {
            // 사칭 허용이 꺼져 있어도 상태창은 '읽게' 한다 — 그 스위치는 사칭 결과로 상태를 캡처할지(쓰기)만 정한다.
            //   인라인 모드여도 출력 블록 지시문은 빼고 현재 값만 싣는다 (사칭 답변 끝에 상태 블록이 붙지 않게).
            const status = statusForChat(reqChatId);
            if (status && ((status.fields && status.fields.length) || (status.sceneFields && status.sceneFields.length))) {
              const regenTargetImp = reqBody && typeof reqBody.regenerateMessageId === "string" && reqBody.regenerateMessageId
                ? reqBody.regenerateMessageId : null;
              const ctx = regenTargetImp
                ? buildChatContextText(reqChatId, status, regenTargetImp)
                : buildChatContextText(reqChatId, status, null, { includeAnchor: true });
              if (ctx) {
                const patched = injectStatusText(opts.body, ctx, reqBody, reqChatId);
                diag.injectTs = Date.now(); diag.injectSkipped = false;
                if (patched) { diag.injectOk = true; diag.injectField = patched.field; opts = { ...opts, body: patched.body }; }
              }
            }
          } else if (!isForeignChat && !isAgentGen && st.enabled && st.dataMode === DATA_MODES.inline && !blockedByImpersonate) {
            const status = statusForChat(getChatId());
            if (status && ((status.fields && status.fields.length) || (status.sceneFields && status.sceneFields.length))) {
              // 기준점: 재생성이면 그 메시지의 '직전' 값, 새 답변이면 '지금 화면의 최신' 값.
              //   예전엔 아무것도 안 넘겨서 resolvePromptEntry 가 최신 메시지를 탐색에서 제외했고,
              //   그 결과 새 턴 생성에 한 턴 뒤처진 값이 실려 나갔다.
              const regenTarget = genTargetByChat[reqChatId] || null;
              const patched = injectStatusText(
                opts.body,
                regenTarget
                  ? buildInjectionText(getChatId(), status, false, regenTarget)
                  : buildInjectionText(getChatId(), status, false, null, { includeAnchor: true }),
                reqBody, reqChatId);
              refreshGroupOrderCache(reqChatId); // 다음 생성용 (응답 순서를 바꿨을 수 있다)
              diag.injectTs = Date.now(); diag.injectSkipped = false;
              if (patched) { diag.injectOk = true; diag.injectField = patched.field; opts = { ...opts, body: patched.body }; }
              else diag.injectOk = false;
            }
          } else if (!isForeignChat && !isAgentGen && st.enabled && st.dataMode === DATA_MODES.api && !blockedByImpersonate && st.injectCurrentValues) {
            // API 모드: 현재 상태창 값을 채팅 답변 생성 시 컨텍스트로 주입 (dryRun 과 별개)
            const status = statusForChat(reqChatId);
            if (status && ((status.fields && status.fields.length) || (status.sceneFields && status.sceneFields.length))) {
              // 기준점: 재생성이면 그 메시지의 '직전' 값, 새 답변이면 '지금 화면의 최신' 값. (위 인라인과 동일)
              const regenTargetApi = genTargetByChat[reqChatId] || null;
              const ctx = regenTargetApi
                ? buildChatContextText(reqChatId, status, regenTargetApi)
                : buildChatContextText(reqChatId, status, null, { includeAnchor: true });
              if (ctx) {
                const patched = injectStatusText(opts.body, ctx, reqBody, reqChatId);
                refreshGroupOrderCache(reqChatId); // 다음 생성용 (응답 순서를 바꿨을 수 있다)
                diag.injectTs = Date.now(); diag.injectSkipped = false;
                if (patched) { diag.injectOk = true; diag.injectField = patched.field; opts = { ...opts, body: patched.body }; }
              }
            }
          } else if (blockedByImpersonate || isAgentGen) {
            diag.injectSkipped = true;
          }
        }
      } catch (_) {}
      const response = await prev.call(this, url, opts);
      try {
        if (response && response.ok && hiddenPatchInfo) {
          patchHiddenMessageState(hiddenPatchInfo.chatId, hiddenPatchInfo.msgId, hiddenPatchInfo.patch);
        }
        // 엔진이 스크롤/페이지 진입 중 받아 온 메시지 목록도 활용한다. 응답 clone만 읽으므로
        // 본체 스트림과 채팅 로딩을 막지 않고, 오래된 페이지의 눈 상태도 순차적으로 채워진다.
        if (response && response.ok && hiddenListChatId && typeof response.clone === "function") {
          response.clone().json().then((list) => {
            if (Array.isArray(list)) { syncHiddenMessageStates(hiddenListChatId, list); invalidateFloat(); }
          }).catch(() => {});
        }
        // 채팅 생성 응답이면 SSE를 clone으로 병렬 구독해 message_saved 조기 캡처를 건다.
        // 본체 스트림은 엔진이 그대로 소비하므로 채팅 렌더/타자 효과에는 영향이 없다.
        if (genWatchChatId && response && response.ok && typeof response.clone === "function") {
          const ct = String((response.headers && response.headers.get && response.headers.get("content-type")) || "");
          if (ct.indexOf("text/event-stream") !== -1) watchGenerateStream(response.clone(), genWatchChatId);
        }
      } catch (_) {}
      return response;
    };
    wrapped.__usWrapped = true;
    globalThis.fetch = wrapped;
    if (marinara.onCleanup) marinara.onCleanup(() => { if (globalThis.fetch === wrapped) globalThis.fetch = prev; });
  })();

  // resolveSubjectNames의 동기 버전 — 인라인 모드는 fetch 가로채기 안에서 동작해 await를 못 쓴다.
  // 카드 로스터는 채팅 진입 시 ensureChatValues → ensureCardRoster로 미리 캐시돼 있어야 하므로,
  // 여기서는 네트워크 호출 없이 캐시(getCardRosterSync)만 읽는다.
  function resolveSubjectNamesSync(chatId, status, anchorMsgId) {
    const prevEntry = resolvePromptEntry(chatId, status && status.id, anchorMsgId);
    const prevLabels = (prevEntry && Array.isArray(prevEntry.subjects))
      ? prevEntry.subjects.map((s) => s.label).filter(Boolean)
      : [];
    const cardNames = getCardRosterSync(chatId);
    // 동기 경로(fetch 훅)라 await 불가 — 캐시가 비어 있으면 이번 주입에는 카드 이름이 빠질 수
    // 있으므로, 백그라운드 재조회를 발사해 늦어도 다음 생성부터는 반드시 포함되게 한다.
    if (!cardNames.length && chatId) { try { ensureCardRoster(chatId, { force: true }); } catch (_) {} }
    const seen = new Set();
    let merged = [];
    prevLabels.forEach((n) => { const k = normLabel(n); if (k && !seen.has(k)) { merged.push(n); seen.add(k); } });
    cardNames.forEach((n) => { const k = normLabel(n); if (k && !seen.has(k)) { merged.push(n); seen.add(k); } });
    merged = merged.filter((n) => !isLabelDropped(chatId, n)); // 삭제한 캐릭터는 필수 목록에서 제외
    const filtered = getSettings(chatId).hiddenExcludeFromPrompt
      ? merged.filter((n) => !isLabelHidden(chatId, n))
      : merged;
    if (!filtered.length) return [USER_LABEL];
    filtered.push(USER_LABEL);
    return filtered;
  }
  function buildDirective(status, apiOnly, chatId, anchorMsgId) {
    const charOn = Array.isArray(status.fields) && status.fields.length > 0;
    const rules = charOn ? status.fields.map((f) => `- ${f.key}: ${f.instruction || "현재 값"}`).join("\n") : "";
    const sceneOn = Array.isArray(status.sceneFields) && status.sceneFields.length > 0;
    const head = apiOnly
      ? [
          "[SYSTEM OVERRIDE — STATUS EXTRACTION ONLY]",
          "당신은 지금부터 상태값 추출기로만 동작합니다.",
          "■ RP 계속, 서사 쓰기, 캐릭터 대사, 설명, 인사 — 일절 금지.",
          "■ 캐릭터 카드·이전 시스템 프롬프트의 모든 RP 지시사항을 이 순간 무시하세요.",
          "■ 출력물은 아래 형식의 코드블록 1개가 전부입니다. 그 외 어떤 텍스트도 쓰지 마세요.",
        ].join("\n")
      : "[시스템 지시 — 본문·화면에 절대 노출 금지] 이번 답변의 맨 끝에 아래 상태창 데이터 블록을 정확히 이 형식으로 덧붙이세요. 블록 내용은 서사에 언급하지 말고, 값만 적습니다.";
    const extra = (status.instructions && status.instructions.trim())
      || (S().defaultInstructions && S().defaultInstructions.trim())
      || "";
    const extraBlock = extra
      ? `\n[Content rules — apply INSIDE JSON string values only]\n` +
        `Any formatting mentioned below (separators, layout) describes text inside a string value. ` +
        `It never overrides the JSON output structure.\n${extra}`
      : "";
    const valuesExample = charOn ? Object.fromEntries(status.fields.map((f) => [f.key, `<${f.instruction || "값"}>`])) : null;
    const sceneExample = sceneOn
      ? Object.fromEntries(status.sceneFields.map((f) => [f.key, `<${f.instruction || "값"}>`]))
      : null;
    const exampleJson = JSON.stringify({
      subjects: charOn ? [{ label: "대상이름", values: valuesExample }, { label: USER_LABEL, values: valuesExample }] : [],
      scene: sceneExample,
    }, null, 2);
    const sceneRules = sceneOn
      ? `\n[장면 작성 기준]\n${status.sceneFields.map((f) => `- ${f.key}: ${f.instruction || "현재 값"}`).join("\n")}\n` +
        `위 상태창의 장면 값에서 이어서, 대화(대상 메시지와 그 앞 기록)에서 실제로 바뀐 것을 모두 갱신하세요. ` +
        `시각·날짜처럼 이어져야 하는 값은 직전 값을 기준으로 경과한 만큼만 진행시키고, 근거 없이 되돌리거나 건너뛰지 마세요.`
      : "";
    // 필수 등장 인물 목록: 이전에 캡처된 이름 + 캐릭터 카드에 배정된 이름을 합친 것.
    //   한 번도 출력된 적 없는 카드 캐릭터도 여기 포함되므로, 아래에서 "전원 필수"를 명시해야
    //   AI가 실제로 그 캐릭터까지 빠짐없이 STATUS 블록으로 출력한다.
    //   장면 전용 스킨(캐릭터 필드 없음)에서는 인물 목록 자체가 불필요 — 주입하지 않는다.
    const subjNames = (charOn && chatId) ? resolveSubjectNamesSync(chatId, status, anchorMsgId) : [];
    const subjBlock = subjNames.length
      ? `\n[필수 등장 인물 — 전원 빠짐없이 출력]\n${subjNames.join(", ")}\n` +
        `위 목록의 모든 대상에 대해 subjects 배열 항목을 하나씩 넣으세요. 이번 장면에 직접 등장하지 않는 대상도 예외 없이 포함하고, ` +
        `대화에 그 인물의 변화 근거가 전혀 없을 때만 마지막으로 알려진 상태(위치·행동 등)를 유지하고, 한 줄이라도 근거가 있으면 반드시 갱신하세요. 목록에 없는 대상을 임의로 추가하거나, 목록에 있는 대상을 생략하지 마세요.\n` +
        `label 은 위 목록의 표기를 글자 그대로 씁니다.\n` +
        `본문에 목록에 없는 이름·호칭이 나오면, 먼저 그것이 목록 인물을 가리키는 애칭·별명·호칭·직책·성/이름 일부인지 ` +
        `판단하세요. 판단 근거는 캐릭터 카드·로어북·대화 기록에 이미 들어 있습니다. 같은 인물이면 새 항목을 만들지 말고 ` +
        `목록 표기 그대로인 항목에 그 내용을 반영합니다. 목록의 누구와도 다른 인물임이 분명할 때만 새 항목을 추가하세요. ` +
        `괄호로 상태를 덧붙여(예: 이름(부상)) 항목을 따로 만드는 것도 금지합니다 — 같은 인물이 탭 두 개로 갈라집니다.`
      : "";
    const subjectHowTo = charOn
      ? `장면에 등장하는 각 캐릭터({{char}})와 사용자({{user}}) 각각을 subjects 배열 항목으로 넣고, ` +
        `사용자 항목의 label은 "${USER_LABEL}"(또는 사용자 페르소나 이름)로 합니다.\n`
      : `이 상태창은 장면(scene) 전용입니다. subjects는 항상 빈 배열([])로 두고, 캐릭터별 항목은 만들지 마세요.\n`;
    const charRulesBlock = rules
      ? `[작성 기준]\n${rules}\n` +
        `[판단 순서] ① 대상 메시지 본문 ② 그 앞 대화 기록(주어진 경우) ③ 위 상태창 값. ` +
        `상태창 값은 출발점일 뿐이며, 대화와 어긋나면 언제나 대화를 따릅니다.\n` +
        `인물마다 따로, 대화에서 그 인물이 한 말·행동·이동·감정 변화·입은 피해 등을 먼저 찾아 반영하세요. ` +
        `대상 메시지에 이름이 직접 나오지 않아도 대명사·호칭·앞 턴 대화로 드러난 변화는 반영합니다. ` +
        `대화 어디에도 변화 근거가 없는 값만 직전 값을 유지하고, ` +
        `수치는 직전 수치를 기준으로 사건에 따라 조금씩만 증감시키며(근거 없이 새 숫자를 만들지 말 것), ` +
        `직전 값을 알 수 없을 때만 새로 정하세요.`
      : "";
    return `${REQ.start}\n${head}\n` +
      subjectHowTo +
      `scene 필드가 있으면 객체, 없으면 null로 설정합니다.\n` +
      `형식 (us-status 코드블록 1개만 출력):\n\`\`\`us-status\n${exampleJson}\n\`\`\`\n` +
      `[Output format]\n` +
      `The block body MUST be valid JSON parseable by JSON.parse(). Quote all keys and string values with ".\n` +
      `Top level is an object with exactly two keys: "subjects" (array) and "scene". Add no other top-level keys.\n` +
      `Do NOT use YAML, "key: value" plain text, indentation-based nesting, markdown tables, HTML tags, or comments.\n` +
      `"us-status" is only a code-fence label, not a custom syntax — mirror the JSON structure shown above.\n` +
      `${charRulesBlock}${sceneRules}${subjBlock}${extraBlock}\n${REQ.end}`;
  }
  function buildCurrentStateText(chatId, status, anchorMsgId, opts) {
    const src = resolvePromptSource(chatId, status && status.id, anchorMsgId, opts);
    const entry = src ? src.entry : null;
    const subs = entry && entry.subjects.length ? entry.subjects : null;
    const sceneOn = Array.isArray(status.sceneFields) && status.sceneFields.length > 0;
    const scene = sceneOn && entry ? entry.scene : null;
    if ((!subs || !subs.length) && !scene) return "";

    const lines = (subs || []).map((s) => {
      const matched = status.fields.filter((f) => s.values[f.key] != null && s.values[f.key] !== "");
      if (!matched.length) return null;
      return (s.label ? `[${s.label}] ` : "") + matched.map((f) => `${f.key}: ${s.values[f.key]}`).join(", ");
    }).filter(Boolean);

    let sceneLine = "";
    if (scene) {
      const matchedScene = status.sceneFields.filter((f) => scene[f.key] != null && scene[f.key] !== "");
      if (matchedScene.length) {
        sceneLine = `[SCENE] ` + matchedScene.map((f) => `${f.key}: ${scene[f.key]}`).join(", ");
      }
    }

    const body = [sceneLine, ...lines].filter(Boolean).join("\n");
    if (!body) return "";
    // 사이 턴에 기록이 없으면 이 값은 '직전'이 아니다 — 그대로 이어 쓰면 몇 턴 전 상태로 되돌아간다.
    if (src && src.skipped > 0) {
      const t = computeTurn(chatId, src.msgId);
      return `[이전 상태창 — ${t ? `턴 ${t}의 ` : ""}기록이며, 그 뒤 ${src.skipped}턴은 기록이 없습니다]\n${body}\n`
        + `이 값은 ${src.skipped}턴 전 값입니다. 그 사이 대화에서 바뀐 위치·시간·행동·감정·수치를 먼저 모두 반영한 뒤 대상 메시지의 변화를 더하세요. 대화와 어긋나는 값은 버리고 대화를 따릅니다.`;
    }
    return `[현재 상태창 — 직전 값이며, 여기서 이어서 갱신하세요]\n${body}`;
  }
  // API 모드에서 채팅 답변 생성 시 현재 상태값을 컨텍스트로 주입 (상태값 갱신 지시 없이 참고용)
  function buildChatContextText(chatId, status, anchorMsgId, opts) {
    const entry = resolvePromptEntry(chatId, status && status.id, anchorMsgId, opts);
    const subs = entry && entry.subjects.length ? entry.subjects : null;
    const sceneOn = Array.isArray(status.sceneFields) && status.sceneFields.length > 0;
    const scene = sceneOn && entry ? entry.scene : null;
    if ((!subs || !subs.length) && !scene) return "";
    const lines = (subs || []).map((s) => {
      const matched = status.fields.filter((f) => s.values[f.key] != null && s.values[f.key] !== "");
      if (!matched.length) return null;
      return (s.label ? `[${s.label}] ` : "") + matched.map((f) => `${f.key}: ${s.values[f.key]}`).join(", ");
    }).filter(Boolean);
    let sceneLine = "";
    if (scene) {
      const matchedScene = status.sceneFields.filter((f) => scene[f.key] != null && scene[f.key] !== "");
      if (matchedScene.length) sceneLine = "[SCENE] " + matchedScene.map((f) => `${f.key}: ${scene[f.key]}`).join(", ");
    }
    const body = [sceneLine, ...lines].filter(Boolean).join("\n");
    if (!body) return "";
    // 지시문은 값 '뒤'에 둔다 — 모델이 가장 마지막에 읽은 지시를 우선하는 성향을 이용한다.
    //   장면 줄이 없는 스킨(캐릭터 전용)에서는 장면 문장을 넣지 않는다.
    const howTo = [
      sceneLine ? "[SCENE] 은 지금 장면의 상태입니다. 답변의 시각·장소·상황을 이 값에서 이어서 쓰고, 근거 없이 되돌리거나 건너뛰지 마세요." : "",
      lines.length
        ? "[이름] 줄은 그 인물의 현재 상태입니다. 이번 장면에 직접 나오지 않는 인물도 목록에 있으면 그 상태는 그대로 유효합니다 — "
          + "그 인물이 지금 어디서 무엇을 하고 있는지 위 값에 맞춰 다루고, 장면에 없다는 이유로 무시하거나 임의로 바꾸지 마세요. "
          + "필요하면 그 상태에 맞게 등장·언급시켜도 됩니다."
        : "",
    ].filter(Boolean).join("\n");
    return `[현재 상태창 — 지금 상황과 인물들의 현재 상태]\n${body}` + (howTo ? `\n${howTo}` : "");
  }
  function buildInjectionText(chatId, status, apiOnly, anchorMsgId, opts) {
    const directive = buildDirective(status, apiOnly, chatId, anchorMsgId);
    if (S().injectCurrentValues) {
      const cs = buildCurrentStateText(chatId, status, anchorMsgId, opts);
      if (cs) return cs + "\n\n" + directive;
    }
    return directive;
  }
  // ── 본편 생성에 상태창 싣기 ──
  //  예전엔 agentInjectionOverrides(agentType "user-status")로만 보냈다. 마리나라 2.4 서버는
  //  프리셋을 쓰는 롤플레이 채팅에서 '프리셋이 에이전트 자리를 정한다'로 보고, 프리셋에 자리가 없는
  //  주입은 버린다. user-status 는 등록된 에이전트가 아니라 자리를 만들 수도 없어 늘 버려졌다.
  //  재생성·스와이프에서는 이 값 자체를 무시하고 첫 생성 때의 캐시를 다시 쓴다.
  //  → generationGuide 로 보낸다. 서버가 프리셋·재생성과 무관하게 채팅 히스토리 '뒤'(프롬프트 맨 끝)에
  //    system 메시지로 붙인다. 앞에 서버 문구("Take the following into special consideration…")가 붙는다.
  //  사칭 재생성: 서버가 가이드를 지우므로(원래 사칭 방향을 복원하는 과정) 사칭 '방향'(userMessage)에 싣는다.
  //    사칭에서 userMessage 는 채팅에 저장되지 않고 사칭 지시문의 direction 으로만 쓰인다.
  //    ※ 일반 턴의 userMessage 는 유저 메시지로 저장되므로 절대 쓰지 않는다.
  //  예외(옛 통로 유지): 개별 응답 그룹 채팅 + 스마트 응답 순서의 '새 답변' — 가이드가 있으면 서버가
  //    AI 응답자 선택을 건너뛰고 '직전에 말하지 않은 한 명'만 답하게 한다. 이 경우만 agentInjectionOverrides.
  const US_GUIDE_RE = /\s*<user_status>[\s\S]*?<\/user_status>\s*/g;
  // 서버의 스마트 응답자 선택이 실제로 도는 채팅인지: 캐릭터 2명 이상 + 개별 응답 + 스마트 순서
  function readGroupResponseOrder(chat) {
    let meta = chat && chat.metadata;
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = null; } }
    let ids = chat && chat.characterIds;
    if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { ids = []; } }
    const smart = !!(meta && meta.groupResponseOrder === "smart" && meta.groupChatMode === "individual");
    return smart && Array.isArray(ids) && ids.length > 1 ? "smart" : null;
  }
  function refreshGroupOrderCache(chatId) {
    if (!chatId) return;
    marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}`)
      .then((chat) => { if (chat) chatGroupOrderCache[chatId] = readGroupResponseOrder(chat); })
      .catch(() => {});
  }
  function injectStatusText(bodyStr, text, parsedBody, chatId) {
    let body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody : null;
    if (!body) { try { body = JSON.parse(bodyStr); } catch { return null; } }
    const regenId = typeof body.regenerateMessageId === "string" && body.regenerateMessageId ? body.regenerateMessageId : null;
    const regenMsg = regenId && Array.isArray(lastMsgListByChat[chatId])
      ? lastMsgListByChat[chatId].find((m) => m && m.id === regenId) : null;
    const replay = regenMsg ? parseMessageExtra(regenMsg).generationReplay : null;
    const block = `<user_status>\n${text}\n</user_status>`;
    const smartGroupFresh = chatGroupOrderCache[chatId] === "smart" && !regenId && body.impersonate !== true;
    if (smartGroupFresh) return injectViaAgent(bodyStr, text, body);
    // 옛 통로에 남은 항목은 뺀다 (두 번 실리지 않게)
    if (Array.isArray(body.agentInjectionOverrides)) {
      body.agentInjectionOverrides = body.agentInjectionOverrides.filter((e) => e && e.agentType !== "user-status");
    }
    if (regenId && replay && replay.impersonate === true) {
      // 사칭 재생성 — 사칭 방향에 싣는다. 비어 있으면 원래 방향을 되살린 뒤 붙인다
      //   (방향은 메시지에 저장되므로 지난번 상태창 블록은 떼어 낸다).
      let dir = typeof body.userMessage === "string" && body.userMessage.trim() ? body.userMessage
        : (typeof replay.userMessage === "string" ? replay.userMessage : "");
      dir = dir.replace(US_GUIDE_RE, "\n\n").trim();
      body.userMessage = dir ? `${dir}\n\n${block}` : block;
      try { return { body: JSON.stringify(body), field: "userMessage(사칭 방향)" }; } catch { return null; }
    }
    let guide = typeof body.generationGuide === "string" ? body.generationGuide : "";
    let source = body.generationGuideSource || null;
    // 재생성: 요청에 가이드가 없으면 서버가 원래 메시지의 가이드(내레이터 등)를 되살린다.
    //   우리가 가이드를 채워 보내면 그 복원이 건너뛰어지므로, 원래 가이드를 직접 가져와 앞에 둔다.
    if (!guide.trim() && replay && typeof replay.generationGuide === "string" && replay.generationGuide.trim()) {
      guide = replay.generationGuide;
      source = replay.generationGuideSource || "guide";
    }
    // 원래 가이드에 지난번 상태창이 섞여 저장돼 있으면 떼어 낸다 (내레이터 가이드는 메시지에 저장된다)
    guide = guide.replace(US_GUIDE_RE, "\n\n").trim();
    body.generationGuide = guide ? `${guide}\n\n${block}` : block;
    if (source) body.generationGuideSource = source;
    try { return { body: JSON.stringify(body), field: "generationGuide" }; } catch { return null; }
  }
  function injectViaAgent(bodyStr, text, parsedBody) {
    // fetch 훅에서 이미 JSON.parse한 바디가 있으면 재사용 — 긴 채팅에서 바디를 두 번
    // 파싱하는 비용(생성 요청 전송 지연)을 없앤다.
    let body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody : null;
    if (!body) { try { body = JSON.parse(bodyStr); } catch { return null; } }
    let arr = Array.isArray(body.agentInjectionOverrides) ? body.agentInjectionOverrides.filter((e) => e && e.agentType !== "user-status") : [];
    arr.push({ agentType: "user-status", agentName: "유저 상태창", text });
    body.agentInjectionOverrides = arr;
    try { return { body: JSON.stringify(body), field: "agentInjectionOverrides" }; } catch { return null; }
  }

  // ── 파싱 ──
  function parseValues(inner) {
    const out = {};
    inner.split(/\r?\n/).forEach((line) => {
      const l = line.trim(); if (!l) return;
      const mm = l.match(/^[\-*•]?\s*(.+?)\s*[:=]\s*(.*)$/);
      if (mm) {
        const key = mm[1].replace(/^[\[\{<"']+|[\]\}>"']+$/g, "").trim();
        const val = mm[2].trim().replace(/^[<"']+|[>"']+$/g, "");
        if (key) out[key] = val;
      }
    });
    return out;
  }
  function parseSubjects(content) {
    const json = parseJsonBlock(content);
    if (json && Array.isArray(json.subjects) && json.subjects.length) return json.subjects;
    const reqRanges = [];
    let rm; RE_REQ.lastIndex = 0;
    while ((rm = RE_REQ.exec(content))) reqRanges.push([rm.index, rm.index + rm[0].length]);
    const inReq = (i) => reqRanges.some(([a, b]) => i >= a && i < b);
    const re = new RegExp(STATUS_SRC, "gi");
    const subjects = []; let m;
    while ((m = re.exec(content))) {
      if (inReq(m.index)) continue;
      const label = (m[1] || "").trim();
      subjects.push({ label, values: parseValues(m[2]) });
    }
    return subjects;
  }
  function parseScene(content) {
    const json = parseJsonBlock(content);
    if (json && json.scene && typeof json.scene === "object") return json.scene;
    const reqRanges = [];
    let rm; RE_REQ.lastIndex = 0;
    while ((rm = RE_REQ.exec(content))) reqRanges.push([rm.index, rm.index + rm[0].length]);
    const inReq = (i) => reqRanges.some(([a, b]) => i >= a && i < b);
    const re = new RegExp(SCENE_SRC, "gi");
    let m;
    while ((m = re.exec(content))) {
      if (inReq(m.index)) continue;
      return parseValues(m[1]);
    }
    return null;
  }
  // 직전 parseJsonBlock 호출이 '잘린 출력 복구'로 값을 얻었는지 (안내 문구용)
  let lastSalvagedPartial = false;
  function consumeSalvageFlag() { const v = lastSalvagedPartial; lastSalvagedPartial = false; return v; }
  function parseJsonBlock(content) {
    lastSalvagedPartial = false;
    const reqRanges = [];
    let rm; RE_REQ.lastIndex = 0;
    while ((rm = RE_REQ.exec(content))) reqRanges.push([rm.index, rm.index + rm[0].length]);
    const inReq = (i) => reqRanges.some(([a, b]) => i >= a && i < b);
    RE_JSON_BLOCK.lastIndex = 0;
    let m;
    while ((m = RE_JSON_BLOCK.exec(content))) {
      if (inReq(m.index)) continue;
      try {
        const parsed = JSON.parse(m[1]);
        if (isStatusPayloadObject(parsed)) return parsed;
      } catch (e) { console.debug("[us-status] parseJsonBlock: invalid JSON in block", e); }
    }
    const loose = findLooseStatusJsonBlocks(content, inReq);
    if (loose.length) return loose[0].parsed;
    // ── 마지막 수단: 출력이 중간에서 끊긴 경우 ──
    //   여기까지 왔다는 건 온전한 JSON 이 하나도 없었다는 뜻이다. 닫는 코드펜스나 닫는
    //   중괄호가 아예 없을 수 있으므로, 코드펜스 뒤쪽 텍스트와 원문 전체를 차례로 복구 시도한다.
    //   복구본은 lastSalvagedPartial 에 표시해 두고 호출부가 '일부만 인식' 안내에 쓴다.
    const salvageSources = [];
    const fenceAt = content.search(/```us-status/i);
    if (fenceAt >= 0 && !inReq(fenceAt)) salvageSources.push(content.slice(fenceAt));
    if (hasLooseStatusJsonHint(content)) salvageSources.push(content);
    for (const src of salvageSources) {
      const salvaged = salvageTruncatedJson(src);
      if (salvaged) { lastSalvagedPartial = true; return salvaged; }
    }
    return null;
  }
  // ── 값 표시 방식 (스킨별 옵션) ─────────────────────────────
  //   AI가 채운 값 자체를 어떻게 그릴지. 기본값은 예전과 같은 '전부 이스케이프' 이므로
  //   옵션을 켜지 않은 기존 스킨의 렌더 결과는 한 글자도 달라지지 않는다.
  //   · valueLineBreaks "off"(기본) | "br" | "div" — 값 안의 줄바꿈 처리
  //   · valueHtml true — <i>·<b> 같은 간단한 서식 태그만 살려서 렌더 (그 외는 글자로)
  const VALUE_TAG_WHITELIST = "i|em|b|strong|small|u|s|del|ins|code|mark|sub|sup|span|br|wbr";
  // 이스케이프한 문자열에서 허용 태그만 되살린다. 따옴표는 이스케이프된 채로 두므로
  //   style="width:{{값}}%" 같은 '속성 안 치환' 자리에서도 속성을 깨고 나갈 수 없다.
  const RE_VALUE_TAG = new RegExp(`&lt;(\\/?)(${VALUE_TAG_WHITELIST})((?:\\s+class=&quot;[\\w\\- ]{0,120}&quot;)?)\\s*(\\/?)&gt;`, "gi");
  function reviveValueTags(escaped) {
    return escaped.replace(RE_VALUE_TAG, (m, close, tag, cls, selfClose) => {
      const attr = cls ? cls.replace(/&quot;/g, '"') : "";
      return `<${close}${tag.toLowerCase()}${attr}${selfClose}>`;
    });
  }
  function renderValue(raw, opts) {
    let out = esc(raw);
    if (opts && opts.valueHtml) out = reviveValueTags(out);
    const mode = opts && opts.valueLineBreaks;
    if (mode === "br") out = out.replace(/\r?\n/g, "<br>");
    else if (mode === "div") {
      const lines = out.split(/\r?\n/);
      if (lines.length > 1) out = lines.map((ln) => `<div class="us-vline">${ln}</div>`).join("");
    }
    return out;
  }
  function valueOptsOf(status) {
    return {
      valueHtml: !!(status && status.valueHtml),
      valueLineBreaks: (status && status.valueLineBreaks) || "off",
    };
  }
  // ── 조건 블록 {{#키}}…{{/키}} / {{^키}}…{{/키}} ─────────────
  //   값이 있으면(#) / 없으면(^) 블록 안을 그대로 두고, 아니면 블록째 지운다.
  //   중첩 가능. 값 치환보다 **먼저** 처리해야 한다 — 나중에 하면 값 안에 우연히 들어 있는
  //   "{{/" 같은 문자열이 블록 토큰으로 오인된다.
  //   짝이 안 맞는 여는 토큰은 조건을 무시하고 내용을 그대로 보여준다(fail-open).
  //   내용이 통째로 사라져 원인을 못 찾는 것보다, 보이는 채로 편집기 경고를 받는 편이 낫다.
  const RE_BLOCK_TOKEN = /\{\{\s*([#^/])\s*([^}]+?)\s*\}\}/g;
  const normKey = (s) => (s == null ? "" : String(s)).replace(/\s+/g, "").toLowerCase();
  function hasBlockTokens(tpl) { return typeof tpl === "string" && /\{\{\s*[#^/]/.test(tpl); }
  function parseBlockNodes(tpl) {
    const tokens = [];
    RE_BLOCK_TOKEN.lastIndex = 0;
    let m;
    while ((m = RE_BLOCK_TOKEN.exec(tpl)) !== null) {
      tokens.push({ type: m[1], key: (m[2] || "").trim(), start: m.index, end: m.index + m[0].length });
    }
    let pos = 0, ti = 0;
    function parse(stopKey) {
      const nodes = [];
      while (ti < tokens.length) {
        const t = tokens[ti];
        if (t.start > pos) nodes.push({ text: tpl.slice(pos, t.start) });
        pos = t.end; ti++;
        const raw = tpl.slice(t.start, t.end);
        if (t.type === "/") {
          if (stopKey != null && normKey(t.key) === normKey(stopKey)) return { nodes, closed: true };
          // 짝 없는 닫기 토큰은 원문 그대로 남긴다 — 블록을 안 쓰는 예전 템플릿이
          // (예: {{/키}} 라는 이름의 필드) 글자 하나 달라지지 않게 하는 하위호환 장치.
          nodes.push({ text: raw });
          continue;
        }
        const inner = parse(t.key);
        nodes.push({ block: t.type, key: t.key, raw, nodes: inner.nodes, closed: inner.closed });
      }
      if (pos < tpl.length) { nodes.push({ text: tpl.slice(pos) }); pos = tpl.length; }
      return { nodes, closed: false };
    }
    return parse(null).nodes;
  }
  function applyConditionalBlocks(tpl, values, label) {
    if (!hasBlockTokens(tpl)) return tpl || "";
    const lookup = (key) => {
      const k = (key || "").trim();
      if (/^(이름|name|char|user)$/i.test(k) && label != null && !(k in values)) return label;
      if (Object.prototype.hasOwnProperty.call(values, k)) return values[k];
      const hit = Object.keys(values).find((x) => normKey(x) === normKey(k));
      return hit != null ? values[hit] : "";
    };
    // 값 있음 판정: 빈 문자열·공백뿐인 값만 '없음'. 숫자 0 과 "false" 는 값으로 친다.
    const filled = (key) => {
      const v = lookup(key);
      return v != null && String(v).trim() !== "";
    };
    const walk = (nodes) => nodes.map((n) => {
      if (n.text != null) return n.text;
      // 닫는 짝이 없으면 조건을 적용하지 않고, 여는 토큰 원문까지 그대로 돌려준다.
      //   → 뒤이어 도는 {{키}} 치환이 예전처럼 값으로 바꿔 준다(하위호환).
      if (!n.closed) return (n.raw || "") + walk(n.nodes);
      const show = n.block === "^" ? !filled(n.key) : filled(n.key);
      return show ? walk(n.nodes) : "";
    }).join("");
    return walk(parseBlockNodes(tpl));
  }
  // 편집기 저장 전 검사 — 짝이 맞지 않는 조건 블록을 사람이 읽을 수 있는 문장으로 돌려준다.
  function checkBlockBalance(tpl) {
    if (!hasBlockTokens(tpl)) return [];
    const problems = []; const stack = [];
    RE_BLOCK_TOKEN.lastIndex = 0;
    let m;
    while ((m = RE_BLOCK_TOKEN.exec(tpl)) !== null) {
      const type = m[1], key = (m[2] || "").trim();
      if (type === "/") {
        if (!stack.length) { problems.push(`{{/${key}}} 에 맞는 여는 태그가 없습니다`); continue; }
        const top = stack[stack.length - 1];
        if (normKey(top) === normKey(key)) stack.pop();
        else problems.push(`{{/${key}}} 가 {{#${top}}} 와 엇갈립니다 (안쪽부터 닫아야 합니다)`);
      } else stack.push(key);
    }
    stack.forEach((k) => problems.push(`{{/${k}}} 가 없습니다`));
    return problems;
  }
  function renderTemplate(tpl, values, label, opts) {
    tpl = applyConditionalBlocks(tpl, values || {}, label);
    return (tpl || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, rawKey) => {
      const key = rawKey.trim();
      if (/^(이름|name|char|user)$/i.test(key) && label != null && !(key in values)) return renderValue(label, opts);
      if (Object.prototype.hasOwnProperty.call(values, key)) return renderValue(values[key], opts);
      const norm = (s) => s.toString().replace(/\s+/g, "").toLowerCase();
      const hit = Object.keys(values).find((k) => norm(k) === norm(key));
      return hit != null ? renderValue(values[hit], opts) : "";
    });
  }
  function buildStatusHost(status, values, label) {
    const host = document.createElement("div");
    host.className = "us-status-host";
    host.setAttribute("data-us-host", "1");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{all:initial;display:block;width:100%;}*{box-sizing:border-box;overflow-wrap:break-word;word-break:keep-all;white-space:normal;}</style><style>${status.css || ""}</style>${renderTemplate(status.template, values, label, valueOptsOf(status))}`;
    return host;
  }
  function buildSceneHost(status, scene) {
    const host = document.createElement("div");
    host.className = "us-scene-host";
    host.setAttribute("data-us-host", "1");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{all:initial;display:block;width:100%;}*{box-sizing:border-box;overflow-wrap:break-word;word-break:keep-all;white-space:normal;}</style><style>${status.sceneCss || ""}</style>${renderTemplate(status.sceneTemplate, scene || {}, "", valueOptsOf(status))}`;
    return host;
  }
  function buildUiHost(tpl, css, values, label, opts) {
    const host = document.createElement("span");
    host.className = "us-ui-host";
    host.setAttribute("data-us-host", "1");
    const shadow = host.attachShadow({ mode: "open" });
    // color/font-size/font-family/line-height:inherit so that tab/button text follows parent (Marinara theme)
    // when no custom tabCss is supplied. The user's custom css can still override these.
    shadow.innerHTML = `<style>:host{all:initial;display:block;min-width:0;color:inherit;font-size:inherit;font-family:inherit;line-height:inherit;}*{box-sizing:border-box;overflow-wrap:break-word;word-break:keep-all;white-space:normal;}</style><style>${css || ""}</style>${renderTemplate(tpl || "", values || {}, label || "", opts)}`;
    return host;
  }
  function buildSceneButton(status) {    const btn = document.createElement("button");
    btn.className = "us-scene-button";
    btn.type = "button";
    btn.setAttribute("aria-label", "장면 띠 펼치기");
    btn.title = "장면 띠 펼치기";
    btn.appendChild(buildUiHost(status.sceneButtonTemplate || DEFAULT_SCENE_BUTTON_TEMPLATE, status.sceneButtonCss || "", {}, ""));
    const arrow = document.createElement("span");
    arrow.className = "us-scene-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "▸";
    btn.appendChild(arrow);
    return btn;
  }
  function wireDragScroll(el) {
    if (!el || el._usDragScroll) return;
    el._usDragScroll = true;
    let dragging = false, moved = false, startX = 0, startLeft = 0;
    const pointX = (e) => ("touches" in e ? e.touches[0] : "changedTouches" in e ? e.changedTouches[0] : e).clientX;
    const canDrag = () => el.scrollWidth > el.clientWidth + 1;
    const move = (e) => {
      if (!dragging) return;
      const dx = pointX(e) - startX;
      if (Math.abs(dx) > 3) moved = true;
      el.scrollLeft = startLeft - dx;
      if (moved && e.cancelable) e.preventDefault();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("dragging");
      if (moved) {
        el.dataset.dragClickBlock = "1";
        setTimeout(() => { delete el.dataset.dragClickBlock; }, 0);
      }
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
    const down = (e) => {
      if (!canDrag()) return;
      dragging = true;
      moved = false;
      startX = pointX(e);
      startLeft = el.scrollLeft;
      el.classList.add("dragging");
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
      window.addEventListener("touchcancel", up);
    };
    el.addEventListener("mousedown", down);
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("wheel", (e) => { if (canDrag() && e.cancelable) e.preventDefault(); }, { passive: false });
    el.addEventListener("click", (e) => {
      if (el.dataset.dragClickBlock === "1") {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }
  function sampleValuesFor(status) {
    const v = {};
    (status.fields || []).forEach((f) => {
      if (!f.key) return;
      const ins = f.instruction || "";
      const mm = ins.match(/예\s*[:：]?\s*([^.\n]+)/);
      if (mm) { v[f.key] = mm[1].split(/[,，]/)[0].trim(); return; }
      if (/HP|MP/i.test(f.key)) { v[f.key] = "84/100"; return; }
      if (/0\s*~\s*100|숫자|호감도|친밀도|호감/.test(ins + f.key)) { v[f.key] = "72"; return; }
      v[f.key] = f.key;
    });
    return v;
  }
  function hasLooseStatusJsonHint(content) {
    if (!content || typeof content !== "string") return false;
    return content.indexOf('"subjects"') !== -1 && content.indexOf('"values"') !== -1 && content.indexOf("{") !== -1;
  }
  function isValidStatusSubject(sub) {
    return !!(sub && typeof sub === "object" && !Array.isArray(sub) && sub.values && typeof sub.values === "object" && !Array.isArray(sub.values));
  }
  function isStatusPayloadObject(parsed) {
    if (!parsed || !Array.isArray(parsed.subjects)) return false;
    const okSubjects = parsed.subjects.every(isValidStatusSubject);
    if (!okSubjects) return false;
    const sceneIsObj = parsed.scene != null && typeof parsed.scene === "object" && !Array.isArray(parsed.scene);
    if (parsed.scene != null && !sceneIsObj) return false;
    // 장면 전용 스킨: subjects가 빈 배열이면 scene 객체가 있어야 유효한 페이로드로 인정
    if (!parsed.subjects.length && !sceneIsObj) return false;
    return true;
  }
  // ── 잘린 JSON 복구 ────────────────────────────────────────
  //   토큰 한도 등으로 출력이 중간에서 끊기면 JSON.parse 가 통째로 실패해, 이미 다 나온
  //   캐릭터들의 값까지 버려진다. 끊긴 지점 이전의 '완결된 부분'까지만 잘라내고 열려 있는
  //   괄호를 닫아 다시 파싱한다. 정상 JSON 은 이 경로를 타지 않으므로 기존 동작에 영향 없음.
  function salvageTruncatedJson(text) {
    if (!text || typeof text !== "string") return null;
    const startIdx = text.indexOf("{");
    if (startIdx < 0) return null;
    const src = text.slice(startIdx);
    // 문자열 밖에서 '값이 완결된' 위치들을 모은다: 닫는 괄호 뒤 / 쉼표 앞
    const cuts = [];
    const stackAt = [];       // 각 컷 위치에서 열려 있는 괄호 스택 사본
    const stack = [];
    let inStr = false, esc = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{" || ch === "[") { stack.push(ch); continue; }
      if (ch === "}" || ch === "]") {
        stack.pop();
        if (stack.length) { cuts.push(i + 1); stackAt.push(stack.slice()); }
        continue;
      }
      if (ch === ",") { cuts.push(i); stackAt.push(stack.slice()); }
    }
    if (!cuts.length) return null;
    // 뒤에서부터 시도 — 가장 많이 살린 결과가 먼저 나온다. 시도 횟수는 제한(성능/폭주 방지).
    const MAX_TRY = 60;
    for (let n = cuts.length - 1, tried = 0; n >= 0 && tried < MAX_TRY; n--, tried++) {
      let candidate = src.slice(0, cuts[n]).replace(/[\s,]+$/, "");
      const open = stackAt[n];
      for (let k = open.length - 1; k >= 0; k--) candidate += open[k] === "{" ? "}" : "]";
      try {
        const parsed = JSON.parse(candidate);
        if (isStatusPayloadObject(parsed)) return parsed;
      } catch (e) { /* 더 앞쪽 경계로 계속 시도 */ }
    }
    return null;
  }
  /** inReq(startIndex): 요청 블록([[STATUS-REQ]]...[[/STATUS-REQ]]) 내부 여부 콜백 */
  function findLooseStatusJsonBlocks(content, inReq = () => false, opts = {}) {
    if (!content || typeof content !== "string") return [];
    const allowInvalid = opts && opts.allowInvalid === true;
    const hits = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let escaped = false;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (ch !== "}") continue;
      if (depth <= 0) continue;
      depth--;
      if (depth !== 0 || start < 0) continue;
      if (inReq(start)) { start = -1; continue; }
      const raw = content.slice(start, i + 1);
      if (!hasLooseStatusJsonHint(raw)) { start = -1; continue; }
      try {
        const parsed = JSON.parse(raw);
        if (isStatusPayloadObject(parsed)) hits.push({ start, end: i + 1, parsed });
        else if (allowInvalid) hits.push({ start, end: i + 1, parsed: null });
      } catch (e) {
        console.debug("[us-status] findLooseStatusJsonBlocks: invalid JSON", e);
        if (allowInvalid) hits.push({ start, end: i + 1, parsed: null });
      }
      start = -1;
    }
    return hits;
  }

  // ── 채팅 DOM 즉시 숨김 (보조 수단: 기본 권장은 dryRun API 모드) ──
  function hideRawBlocksInChat() {
    const st = S();
    if (!st.enabled) return;
    const shouldHide = st.dataMode === DATA_MODES.api || (st.dataMode === DATA_MODES.inline && st.stripFromMessage);
    if (!shouldHide) return;
    const scopes = Array.from(document.querySelectorAll("[data-message-id], .chat-messages, main"));
    if (!scopes.length) return;
    const applyStrip = (el) => {
      if (!el) return;
      if (el.closest("#" + PANEL_ID) || el.closest("#" + MODAL_ID) || el.closest("#" + FLOAT_ID)) return;
      const t = el.textContent || "";
      if (t.indexOf("[[STATUS") === -1 && t.indexOf("[[SCENE") === -1 && t.indexOf("```us-status") === -1 && !hasLooseStatusJsonHint(t)) return;
      let childHas = false;
      for (const c of el.children || []) {
        const ct = c.textContent || "";
        if (ct.indexOf("[[STATUS") !== -1 || ct.indexOf("[[SCENE") !== -1 || ct.indexOf("```us-status") !== -1 || hasLooseStatusJsonHint(ct)) { childHas = true; break; }
      }
      if (childHas) return;
      stripBlocksDOM(el);
    };
    for (const scope of scopes) {
      if (scope.matches("[data-message-id]")) applyStrip(scope);
      for (const el of scope.querySelectorAll("[data-message-id], p,span,div")) applyStrip(el);
    }
  }
  function stripBlocksDOM(root) {
    root.querySelectorAll("pre").forEach((pre) => {
      const preText = pre.textContent || "";
      if (pre.querySelector("code." + JSON_BLOCK_LANG)
        || pre.querySelector("code.language-" + JSON_BLOCK_LANG)
        || preText.indexOf("```" + JSON_BLOCK_LANG) !== -1
        || preText.indexOf("[[STATUS") !== -1
        || preText.indexOf("[[SCENE") !== -1
        || hasLooseStatusJsonHint(preText)) {
        if (!pre.closest("#" + PANEL_ID) && !pre.closest("#" + MODAL_ID) && !pre.closest("#" + FLOAT_ID)) pre.remove();
      }
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let text = ""; let n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: text.length, end: text.length + n.nodeValue.length }); text += n.nodeValue; }
    if (!text || (text.indexOf("[[STATUS") === -1 && text.indexOf("[[SCENE") === -1 && text.indexOf("```" + JSON_BLOCK_LANG) === -1 && !hasLooseStatusJsonHint(text))) return;
    const ranges = []; let rm; RE_REQ.lastIndex = 0;
    while ((rm = RE_REQ.exec(text))) ranges.push([rm.index, rm.index + rm[0].length]);
    const inReq = (i) => ranges.some(([a, b]) => i >= a && i < b);
    const reB = new RegExp(STATUS_BLOCK_SRC, "gi"); let wm;
    while ((wm = reB.exec(text))) if (!inReq(wm.index)) ranges.push([wm.index, wm.index + wm[0].length]);
    const reS = new RegExp(SCENE_BLOCK_SRC, "gi");
    while ((wm = reS.exec(text))) if (!inReq(wm.index)) ranges.push([wm.index, wm.index + wm[0].length]);
    RE_JSON_BLOCK.lastIndex = 0;
    while ((wm = RE_JSON_BLOCK.exec(text))) if (!inReq(wm.index)) ranges.push([wm.index, wm.index + wm[0].length]);
    for (const hit of findLooseStatusJsonBlocks(text, inReq, { allowInvalid: true })) ranges.push([hit.start, hit.end]);
    if (!ranges.length) return;
    for (const seg of nodes) {
      let s = seg.node.nodeValue;
      const ov = ranges.map(([a, b]) => [Math.max(a, seg.start), Math.min(b, seg.end)]).filter(([a, b]) => b > a).sort((x, y) => y[0] - x[0]);
      for (const [a, b] of ov) s = s.slice(0, a - seg.start) + s.slice(b - seg.start);
      const sClean = stripRepeatJunk(s);
      if (sClean !== seg.node.nodeValue) seg.node.nodeValue = sClean;
    }
  }
  function stripRepeatJunk(content) {
    if (!content || typeof content !== "string") return content;
    // 동일 문자(한글 자모 포함)가 10회 이상 연속 반복되는 패턴 제거
    return content.replace(/([\s\S])\1{9,}/g, "");
  }
  function stripBlocksText(content) {
    const reqRanges = []; let rm; RE_REQ.lastIndex = 0;
    while ((rm = RE_REQ.exec(content))) reqRanges.push([rm.index, rm.index + rm[0].length]);
    const inReq = (i) => reqRanges.some(([a, b]) => i >= a && i < b);
    const ranges = reqRanges.slice();
    const reB = new RegExp(STATUS_BLOCK_SRC, "gi"); let wm;
    while ((wm = reB.exec(content))) if (!inReq(wm.index)) ranges.push([wm.index, wm.index + wm[0].length]);
    const reS = new RegExp(SCENE_BLOCK_SRC, "gi");
    while ((wm = reS.exec(content))) if (!inReq(wm.index)) ranges.push([wm.index, wm.index + wm[0].length]);
    RE_JSON_BLOCK.lastIndex = 0;
    while ((wm = RE_JSON_BLOCK.exec(content))) if (!inReq(wm.index)) ranges.push([wm.index, wm.index + wm[0].length]);
    for (const hit of findLooseStatusJsonBlocks(content, inReq, { allowInvalid: true })) ranges.push([hit.start, hit.end]);
    if (!ranges.length) return content;
    ranges.sort((a, b) => b[0] - a[0]);
    let out = content;
    for (const [a, b] of ranges) out = out.slice(0, a) + out.slice(b);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── 캡처 ──
  const strippedIds = new Set();
  let stripReapplyDebounce = null;
  const lastMsgCountByChat = {};
  function latestAssistantSwipeFromDom(chatId) {
    const latest = latestAsstByChat[chatId];
    if (!latest || !latest.id) return null;
    const nodes = getMsgNodes();
    for (const n of nodes) {
      if (n.getAttribute("data-message-id") !== latest.id) continue;
      return readActiveSwipeFromNode(n);
    }
    return null;
  }
  async function chatChangedSinceLast(chatId) {
    try {
      const r = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/message-count`);
      const n = r && typeof r.count === "number" ? r.count : null;
      if (n == null) return true;
      const prev = lastMsgCountByChat[chatId];
      lastMsgCountByChat[chatId] = n;
      const domSwipe = latestAssistantSwipeFromDom(chatId);
      let swipeChanged = false;
      if (Number.isFinite(domSwipe)) {
        const prevSwipe = lastLatestSwipeByChat[chatId];
        if (prevSwipe === undefined) lastLatestSwipeByChat[chatId] = domSwipe;
        else if (prevSwipe !== domSwipe) { lastLatestSwipeByChat[chatId] = domSwipe; swipeChanged = true; }
      }
      return prev === undefined || n !== prev || swipeChanged;
    } catch (_) { return true; }
  }
  const lastMsgListByChat = {}; // chatId → 마지막으로 받은 메시지 목록 (턴 번호 계산용)
  // chatId → 채팅 '전체' 어시스턴트 ID 시간순 (잘리지 않은 목록을 받았을 때만 갱신). assistantChrono 참고.
  const fullAsstChronoByChat = {};
  // ── 턴 번호 맵 ──────────────────────────────────────────────────────────
  //   /messages 는 limit 이 걸린 '뒤쪽 꼬리'만 준다. 그 목록을 앞에서부터 세면 턴 번호가
  //   항상 1부터 다시 시작해, 대화가 limit 을 넘는 순간부터 턴수가 깨진다.
  //   (게다가 호출처마다 limit 이 달라서(40 / historyDepth / 2000) 마지막에 어떤 조회가
  //    돌았느냐에 따라 번호가 들쭉날쭉 — '가끔 깨져 나온다'의 원인)
  //   해결: 서버가 요청한 limit 보다 적게 주면 그건 대화 전체이므로 그때 정확한 턴 맵을
  //   만들어 두고, 잘린 꼬리 목록은 이미 아는 메시지를 앵커로 삼아 이어서 번호를 매긴다.
  const turnMapByChat = {}; // chatId → { map: {msgId:turn}, maxTurn, complete }
  function updateTurnMap(chatId, list, requestedLimit) {
    if (!chatId || !Array.isArray(list)) return;
    const complete = list.length < requestedLimit; // 요청보다 적게 왔다 = 더 없다 = 전체
    const cur = turnMapByChat[chatId];
    if (complete) {
      const map = {}; let turn = 0;
      for (const m of list) if (m && m.role === "assistant" && m.id) map[m.id] = ++turn;
      turnMapByChat[chatId] = { map, maxTurn: turn, complete: true };
      return;
    }
    // 잘린 꼬리: 기존 맵에서 앵커(이미 번호를 아는 메시지)를 찾아 거기서부터 이어 붙인다.
    if (!cur) return; // 기준이 없으면 섣불리 번호를 매기지 않는다 (null 반환 → 표시 생략)
    const map = { ...cur.map }; let maxTurn = cur.maxTurn, anchored = false, turn = 0;
    for (const m of list) {
      if (!m || m.role !== "assistant" || !m.id) continue;
      if (map[m.id]) { turn = map[m.id]; anchored = true; continue; }
      if (!anchored) continue;      // 앵커 이전의 미지 메시지는 건너뜀 (번호 추정 불가)
      map[m.id] = ++turn;
      if (turn > maxTurn) maxTurn = turn;
    }
    turnMapByChat[chatId] = { map, maxTurn, complete: false };
  }
  async function fetchMessages(chatId, limit) {
    const lim = Number.isFinite(limit) && limit > 0 ? limit : 40;
    try { const list = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/messages?limit=${lim}`); diag.fetchErr = null; diag.fetchOkTs = Date.now(); diag.msgCount = Array.isArray(list) ? list.length : 0; if (Array.isArray(list)) { lastMsgListByChat[chatId] = list; syncHiddenMessageStates(chatId, list); updateTurnMap(chatId, list, lim); if (list.length < lim) fullAsstChronoByChat[chatId] = list.filter((m) => m && m.role === "assistant" && m.id).map((m) => m.id); } return Array.isArray(list) ? list : null; }
    catch (e) { diag.fetchErr = String((e && e.message) || e); return null; }
  }
  async function fetchMessageCount(chatId) {
    try { const r = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/message-count`); return r && typeof r.count === "number" ? r.count : null; }
    catch (_) { return null; }
  }
  async function cleanupStored(chatId, list) {
    let patched = false;
    for (const msg of list) {
      if (!msg || typeof msg.content !== "string") continue;
      const key = msg.id + "#" + (msg.activeSwipeIndex || 0);
      if (strippedIds.has(key)) continue;
      if (msg.content.indexOf("[[STATUS") === -1 && msg.content.indexOf("[[SCENE") === -1 && msg.content.indexOf("```" + JSON_BLOCK_LANG) === -1 && !hasLooseStatusJsonHint(msg.content)) continue;
      const cleaned = stripRepeatJunk(stripBlocksText(msg.content));
      if (cleaned === msg.content) continue;
      try {
        await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msg.id)}`, { method: "PATCH", body: JSON.stringify({ content: cleaned }) });
        strippedIds.add(key); diag.patchTs = Date.now(); diag.patchCount++; patched = true;
      } catch (e) {}
    }
    if (patched) {
      clearTimeout(stripReapplyDebounce);
      stripReapplyDebounce = setTimeout(hideRawBlocksInChat, 160);
    }
  }
  function pickLatestAssistant(list) {
    let asst = null;
    const asstIds = [];
    const swipeMap = {};
    for (const mm of list) {
      if (mm && mm.role === "assistant" && mm.id) {
        asstIds.push(mm.id);
        swipeMap[mm.id] = mm.activeSwipeIndex || 0;
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].role === "assistant" && typeof list[i].content === "string") { asst = list[i]; break; }
    }
    return { asst, asstIds, swipeMap };
  }
  function applyAssistantMeta(chatId, list, depth) {
    const { asst, asstIds, swipeMap } = pickLatestAssistant(list);
    assistantIdsByChat[chatId] = new Set(asstIds);
    swipeByMsgByChat[chatId] = swipeMap;
    const swipe = asst ? (asst.activeSwipeIndex || 0) : 0;
    latestAsstByChat[chatId] = { id: asst ? asst.id : null, swipe };
    lastLatestSwipeByChat[chatId] = swipe;
    diag.asstFound = !!asst; diag.swipe = swipe;
    // __latest__(생성 중 임시 저장분)를 실제 메시지 ID로 이전한다. 단 '신선도' 가드를 둔다:
    //   서버 목록 반영이 늦어 tick 이 아직 '이번 턴 메시지'를 못 보고 '이전 턴'을 최신으로 뽑는 순간이 있는데,
    //   그때 이번 값(__latest__)을 이전 턴 ID 밑에 꽂으면 화면이 영구히 '한 턴 전'으로 밀린다.
    //   방어: 지금까지 이 채팅에서 '최신'으로 확정됐던 ID들을 기억(seenLatestIds)해 두고,
    //   현재 뽑힌 최신 ID가 '이미 지나쳐 본 옛 ID'라면(= 목록이 뒤로 후퇴한 것) 이전을 건너뛴다.
    if (asst && asst.id) {
      const seen = seenLatestIdsByChat[chatId] || (seenLatestIdsByChat[chatId] = new Set());
      // 핵심 규칙: '이미 최신으로 확정해 본 적 있는 ID'에는 placeholder 를 이전하지 않는다.
      //   - 새 턴이 뜨면 그 ID 는 seen 에 없으므로 정상 이전된다.
      //   - 새 placeholder 가 생겼는데 목록이 아직 옛 ID(seen 에 있음)만 보여주는 순간엔 이전을 미룬다
      //     → 다음 tick 에 진짜 새 메시지 ID 가 목록에 실리면 그때 그 ID 로 이전된다(= 밀림 방지).
      //   첫 관측(seen 이 비어 페이지 로드 직후)엔 seen.has 가 false 이므로 그대로 이전된다.
      if (!seen.has(asst.id)) {
        migrateLatestPlaceholder(chatId, asst.id, swipe);
      }
      seen.add(asst.id);
    }
    // depth(historyDepth)는 fetch 창 크기일 뿐 — 삭제 기준은 recordLimit(선입선출)만 사용한다.
    pruneStore(chatId, asstIds, getSettings(chatId).recordLimit);
    return { asst, asstIds, swipe };
  }
  function findFocusedAssistantMessage(chatId) {
    chatId = chatId || getChatId();
    if (!chatId) return null;
    const ids = assistantIdsByChat[chatId];
    if (!ids || !ids.size) return null;
    const nodes = getMsgNodes();
    const vh = window.innerHeight || 0;
    let best = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      const id = n.getAttribute("data-message-id");
      if (!id || !ids.has(id) || isStatusMessageHidden(chatId, id)) continue;
      const r = n.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh) continue;
      const center = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
      const dist = Math.abs(center - vh / 2);
      if (dist < bestDist) { bestDist = dist; best = { id, node: n }; }
    }
    const latest = latestVisibleAssistantMeta(chatId);
    let next = null;
    if (best && latest && latest.id && best.id !== latest.id) {
      next = { id: best.id, swipe: resolveSwipeForMsg(chatId, best.id, 0, best.node) };
    }
    return next;
  }
  function updateFocusedMessage(chatId) {
    chatId = chatId || getChatId();
    if (!chatId) return;
    // 인라인은 메시지마다 자기 기록을 직접 렌더하므로 플로팅용 스크롤 포커스를 유지하지 않는다.
    // 이전 메시지 재생성의 보조 판별이 필요할 때만 findFocusedAssistantMessage()를 일회 호출한다.
    const prev = focusedMsgByChat[chatId];
    if (isInlineDisplayMode() || config.ui.historyHoverPreview === false) {
      if (prev) { delete focusedMsgByChat[chatId]; invalidateFloat(); }
      return;
    }
    // 생성/새로고침 중이어도 플로팅 과거 미리보기는 허용한다.
    const next = findFocusedAssistantMessage(chatId);
    const same = (!!prev === !!next) && (!prev || (prev.id === next.id && prev.swipe === next.swipe));
    if (same) return;
    if (next) focusedMsgByChat[chatId] = next;
    else delete focusedMsgByChat[chatId];
    invalidateFloat();
  }
  async function syncMessages(opts = {}) {
    // opts.chatId: 대상 채팅 명시(자동 캡처 등 '생성이 일어난 채팅'에 바인딩해야 하는 경로용).
    //  미지정 시 현재 보고 있는 채팅.
    const chatId = opts.chatId || getChatId();
    if (!chatId) return null;
    await ensureChatValues(chatId);
    const st = getSettings(chatId);
    if (!st.enabled) { latestAsstByChat[chatId] = { id: null, swipe: 0 }; renderFloat(); return null; }
    const list = await fetchMessages(chatId);
    if (!list) return null;
    const { asst, swipe } = applyAssistantMeta(chatId, list, st.historyDepth);
    updateFocusedMessage(chatId);

    const status = statusForChat(chatId);
    // 과거 메시지 재생성은 목록의 마지막 assistant가 아니라 regenerateMessageId가 가리킨 메시지를 파싱한다.
    const targetAsst = opts.targetMsgId
      ? (list.find((m) => m && m.id === opts.targetMsgId && m.role === "assistant") || asst)
      : asst;
    const targetSwipe = targetAsst
      ? ((swipeByMsgByChat[chatId] && swipeByMsgByChat[chatId][targetAsst.id]) ?? (targetAsst.activeSwipeIndex || 0))
      : swipe;
    if (!opts.forApi && st.dataMode === DATA_MODES.inline && status && targetAsst) {
      const mkey = targetAsst.id + "#" + targetSwipe;
      const edited = manualIds[chatId] && manualIds[chatId].has(mkey);
      const subjects = parseSubjects(targetAsst.content);
      const salvagedA = consumeSalvageFlag();
      const scene = parseScene(targetAsst.content);
      // 출력이 중간에서 끊겼지만 완결된 부분까지는 살린 경우 안내.
      //   인라인 경로는 notifyCaptureResult 를 타지 않으므로 여기서 바로 띄운다
      //   (그 채팅을 보고 있을 때만 — 다른 채팅 알림이 섞이지 않게).
      if ((salvagedA || consumeSalvageFlag()) && (subjects.length || scene) && getChatId() === chatId) {
        showFloatNotice("출력이 중간에서 끊겨 인식된 부분까지만 저장했습니다", "warn");
      }
      const already = getMsgValues(chatId, targetAsst.id, targetSwipe);
      const alreadyScene = getMsgScene(chatId, targetAsst.id, targetSwipe);
      diag.blockFound = subjects.length > 0 || !!already || !!scene || !!alreadyScene;
      diag.subjectCount = subjects.length || (already ? already.length : 0);
      if (opts.generationComplete && !edited && !subjects.length && !scene) {
        // 같은 msgId/swipe가 재사용되는 엔진 경로도 대비해 현재 키의 옛 인식값을 제거한다.
        // 다른 스와이프/다른 턴 기록은 보존하므로 기록 탐색에는 영향이 없다.
        deleteMsgEntry(chatId, targetAsst.id, targetSwipe);
        diag.blockFound = false; diag.subjectCount = 0;
        setCaptureNotice(chatId, "noformat", targetAsst.id, targetSwipe);
      } else if (subjects.length || scene || already || alreadyScene || edited) {
        setCaptureNotice(chatId, null);
      } else if (!isGeneratingByChat[chatId]) {
        // 새 턴/새 스와이프 본문에 상태 형식이 없으면 이전 스와이프 값을 대신 보여주지 않고
        // 이 턴의 미인식 상태를 명시한다.
        setCaptureNotice(chatId, "noformat", targetAsst.id, targetSwipe);
      }
      if (!edited && (subjects.length || scene)) {
        let keepSubjects;
        if (Array.isArray(status.fields) && status.fields.length) {
          // 캐릭터 누락 방지: 이번에 나온 캐릭터는 갱신하되, 이번에 안 나온(장면 밖) 캐릭터는
          // 직전 로스터에서 이월해 유지한다. subjects가 비어 있으면(블록 없음) 기존 값 전체 유지.
          const roster = priorRosterSubjects(chatId, targetAsst.id, status.id, targetSwipe);
          keepSubjects = subjects.length
            ? mergeSubjectsCarryOver(roster || already, subjects)
            : (already || roster || []);
          // 캐릭터 카드에 배정된 캐릭터는 장면에 안 나와도 기본적으로 항상 탭에 있어야 한다.
          let cardNames = await ensureCardRoster(chatId);
          if (!cardNames.length) cardNames = await ensureCardRoster(chatId, { force: true }); // 빈 로스터면 즉시 1회 재조회 (일시 오류 복구)
          keepSubjects = dropDeleted(chatId, mergeCardRosterIntoSubs(keepSubjects, cardNames, chatId));
        } else {
          // 장면 전용 스킨: 캐릭터 이월·카드 로스터 병합 없이 subjects를 비워 저장한다.
          keepSubjects = [];
        }
        const keepScene = scene || alreadyScene || null;
        // #6: 생성 중에는 캡처(write)하지 않음 — idle 후 최종 캡처에서만 저장
        if (!isGeneratingByChat[chatId]) {
          if (setMsgEntry(chatId, status.id, targetAsst.id, targetSwipe, { scene: keepScene, subjects: keepSubjects })) diag.captureTs = Date.now();
        }
      }
    } else if (status) {
      diag.blockFound = !!(asst && (getMsgValues(chatId, asst.id, swipe) || getMsgScene(chatId, asst.id, swipe)));
    }
    if (!opts.forApi && st.dataMode === DATA_MODES.inline && st.stripFromMessage) await cleanupStored(chatId, list);
    renderFloat();
    if (!opts.forApi) refreshHistoryUiIfOpen();

    return { list, asst };
  }
  async function syncAssistantMetaNow(chatId, depth) {
    const list = await fetchMessages(chatId);
    if (!list) return null;
    const { asst, swipe } = applyAssistantMeta(chatId, list, depth);
    return { asst, swipe, list };
  }
  //  explicitChatId: 캡처 대상 채팅을 명시. 자동 캡처(generation-complete)와 수동 새로고침은
  //  '생성이 일어난 채팅'을 넘겨야 한다 — 생성/캡처 도중 사용자가 다른 채팅으로 이동하면
  //  getChatId()(=지금 보고 있는 채팅)가 바뀌어 엉뚱한 채팅을 캡처하거나(그 채팅이 비활성이면
  //  조용히 스킵) 원래 채팅의 출력이 저장되지 않는 버그가 있었다.
  async function captureApi(forceSyncMeta, extraPrompt, targetMsgId, targetSwipe, forceFullContext, explicitChatId, clearCurrentOnFailure) {
    const chatId = explicitChatId || getChatId();
    if (!chatId) return;
    // 동시 실행 방지: 이미 이 채팅의 캡처가 진행 중이면 중복 호출을 막는다.
    //  단, busy 가 비정상적으로 오래(5분+) 유지되면 stale 로 간주하고 재진입을 허용한다.
    //  (dryRun 요청이 응답 없이 영구 pending 되면 finally 가 실행되지 않아 busy 가 영영 남고,
    //   그 채팅만 새로고침/재생성이 무반응이 되는 고착 상태가 생길 수 있다)
    if (captureBusyByChat[chatId]) {
      const since = captureBusyTsByChat[chatId] || 0;
      if (since && Date.now() - since < 300000) return;
      // stale busy — 해제하고 계속 진행
      captureBusyByChat[chatId] = false;
    }
    await ensureChatValues(chatId);
    const st = getSettings(chatId);
    if (!st.enabled) return;
    captureBusyByChat[chatId] = true;
    captureBusyTsByChat[chatId] = Date.now();
    if (chatId === getChatId()) invalidateFloat(); // 캡처 시작을 즉시 화면에 반영(스피너 등)
    try {
      return await captureApiInner(chatId, st, forceSyncMeta, extraPrompt, targetMsgId, targetSwipe, forceFullContext, clearCurrentOnFailure);
    } finally {
      captureBusyByChat[chatId] = false;
      delete captureBusyTsByChat[chatId];
      // 캡처가 끝나면(성공·실패 무관) 다음 tick(최대 3초)을 기다리지 말고 즉시 다시 그린다.
      if (chatId === getChatId()) invalidateFloat();
    }
  }
  // 캡처용 dryRun 요청 바디를 구성한다 (captureApiInner + 진단 토큰 측정 공용).
  // sentChars: extensionBlocks로 직접 보내는 글자수(히스토리/로어북/캐릭터/페르소나는 서버 조립분이라 미포함).
  async function buildCaptureReqBody(chatId, st, status, opts) {
    opts = opts || {};
    const forceFullContext = opts.forceFullContext;
    const resolvedTarget = opts.resolvedTarget;
    // 대상이 최근 메시지 창 밖(오래된 턴)이면 전체 목록을 먼저 받아 둔다 —
    //   그래야 아래 '직전 값' 탐색이 대상의 앞/뒤를 구분한다(빈 턴 채우기처럼 옛 턴을 캡처할 때).
    if (resolvedTarget && String(resolvedTarget).indexOf("__") !== 0) {
      const known = assistantIdsByChat[chatId];
      const full = fullAsstChronoByChat[chatId];
      if (!(known instanceof Set && known.has(resolvedTarget)) && !(Array.isArray(full) && full.indexOf(resolvedTarget) >= 0)) {
        const total = await fetchMessageCount(chatId);
        await fetchMessages(chatId, Number.isFinite(total) && total > 0 ? total + 1 : 2000);
      }
    }
    // 캡처 대상 메시지를 기준점으로 넘긴다 — '직전 값'이 화면 스크롤 위치가 아니라
    //   실제 캡처 대상의 바로 앞 턴에서 나오도록.
    const directive = buildInjectionText(chatId, status, true, resolvedTarget || null);
    const fullMessage = opts.extraPrompt ? `${directive}\n\n[추가 요청사항]\n${opts.extraPrompt}` : directive;
    // 직전 값이 어느 턴에서 왔는지 — 사이에 빈 턴이 있으면(skipped > 0) 그 구간 대화를 따로 넣는다.
    const promptSrc = S().injectCurrentValues ? resolvePromptSource(chatId, status && status.id, resolvedTarget || null) : null;
    const gapTurns = promptSrc && promptSrc.msgId !== "__latest__" ? promptSrc.skipped : 0;
    const incHistory    = forceFullContext ? true : !!st.incHistory;
    // 마리나라 채팅 요약(chat metadata.summary). 서버 dryRun 이 includeChatSummary 로 직접 조립한다.
    //  히스토리를 끄면 이전 턴을 못 보는데, 요약이 그 자리를 훨씬 적은 토큰으로 메운다. 요약이 없는 채팅이면 빈 블록.
    const incChatSummary = forceFullContext ? true : !!st.incChatSummary;
    const incLorebook   = forceFullContext ? true : !!st.incLorebook;
    // 캡처 전용: 캐릭터 카드는 기본적으로 OFF.
    // 이유: 캐릭터 카드의 system_prompt·post_history_instructions에 RP 지시·스탯 템플릿이 포함된 경우
    //       모델이 STATUS 블록 대신 그 내용을 에코해버려 형식 인식이 실패한다.
    // 비활성화해도 등장 인물 이름은 subjectNames 블록으로 별도 주입하므로 추출 품질에 영향 없음.
    // 명시적으로 켜고 싶으면 설정에서 '캐릭터 카드 포함'을 활성화하면 된다.
    const incCharacters = forceFullContext ? true : !!st.incCharacters;
    // '숨긴 캐릭터 프롬프트 제외' ON + 카드 포함 ON: 서버 includeCharacters는 전체 카드만
    //  넣을 수 있으므로(개별 제외 불가), 끄고 숨긴 캐릭터를 뺀 카드 블록을 직접 주입한다.
    let customCardBlocks = null;
    if (incCharacters && st.hiddenExcludeFromPrompt && getHiddenArr(chatId).length) {
      try { customCardBlocks = await buildCardBlocksExcludingHidden(chatId); } catch (_) { customCardBlocks = null; }
    }
    const useCustomCards = Array.isArray(customCardBlocks); // 빈 배열도 유효(전원 숨김 → 카드 없음)
    const incPersona    = forceFullContext ? true : !!st.incPersona;
    // 히스토리 범위가 '마지막 기록 이후' 구간보다 짧으면 그 구간까지는 넓힌다 (최대 200).
    const wantTurns = forceFullContext ? 0 : (Number(st.historyTurns) > 0 ? Math.min(200, Math.max(Math.floor(st.historyTurns), gapTurns + 1)) : 0);
    let msgList = await fetchMessages(chatId, Math.max(st.historyDepth, wantTurns > 0 ? wantTurns * 2 + 4 : 0));
    let tgtMsg = msgList && msgList.find((m) => m.id === resolvedTarget);
    // ── 과거 메시지 재생성: 히스토리를 '대상 이전'까지로 잘라 직접 주입 ──
    //  마리나라 dryRun의 includeHistory는 항상 '전체' 히스토리를 조립한다(대상 기준 절단 없음).
    //  그래서 과거 메시지를 재생성하면 대상 '이후'(미래) 메시지까지 컨텍스트에 들어가
    //  다음 턴을 참조하거나 수치가 미래 값으로 오염되는 문제가 생긴다.
    //  → 대상이 최신이 아니면 includeHistory를 끄고, 대상 '직전'까지의 기록을 우리가 잘라 넣는다.
    let histCut = null;
    const latestIdNow = latestAsstByChat[chatId] && latestAsstByChat[chatId].id;
    const isPastTarget = !!(resolvedTarget && resolvedTarget !== "__latest__" && latestIdNow && resolvedTarget !== latestIdNow);
    // '히스토리 범위' — 최근 몇 개 답변까지 보낼지. 0 이면 제한 없음(서버가 전체 조립).
    //   마리나라 dryRun 의 includeHistory 는 잘라 주는 옵션이 없으므로, 제한을 두려면
    //   includeHistory 를 끄고 우리가 직접 잘라 넣는 수밖에 없다.
    const histTurns = wantTurns; // 위에서 조회 창을 넓힐 때 쓴 값과 같은 값
    // 뒤에서부터 어시스턴트 답변을 histTurns 개까지 세고, 그 턴의 사용자 발화까지 함께 남긴다.
    const cutRecentTurns = (arr) => {
      if (!(histTurns > 0)) return arr;
      let seen = 0, start = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i].role === "assistant") {
          seen++;
          if (seen > histTurns) { start = i + 1; break; }
        }
      }
      return arr.slice(start);
    };
    const keepForHistory = (m) => {
      if (!m || typeof m.content !== "string" || !m.content.trim()) return false;
      const ex = m.extra;
      if (ex && (ex.hiddenFromAI === true)) return false; // AI에게 숨긴 메시지 제외 (서버와 동일 규칙)
      return m.role === "user" || m.role === "assistant";
    };
    // 히스토리를 우리가 직접 잘라 넣어야 하는 경우:
    //   ① 과거 메시지 재생성 — 서버 includeHistory 는 대상 '이후'(미래) 메시지까지 넣어 컨텍스트를 오염시킨다.
    //   ② 히스토리 범위 제한(histTurns > 0) — 서버는 항상 전체를 조립하므로 여기서만 자를 수 있다.
    if (incHistory && (isPastTarget || histTurns > 0)) {
      // 대상이 오래돼 historyDepth 창 밖이면 전체를 다시 가져온다 (대상 본문 확보 겸용)
      const hasTargetInList = !!(msgList && msgList.some((m) => m && m.id === resolvedTarget));
      let full = hasTargetInList ? msgList : (isPastTarget ? await fetchMessages(chatId, 2000) : (msgList || []));
      if (Array.isArray(full)) {
        const ti = full.findIndex((m) => m && m.id === resolvedTarget);
        if (ti >= 0 && !tgtMsg) tgtMsg = full[ti]; // historyDepth 창 밖 대상도 본문 확보
        // 대상을 못 찾았는데 과거 재생성이면 자르지 않는다 — 어디까지가 '대상 이전'인지 알 수 없다.
        //   (턴 수 제한만 걸린 최신 캡처는 목록 끝까지를 기록으로 본다)
        const endIdx = ti >= 0 ? ti : (isPastTarget ? -1 : full.length);
        if (endIdx >= 0) {
          histCut = cutRecentTurns(full.slice(0, endIdx).filter(keepForHistory))
            .slice(-200) // 안전 상한
            .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
        }
      }
    }
    const useHistCut = !!(histCut && histCut.length);
    const tgtContent = tgtMsg && typeof tgtMsg.content === "string" ? tgtMsg.content.trim() : "";
    // 채팅 히스토리를 끈 캡처는 대상 메시지 한 개만 보고 상태를 쓴다. 그러면
    //   · 대상 턴의 사용자 발화({{user}}의 행동)를 못 보고
    //   · 사이 턴에 기록이 없을 때 그 턴들에서 일어난 변화를 통째로 모른 채 몇 턴 전 값을 이어 쓴다.
    //   → 마지막 상태 기록 다음부터 대상 직전까지(최대 GAP_CONTEXT_MAX_TURNS 턴)를 직접 넣는다.
    let gapBlocks = null;
    if (!incHistory && resolvedTarget) {
      let src = msgList || [];
      const needSrc = gapTurns > 0 && promptSrc && !src.some((m) => m && m.id === promptSrc.msgId);
      const needTgt = String(resolvedTarget).indexOf("__") !== 0 && !src.some((m) => m && m.id === resolvedTarget);
      if (needSrc || needTgt) {
        const total = await fetchMessageCount(chatId);
        src = (await fetchMessages(chatId, Number.isFinite(total) && total > 0 ? total + 1 : 2000)) || src;
      }
      let ti = src.findIndex((m) => m && m.id === resolvedTarget);
      if (ti < 0 && String(resolvedTarget).indexOf("__") === 0) {
        for (let i = src.length - 1; i >= 0; i--) { if (src[i] && src[i].role === "assistant") { ti = i; break; } }
      }
      if (ti >= 0) {
        let start = ti;
        if (gapTurns > 0) {
          const si = src.findIndex((m) => m && m.id === promptSrc.msgId);
          if (si >= 0 && si < ti) start = si + 1;
        }
        if (start === ti) { // 빈 턴 없음 → 대상 턴의 사용자 발화만
          while (start > 0 && src[start - 1] && src[start - 1].role !== "assistant") start--;
        }
        let seen = 0, cut = start;
        for (let i = ti - 1; i >= start; i--) {
          if (src[i] && src[i].role === "assistant" && ++seen > GAP_CONTEXT_MAX_TURNS) { cut = i + 1; break; }
        }
        const picked = src.slice(cut, ti).filter(keepForHistory)
          .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
        if (picked.length) {
          const head = gapTurns > 0
            ? `[마지막 상태 기록 이후 ~ 대상 메시지 직전까지의 대화${cut > start ? ` (앞부분 생략, 최근 ${GAP_CONTEXT_MAX_TURNS}턴)` : ""}. 기록이 빠진 ${gapTurns}턴 동안의 변화가 여기 있습니다 — 상태에 모두 반영하세요.]`
            : "[대상 메시지 직전의 사용자 발화입니다 — {{user}}의 행동·말도 상태에 반영하세요.]";
          gapBlocks = [{ role: "system", content: head }, ...picked];
        }
      }
    }
    const blocks = [];
    if (useHistCut) {
      blocks.push({ role: "system", content: "[아래는 대상 메시지 '직전'까지의 대화 기록입니다. 이 시점 이후의 전개는 아직 존재하지 않는 것으로 간주하고, 이후 내용을 참조하지 마세요.]" });
      histCut.forEach((b) => blocks.push(b));
    }
    if (gapBlocks) gapBlocks.forEach((b) => blocks.push(b));
    if (useCustomCards && customCardBlocks.length) {
      customCardBlocks.forEach((b) => blocks.push(b));
    }
    
    if (tgtContent) blocks.push({ role: "system", content: `[상태를 추출할 대상 메시지]\n${tgtContent}` });
    // 캐릭터 이름은 카드가 꺼져 있어도 항상 주입 (추출 대상 식별용)
    // 이 목록은 '이전에 출력됐던 이름'뿐 아니라 '캐릭터 카드에 배정된 이름'까지 합친 것 —
    // 즉 지금까지 한 번도 등장 안 한 카드 캐릭터도 포함되므로, 아래처럼 명시적으로
    // "전원 필수 출력"을 못박아야 AI가 실제로 빠짐없이 STATUS 블록을 만든다.
    // ※ 장면 전용 스킨(캐릭터 필드 없음)에서는 subjects를 출력하지 않으므로 이 블록도 넣지 않는다.
    const statusHasCharFields = Array.isArray(status.fields) && status.fields.length > 0;
    const subjectNames = statusHasCharFields ? await resolveSubjectNames(chatId, status, resolvedTarget || null) : [];
    if (subjectNames.length) {
      blocks.push({
        role: "system",
        content: `필수 등장 인물 목록(전원 빠짐없이 출력): ${subjectNames.join(", ")}\n`
          + `위 목록의 모든 대상에 대해 STATUS 블록을 하나씩 출력하세요. 이번 장면에 직접 등장하지 않는 대상도 예외 없이 포함하되, 대화에 그 인물의 변화 근거가 전혀 없을 때만 마지막으로 알려진 상태(위치·행동 등)를 유지하고, 한 줄이라도 근거가 있으면 반드시 갱신하세요. 목록에 없는 대상을 임의로 추가하거나, 목록에 있는 대상을 생략하지 마세요.\n`
          + `label 은 위 목록의 표기를 글자 그대로 씁니다.\n`
          + `본문에 목록에 없는 이름·호칭이 나오면, 먼저 그것이 목록 인물을 가리키는 애칭·별명·호칭·직책·성/이름 일부인지 판단하세요. 판단 근거는 캐릭터 카드·로어북·대화 기록에 이미 들어 있습니다. 같은 인물이면 새 항목을 만들지 말고 목록 표기 그대로인 항목에 그 내용을 반영합니다. 목록의 누구와도 다른 인물임이 분명할 때만 새 항목을 추가하세요. 괄호로 상태를 덧붙여(예: 이름(부상)) 항목을 따로 만드는 것도 금지합니다 — 같은 인물이 탭 두 개로 갈라집니다.`,
      });
    }
    blocks.push({ role: "system", content: fullMessage });
    const sentChars = blocks.reduce((n, b) => n + (b.content ? b.content.length : 0), 0);
    // 재상기(reminder) 블록: 히스토리·메시지 뒤에 배치해 컨텍스트를 읽고 난 직후 지시를 한번 더 보여준다.
    // 모델이 "가장 마지막에 본 내용"을 우선하는 특성을 활용해 RP 지속 경향을 차단한다.
    const reminderText = "■ 상기: RP를 계속하지 마세요. 이 시점에서 오직 us-status 코드블록 하나만 출력하고 종료합니다."
      + " 블록 내용은 유효한 JSON만 허용 — 큰따옴표 키/값, 최상위 subjects/scene. YAML·평문 금지."
      + "\n■ 값은 대화 내용이 1순위, 이전 상태창 값은 출발점일 뿐입니다. 인물마다 대화 속 변화를 확인해 갱신하고, 근거가 없는 값만 유지하세요."
      + (opts.extraPrompt ? `\n■ 추가 요청사항(반드시 반영): ${opts.extraPrompt}` : "");
    const reqBody = {
      chatId,
      promptParts: {
        // useHistCut: 과거 대상 재생성 — 서버 전체 히스토리 대신 위에서 잘라 넣은 기록만 사용
        includeHistory: useHistCut ? false : incHistory,
        includePersona: incPersona,
        includeCharacters: useCustomCards ? false : incCharacters, // 숨김 제외 시 커스텀 카드 블록으로 대체
        includeLorebook: incLorebook,
        includeChatSummary: incChatSummary,
        extensionBlocks: blocks,
        // 컨텍스트(히스토리·마지막 메시지) 뒤에 재상기 블록을 놓는 조립 순서
        //  chatSummary 는 서버 기본 순서와 같이 캐릭터 카드 뒤·로어북 앞 (2.3.x·2.4.0 모두 지원하는 키)
        order: ["extensionBlocks", "persona", "characters", "chatSummary", "lorebook", "history", "lastMessage", "presetText"],
        presetText: reminderText,
      },
      streaming: false,
    };
    return { reqBody, sentChars, incHistory, incChatSummary, incLorebook, incCharacters, incPersona };
  }
  async function captureApiInner(chatId, st, forceSyncMeta, extraPrompt, targetMsgId, targetSwipe, forceFullContext, clearCurrentOnFailure) {
    const status = statusForChat(chatId);
    if (!status || (!(status.fields && status.fields.length) && !(status.sceneFields && status.sceneFields.length))) return;
    // 메타 동기화는 반드시 '캡처 대상 chatId'에 바인딩된 경로로 한다.
    //  기존의 syncMessages({forApi:true})는 내부에서 getChatId()를 다시 읽어,
    //  캡처 도중 다른 채팅으로 이동해 있으면 엉뚱한 채팅 메타를 갱신하고
    //  대상 채팅은 stale 메타(__latest__ 폴백)로 저장되는 문제가 있었다.
    if (forceSyncMeta || !(chatId in latestAsstByChat)) await syncAssistantMetaNow(chatId, st.historyDepth);
    // 저장 대상 메시지: 호출자가 명시적으로 넘긴 msgId, 없으면 최신 어시스턴트
    const latestMeta = latestAsstByChat[chatId] || { id: "__latest__", swipe: 0 };
    const latestMid = latestMeta.id || "__latest__";
    const resolvedTarget = (typeof targetMsgId === "string" && targetMsgId) ? targetMsgId : latestMid;
    // 대상 메시지의 활성 스와이프. /messages 의 activeSwipeIndex(=swipeByMsgByChat)가 출처.
    // ※ 메시지 DOM에는 스와이프 속성이 없어 DOM에서 읽을 수 없다 — 반드시 서버 메타에서 가져온다.
    const resolveTargetSwipe = () => Number.isFinite(targetSwipe)
      ? targetSwipe
      : resolveSwipeForMsg(chatId, resolvedTarget, (resolvedTarget === latestMid ? (latestMeta.swipe || 0) : 0));
    let resolvedSwipe = resolveTargetSwipe();
    diag.captureMsgId = resolvedTarget; diag.captureSwipe = resolvedSwipe; // 진단: 저장 대상 턴/스와이프
    const { reqBody, sentChars } = await buildCaptureReqBody(chatId, st, status, { extraPrompt, resolvedTarget, forceFullContext });
    diag.lastInChars = sentChars;
    if (st.apiConnectionId) reqBody.connectionId = st.apiConnectionId;
    reqBody.skipPreset = true; // 캡처는 채팅 프리셋을 따르지 않는다 (promptParts로 직접 조립)
    const myRunId = genRunId();
    reqBody.runId = myRunId;
    activeDryRunIdByChat[chatId] = myRunId;
    if (chatId === getChatId()) invalidateFloat();
    try {
      const r = await marinara.apiFetch(`/generate/dryRun`, { method: "POST", body: JSON.stringify(reqBody) });
      if (activeDryRunIdByChat[chatId] === myRunId) delete activeDryRunIdByChat[chatId];
      if (r && r.aborted) {
        if (clearCurrentOnFailure) deleteMsgEntry(chatId, resolvedTarget, resolvedSwipe);
        setCaptureNotice(chatId, "aborted", resolvedTarget, resolvedSwipe);
        return { status: "aborted" }; // 사용자가 중지 — 팝업 알림 없이 상태창에만 표시
      }
      diag.apiErr = null; diag.apiTs = Date.now();
      const content = r && typeof r.content === "string" ? r.content : "";
      diag.lastOutChars = content.length;
      // 생성은 됐다는데 출력이 비어 있음 → 하드 실패로 취급 (실패 팝업 대상)
      if (!content.trim()) {
        diag.blockFound = false; diag.subjectCount = 0;
        if (clearCurrentOnFailure) deleteMsgEntry(chatId, resolvedTarget, resolvedSwipe);
        setCaptureNotice(chatId, "empty", resolvedTarget, resolvedSwipe);
        return { status: "empty" };
      }
      // dryRun이 끝난 시점엔 재생성 스와이프가 서버에 확실히 커밋돼 있다.
      // 시작 전 고정값 대신 "지금" 최신 메타로 대상 스와이프를 다시 읽어 덮어쓰기를 막는다.
      await syncAssistantMetaNow(chatId, st.historyDepth);
      resolvedSwipe = resolveTargetSwipe();
      diag.captureSwipe = resolvedSwipe;
      const subjects = parseSubjects(content);
      const salvagedSubjects = consumeSalvageFlag();
      const scene = parseScene(content);
      // parseScene 이 또 한 번 파싱하므로 두 호출의 복구 여부를 합쳐서 본다
      const salvagedPartial = salvagedSubjects || consumeSalvageFlag();
      diag.blockFound = subjects.length > 0 || !!scene; diag.subjectCount = subjects.length;
      diag.salvagedPartial = salvagedPartial;
      const recognized = subjects.length > 0 || !!scene;
      // API 가 출력을 주면 인식 여부와 무관하게 '순수 원문'을 출력 결과 슬롯에 항상 보관한다.
      //  ※ 턴/스와이프 표기는 어긋나는 경우가 잦아 출력 결과에서는 계산·표시하지 않는다.
      lastRawOutputByChat[chatId] = {
        text: content, msgId: resolvedTarget,
        recognized, ts: Date.now(),
      };
      refreshRawOutputTabIfOpen();
      if (recognized) {
        setCaptureNotice(chatId, null);
        if (salvagedPartial) salvagedNoticeByChat[chatId] = Date.now();
        const prevSubs = getMsgValues(chatId, resolvedTarget, resolvedSwipe);
        let keepSubjects, cardNames = [];
        if (Array.isArray(status.fields) && status.fields.length) {
          // 캐릭터 누락 방지: 이번에 안 나온 캐릭터는 직전 로스터에서 이월해 유지한다.
          const roster = priorRosterSubjects(chatId, resolvedTarget, status.id, resolvedSwipe);
          keepSubjects = subjects.length
            ? mergeSubjectsCarryOver(roster || prevSubs, subjects)
            : (prevSubs || roster || []);
          // 캐릭터 카드에 배정된 캐릭터는 장면에 안 나와도 기본적으로 항상 탭에 있어야 한다.
          cardNames = await ensureCardRoster(chatId);
          if (!cardNames.length) cardNames = await ensureCardRoster(chatId, { force: true }); // 빈 로스터면 즉시 1회 재조회 (일시 오류 복구)
          keepSubjects = dropDeleted(chatId, mergeCardRosterIntoSubs(keepSubjects, cardNames, chatId));
        } else {
          // 장면 전용 스킨: 캐릭터 값·카드 로스터 이월을 하지 않고 subjects를 비워 저장한다.
          keepSubjects = [];
        }
        // 진단: 이번 캡처의 로스터/파싱/최종 라벨 기록 — 콘솔에서 __usDebug.dump() 로 확인 가능
        diag.lastCardNames = cardNames.slice();
        diag.lastParsedLabels = subjects.map((s) => s && s.label);
        diag.lastKeepLabels = keepSubjects.map((s) => s && s.label);
        console.log("[User Status] 캡처 저장 진단:", { chatId, 카드로스터: diag.lastCardNames, AI출력라벨: diag.lastParsedLabels, 최종저장라벨: diag.lastKeepLabels });
        const keepScene = scene || getMsgScene(chatId, resolvedTarget, resolvedSwipe) || null;
        const saved = setMsgEntry(chatId, status.id, resolvedTarget, resolvedSwipe, { scene: keepScene, subjects: keepSubjects });
        if (saved) diag.captureTs = Date.now();
        hideRawBlocksInChat();
        // renderFloat()는 시그니처 캐시(lastFloatSig)가 같으면 그냥 넘어갈 수 있다.
        //  방금 값이 바뀐 직후이므로 캐시를 무효화해 확실히 다시 그린다.
        invalidateFloat();
        refreshHistoryUiIfOpen();
        // saved=false → 직전과 글자까지 동일한 값(변화 없음)
        return { status: saved ? "saved" : "nochange" };
      }
      // 출력은 있으나 상태창 형식 미인식
      if (clearCurrentOnFailure) deleteMsgEntry(chatId, resolvedTarget, resolvedSwipe);
      setCaptureNotice(chatId, "noformat", resolvedTarget, resolvedSwipe);
      return { status: "noformat" };
    } catch (e) {
      diag.apiErr = String((e && e.message) || e);
      diag.apiTs = Date.now(); // 에러도 시각 갱신 — 수동 새로고침의 에러 분류가 정상 동작하도록
      if (activeDryRunIdByChat[chatId] === myRunId) delete activeDryRunIdByChat[chatId];
      if (clearCurrentOnFailure) deleteMsgEntry(chatId, resolvedTarget, resolvedSwipe);
      setCaptureNotice(chatId, "error", resolvedTarget, resolvedSwipe);
      return { status: "error", message: diag.apiErr };
    }
  }
  function captureNow(forceSyncMeta, explicitChatId) {
    const chatId = explicitChatId || getChatId();
    const st = getSettings(chatId);
    if (!st.enabled) return;
    if (st.dataMode === DATA_MODES.api) return captureApi(forceSyncMeta, undefined, undefined, undefined, undefined, chatId);
    return syncMessages({ chatId });
  }

  // ── 수동 값 입력 (API 미사용) ──────────────────────────────
  // 현재 표시 대상(턴/스와이프)을 결정한다. currentRenderMeta가 포커스/최신을 알아서 처리.
  //  ※ 스와이프 해석은 '기록 저장(captureApi)'과 완전히 동일한 소스를 쓴다:
  //    서버 /messages 의 activeSwipeIndex(swipeByMsgByChat) 1순위.
  //    DOM 카운터(resolveSwipeForMsg)는 재생성 직후 서버보다 먼저 갱신되는 과도기 때문에
  //    표시용으로만 쓰이는데, 저장까지 DOM 기준으로 하면 기록의 턴-스와이프와 어긋난다.
  function manualTargetMeta(chatId) {
    const meta = currentRenderMeta(chatId);
    const msgId = meta.id;
    let swipe = Number.isFinite(meta.swipe) ? meta.swipe : 0;
    const srvMap = swipeByMsgByChat[chatId];
    const srv = srvMap ? Number.parseInt(srvMap[msgId], 10) : NaN;
    if (Number.isFinite(srv)) swipe = srv;
    return { msgId, swipe };
  }
  // (구 ensureManualEntry 제거 — '값 직접 입력'이 열자마자 빈 항목을 저장하던 동작 폐지.
  //  저장은 값 편집 폼의 [저장] 버튼에서만 일어난다.)

  // 출력(JSON)으로 현재 턴 생성하기 — 자동 파싱 후 실패하면 수동 입력 모달.
  //   prefillFromRaw: true 면 lastRawOutputByChat 원문을 텍스트칸에 채워 자동 파싱 시도.
  async function openManualJsonModal(chatId, opts) {
    opts = opts || {};
    const status = statusForChat(chatId);
    if (!status) { openPanel(); return; }
    // 저장 대상(턴/스와이프)을 최신 서버 메타로 확정 — 기록 저장과 같은 값을 보게 한다.
    try { await syncAssistantMetaNow(chatId, getSettings(chatId).historyDepth); } catch (_) {}
    const raw = chatId && lastRawOutputByChat[chatId] ? lastRawOutputByChat[chatId] : null;
    const prefill = (opts.prefillFromRaw && raw && raw.text) ? raw.text : "";

    // 자동 파싱 먼저 시도 (원문이 있으면)
    if (opts.prefillFromRaw && prefill) {
      const okAuto = applyManualJson(chatId, status, prefill, { silent: true });
      if (okAuto) {
        showFloatNotice("출력에서 값을 인식해 적용했습니다.", "info");
        return;
      }
      // 자동 실패 → 아래 모달로 폴백(텍스트 채워서 사용자가 수정)
    }

    const overlayId = "us-manual-json-modal";
    const old = document.getElementById(overlayId); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = overlayId;
    ov.style.cssText = "position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-family:inherit;";
    const box = document.createElement("div");
    box.style.cssText = [
      "width:min(440px,92vw)", "max-height:82vh", "overflow:auto", "box-sizing:border-box",
      "background:var(--us-float-bg,#222)", "border:1px solid var(--us-float-border,#888)",
      "border-radius:12px", "padding:16px", "color:var(--us-float-fg,#eee)",
      "box-shadow:0 14px 40px rgba(0,0,0,.55)", "font-size:13px", "line-height:1.5",
    ].join(";");
    const _floatEl = document.getElementById(FLOAT_ID);
    if (_floatEl) { try { const cs = getComputedStyle(_floatEl); WIDGET_FLOAT_VARS.forEach((v) => { const val = cs.getPropertyValue(v); if (val && val.trim()) box.style.setProperty(v, val.trim()); }); } catch (e) {} }
    const tgt = manualTargetMeta(chatId);
    const turnNo = computeTurn(chatId, tgt.msgId);
    const turnLabel = turnNo ? (turnNo + "번째 턴") : "현재 턴";
    box.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px;">출력에서 값 가져오기</div>
      <div style="font-size:11px;opacity:.75;margin-bottom:10px;">${esc(turnLabel)} · 스와이프 ${tgt.swipe + 1} 에 저장됩니다. 상태창 JSON 또는 출력 원문을 붙여넣으세요.</div>
      <textarea class="us-mj-input" spellcheck="false" style="width:100%;min-height:160px;box-sizing:border-box;resize:vertical;background:var(--us-float-secondary,#1a1a1a);color:var(--us-float-fg,#eee);border:1px solid var(--us-float-border,#555);border-radius:8px;padding:9px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;"></textarea>
      <div class="us-mj-err" style="color:var(--us-float-primary,#e55);font-size:11px;min-height:14px;margin:6px 2px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
        <button class="us-mj-cancel" style="background:transparent;border:1px solid var(--us-float-border,#555);color:var(--us-float-muted,#aaa);cursor:pointer;font-size:12px;padding:6px 12px;border-radius:8px;font-family:inherit;">취소</button>
        <button class="us-mj-apply" style="background:var(--us-float-primary,#6c8cff);border:1px solid transparent;color:var(--us-float-primary-fg,#fff);cursor:pointer;font-size:12px;padding:6px 14px;border-radius:8px;font-family:inherit;font-weight:600;">적용</button>
      </div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const ta = box.querySelector(".us-mj-input");
    const errEl = box.querySelector(".us-mj-err");
    if (prefill) ta.value = prefill;
    ta.focus();
    const close = () => ov.remove();
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    box.querySelector(".us-mj-cancel").onclick = close;
    box.querySelector(".us-mj-apply").onclick = () => {
      const text = ta.value.trim();
      if (!text) { errEl.textContent = "내용을 입력하세요."; return; }
      const ok = applyManualJson(chatId, status, text, { silent: false, onError: (msg) => { errEl.textContent = msg; } });
      if (ok) { close(); showFloatNotice("값을 적용했습니다.", "info"); }
    };
  }

  // 텍스트(상태창 JSON 또는 원문)를 파싱해 현재 턴/스와이프에 저장. 성공 true.
  function applyManualJson(chatId, status, text, opts) {
    opts = opts || {};
    const fail = (msg) => { if (!opts.silent && opts.onError) opts.onError(msg); return false; };
    let subjects = null, scene = null;
    // 1) 우선 전체 텍스트를 parseSubjects/parseScene 로 — 코드블록·느슨한 JSON·상태창 형식 모두 커버
    try {
      subjects = parseSubjects(text);
      scene = parseScene(text);
    } catch (e) { subjects = null; scene = null; }
    // 2) 그래도 없으면, 순수 JSON 객체로 직접 파싱 시도
    if ((!subjects || !subjects.length) && !scene) {
      try {
        const obj = JSON.parse(text);
        if (obj && Array.isArray(obj.subjects)) subjects = obj.subjects;
        if (obj && obj.scene && typeof obj.scene === "object") scene = obj.scene;
        // {라벨:{필드:값}} 또는 [{label,values}] 같은 변형도 허용
        if ((!subjects || !subjects.length) && Array.isArray(obj)) subjects = obj;
      } catch (e) { /* not pure json */ }
    }
    if ((!subjects || !subjects.length) && !scene) {
      return fail("인식되는 값이 없습니다.");
    }
    const { msgId, swipe } = manualTargetMeta(chatId);
    // 카드에 배정된 캐릭터는 수동 입력에도 항상 탭으로 유지한다 (장면 미등장 시 빈 값).
    //  숨김 여부는 표시 단계(눈 토글)에서 처리 — 값 자체는 보존.
    //  장면 전용 스킨(캐릭터 필드 없음)은 subjects를 비워 저장 — 캐릭터 영역이 없으므로 로스터 병합 불필요.
    const charFieldsOn = status && Array.isArray(status.fields) && status.fields.length > 0;
    let keepSubjects;
    if (charFieldsOn) {
      keepSubjects = (subjects && subjects.length) ? subjects : [{ label: "", values: {} }];
      keepSubjects = dropDeleted(chatId, mergeCardRosterIntoSubs(keepSubjects, getCardRosterSync(chatId), chatId));
    } else {
      keepSubjects = [];
    }
    setMsgEntry(chatId, status.id, msgId, swipe, {
      scene: scene || null,
      subjects: keepSubjects,
    });
    // 수동 입력 표시(다른 곳의 편집 저장과 동일하게 manualIds 마킹)
    if (!manualIds[chatId]) manualIds[chatId] = new Set();
    manualIds[chatId].add(msgId + "#" + swipe);
    hideRawBlocksInChat();
    renderFloat();
    refreshHistoryUiIfOpen();
    return true;
  }
  // 플로팅 창 새로고침 헬퍼 (일반 새로고침 + 프롬프트 재생성 공통 사용)
  // ── 토스트 알림 ──
  // ── 플로팅 상태창 위에 뜨는 알림 레이어 (기존 토스트 대체) ──
  // #us-float 내부에 붙여 --us-float-* 스킨 변수를 그대로 따라가고, 위치도 플로팅 창에 고정된다.
  // renderFloat가 innerHTML을 다시 그릴 때마다 사라지므로 상태를 보관해 재부착한다.
  let activeFloatNotice = null; // { msg, type, action } | null
  function showFloatNotice(msg, type, action) {
    activeFloatNotice = { msg, type: type || "info", action: action || null, chatId: getChatId() };
    renderFloatNotice();
  }
  function dismissFloatNotice() {
    activeFloatNotice = null;
    const e = document.getElementById(FLOAT_NOTICE_ID);
    if (e) e.remove();
  }
  // ── 실패 모달 (생성 실패·API 오류) ──
  // 화면 중앙, 2줄, 작은 팝업. 블랙 오버레이로 뒤 클릭 차단(모달). 오버레이/X 클릭으로 닫힘.
  const CAPTURE_MODAL_ID = "us-capture-modal";
  let activeCaptureModal = null; // { line1, line2, action, chatId } | null
  function hideCaptureModalDom() { const e = document.getElementById(CAPTURE_MODAL_ID); if (e) e.remove(); }
  // 사용자가 직접 닫음(X/오버레이) 또는 새 결과로 무효화 → 상태까지 제거(복원 안 됨)
  function dismissCaptureModal() { activeCaptureModal = null; hideCaptureModalDom(); }
  // 실패 모달을 띄운다 (캡처 대상 chatId에 바인딩 → dryRun 도중 채팅을 옮겨도 올바른 채팅에만 표시).
  function showCaptureModal(chatId, line1, line2, action) {
    activeCaptureModal = { line1, line2, action: action || null, chatId: chatId || getChatId() };
    renderCaptureModal();
  }
  function renderCaptureModal() {
    hideCaptureModalDom();
    if (!activeCaptureModal) return;
    // 자신이 생성된 채팅에서만 표시 (다른 채팅에 있는 동안은 숨김, 상태는 유지 → 돌아오면 복원)
    if (activeCaptureModal.chatId && activeCaptureModal.chatId !== getChatId()) return;
    const { line1, line2, action } = activeCaptureModal;
    const floatEl = document.getElementById(FLOAT_ID);
    const ov = document.createElement("div");
    ov.id = CAPTURE_MODAL_ID;
    // 오버레이는 '항상' 뷰포트 전체를 덮고, 대화상자는 '항상' 화면 정중앙에 고정한다.
    //  이전 방식(플로팅 창 rect 를 측정해 그 위에 커버/박스를 배치)은 생성 중 창이 줄었다가
    //  실패 시점에 이전 메시지로 창 높이가 되돌아오면 rect 가 낡은 값이 되어
    //  검은 커버가 창을 다 못 덮고 박스도 중앙을 벗어나는 문제가 있었다.
    ov.style.cssText = "position:fixed;z-index:100000;inset:0;pointer-events:auto;background:rgba(0,0,0,.5);font-family:inherit;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    const BOX_W = Math.min(220, Math.floor(window.innerWidth * 0.8));
    box.style.cssText = [
      "position:relative", "pointer-events:auto",
      "width:" + BOX_W + "px",
      "background:var(--us-float-bg,#222)",
      "border:1px solid var(--us-float-border,#888)",
      "border-radius:12px", "padding:14px 14px 12px",
      "color:var(--us-float-fg,#eee)",
      "box-shadow:0 10px 30px rgba(0,0,0,.5)",
      "text-align:center", "font-size:13px", "line-height:1.45",
      "box-sizing:border-box",
    ].join(";");
    if (floatEl) {
      try {
        const cs = getComputedStyle(floatEl);
        WIDGET_FLOAT_VARS.forEach((v) => { const val = cs.getPropertyValue(v); if (val && val.trim()) box.style.setProperty(v, val.trim()); });
      } catch (e) {}
    }
    const x = document.createElement("button");
    x.innerHTML = ICON.close;
    x.setAttribute("aria-label", "닫기");
    x.style.cssText = "position:absolute;top:6px;right:8px;background:transparent;border:none;color:var(--us-float-muted,#999);cursor:pointer;font-size:12px;line-height:1;padding:0;font-family:inherit;";
    x.onclick = dismissCaptureModal;
    const t1 = document.createElement("div");
    t1.textContent = (line1 || "");
    t1.style.cssText = "font-weight:600;margin-bottom:3px;";
    const t2 = document.createElement("div");
    t2.textContent = (line2 || "");
    t2.style.cssText = "opacity:.85;font-size:11px;";
    box.appendChild(x); box.appendChild(t1); box.appendChild(t2);
    if (action && action.label) {
      const act = document.createElement("button");
      act.textContent = action.label;
      act.style.cssText = "margin-top:10px;background:var(--us-float-secondary,#333);border:1px solid var(--us-float-border,#555);color:var(--us-float-fg,#eee);cursor:pointer;font-size:11px;line-height:1;padding:5px 10px;border-radius:7px;font-family:inherit;";
      act.onclick = () => { dismissCaptureModal(); try { action.onClick && action.onClick(); } catch (e) {} };
      box.appendChild(act);
    }
    ov.appendChild(box);
    // 박스 바깥(오버레이) 클릭으로 닫기
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) dismissCaptureModal(); });
    document.body.appendChild(ov);
  }
  function renderFloatNotice() {
    if (!activeFloatNotice) return;
    // 알림은 자신이 생성된 채팅에서만 표시 (다른 채팅으로 넘어가면 가리지 않도록)
    if (activeFloatNotice.chatId && activeFloatNotice.chatId !== getChatId()) {
      const e = document.getElementById(FLOAT_NOTICE_ID); if (e) e.remove();
      return;
    }
    let host = document.getElementById(FLOAT_ID);
    if (!host) { renderFloat(); host = document.getElementById(FLOAT_ID); }
    if (!host) return;
    const oldEl = document.getElementById(FLOAT_NOTICE_ID);
    if (oldEl) oldEl.remove();
    const { msg, type, action } = activeFloatNotice;
    const accent = type === "error" ? "var(--us-float-primary,#e55)" : "var(--us-float-border,#888)";
    const el = document.createElement("div");
    el.id = FLOAT_NOTICE_ID;
    el.style.cssText = [
      "position:absolute", "left:6px", "right:6px", "top:6px", "z-index:30",
      "background:var(--us-float-bg,#222)",
      `border:1px solid ${accent}`,
      "border-radius:10px", "padding:9px 10px", "font-size:12px",
      "color:var(--us-float-fg,#eee)",
      "box-shadow:0 6px 18px rgba(0,0,0,.4)",
      "line-height:1.45", "font-family:inherit",
    ].join(";");
    const top = document.createElement("div");
    top.style.cssText = "display:flex;align-items:flex-start;gap:8px;";
    const text = document.createElement("span");
    text.textContent = (type === "info" ? "ℹ " : "⚠ ") + msg;
    text.style.cssText = "flex:1;";
    const x = document.createElement("button");
    x.innerHTML = ICON.close;
    x.setAttribute("aria-label", "닫기");
    x.style.cssText = "background:transparent;border:none;color:var(--us-float-muted,#999);opacity:.85;cursor:pointer;font-size:12px;line-height:1;padding:0;flex:none;margin-top:1px;font-family:inherit;";
    x.onclick = dismissFloatNotice;
    top.appendChild(text); top.appendChild(x);
    el.appendChild(top);
    if (action && action.label) {
      const act = document.createElement("button");
      act.textContent = action.label;
      act.style.cssText = "margin-top:7px;background:var(--us-float-secondary,#333);border:1px solid var(--us-float-border,#555);color:var(--us-float-fg,#eee);cursor:pointer;font-size:11px;line-height:1;padding:5px 9px;border-radius:7px;font-family:inherit;";
      act.onclick = () => { try { action.onClick && action.onClick(); } catch (e) {} };
      el.appendChild(act);
    }
    const pos = getComputedStyle(host).position;
    if (pos === "static" || !pos) host.style.position = "relative";
    host.appendChild(el);
  }
  // 하위호환: 기존 showUsToast 호출을 모두 플로팅 알림으로 라우팅
  function showUsToast(msg, type, action) { showFloatNotice(msg, type, action); }

  // ── 캡처 결과 알림 (수동 새로고침 + 자동 캡처 공용) ──
  //   saved/aborted → 알림 없음 / empty,error → 실패·오류 / nochange → 변화 없음(quiet면 생략)
  //   noformat → 형식 미인식 안내 + "원문 보기"(설정의 출력 결과 탭으로 이동)
  function notifyCaptureResult(chatId, result, opts) {
    opts = opts || {};
    if (!result || !result.status) return;
    // 알림은 '그 결과가 난 채팅'을 보고 있을 때만 띄운다.
    //  자동 캡처는 비동기라, A채팅 캡처가 끝나기 전에 B채팅으로 옮기면
    //  A의 실패 알림이 B에 떠서 어느 채팅 얘기인지 헷갈리게 된다.
    if (chatId && getChatId() !== chatId) return;
    // 새 캡처 결과가 나오면 이전 알림/모달은 먼저 닫는다 (성공 시 묵은 실패 모달이 남지 않도록)
    dismissFloatNotice();
    dismissCaptureModal();
    switch (result.status) {
      case "saved":
        // 잘린 출력을 복구해 저장한 경우에만 안내 (정상 저장은 조용히 넘어간다)
        if (salvagedNoticeByChat[chatId]) {
          delete salvagedNoticeByChat[chatId];
          if (!opts.quiet) showFloatNotice("출력이 중간에서 끊겨 인식된 부분까지만 저장했습니다", "warn", { label: "출력 결과 보기", onClick: () => openRawOutputTab(chatId) });
        }
        return;
      case "aborted":
        return;
      case "error":
        // 인라인 모드: 브라우저 중앙 모달 대신 '최신' 상태창 안에 표시한다.
        //   실패 시 해당 스와이프 기록이 지워지므로(clearCurrentOnFailure) 최신 창 중앙에
        //   오류 문구가 뜬다. 실패 대상이 최신 창 표시 대상과 다르면 창 위 알림으로 보완.
        if (isInlineDisplayMode()) {
          if (!captureNoticeForMeta(chatId, currentRenderMeta(chatId))) {
            showFloatNotice("API 오류 — 상태값을 가져오지 못했습니다", "error", { label: "출력 결과 보기", onClick: () => openRawOutputTab(chatId) });
          }
          invalidateFloat();
          return;
        }
        showCaptureModal(chatId, "API 오류가 발생했습니다", "상태값을 가져오지 못했습니다", { label: "출력 결과 보기", onClick: () => openRawOutputTab(chatId) });
        return;
      case "empty":
        if (isInlineDisplayMode()) {
          if (!captureNoticeForMeta(chatId, currentRenderMeta(chatId))) {
            showFloatNotice("생성에 실패했습니다 — 출력을 받지 못했습니다", "error");
          }
          invalidateFloat();
          return;
        }
        showCaptureModal(chatId, "생성에 실패했습니다", "출력을 받지 못했습니다");
        return;
      case "nochange":
        if (!opts.quiet) showFloatNotice("이전과 동일한 상태값 — 변화 없음으로 처리됩니다", "warn");
        return;
      case "noformat":
        showFloatNotice("출력 형식을 인식하지 못했습니다", "warn", { label: "원문 보기", onClick: () => openRawOutputTab(chatId) });
        return;
    }
  }

  // "원문 보기" → 별도 모달 대신 설정창의 '출력 결과' 탭을 연다. 알림은 닫는다.
  function openRawOutputTab(chatId) {
    dismissFloatNotice();
    // 패널 열기 전에 탭을 지정해두면 openPanel이 rawout으로 바로 열린다 (이중 렌더 방지).
    config.ui.panelTab = "rawout";
    if (!document.getElementById(PANEL_ID)) {
      openPanel(); // selectTab("rawout")으로 바로 열림
    } else {
      // 패널이 이미 열려 있으면 탭만 전환
      rebuildPanelTabBar();
      if (panelSelectTab) panelSelectTab("rawout");
    }
  }

  // '출력 결과' 탭이 현재 열려 있으면 다시 그린다 (원문 보관/갱신 직후 호출)
  function refreshRawOutputTabIfOpen() {
    if (!config || !config.ui || config.ui.panelTab !== "rawout") return;
    if (!document.getElementById(PANEL_ID)) return;
    const body = document.getElementById("us-tabbody");
    if (body) renderRawOutputTab(body);
  }

  async function doFloatRefresh(extraPrompt, targetMeta) {
    if (refreshing) return;
    const chatId = getChatId();
    captureNoticeByChat[chatId] = null;
    const prevCaptureTs = diag.captureTs;
    // 스피너가 도는 동안에도 '이전 메시지' 라벨이 유지되도록, 포커스가 이전 메시지면
    // refreshing=true(=isBusy) 설정 전에 genTargetByChat를 채워둔다.
    const stEarly = getSettings(chatId);
    let refreshSetGenTgt = false;
    if (stEarly.dataMode === DATA_MODES.api && !(chatId in genTargetByChat)) {
      const f0 = targetMeta && targetMeta.id ? targetMeta : focusedMsgByChat[chatId];
      const l0 = latestAsstByChat[chatId];
      if (f0 && f0.id && l0 && l0.id && f0.id !== l0.id) {
        genTargetByChat[chatId] = f0.id;
        refreshSetGenTgt = true;
      }
    }
    refreshing = true; refreshingChatId = chatId; refreshingStartTs = Date.now(); invalidateFloat();
    let apiResult = null;
    try {
      // 이후 로직은 전부 '시작 시점 chatId'에 바인딩 — await 도중 다른 채팅으로 이동해도
      // S()(=지금 보는 채팅)가 아닌 이 채팅의 설정/캡처를 유지한다.
      const st = getSettings(chatId);
      // 수동 새로고침: 호출 시점의 포커스 메시지를 스냅샷해서 명시적으로 넘김
      // (captureApi 내부에서 focusedMsgByChat를 보지 않으므로 레이스 컨디션 없음)
      if (st.dataMode === DATA_MODES.api) {
        const focused = targetMeta && targetMeta.id ? targetMeta : focusedMsgByChat[chatId];
        const latest = latestAsstByChat[chatId];
        const isOnPrior = focused && focused.id && latest && latest.id && focused.id !== latest.id;
        const tgtId = isOnPrior ? focused.id : (latest && latest.id) || null;
        // 스와이프 고정은 '대상을 알 때'만. 기록 삭제 직후처럼 latest 메타가 비어 있으면
        // undefined 를 넘겨 captureApiInner 가 서버 최신 메타로 스와이프를 해석하게 한다.
        // (예전엔 이때 0 이 고정으로 넘어가 실제 활성 스와이프(예: 2)가 아닌 스와이프 0 에
        //  저장됐고, 화면엔 여전히 '값 없음' → 삭제 후 재생성이 안 되는 것처럼 보였다)
        const tgtSwipe = isOnPrior
          ? (((swipeByMsgByChat[chatId] || {})[focused.id]) ?? focused.swipe ?? 0)
          : (latest && latest.id ? (latest.swipe || 0) : undefined);
        // 첫 캡처(저장값 없음)면 풀 컨텍스트로 시작할지 물어본다 (수동: 항상 질문)
        const forceFull = maybeAskFirstCapture(chatId, { force: true });
        // clearCurrentOnFailure=true: 실패(오류·빈 출력·미인식·중지)하면 대상 스와이프의 기존 기록을
        // 지운다 — 이전 값이 실패 뒤에도 현재 상태처럼 계속 표시되지 않게 (자동 캡처와 동일 규칙).
        apiResult = await captureApi(true, extraPrompt, tgtId, tgtSwipe, forceFull, chatId, true);
      }
      else if (targetMeta && targetMeta.id) await syncMessages({ chatId, targetMsgId: targetMeta.id });
      else await captureNow(true, chatId);
    } catch (e) {
      if (getSettings(chatId).dataMode === DATA_MODES.api && !apiResult) {
        apiResult = { status: "error", message: String((e && e.message) || e) };
      }
    }
    // 새로고침이 직접 설정한 경우에만 정리 (phase 핸들러가 설정한 값은 건드리지 않음)
    if (refreshSetGenTgt) delete genTargetByChat[chatId];
    refreshing = false; refreshingChatId = null; refreshingStartTs = 0;
    if (!dryRunAborted && chatId) {
      if (getSettings(chatId).dataMode === DATA_MODES.api) {
        // captureApiInner가 돌려준 결과로 분기 (수동 새로고침은 변화 없음도 안내)
        notifyCaptureResult(chatId, apiResult);
      } else if (diag.captureTs === prevCaptureTs) {
        // 인라인: 새 값이 저장되지 않음 — 형식 미인식이면 채팅에서 확인하도록 안내
        if (diag.blockFound) showUsToast("이전과 동일한 상태값 — 변화 없음으로 처리됩니다", "warn");
        else showUsToast("출력 형식을 인식하지 못했습니다 — 채팅 답변을 확인하세요", "warn");
      }
    }
    dryRunAborted = false;
    invalidateFloat();
  }

  // ── 빈 턴 채우기 ──────────────────────────────────────────
  //  첫 기록 이후 상태값이 없는 턴을 오래된 것부터 하나씩 캡처한다.
  //  순서가 중요하다: 각 캡처는 '바로 앞 턴' 값을 직전 값으로 받아야 하므로 반드시 차례대로 돌린다.
  //  (첫 기록 이전 턴은 확장을 켜기 전 구간이라 채우지 않는다)
  const fillRunByChat = {}; // chatId → { cancel, done, total, failed }
  async function findEmptyTurns(chatId) {
    await syncAssistantMetaNow(chatId, getSettings(chatId).historyDepth);
    const total = await fetchMessageCount(chatId);
    const list = (await fetchMessages(chatId, Number.isFinite(total) && total > 0 ? total + 1 : 2000)) || [];
    const asst = list.filter((m) => m && m.role === "assistant" && m.id
      && typeof m.content === "string" && m.content.trim() && !isStatusMessageHidden(chatId, m.id));
    const has = (m) => {
      const e = getMsgEntry(chatId, m.id, m.activeSwipeIndex || 0);
      return !!(e && (e.scene || e.subjects.length));
    };
    const first = asst.findIndex(has);
    if (first < 0) return { targets: [], noRecord: true };
    return {
      targets: asst.slice(first + 1).filter((m) => !has(m)).map((m) => ({ id: m.id, swipe: m.activeSwipeIndex || 0 })),
      noRecord: false,
    };
  }
  function updateFillButton(chatId) {
    const btn = document.getElementById("us-hist-fill");
    if (!btn || getChatId() !== chatId) return;
    const run = fillRunByChat[chatId];
    btn.textContent = run ? `중지 (${run.done}/${run.total})` : "빈 턴 채우기";
    btn.classList.toggle("danger", !!run);
  }
  async function fillEmptyTurns(chatId) {
    if (!chatId || fillRunByChat[chatId]) return;
    const st = getSettings(chatId);
    if (st.dataMode !== DATA_MODES.api) { alert("빈 턴 채우기는 'API 따로 연결' 방식에서만 쓸 수 있습니다."); return; }
    const { targets, noRecord } = await findEmptyTurns(chatId);
    if (noRecord) { alert("이 채팅에는 아직 상태 기록이 없습니다. 최신 턴에서 먼저 상태를 생성해 주세요."); return; }
    if (!targets.length) { showFloatNotice("비어 있는 턴이 없습니다.", "info"); return; }
    if (!confirm(`상태 기록이 없는 턴 ${targets.length}개를 오래된 것부터 차례로 생성합니다.\n(API 호출 ${targets.length}회, 이미 있는 기록은 건드리지 않습니다)\n\n진행할까요?`)) return;
    const run = fillRunByChat[chatId] = { cancel: false, done: 0, total: targets.length, failed: 0 };
    updateFillButton(chatId);
    let saved = 0, errStreak = 0, stoppedByError = false;
    try {
      for (const t of targets) {
        if (run.cancel) break;
        // 다른 캡처·채팅 답변 생성이 돌고 있으면 끝날 때까지 기다린다 (최대 5분)
        const waitStart = Date.now();
        while ((captureBusyByChat[chatId] || isGeneratingByChat[chatId]) && !run.cancel && Date.now() - waitStart < 300000) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (run.cancel) break;
        // 기다리는 사이 누가 채웠으면 건너뛴다
        const already = getMsgEntry(chatId, t.id, t.swipe);
        if (!(already && (already.scene || already.subjects.length))) {
          let res;
          try { res = await captureApi(true, undefined, t.id, t.swipe, false, chatId, false); }
          catch (e) { res = { status: "error", message: String((e && e.message) || e) }; }
          const ok = res && (res.status === "saved" || res.status === "nochange");
          if (ok) { saved++; errStreak = 0; }
          else {
            run.failed++;
            if (res && res.status === "aborted") break;
            if (++errStreak >= 2) { stoppedByError = true; break; }
          }
        }
        run.done++;
        updateFillButton(chatId);
      }
    } finally {
      delete fillRunByChat[chatId];
      updateFillButton(chatId);
      invalidateFloat();
      refreshHistoryUiIfOpen();
    }
    const msg = stoppedByError ? `연속 실패로 멈췄습니다 — ${saved}개 채움, ${run.failed}개 실패`
      : run.cancel ? `중지했습니다 — ${saved}개 채움`
      : `빈 턴 ${saved}개를 채웠습니다${run.failed ? ` (${run.failed}개 실패)` : ""}`;
    if (getChatId() === chatId) showFloatNotice(msg, stoppedByError || run.failed ? "warn" : "info");
  }

  // ── 스타일 ──
  marinara.addStyle(`
  .us-icon-svg{display:block;width:16px;height:16px;max-width:100%;max-height:100%;overflow:visible;pointer-events:none;flex:none;}
  button.us-f-btn,button.us-inline-action,button.us-iconbtn{touch-action:manipulation;-webkit-tap-highlight-color:transparent;}
  /* ── 상태창: 화면 플로팅이 기본 CSS, 채팅 내부 모드는 런타임 인라인 스타일로 전환 ── */
  /* --us-float-* 변수: Window CSS에서 이 변수들만 덮어쓰면 하위 모든 요소가 따라옵니다 */
  #${FLOAT_ID}{
    position:fixed;right:14px;bottom:96px;z-index:99989;
    --us-float-bg:var(--card,#1c1c1c);
    --us-float-fg:var(--foreground,#eee);
    --us-float-border:var(--border,#333);
    --us-float-muted:var(--muted-foreground,#999);
    --us-float-primary:var(--primary,#6c8cff);
    --us-float-primary-fg:var(--primary-foreground,#fff);
    --us-float-secondary:var(--secondary,#232323);
    --us-float-accent:var(--accent,#333);
    background:var(--us-float-bg);border:1px solid var(--us-float-border);border-radius:14px;
    padding:8px;color:var(--us-float-fg);box-shadow:0 10px 30px rgba(0,0,0,.4);
    width:min(${FLOAT_W}px,92vw);box-sizing:border-box;font-family:inherit;user-select:none;}
  #${FLOAT_ID} .us-f-bar{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:2px 2px 0;cursor:grab;}
  #${FLOAT_ID} .us-f-bar:active{cursor:grabbing;}
  #${FLOAT_ID}.inline-mode .us-f-bar{cursor:default;background:transparent!important;justify-content:flex-end;}
  #${FLOAT_ID}.inline-mode .us-f-bar:hover,#${FLOAT_ID}.inline-mode .us-f-bar:active{cursor:default;background:transparent!important;}
  #${FLOAT_ID}.inline-mode.inline-title-hidden .us-f-bar [data-act="collapse"]{margin-right:auto;}
  /* 제목 바 자체가 접기/펼치기 영역일 때의 커서. 버튼은 각자 pointer 를 유지한다. */
  #${FLOAT_ID}.inline-mode .us-f-bar.us-bar-toggleable{cursor:pointer;}
  #${FLOAT_ID}.inline-mode .us-f-bar.us-bar-toggleable:hover,#${FLOAT_ID}.inline-mode .us-f-bar.us-bar-toggleable:active{cursor:pointer;}
  #${FLOAT_ID} .us-f-bar.us-bar-toggleable .us-f-title{cursor:inherit;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-head.us-bar-toggleable{cursor:pointer;}
  #${FLOAT_ID} .us-f-title{flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--us-float-fg);}
  #${FLOAT_ID} .us-f-btn{background:transparent;border:none;color:var(--us-float-muted);font-size:15px;line-height:1;cursor:pointer;padding:0;width:26px;height:26px;box-sizing:border-box;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;flex:none;}
  #${FLOAT_ID} .us-f-btn .us-icon-svg{width:14px;height:14px;}
  #${FLOAT_ID} .us-f-btn:hover{background:var(--us-float-accent);color:var(--us-float-fg);}
  #${FLOAT_ID} .us-f-btn:disabled{cursor:default;background:transparent;}
  #${FLOAT_ID} .us-f-btn.on{color:var(--us-float-primary);}
  #${FLOAT_ID} .us-f-btn.spinning{color:var(--us-float-primary);}
  #${FLOAT_ID} .us-f-btn.spinning svg{animation:us-spin .8s linear infinite;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-action.spinning{color:var(--us-float-primary,#6c8cff);}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-action.spinning svg{animation:us-spin .8s linear infinite;}
  #${FLOAT_ID} .us-edit{display:flex;flex-direction:column;gap:7px;padding-top:8px;}
  #${FLOAT_ID} .us-erow{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px;}
  #${FLOAT_ID} .us-erow:last-child{margin-bottom:0;}
  #${FLOAT_ID} .us-erow>span{flex:none;width:84px;color:var(--us-float-muted);overflow:hidden;text-overflow:ellipsis;}
  #${FLOAT_ID} .us-erow .us-input{flex:1;min-width:0;background:var(--us-float-secondary);border-color:var(--us-float-border);color:var(--us-float-fg);}
  /* 값 칸(textarea) — 한 줄이면 input 처럼, 길면 내용만큼 늘어난다 */
  #${FLOAT_ID} .us-erow textarea.us-input{flex:1;min-width:0;background:var(--us-float-secondary);border-color:var(--us-float-border);color:var(--us-float-fg);font-family:inherit;font-size:12px;line-height:1.45;min-height:0;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden;display:block;}
  #${FLOAT_ID} .us-erow.us-erow-multi{align-items:flex-start;}
  #${FLOAT_ID} .us-erow.us-erow-multi>span{padding-top:7px;}
  /* 값 편집 폼 안의 접기 그룹 */
  #${FLOAT_ID} .us-vgroup{margin:6px 0;border:1px solid var(--us-float-border,#444);border-radius:8px;overflow:hidden;}
  #${FLOAT_ID} .us-vgroup>.us-vgroup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;font-size:11px;font-weight:600;cursor:pointer;color:var(--us-float-fg,#eee);}
  #${FLOAT_ID} .us-vgroup>.us-vgroup-body{padding:6px 8px 2px;}
  #${FLOAT_ID} .us-erow-foot{display:flex;justify-content:space-between;gap:6px;margin-top:10px;}
  #${FLOAT_ID} .us-name-edit{flex:1;min-width:0;font-size:12px;padding:5px 8px;background:var(--us-float-secondary);border-color:var(--us-float-border);color:var(--us-float-fg);}
  /* 값 수정 폼의 저장/취소/삭제 버튼(.us-btn) — #us-float 범위에 규칙이 없으면 전역 .us-btn(마리나라색)으로 떨어져
     윈도우 CSS 를 안 따라가므로, 플로팅 창 변수(--us-float-*)로 별도 지정한다. */
  #${FLOAT_ID} .us-btn{background:var(--us-float-secondary);border-color:var(--us-float-border);color:var(--us-float-fg);}
  #${FLOAT_ID} .us-btn:hover{background:var(--us-float-accent);}
  #${FLOAT_ID} .us-btn.primary{background:var(--us-float-primary);color:var(--us-float-primary-fg,#fff);border-color:transparent;}
  #${FLOAT_ID} .us-btn.danger{background:transparent;color:#ff6b6b;border-color:#ff6b6b55;}
  #${FLOAT_ID} .us-btn.danger:hover{background:#ff6b6b18;}
  @keyframes us-spin{to{transform:rotate(360deg);}}
  .us-tabs{display:flex;gap:4px;align-items:center;padding:8px 2px 0;min-width:0;}
  .us-pills{display:flex;gap:4px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none;cursor:grab;user-select:none;touch-action:pan-x;}
  .us-pills::-webkit-scrollbar{display:none;}
  #${FLOAT_ID} .us-edit-scroll::-webkit-scrollbar{width:8px;height:8px;}
  #${FLOAT_ID} .us-edit-scroll::-webkit-scrollbar-track{background:transparent;}
  #${FLOAT_ID} .us-edit-scroll::-webkit-scrollbar-thumb{background:var(--us-float-border,#666);border-radius:8px;border:2px solid transparent;background-clip:padding-box;}
  #${FLOAT_ID} .us-edit-scroll::-webkit-scrollbar-thumb:hover{background:var(--us-float-muted,#888);background-clip:padding-box;}
  .us-pills.dragging{cursor:grabbing;}
  /* 그립이 붙은 탭: buildUiHost 의 :host{display:block} 때문에 그립과 라벨이 세로로 쌓이던 것을
     가로 한 줄로 정렬한다. :has() 미지원 브라우저를 위해 .us-tab-grip 쪽에도 보정을 둔다. */
  .us-tab:has(.us-tab-grip){display:inline-flex;align-items:center;gap:5px;}
  .us-tab:has(.us-tab-grip) .us-ui-host{display:inline-block;vertical-align:middle;}
  .us-tab-grip{flex:none;cursor:grab;opacity:.45;font-size:11px;line-height:1;letter-spacing:-1px;touch-action:none;user-select:none;}
  .us-tab-grip:hover{opacity:.9;}
  .us-tab-grip:active{cursor:grabbing;}
  #${FLOAT_ID} .us-nav{flex:none;width:22px;height:22px;border-radius:50%;border:1px solid var(--us-float-border);background:transparent;color:var(--us-float-muted);cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;}
  #${FLOAT_ID} .us-nav:hover{background:var(--us-float-accent);color:var(--us-float-fg);}
  .us-nav{flex:none;width:22px;height:22px;border-radius:50%;border:1px solid var(--border,#444);background:transparent;color:var(--muted-foreground,#aaa);cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;}
  .us-nav:hover{background:var(--accent,#333);color:var(--foreground,#fff);}
  #${FLOAT_ID} .us-tab{font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;border:1px solid var(--us-float-border);background:transparent;color:var(--us-float-muted);white-space:nowrap;flex:none;font-family:inherit;}
  #${FLOAT_ID} .us-tab.on{background:var(--us-float-primary);color:var(--us-float-primary-fg);border-color:transparent;}
  .us-tab{font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;border:1px solid var(--border,#444);background:transparent;color:var(--muted-foreground,#aaa);white-space:nowrap;flex:none;font-family:inherit;}
  .us-tab.on{background:var(--primary,#6c8cff);color:var(--primary-foreground,#fff);border-color:transparent;}
  .us-tab .us-ui-host,.us-scene-button .us-ui-host{display:block;width:100%;}
  .us-scene-button .us-scene-arrow{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:13px;line-height:1;color:var(--us-float-muted,var(--muted-foreground,#aaa));pointer-events:none;}
  #${FLOAT_ID} .us-scene-slot{margin-top:8px;}
  .us-hist-widget .us-scene-slot{margin-top:4px;}
  #${FLOAT_ID} .us-char-slot{margin-top:8px;min-width:0;}
  .us-hist-widget .us-char-slot{margin-top:4px;min-width:0;}
  .us-hist-widget .us-tab{color:var(--us-float-muted,var(--muted-foreground,#aaa));border-color:var(--us-float-border,var(--border,#444));}
  .us-hist-widget .us-tab.on{background:var(--us-float-primary,var(--primary,#6c8cff));color:var(--us-float-primary-fg,var(--primary-foreground,#fff));border-color:transparent;}
  /* 창 루트에 user-select:none 이 걸려 있어(드래그로 창을 옮기기 위함), 값을 읽는 영역마다
     text 로 되돌려야 한다. 캐릭터 카드(.us-f-body)만 되돌려 놓아서 장면 띠 안의 값은
     드래그 선택이 안 됐다. */
  #${FLOAT_ID} .us-scene-body,.us-hist-widget .us-scene-body{padding:0;margin-top:6px;user-select:text;}
  #${FLOAT_ID} .us-scene-button,.us-hist-widget .us-scene-button{position:relative;display:flex;align-items:center;justify-content:center;width:100%;min-height:32px;padding:6px 30px 6px 12px;border-radius:8px;border:1px solid var(--us-float-border,var(--border,#444));background:var(--us-float-secondary,var(--secondary,#232323));color:var(--us-float-fg,var(--foreground,#eee));cursor:pointer;font-family:inherit;font-size:12px;box-sizing:border-box;}
  #${FLOAT_ID} .us-scene-button:hover,.us-hist-widget .us-scene-button:hover{background:var(--us-float-accent,var(--accent,#333));}
  #${FLOAT_ID} .us-f-body,.us-hist-widget .us-f-body{user-select:text;padding-top:8px;touch-action:pan-y;max-height:${BODY_MAX_H}px;overflow:auto;}
  #${FLOAT_ID}.collapsed .us-f-content{display:none;}
  #${FLOAT_ID}.icon-mode{width:48px !important;min-width:0 !important;height:48px;padding:0;display:flex !important;align-items:center;justify-content:center;cursor:pointer;}
  .us-float-icon-btn{width:40px;height:40px;background:transparent;border:none;font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--us-float-fg,#eee);border-radius:8px;padding:0;font-family:inherit;}
  .us-float-icon-btn .us-icon-svg{width:22px;height:22px;}
  .us-float-icon-btn:hover{background:var(--us-float-accent,#333);}
  #${FLOAT_ID} .us-f-empty{font-size:12px;color:var(--us-float-muted);text-align:center;padding:14px 10px;line-height:1.7;}
  /* 꺼져 있을 때만 바에 나타나는 전원 버튼 — 눈에 띄도록 강조색 */
  #${FLOAT_ID} .us-f-btn.us-f-power{color:var(--us-float-primary);}
  #${FLOAT_ID} .us-f-btn.us-f-power:hover{background:var(--us-float-accent);color:var(--us-float-primary);}
  #${FLOAT_ID} .us-f-manual-add,#${FLOAT_ID} .us-f-manual-fromraw,#${FLOAT_ID} .us-f-manual-paste{border:1px solid var(--us-float-border);background:var(--us-float-secondary);color:var(--us-float-fg);font-family:inherit;font-size:11px;padding:5px 9px;border-radius:7px;cursor:pointer;}
  #${FLOAT_ID} .us-f-manual-fromraw,#${FLOAT_ID} .us-f-manual-paste{display:inline-flex;align-items:center;gap:5px;}
  #${FLOAT_ID} .us-f-manual-fromraw .us-icon-svg,#${FLOAT_ID} .us-f-manual-paste .us-icon-svg{width:13px;height:13px;}
  #${FLOAT_ID} .us-f-manual-add:hover,#${FLOAT_ID} .us-f-manual-fromraw:hover,#${FLOAT_ID} .us-f-manual-paste:hover{background:var(--us-float-accent);}
  #${FLOAT_ID} .us-f-ctx{font-size:11px;color:var(--us-float-fg,var(--foreground,#eee));font-family:inherit;padding:0 2px;}

  /* 메시지별 과거 기록: 최신 상태가 생기면 이전 기록은 이 접힌 헤더로 남는다. */
  [${INLINE_STATUS_ATTR}="past"].us-hist-widget{
    --us-float-bg:var(--card,#1c1c1c);--us-float-fg:var(--foreground,#eee);
    --us-float-border:var(--border,#333);--us-float-muted:var(--muted-foreground,#999);
    --us-float-primary:var(--primary,#6c8cff);--us-float-primary-fg:var(--primary-foreground,#fff);
    --us-float-secondary:var(--secondary,#232323);--us-float-accent:var(--accent,#333);
    width:min(${FLOAT_W}px,100%);max-width:100%;min-width:0;margin-top:10px;padding:8px;box-sizing:border-box;border:1px solid var(--us-float-border);
    border-radius:14px;background:var(--us-float-bg);color:var(--us-float-fg);font-family:inherit;
    box-shadow:0 5px 18px rgba(0,0,0,.22);user-select:none;
  }
  [${INLINE_STATUS_ATTR}="past"] .us-inline-head{display:flex;align-items:center;gap:4px;width:100%;min-width:0;box-sizing:border-box;padding:2px;background:transparent!important;border:0;color:inherit;font:inherit;text-align:left;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-head:hover,[${INLINE_STATUS_ATTR}="past"] .us-inline-head:active{background:transparent!important;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-main{display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:0;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;text-align:left;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-main.us-inline-empty{cursor:default;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-actions{display:flex;align-items:center;gap:1px;flex:none;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-action{width:25px;height:25px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--us-float-muted);cursor:pointer;font:inherit;font-size:13px;line-height:1;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-action:hover{background:var(--us-float-accent);color:var(--us-float-fg);}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-action:disabled{opacity:.35;cursor:default;background:transparent;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-action .us-icon-svg{width:14px;height:14px;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-chevron{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;color:var(--us-float-muted);font-size:15px;flex:none;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-chevron .us-icon-svg{width:14px;height:14px;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-title{flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-turn{font-size:11px;color:var(--us-float-muted);flex:0 1 auto;min-width:0;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  [${INLINE_STATUS_ATTR}="past"] .us-inline-content{padding-top:6px;}
  [${INLINE_STATUS_ATTR}="past"].collapsed .us-inline-content{display:none;}
  [${INLINE_STATUS_ATTR}] .us-tabs{min-width:0;}
  [${INLINE_SLOT_ATTR}]{display:flex;width:100%;max-width:100%;min-width:0;align-self:stretch;justify-content:flex-start;padding:0 8px;box-sizing:border-box;}

  /* ── 추가 요청사항 버블 창 (--us-float-* 변수 공유) ── */
  #${PROMPT_BUBBLE_ID}{
    position:fixed;z-index:99990;
    --us-float-bg:var(--card,#1c1c1c);
    --us-float-fg:var(--foreground,#eee);
    --us-float-border:var(--border,#333);
    --us-float-muted:var(--muted-foreground,#999);
    --us-float-primary:var(--primary,#6c8cff);
    --us-float-secondary:var(--secondary,#232323);
    --us-float-accent:var(--accent,#333);
    background:var(--us-float-bg);border:1px solid var(--us-float-border);border-radius:10px;
    padding:0;width:min(300px,88vw);box-sizing:border-box;font-family:inherit;user-select:none;
    box-shadow:0 8px 24px rgba(0,0,0,.35);color:var(--us-float-fg);}
  #${PROMPT_BUBBLE_ID} .us-pb-handle{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;padding:8px 10px 6px;cursor:grab;border-bottom:1px solid var(--us-float-border);}
  #${PROMPT_BUBBLE_ID} .us-pb-title,#${FLOAT_ID} .us-edit-title{display:inline-flex;align-items:center;gap:5px;}
  #${PROMPT_BUBBLE_ID} .us-pb-handle:active{cursor:grabbing;}
  #${PROMPT_BUBBLE_ID} .us-pb-body{padding:8px 10px;}
  #${PROMPT_BUBBLE_ID} .us-prompt-input{width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;padding:7px 9px;border-radius:7px;border:1px solid var(--us-float-border);background:var(--us-float-secondary);color:var(--us-float-fg);resize:vertical;min-height:60px;line-height:1.5;}
  #${PROMPT_BUBBLE_ID} .us-pb-foot{display:flex;justify-content:flex-end;gap:6px;margin-top:6px;}
  #${PROMPT_BUBBLE_ID} .us-f-btn{background:transparent;border:none;color:var(--us-float-muted);font-size:15px;line-height:1;cursor:pointer;padding:0;width:26px;height:26px;box-sizing:border-box;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;flex:none;}
  #${PROMPT_BUBBLE_ID} .us-f-btn svg{display:block;}
  #${PROMPT_BUBBLE_ID} .us-f-btn:hover{background:var(--us-float-accent);color:var(--us-float-fg);}
  #${PROMPT_BUBBLE_ID} .us-btn{background:var(--us-float-secondary);border-color:var(--us-float-border);color:var(--us-float-fg);}
  #${PROMPT_BUBBLE_ID} .us-btn:hover{background:var(--us-float-accent);}
  #${PROMPT_BUBBLE_ID} .us-btn.primary{background:var(--us-float-primary);color:var(--us-float-primary-fg,#fff);border-color:transparent;}

  /* 맞춤 CSS 사용 시 미지정 색은 Marinara의 라이트/다크 변수 대신 고정 팔레트를 사용한다.
     :where()로 조건의 specificity를 0으로 만들어 뒤에 삽입되는 사용자 CSS가 그대로 우선한다. */
  :where(html.us-custom-css-active) #${FLOAT_ID},
  :where(html.us-custom-css-active) #${PROMPT_BUBBLE_ID}{
    --us-float-bg:#1c1c1c;--us-float-fg:#eeeeee;--us-float-border:#333333;
    --us-float-muted:#999999;--us-float-primary:#6c8cff;--us-float-primary-fg:#ffffff;
    --us-float-secondary:#232323;--us-float-accent:#333333;
  }
  :where(html.us-custom-css-active) .us-box{
    --us-box-bg:#1c1c1c;--us-box-fg:#eeeeee;--us-box-border:#333333;--us-box-muted:#999999;
    --us-box-input-bg:#111111;--us-box-secondary:#2a2a2a;--us-box-accent:#333333;
    --us-box-primary:#6c8cff;--us-box-primary-fg:#ffffff;
    --us-box-switch-off:#333333;--us-box-switch-on:#6c8cff;--us-box-switch-thumb:#ffffff;
  }
  :where(html.us-custom-css-active) #${FLOAT_ID} .us-status-host,
  :where(html.us-custom-css-active) #${FLOAT_ID} .us-scene-host,
  :where(html.us-custom-css-active) #${FLOAT_ID} .us-ui-host{
    --background:#232323;--card:#1c1c1c;--card-foreground:#eeeeee;--foreground:#eeeeee;
    --border:#333333;--muted-foreground:#999999;--primary:#6c8cff;--primary-foreground:#ffffff;
    --secondary:#232323;--accent:#333333;--input:#111111;
  }
  :where(html.us-custom-css-active) .us-box{
    --background:#2a2a2a;--card:#1c1c1c;--card-foreground:#eeeeee;--foreground:#eeeeee;
    --border:#333333;--muted-foreground:#999999;--primary:#6c8cff;--primary-foreground:#ffffff;
    --secondary:#2a2a2a;--accent:#333333;--input:#111111;
  }

  /* ── 설정·편집기 오버레이 ── */
  #${PANEL_ID},#${MODAL_ID},#${STATUS_MANAGER_ID}{position:fixed;inset:0;z-index:99991;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);font-family:inherit;}
  #${MODAL_ID},#${STATUS_MANAGER_ID}{z-index:99992;}

  /* ── .us-box: --us-box-* 변수 — Window CSS에서 이 변수들만 바꾸면 하위 전체가 따라옵니다 ── */
  .us-box{
    --us-box-bg:var(--card,#1c1c1c);
    --us-box-fg:var(--card-foreground,#eee);
    --us-box-border:var(--border,#333);
    --us-box-muted:var(--muted-foreground,#999);
    --us-box-input-bg:var(--input,#111);
    --us-box-secondary:var(--secondary,#2a2a2a);
    --us-box-accent:var(--accent,#333);
    --us-box-primary:var(--primary,#6c8cff);
    --us-box-primary-fg:var(--primary-foreground,#fff);
    --us-box-switch-off:var(--us-box-border);
    --us-box-switch-on:var(--us-box-primary);
    --us-box-switch-thumb:#fff;
    background:var(--us-box-bg);color:var(--us-box-fg);border:1px solid var(--us-box-border);
    border-radius:14px;width:min(720px,94vw);max-height:88vh;overflow-y:auto;padding:18px 20px;}
  #${PANEL_ID} .us-box{display:flex;flex-direction:column;width:min(760px,94vw);height:min(86vh,760px);}
  /* 탭 본문은 스크롤 컨테이너라 경계에서 포커스 링(트랙 밖 4px)이 잘린다.
     안쪽 패딩 5px + 같은 크기 네거티브 마진으로 시각적 정렬은 그대로 두고 잘림만 방지. */
  #${PANEL_ID} #us-tabbody{flex:1;min-height:0;overflow-y:auto;padding:5px 7px 5px 5px;margin:-5px -5px 0 -5px;}

  /* .us-box 스코프 자식 요소 — 변수 자동 계승 */
  .us-box .us-h h2,.us-box .us-sub,.us-box label,.us-box p{color:inherit;}
  .us-box .us-x{background:transparent;border:none;color:var(--us-box-muted);font-size:20px;cursor:pointer;line-height:1;}
  .us-box .us-x .us-icon-svg{width:17px;height:17px;}
  .us-box .us-sub,.us-box .us-note{color:var(--us-box-muted);}
  /* 설명글 안의 <code> 조각도 창 테마를 따르게 — 안 그러면 편집기만 마리나라 색으로 튄다 */
  .us-box .us-note code,.us-box .us-det-note code{background:var(--us-box-secondary);color:var(--us-box-fg);border-radius:4px;padding:1px 4px;}
  .us-box .us-ptabs{border-bottom-color:var(--us-box-border);}
  .us-box .us-ptab{color:var(--us-box-muted);background:transparent;border-bottom:2px solid transparent;}
  .us-box .us-ptab.on{color:var(--us-box-fg);border-bottom-color:var(--us-box-primary);}
  .us-box .us-sec h3{color:var(--us-box-fg);}
  .us-box .us-sec-fold>.us-fold-head{border-bottom-color:var(--us-box-border);}
  .us-box .us-btn{background:var(--us-box-secondary);color:var(--us-box-fg);border-color:var(--us-box-border);}
  .us-box .us-btn:hover{background:var(--us-box-accent);}
  .us-box .us-btn.primary{background:var(--us-box-primary);color:var(--us-box-primary-fg);border-color:transparent;}
  .us-box .us-btn.on{background:var(--us-box-primary);color:var(--us-box-primary-fg);border-color:transparent;}
  .us-box .us-btn.danger{background:transparent;color:#ff6b6b;border-color:#ff6b6b55;}
  .us-box .us-btn.danger:hover{background:#ff6b6b18;}
  .us-box .us-input,.us-box .us-ta,.us-box .us-sel{background:var(--us-box-input-bg);color:var(--us-box-fg);border-color:var(--us-box-border);}
  .us-box .us-sel option,.us-box select option{background:var(--us-box-input-bg);color:var(--us-box-fg);}
  /* 설정창 스크롤바도 윈도우 CSS(--us-box-*)를 따라가도록 */
  .us-box{scrollbar-width:thin;scrollbar-color:var(--us-box-border) transparent;}
  .us-box *{scrollbar-width:thin;scrollbar-color:var(--us-box-border) transparent;}
  .us-box ::-webkit-scrollbar{width:10px;height:10px;}
  .us-box ::-webkit-scrollbar-track{background:transparent;}
  .us-box ::-webkit-scrollbar-thumb{background:var(--us-box-border);border-radius:6px;border:2px solid transparent;background-clip:content-box;}
  .us-box ::-webkit-scrollbar-thumb:hover{background:var(--us-box-muted);background-clip:content-box;}
  .us-box .us-preview{border-color:var(--us-box-border);background:var(--us-box-input-bg);}
  .us-box .us-item{border-color:var(--us-box-border);}
  .us-box .us-item .nm{color:inherit;}
  .us-box .us-item .meta{color:var(--us-box-muted);}
  .us-box .us-item.active{border-color:var(--us-box-primary);}
  .us-box .us-item:hover{background:var(--us-box-accent);}
  .us-box .us-wbox{border-color:var(--us-box-border);}
  /* .us-wbox .us-wfold (전역, 1920행) 과 specificity 가 같아(0,2,0) 뒤에 오는 전역 규칙에 덮인다.
     .us-box 컨텍스트에서는 확실히 이기도록 .us-box.us-box 로 specificity 를 올린다. */
  .us-box.us-box .us-wfold{color:var(--us-box-muted);}
  /* 접기 헤더는 hover 시 배경을 칠하지 않는다 — 펼친 뒤 커서가 그대로 얹혀 있으면
     헤더가 계속 색으로 채워져 보이는 문제. 글자색만 살짝 밝히는 정도로 둔다. */
  .us-box.us-box .us-wfold:hover{background:transparent;color:var(--us-box-fg,var(--foreground,#eee));}
  .us-box.us-box .us-wbox.open .us-wfold{border-bottom-color:var(--us-box-border);}
  .us-box .us-switch .us-track{background:var(--us-box-switch-off);flex:0 0 auto;min-width:40px;box-sizing:border-box;}
  .us-box .us-switch .us-track::after{background:var(--us-box-switch-thumb);}
  .us-box .us-switch input:checked + .us-track{background:var(--us-box-switch-on);}
  .us-box .us-switch:hover .us-track{filter:brightness(1.2);}
  .us-box .us-switch input:checked:focus + .us-track,.us-box .us-switch:focus-within .us-track{outline:2px solid var(--us-box-switch-on);outline-offset:2px;}
  .us-box .us-iconbtn{color:var(--us-box-muted);}
  .us-box .us-syncbtn{flex:none;}
  .us-box .us-syncbtn.off{opacity:.5;}
  .us-box .us-iconbtn:hover{background:var(--us-box-accent);color:var(--us-box-fg);border-radius:6px;}
  .us-box .us-det{border-color:var(--us-box-border);}
  .us-box .us-det .us-ta{border-top-color:var(--us-box-border);}
  .us-box .us-hturn{border-color:var(--us-box-border);background:var(--us-box-secondary);}
  .us-box .us-hturn-title{color:inherit;}
  .us-box .us-hturn-meta{color:var(--us-box-muted);}
  .us-box .us-hturn-btn.on{background:var(--us-box-primary);color:var(--us-box-primary-fg);border-color:transparent;}
  .us-box .us-manager-item{border-color:var(--us-box-border);}
  .us-box .us-manager-item .nm{color:inherit;}
  .us-box .us-manager-item .meta{color:var(--us-box-muted);}
  .us-box .us-manager-item.active{border-color:var(--us-box-primary);}
  .us-box .us-manager-item:hover{background:var(--us-box-accent);}
  .us-box .us-scope-toggle .us-btn[data-scope].on{font-weight:700;}
  .us-hist-preview-scroll{width:100%;height:min(48vh,370px);min-height:200px;overflow:auto;border:1px solid var(--us-box-border,var(--border,#333));border-radius:10px;padding:10px 8px;background:var(--us-box-input-bg,var(--background,#0e0e0e));box-sizing:border-box;display:flex;justify-content:center;align-items:flex-start;flex:1;}

  /* ── 기록 미리보기 위젯 (--us-float-* 변수 공유) ── */
  .us-hist-widget{
    width:min(${FLOAT_W}px,92vw);max-width:100%;
    --us-float-bg:var(--card,#1c1c1c);
    --us-float-fg:var(--foreground,#eee);
    --us-float-border:var(--border,#333);
    --us-float-muted:var(--muted-foreground,#999);
    --us-float-primary:var(--primary,#6c8cff);
    --us-float-primary-fg:var(--primary-foreground,#fff);
    --us-float-secondary:var(--secondary,#232323);
    --us-float-accent:var(--accent,#333);
    border:1px solid var(--us-float-border);border-radius:14px;
    background:var(--us-float-bg);color:var(--us-float-fg);
    padding:8px;box-sizing:border-box;box-shadow:0 10px 30px rgba(0,0,0,.4);}
  .us-hist-widget .us-f-bar{display:flex;align-items:center;gap:6px;padding:2px 2px 0;}
  .us-hist-widget .us-f-title{flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--us-float-fg);}
  .us-hist-widget .us-f-body{user-select:text;padding-top:4px;touch-action:pan-y;max-height:${BODY_MAX_H}px;overflow:auto;}

  /* ── 글로벌 공용 클래스 (float/box 밖에서도 쓰임) ── */
  .us-h{display:flex;align-items:center;gap:8px;margin:0 0 12px;}
  .us-h h2{font-size:16px;margin:0;flex:1;}
  .us-head-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--us-box-muted,var(--muted-foreground,#999));}
  .us-x{background:transparent;border:none;color:var(--muted-foreground,#999);font-size:20px;cursor:pointer;line-height:1;}
  .us-sub{font-size:12px;color:var(--muted-foreground,#999);line-height:1.6;margin-bottom:10px;}
  .us-ptabs{display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid var(--border,#333);}
  .us-ptab{font-size:12px;padding:7px 12px;cursor:pointer;border:none;background:transparent;color:var(--muted-foreground,#999);border-bottom:2px solid transparent;font-family:inherit;}
  .us-ptab.on{color:var(--foreground,#fff);border-bottom-color:var(--primary,#6c8cff);font-weight:600;}
  .us-sec{margin-top:14px;}
  /* 섹션 제목 — 밑줄 없이 여백으로 구분한다. 크기는 본문 라벨(12px)과 맞추고,
     uppercase 는 한글에 효과가 없으면서 영문 라벨만 튀게 만들어 쓰지 않는다. */
  .us-sec h3{font-size:13px;font-weight:600;letter-spacing:0;color:var(--foreground,#eee);border-bottom:none;padding-bottom:0;margin:0 0 8px;}
  /* 접히는 섹션 제목만 예외: 열렸을 때 머리와 내용을 가르는 선이 필요하다 */
  .us-sec-fold>.us-fold-head{border-bottom:1px solid var(--border,#333);padding-bottom:5px;}
  /* 접히는 설정 섹션 (고급 탭의 모드 전용 항목) */
  .us-sec-fold>.us-fold-head{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none;}
  .us-sec-fold>.us-fold-head:hover{background:transparent;color:var(--us-box-fg,var(--foreground,#eee));}
  .us-sec-fold>.us-fold-head:focus-visible{outline:2px solid var(--us-box-primary,var(--primary,#6c8cff));outline-offset:2px;border-radius:4px;}
  .us-fold-arrow{flex:none;font-size:10px;line-height:1;width:10px;text-align:center;}
  .us-fold-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .us-fold-badge{flex:none;font-size:9px;letter-spacing:0;text-transform:none;font-weight:500;padding:2px 7px;border-radius:999px;border:1px solid currentColor;opacity:.6;white-space:nowrap;}
  .us-sec-fold:not(.open)>.us-fold-head{border-bottom-color:transparent;margin-bottom:0;}
  .us-sec-fold:not(.open)>.us-fold-body{display:none;}
  .us-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:7px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border,#444);background:var(--secondary,#2a2a2a);color:var(--foreground,#eee);font-family:inherit;}
  .us-btn:hover{background:var(--accent,#333);}
  .us-btn.primary{background:var(--primary,#6c8cff);color:var(--primary-foreground,#fff);border-color:transparent;}
  .us-btn.on{background:var(--primary,#6c8cff);color:var(--primary-foreground,#fff);border-color:transparent;}
  .us-btn.danger{color:#ff6b6b;border-color:#ff6b6b55;} .us-btn.sm{padding:3px 7px;font-size:11px;}
  .us-row{display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;align-items:center;margin-bottom:5px;padding:3px 2px;box-sizing:border-box;scrollbar-width:none;}
  .us-row::-webkit-scrollbar{display:none;}
  .us-list{display:flex;flex-direction:column;gap:6px;}
  .us-item{display:flex;align-items:center;gap:8px;border:1px solid var(--border,#333);border-radius:8px;padding:8px 10px;flex-wrap:wrap;}
  .us-item .nm.has-desc,.us-manager-item .nm.has-desc{cursor:pointer;}
  .us-desc-chev{display:inline-block;width:12px;margin-right:4px;font-size:10px;opacity:.7;}
  .us-wdesc{order:9;flex:0 0 100%;box-sizing:border-box;padding:2px 2px 0 16px;font-size:12px;line-height:1.5;color:var(--muted-foreground,#999);white-space:pre-wrap;overflow-wrap:anywhere;}
  .us-box .us-wdesc{color:var(--us-box-muted);}
  .us-item .nm{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .us-item .meta{flex:none;font-size:11px;color:var(--muted-foreground,#999);white-space:nowrap;}
  .us-item.active{border-color:var(--primary,#6c8cff);}
  .us-wbox{border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;margin-top:6px;}
  .us-wbox .us-wfold{cursor:pointer;font-size:12px;color:var(--muted-foreground,#999);padding:8px 10px;display:flex;justify-content:space-between;align-items:center;}
  .us-wbox .us-wfold:hover{background:transparent;color:var(--foreground,#eee);}
  .us-wbox.open .us-wfold{border-bottom:1px solid var(--border,#333);}
  .us-wbox .us-wothers{max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:8px;}
  .us-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;flex:0 0 auto;flex-shrink:0;}
  .us-switch input{position:absolute;opacity:0;width:0;height:0;}
  .us-switch .us-track{width:40px;min-width:40px;height:22px;border-radius:999px;background:var(--border,#555);transition:background .15s;position:relative;flex:0 0 auto;box-sizing:border-box;}
  .us-switch .us-track::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;}
  .us-switch input:checked + .us-track{background:var(--primary,#6c8cff);}
  .us-switch input:checked + .us-track::after{transform:translateX(18px);}
  /* 네이티브 체크박스/라디오(.us-switch 토글은 제외: impersonate·데이터 모드·윈도우 모드 등)를 직접 그린다.
     accent-color 만으로는 '체크된 채움색'만 바뀌고 '미체크 테두리·라디오'는 브라우저 기본 회색으로 남으므로,
     appearance:none 으로 직접 그려 미체크/체크/점 색을 모두 윈도우 CSS(--us-box-*)가 따라오게 한다. */
  .us-box input[type=checkbox]:not(.us-switch input),
  .us-box input[type=radio]{
    appearance:none;-webkit-appearance:none;margin:0;flex:none;cursor:pointer;box-sizing:border-box;
    width:15px;height:15px;position:relative;vertical-align:-2px;
    border:1.5px solid var(--us-box-muted,#999);border-radius:4px;background:var(--us-box-input-bg,#111);
    transition:background .12s,border-color .12s;}
  .us-box input[type=radio]{border-radius:50%;}
  .us-box input[type=checkbox]:not(.us-switch input):hover,
  .us-box input[type=radio]:hover{border-color:var(--us-box-primary,#6c8cff);}
  .us-box input[type=checkbox]:not(.us-switch input):checked,
  .us-box input[type=radio]:checked{background:var(--us-box-primary,#6c8cff);border-color:var(--us-box-primary,#6c8cff);}
  .us-box input[type=checkbox]:not(.us-switch input):checked::after{
    /* 광학 중앙 정렬: inset+margin:auto 로 기하 중앙에 놓되, 45° 체크(✓)는 획의 무게가
       경계 상자 중심보다 아래(≈1.2px)에 쏠리므로 top 을 당겨 1px 위로 보정한다.
       (기계적 중앙에 두면 꼭짓점이 아래 테두리에 붙어 보임) */
    content:"";position:absolute;left:0;right:0;top:-2px;bottom:0;margin:auto;width:3px;height:7px;
    border:solid var(--us-box-primary-fg,#fff);border-width:0 2px 2px 0;transform:rotate(45deg);}
  .us-box input[type=radio]:checked::after{
    content:"";position:absolute;inset:3px;border-radius:50%;background:var(--us-box-primary-fg,#fff);}
  .us-box input[type=checkbox]:not(.us-switch input):focus-visible,
  .us-box input[type=radio]:focus-visible{outline:2px solid var(--us-box-primary,#6c8cff);outline-offset:2px;}
  /* 플로팅/요청창에 일반 체크박스가 생길 경우에도 강조색 상속 (현재는 .us-switch 토글만 사용) */
  #${FLOAT_ID} input[type=checkbox]:not(.us-switch input),#${PROMPT_BUBBLE_ID} input[type=checkbox]:not(.us-switch input){accent-color:var(--us-float-primary,var(--primary,#6c8cff));}
  .us-field{display:grid;grid-template-columns:130px 1fr auto;gap:6px;margin-bottom:6px;align-items:center;}
  /* 추가 버튼 줄 — 오른쪽 정렬 */
  /* 추가 버튼 줄 — 오른쪽 끝을 '삭제 버튼'이 아니라 '입력칸 오른쪽 끝'에 맞춘다.
     삭제 버튼과 같은 크기의 투명 자리표시자를 하나 둬서, 아이콘 크기가 바뀌어도 자동으로 맞는다. */
  .us-addrow{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:6px;}
  .us-addrow .us-addrow-gap{flex:none;visibility:hidden;pointer-events:none;color:transparent;padding:2px 4px;font-size:14px;line-height:1;}
  .us-addrow .us-addrow-gap .us-icon-svg{width:15px;height:15px;}
  /* 버튼 안 아이콘 */
  .us-btn .us-btn-icon{display:inline-flex;align-items:center;margin-right:5px;}
  .us-btn .us-btn-icon .us-icon-svg{width:14px;height:14px;}
  /* 토글 라벨 옆에 붙는 짧은 설명 — 줄을 따로 쓰지 않는다 */
  .us-note.us-note-inline{margin:0 0 0 8px;flex:1;min-width:0;}
  /* 기록 수정의 값 칸 — 저장된 문자열(줄바꿈·태그 포함)을 그대로 담는 자동 높이 textarea */
  .us-vrow{align-items:center;}
  .us-vrow.us-vrow-multi{align-items:start;}
  .us-vrow.us-vrow-multi>label{padding-top:7px;}
  .us-vval{font-family:inherit;min-height:0;height:auto;line-height:1.45;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden;display:block;}
  /* 접기 그룹 마커 행: 상태값 목록 사이에 끼워 넣는 구분선 */
  /* 모바일 미디어쿼리의 .us-field.us-field-drag 규칙(뒤쪽)에 지지 않도록 클래스 3개로 특이도 확보 */
  .us-field.us-field-drag.us-fold-row{grid-template-columns:auto auto minmax(0,1fr) auto;}
  .us-fold-row .us-input{font-weight:600;}
  .us-fold-caret{background:transparent;border:none;color:var(--us-box-muted,var(--muted-foreground,#999));cursor:pointer;font-size:11px;line-height:1;padding:2px 4px;}
  /* 접기 안쪽 행 — 들여쓰기만으로 계층을 보여 준다 (세로 바는 핸들 앞에 겹쳐 지저분했다) */
  .us-field-row-in-fold{padding-left:16px;}
  /* 왼쪽으로 끌어 '그룹 밖으로 빼기'가 적용될 상태 — 놓기 전에 미리 보여 준다 */
  .us-field-drag.us-field-outdent{outline:1px dashed var(--us-box-primary,var(--primary,#6c8cff));outline-offset:2px;border-radius:6px;}
  /* 값 수정 화면의 그룹 박스 */
  .us-vfold{border:1px solid var(--us-box-border,var(--border,#333));border-radius:8px;margin:6px 0;overflow:hidden;}
  .us-vfold>.us-efold-head{padding:7px 10px;font-size:12px;font-weight:600;background:transparent;}
  .us-vfold>.us-efold-body{padding:8px 10px 2px;}
  .us-field.us-field-drag{grid-template-columns:auto 130px 1fr auto;}
  .us-drag-handle{display:inline-flex;align-items:center;justify-content:center;width:18px;color:var(--us-box-muted,var(--muted-foreground,#888));font-size:15px;cursor:grab;user-select:none;line-height:1;letter-spacing:-2px;touch-action:none;}
  .us-drag-handle:active{cursor:grabbing;}
  /* (구 HTML5 드래그 표시선 CSS 제거 — 필드 정렬은 포인터 기반으로 행 자체가 움직인다) */
  .us-input,.us-ta,.us-sel{width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;padding:7px 9px;border-radius:7px;border:1px solid var(--border,#444);background:var(--input,#111);color:var(--foreground,#eee);}
  /* 코드/템플릿 입력칸도 가로 스크롤 대신 자동 줄바꿈으로 — 긴 CSS 한 줄이 옆으로 흐르지 않게.
     overflow-wrap:anywhere 는 공백 없는 긴 선택자/URL 도 칸 안에서 접히게 한다. */
  .us-ta{font-family:ui-monospace,Menlo,monospace;min-height:120px;line-height:1.5;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden;}
  @media(max-width:640px){.us-field{grid-template-columns:90px 1fr auto;}.us-field.us-field-drag{grid-template-columns:auto 90px 1fr auto;}}
  .us-preview{border:1px dashed var(--border,#444);border-radius:10px;padding:12px;background:var(--background,#0e0e0e);min-height:60px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:center;}
  .us-preview.us-hist-preview{padding:0;border:none;background:transparent;min-height:0;align-items:flex-start;justify-content:flex-start;}
  .us-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;}
  .us-toggle:has(.us-note-inline){display:flex;width:100%;}
  .us-toggle>span{min-width:0;}
  .us-sw-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:6px;}
  .us-sw-item{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;}
  .us-sw{position:relative;display:inline-block;width:34px;height:18px;flex:none;}
  .us-sw input{opacity:0;width:0;height:0;position:absolute;margin:0;}
  .us-sw .tr{position:absolute;inset:0;background:var(--muted-foreground,#999);border-radius:999px;transition:.18s;opacity:.45;}
  .us-sw .tr:before{content:"";position:absolute;width:14px;height:14px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.18s;}
  .us-sw input:checked + .tr{background:var(--primary,#6c8cff);opacity:1;}
  .us-sw input:checked + .tr:before{transform:translateX(16px);}
  /* 설정창(.us-box) 안의 참고 토글(채팅 히스토리·로어북·캐릭터 카드·페르소나)도 윈도우 CSS(--us-box-*)를 따르게 한다 */
  .us-box .us-sw .tr{background:var(--us-box-switch-off,var(--muted-foreground,#999));}
  .us-box .us-sw .tr:before{background:var(--us-box-switch-thumb,#fff);}
  .us-box .us-sw input:checked + .tr{background:var(--us-box-switch-on,var(--us-box-primary,var(--primary,#6c8cff)));}
  .us-radio{display:flex;flex-direction:column;gap:6px;font-size:12px;}
  .us-radio label{display:flex;gap:8px;align-items:flex-start;cursor:pointer;}
  .us-scope-toggle{display:flex;gap:8px;flex-wrap:wrap;}
  .us-scope-toggle .us-btn[data-scope].on{font-weight:700;}
  .us-history-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);grid-template-areas:"list preview";gap:18px;align-items:stretch;}
  .us-history-col{min-width:0;display:flex;flex-direction:column;}
  .us-history-list-col{grid-area:list;}
  .us-history-preview-col{grid-area:preview;align-items:stretch;gap:8px;}
  #us-hist-apply{width:auto;min-width:72px;}
  .us-history-list-scroll{flex:1;min-height:0;overflow-y:auto;}
  .us-hist-pager-row{flex:none;padding-top:6px;}
  .us-hist-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;margin-bottom:8px;flex-wrap:wrap;}
  .us-hist-pager{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;}
  /* 이전/다음 버튼과 가운데 "1 / 11" 표시가 좁은 폭에서 눌려 글자가 세로로
     쪼개지지 않게 고정 폭 + 줄바꿈 금지로 둔다. */
  .us-hist-pager>.us-btn,.us-hist-pager>.us-note{flex:0 0 auto;white-space:nowrap;}
  .us-hist-pager>.us-note{text-align:center;min-width:44px;}
  .us-hist-pager .us-num{flex:0 0 auto;width:62px;min-width:62px;}
  .us-hturn{border:1px solid var(--border,#333);border-radius:10px;padding:8px 9px;margin-top:9px;background:var(--secondary,#232323);width:100%;box-sizing:border-box;}
  .us-hturn-head{display:inline-flex;align-items:center;column-gap:10px;row-gap:4px;flex-wrap:wrap;margin-bottom:8px;max-width:100%;}
  .us-hturn-title{font-size:12px;font-weight:700;line-height:1.2;}
  .us-hturn-meta{font-size:11px;color:var(--muted-foreground,#999);line-height:1.2;}
  .us-hturn-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;align-items:stretch;}
  .us-hist-action-btn{min-width:0;width:100%;justify-content:center;padding:3px 8px;white-space:nowrap;}
  .us-hturn-btn.on{background:var(--primary,#6c8cff);color:var(--primary-foreground,#fff);border-color:transparent;}
  .us-hist-preview-actions{display:flex;justify-content:flex-end;width:100%;margin-top:2px;align-items:center;gap:8px;}
  .us-sel option,.us-sel optgroup{color:CanvasText;background:Canvas;}
  .us-det{border:1px solid var(--border,#333);border-radius:8px;margin-top:6px;overflow:hidden;}
  /* 접기 카드 제목은 섹션 제목(13px)보다 한 단 아래 — 위계가 뒤집히지 않게 12px */
  .us-det>summary{padding:8px 12px;cursor:pointer;font-size:12px;font-weight:600;user-select:none;list-style:none;display:flex;align-items:center;gap:6px;}
  .us-det>summary:hover,.us-efold-head:hover{background:transparent;}
  .us-det>summary::before{content:"▸";font-size:11px;transition:transform .15s;}
  .us-det[open]>summary::before{content:"▾";}
  /* details 안의 입력칸은 카드 아래쪽에 딱 맞물리게 —
     display:block 이 없으면 inline 요소의 baseline 여백(3~4px)이 아래에 남는다. */
  .us-det .us-ta{display:block;border:none;border-top:1px solid var(--border,#333);border-radius:0 0 7px 7px;margin:0;vertical-align:bottom;}
  /* details 안 설명글 — summary(8px 12px)와 왼쪽 여백을 맞춘다. 입력칸 위에 온다. */
  .us-det .us-det-note{margin:0;padding:0 12px 8px;}
  .us-manager-item{display:flex;align-items:center;gap:8px;border:1px solid var(--border,#333);border-radius:8px;padding:8px 10px;flex-wrap:wrap;}
  .us-wgrip{flex:none;user-select:none;color:var(--us-box-muted,var(--muted-foreground,#888));font-size:13px;line-height:1;padding:2px 2px;}
  .us-manager-item.active{border-color:var(--primary,#6c8cff);}
  .us-manager-item .nm{flex:1;min-width:120px;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .us-manager-item .meta{font-size:11px;color:var(--muted-foreground,#999);}
  .us-note{font-size:11px;color:var(--muted-foreground,#999);line-height:1.5;margin-top:6px;}
  .us-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap;}
  .us-iconbtn{background:transparent;border:none;color:var(--muted-foreground,#999);cursor:pointer;font-size:14px;padding:2px 4px;}
  .us-iconbtn .us-icon-svg{width:15px;height:15px;}
  .us-scan-skin{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border:1px solid var(--us-box-border,var(--border,#444));border-radius:7px;color:var(--us-box-muted,var(--muted-foreground,#999));background:var(--us-box-secondary,var(--secondary,#232323));}
  .us-scan-skin:hover{background:var(--us-box-accent,var(--accent,#333));color:var(--us-box-fg,var(--foreground,#eee));}
  .us-scan-skin:disabled{opacity:.4;cursor:default;}
  .us-num{width:74px;}
  @media(max-width:${HISTORY_LAYOUT_BREAKPOINT}px){.us-history-layout{grid-template-columns:1fr;grid-template-areas:"list" "preview";}.us-history-preview-col{align-items:stretch;}.us-history-list-scroll{max-height:40vh;}}
  @media(max-width:640px){
    #${FLOAT_ID}.inline-mode{max-width:100%!important;padding:7px;}
    #${FLOAT_ID}.inline-mode .us-f-bar{gap:2px;padding-left:0;padding-right:0;}
    #${FLOAT_ID}.inline-mode .us-f-btn{width:29px;height:29px;}
    #${FLOAT_ID}.inline-mode .us-f-title{font-size:11.5px;}
    [${INLINE_SLOT_ATTR}]{padding-left:4px;padding-right:4px;}
    [${INLINE_STATUS_ATTR}="past"].us-hist-widget{padding:7px;}
    [${INLINE_STATUS_ATTR}="past"] .us-inline-head{gap:1px;padding:0;}
    [${INLINE_STATUS_ATTR}="past"] .us-inline-main{gap:4px;}
    [${INLINE_STATUS_ATTR}="past"] .us-inline-actions{gap:0;}
    [${INLINE_STATUS_ATTR}="past"] .us-inline-action{width:28px;height:28px;}
    [${INLINE_STATUS_ATTR}="past"] .us-inline-chevron{width:24px;height:28px;}
    .us-box{width:calc(100vw - 16px);max-width:none;padding:14px 12px;border-radius:12px;}
    #${PANEL_ID} .us-box{width:calc(100vw - 12px);height:min(92vh,780px);}
    .us-row{flex-wrap:wrap;overflow-x:visible;}
    .us-status-default-row .us-note{flex-basis:100%;}
    .us-status-default-row .us-sel{max-width:none!important;}
    /* ── 내 상태창 목록 (좁은 화면) ────────────────────────────────
       1줄: 즐겨찾기 · 이름 · (장면/캐릭터 · 윈도우 CSS 여부)
       2줄: 적용 · 편집 · 복제 · 추출 · 삭제
       ::after 로 폭 100% 짜리 높이 0 항목을 끼워 줄바꿈 지점을 강제한다. */
    .us-item,.us-manager-item{gap:6px;padding:8px;flex-wrap:wrap;align-items:center;}
    .us-item .us-wgrip,.us-manager-item .us-wgrip,
    .us-item .us-iconbtn,.us-manager-item .us-iconbtn{order:0;flex:none;}
    .us-item .nm,.us-manager-item .nm{order:1;flex:1 1 auto;min-width:48px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .us-item .us-syncbtn,.us-manager-item .us-syncbtn{order:3;}
    .us-item .meta,.us-manager-item .meta{order:2;flex:0 1 auto;min-width:0;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .us-item::after,.us-manager-item::after{content:"";order:5;flex:0 0 100%;height:0;margin:0;}
    .us-item .us-btn,.us-manager-item .us-btn{order:6;flex:1 1 auto;min-height:32px;justify-content:center;white-space:nowrap;padding:5px 4px;}
    .us-field{grid-template-columns:72px minmax(0,1fr) auto;}
    .us-field.us-field-drag{grid-template-columns:auto 72px minmax(0,1fr) auto;}

    /* ── 좁은 화면: 버튼만 있는 줄은 격자로 ────────────────────────
       예전엔 flex 로 늘어난 버튼 안에서 글자가 두 줄로 접히며 버튼이
       세로로 길쭉해졌다. 한 줄에 하나(버튼이 4개 이상이면 두 개)씩
       폭을 꽉 채워 배치하고 글자는 접지 않는다. */
    .us-box .us-row:not(:has(> :not(.us-btn))),
    .us-box .us-foot,
    .us-box .us-scope-toggle{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;overflow:visible;}
    .us-box .us-row:not(:has(> :not(.us-btn))):has(> .us-btn:nth-child(4)),
    .us-box .us-scope-toggle{grid-template-columns:repeat(2,minmax(0,1fr));}
    .us-box .us-row:not(:has(> :not(.us-btn)))>.us-btn,
    .us-box .us-foot>.us-btn,
    .us-box .us-scope-toggle>.us-btn{width:100%;min-width:0;justify-content:center;white-space:nowrap;min-height:38px;}

    /* 탭 줄 — 탭은 줄바꿈, '이 채팅에서 켜기'는 아래 줄로 내려 붙는다 */
    .us-box .us-ptabs{flex-wrap:wrap;gap:2px 4px;row-gap:0;}
    .us-box .us-ptab{padding:7px 10px;font-size:11.5px;white-space:nowrap;}

    /* 참조 범위 스위치 — 두 칸 격자 + 좌우 정렬로 터치 영역 확보 */
    .us-box .us-sw-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;}
    .us-box .us-sw-item{justify-content:space-between;white-space:normal;min-width:0;}

    /* 스위치가 붙은 설정 줄 — 글이 길어도 스위치가 찌그러지지 않게 */
    .us-box .us-toggle{align-items:flex-start;line-height:1.5;}
    .us-box .us-toggle>span{flex:1;}
    .us-box .us-toggle .us-switch{margin-top:1px;}

    .us-box .us-hturn-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
    .us-box .us-fold-badge{display:none;}
    .us-box .us-num{width:84px;}
    .us-box .us-hist-pager .us-num{width:62px;min-width:62px;}
    .us-box .us-sel{max-width:none;}
  }
  /* 동적 뷰포트 단위 지원 브라우저(모바일 주소창 대응) — 위 규칙 뒤에 와야 덮어쓴다 */
  @supports (height:100dvh){
    @media(max-width:640px){
      .us-box{max-height:92dvh;}
      #${PANEL_ID} .us-box{height:min(92dvh,780px);}
    }
  }
  @media(max-width:420px){
    [${INLINE_STATUS_ATTR}="past"] .us-inline-turn{display:none;}
    #${FLOAT_ID}.inline-mode .us-f-title{font-size:11px;}
    .us-box .us-hturn-grid{grid-template-columns:1fr;}
    .us-field{grid-template-columns:minmax(0,1fr) auto;}
    .us-field.us-field-drag{grid-template-columns:auto minmax(0,1fr) auto;}
    .us-field>label,.us-field>.us-field-label{grid-column:1/-1;}
    /* 가장 좁은 폭: 버튼은 무조건 한 줄에 하나, 스위치 목록도 한 칸씩 */
    .us-box .us-row:not(:has(> :not(.us-btn))):has(> .us-btn:nth-child(4)),
    .us-box .us-scope-toggle{grid-template-columns:minmax(0,1fr);}
    .us-box .us-sw-row{grid-template-columns:minmax(0,1fr);gap:8px;}
    .us-box{padding:12px 10px;}
    .us-box .us-h h2{font-size:15px;}
    .us-box .us-ptab{padding:7px 8px;font-size:11px;}
    /* 값 수정 폼(플로팅/기록 편집) — 라벨을 입력칸 위로 올린다 */
    #${FLOAT_ID} .us-erow{flex-wrap:wrap;gap:4px;}
    #${FLOAT_ID} .us-erow>span{width:100%;flex:1 0 100%;font-size:11px;}
    #${FLOAT_ID} .us-erow-foot{flex-wrap:wrap;align-items:center;}
    #${FLOAT_ID} .us-erow-foot .us-btn{flex:1 1 auto;justify-content:center;white-space:nowrap;}
  }
  @media(hover:none){
    #${FLOAT_ID} .us-f-btn:hover,[${INLINE_STATUS_ATTR}="past"] .us-inline-action:hover{background:transparent;}
  }
  `);

  // ── 주체 네비게이터 ──
  let refreshing = false;
  let refreshingChatId = null; // 수동 새로고침이 시작된 채팅 — 그 채팅에서만 스피너를 돈다
  let refreshingStartTs = 0;   // 새로고침 시작 시각 (굳은 잠금 자동 해제용)
  const activeDryRunIdByChat = {}; // 채팅별 진행 중 dryRun runId (자동 캡처도 중지 가능)
  let dryRunAborted = false;   // 사용자가 직접 중지했을 때 toast 억제용
  function genRunId() {
    return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : (Math.random().toString(36).slice(2, 9) + "-" + Date.now().toString(36));
  }
  const isGeneratingByChat = {};
  const genStartTsByChat = {}; // cid → 생성 시작 시각 (stale 스피너 워치독용)
  const genBaselineByChat = {}; // cid → 생성 직전 메시지 스냅샷 (에이전트 등 '메시지를 커밋하지 않는' 생성의 캡처 억제용 백스톱)
  const genTargetByChat = {}; // cid → 생성 시작 시 스냅샷한 타겟 msgId(이전 메시지 재생성) 또는 null(최신)
  const genTargetExplicit = {}; // cid → fetch 훅이 regenerateMessageId로 정확히 잡았으면 true (포커스 추측 차단)
  const captureBusyByChat = {}; // cid → 캡처 진행 중 여부 (중복 요청 방지)
  const captureBusyTsByChat = {}; // cid → 캡처 시작 시각 (stale busy 감지용)
  const captureTimerByChat = {}; // cid → idle 후 지연 캡처 타이머 (연속 idle 디바운스)
  // 비동기 생성 이벤트(mari-phase/generation-complete/error)에 chatId가 없을 때의 귀속 규칙.
  //   과거엔 getChatId()(=지금 보고 있는 채팅)로 폴백했는데, 생성 시작 후 다른 채팅으로 이동하면
  //   그 채팅에 스피너가 잘못 붙었다(다른 방에서도 스피너가 돎). 대신 '실제 생성 진행 중'으로
  //   기록된 채팅(fetch 훅이 genStartTsByChat/isGeneratingByChat에 남김)으로 귀속한다.
  function resolveGenChatId(explicit) {
    if (explicit && typeof explicit === "string") return explicit;
    const inflight = Object.keys(genStartTsByChat);
    if (inflight.length === 1) return inflight[0];
    if (inflight.length > 1) {
      let best = null, bestTs = -1;
      for (const k of inflight) { const ts = genStartTsByChat[k] || 0; if (ts > bestTs) { bestTs = ts; best = k; } }
      if (best) return best;
    }
    const gens = Object.keys(isGeneratingByChat).filter((k) => isGeneratingByChat[k]);
    if (gens.length === 1) return gens[0];
    return getChatId();
  }
  let editingFloat = false;
  let promptBubbleOpen = false;
  let promptBubbleTargetMeta = null; // 인라인 과거 기록의 프롬프트 재생성 대상
  let promptBubblePos = null;
  let othersBoxOpen = false;
  const historyTurnPageByChat = {};
  const historySelectedKeyByChat = {};
  const activeTabByChat = {};
  function isInlineDisplayMode() {
    return !config.ui || config.ui.displayMode !== "floating";
  }
  // 이 채팅에서 상태창이 실제로 동작하는 상태인지. (CONVO 기본 비활성 + 채팅별 끄기)
  //  렌더 분기(꺼짐 안내·전원 버튼)와 인라인 마운트 판정이 같은 기준을 쓰도록 한 곳에 모은다.
  function isChatConvoDisabled(chatId) {
    return getChatModeCached(chatId) === "conversation" && !config.perChatSettings[chatId];
  }
  function isChatWindowActive(chatId) {
    return !isChatConvoDisabled(chatId) && !!getSettings(chatId).enabled;
  }
  // 이 채팅에서 상태창을 켠다 (CONVO 기본 비활성 채팅은 채팅 전용 설정을 만들어 켬)
  function turnOnStatusForChat(chatId) {
    if (chatId) { ensureChatSettings(chatId); config.perChatSettings[chatId].enabled = true; }
    else { if (!config.settings) config.settings = {}; config.settings.enabled = true; }
    saveConfig();
    invalidateFloat();
    // 꺼져 있는 동안 비워 뒀던 메시지 메타를 즉시 다시 읽어 값이 바로 보이게 한다.
    try { void syncMessages({ chatId }); } catch (_) {}
  }
  // ── 제목 바(상단 바)로 접기/펼치기 ──────────────────────────────
  //   "click"(기본) — 제목 줄을 한 번 클릭하면 접기/펼치기.
  //   플로팅 모드에서는 창 이동(드래그)과 구분해야 하므로, 누른 지점과 뗀 지점의
  //   거리가 5px 미만일 때만 클릭으로 본다. "off" 로 두면 화살표 버튼만 동작한다.
  function barToggleMode() {
    return (config && config.ui && config.ui.barToggleMode === "off") ? "off" : "click";
  }
  // 바 위에 '얹혀 있는' 조작 버튼(접기·값수정·재생성·새로고침·설정)은 토글 대상에서 제외한다.
  function isBarPassThroughTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest("button,a,input,textarea,select,[data-inline-act],[data-act]");
  }
  // handleEl: 클릭 판정을 받을 바 요소 / toggleFn: 접기 토글 함수
  function wireBarToggle(handleEl, toggleFn) {
    if (!handleEl || handleEl._usBarToggle) return;
    handleEl._usBarToggle = true;
    if (barToggleMode() === "off") { handleEl.style.cursor = ""; return; }
    handleEl.classList.add("us-bar-toggleable");
    let downXY = null;
    const onDown = (e) => {
      if (isBarPassThroughTarget(e.target)) { downXY = null; return; }
      const p = "touches" in e ? e.touches[0] : e;
      downXY = p ? { x: p.clientX, y: p.clientY } : null;
    };
    handleEl.addEventListener("mousedown", onDown);
    handleEl.addEventListener("touchstart", onDown, { passive: true });
    handleEl.addEventListener("click", (e) => {
      if (isBarPassThroughTarget(e.target)) return;
      // 빠르게 두 번 누르면 두 번 토글돼 제자리로 돌아오는 것 방지 (두 번째 클릭 무시)
      if (e.detail > 1) return;
      // 드래그(이동)와 클릭(접기) 구분 — 5px 이상 움직였으면 이동으로 본다.
      if (downXY && (Math.abs(e.clientX - downXY.x) > 5 || Math.abs(e.clientY - downXY.y) > 5)) { downXY = null; return; }
      downXY = null;
      e.preventDefault(); e.stopPropagation();
      toggleFn();
    });
  }
  function isLatestWindowCollapsed(chatId) {
    if (!isInlineDisplayMode()) return !!config.ui.floatCollapsed;
    const saved = chatId && config.ui.inlineWindowCollapsed && config.ui.inlineWindowCollapsed[chatId];
    return typeof saved === "boolean" ? saved : !!config.ui.inlineWindowDefaultCollapsed;
  }
  // 현재 아이콘 최소화 모드인지 — 위치를 floatPos/iconPos 중 어느 쪽에 읽고 쓸지 결정.
  function isIconModeNow() {
    return !isInlineDisplayMode() && !!config.ui.floatCollapsed && config.ui.floatMinimizeMode === "icon";
  }
  function getActivePos() {
    return isIconModeNow() ? config.ui.iconPos : config.ui.floatPos;
  }
  function setActivePos(p) {
    if (isIconModeNow()) config.ui.iconPos = p; else config.ui.floatPos = p;
  }
  function applyFloatPos(el) {
    const layoutProps = ["position", "inset", "left", "right", "top", "bottom", "z-index", "width", "max-width", "min-width", "align-self", "box-sizing", "margin"];
    for (const prop of layoutProps) el.style.removeProperty(prop);
    if (isInlineDisplayMode()) {
      // 채팅 내부 모드에서는 Window CSS의 fixed 위치·큰 폭보다 메시지 열의 레이아웃을 우선한다.
      el.style.setProperty("position", "static", "important");
      el.style.setProperty("inset", "auto", "important");
      el.style.setProperty("left", "auto", "important");
      el.style.setProperty("right", "auto", "important");
      el.style.setProperty("top", "auto", "important");
      el.style.setProperty("bottom", "auto", "important");
      el.style.setProperty("z-index", "auto", "important");
      el.style.setProperty("width", config.ui.inlineFullWidth ? "100%" : `min(${FLOAT_W}px, 100%)`, "important");
      el.style.setProperty("max-width", "100%", "important");
      el.style.setProperty("min-width", "0", "important");
      el.style.setProperty("align-self", "flex-start", "important");
      el.style.setProperty("box-sizing", "border-box", "important");
      el.style.setProperty("margin", "10px 0 0", "important");
      return;
    }
    // 화면에 띄우기 모드는 v1.8 계열의 독립 위치와 드래그 좌표를 그대로 사용한다.
    const pos = getActivePos();
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      // ⚠ 저장된 좌표를 그대로 쓰면 안 된다. 브라우저 창을 줄이면 그 좌표가 화면 밖이 되어
      //   창이 잘리고, 드래그 핸들(제목 바)까지 밖으로 나가 되돌릴 방법이 없어진다.
      //   창의 '실제 크기'를 재서 화면 안에 완전히 들어오도록 매 렌더마다 보정한다.
      //   저장값 자체는 건드리지 않는다 — 브라우저를 다시 넓히면 원래 자리로 돌아가야 하므로.
      const c = clampPos(pos.x, pos.y, el);
      el.style.left = c.x + "px"; el.style.top = c.y + "px"; el.style.right = "auto"; el.style.bottom = "auto";
    } else {
      el.style.right = "14px"; el.style.bottom = "96px"; el.style.left = "auto"; el.style.top = "auto";
    }
  }
  // 창 크기가 바뀌면 위치를 즉시 다시 보정한다 (렌더를 기다리지 않게).
  //   요소 크기를 알아야 하므로 DOM 에 붙어 있는 상태에서 호출한다.
  function reclampFloatPos() {
    if (isInlineDisplayMode()) return;
    const el = document.getElementById(FLOAT_ID);
    if (!el || !el.isConnected) return;
    const pos = getActivePos();
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return;
    const c = clampPos(pos.x, pos.y, el);
    el.style.left = c.x + "px"; el.style.top = c.y + "px"; el.style.right = "auto"; el.style.bottom = "auto";
  }
  // 캐릭터 본문 좌우 밀기 → 탭 이동.
  //   ⚠ 가로 거리만 보면 모바일에서 위아래로 스크롤하다 손가락이 비스듬히 가도 탭이 넘어간다.
  //   그래서 ① 한 번이라도 세로 움직임이 더 크면 그 터치는 스크롤로 보고 버리고
  //   ② 끝났을 때 가로가 세로의 2배 이상 · 60px 이상일 때만 넘긴다.
  //   ③ 두 손가락(확대) · 가로 스크롤 되는 칸 안에서 시작한 터치는 무시한다.
  function attachSwipe(el, onNext, onPrev) {
    let x0 = null, y0 = 0, scrolled = false;
    const hScrollable = (node) => {
      for (let n = node; n && n !== el && n.nodeType === 1; n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode) {
        if (n.scrollWidth > n.clientWidth + 2) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll") return true;
        }
      }
      return false;
    };
    const start = (e) => {
      x0 = null;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const target = (e.composedPath && e.composedPath()[0]) || e.target;
      if (hScrollable(target)) return;
      x0 = t.clientX; y0 = t.clientY; scrolled = false;
    };
    const move = (e) => {
      if (x0 == null) return;
      if (e.touches.length !== 1) { x0 = null; return; }
      const t = e.touches[0];
      if (Math.abs(t.clientY - y0) > 10 && Math.abs(t.clientY - y0) >= Math.abs(t.clientX - x0)) scrolled = true;
    };
    const end = (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (scrolled || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (dx < 0) onNext(); else onPrev();
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", () => { x0 = null; });
  }
  // ── 스킨 내부 UI 상태 보존 ──────────────────────────────────────────────
  //   라디오 탭·체크박스·<details> 펼침처럼 스킨 템플릿(shadow DOM) 안의 인터랙션 상태는
  //   플로팅 창이 다시 그려질 때마다 템플릿 기본값으로 리셋된다 (재렌더는 스트리밍·스크롤
  //   포커스 갱신·값 변경 등으로 수시로 일어남 → "인벤토리 탭을 눌러도 SCENE으로 튕김").
  //   여기서 채팅별로 상태를 기억해 두고, 렌더 직후 복원한다 (세션 휘발성 — 새로고침 시 초기화).
  //   추가 규칙: <details> 를 한 번이라도 펼치면 그 항목의 'new' 클래스를 제거하고 기억한다
  //   → NEW 배지는 한 번 열어보면 다시 그려져도 사라진 채 유지된다.
  const skinUiStateByChat = {}; // key(chatId/미리보기 키) → { radios:Map(name→id), checked:Set(id), open:Set(detKey), seen:Set(detKey) }
  function skinUiState(key) {
    return skinUiStateByChat[key] || (skinUiStateByChat[key] = { radios: new Map(), checked: new Set(), open: new Set(), seen: new Set() });
  }
  // details 식별 키: summary 텍스트(값이 같으면 재렌더 후에도 같은 항목) → 없으면 순번
  function skinDetKey(d, i) {
    const s = d.querySelector("summary");
    const t = s ? (s.textContent || "").trim() : "";
    return t || ("idx:" + i);
  }
  function wireSkinUiState(container, key) {
    if (!container || !key) return;
    const st = skinUiState(key);
    container.querySelectorAll("[data-us-host]").forEach((host) => {
      const sr = host.shadowRoot;
      if (!sr || sr._usUiWired) return;
      sr._usUiWired = true;
      // ① 복원 — 라디오(탭)
      sr.querySelectorAll('input[type="radio"]').forEach((r) => {
        if (r.name && st.radios.has(r.name)) r.checked = (st.radios.get(r.name) === (r.id || r.value));
      });
      // ① 복원 — 체크박스
      sr.querySelectorAll('input[type="checkbox"]').forEach((c) => {
        if (c.id && st.checked.has(c.id)) c.checked = true;
      });
      // ① 복원 — details 펼침 + NEW 제거(seen)
      const dets = Array.from(sr.querySelectorAll("details"));
      dets.forEach((d, i) => {
        const k = skinDetKey(d, i);
        if (st.open.has(k)) d.open = true;
        if (st.seen.has(k)) d.classList.remove("new");
      });
      // ② 기록 — 이후 조작을 상태에 반영 (capture: shadow root 이하 전체를 커버, toggle은 비버블 이벤트라 capture 필수)
      sr.addEventListener("change", (e) => {
        const t = e.target;
        if (!t) return;
        if (t.type === "radio" && t.name) st.radios.set(t.name, t.id || t.value);
        else if (t.type === "checkbox" && t.id) { if (t.checked) st.checked.add(t.id); else st.checked.delete(t.id); }
      }, true);
      sr.addEventListener("toggle", (e) => {
        const d = e.target;
        if (!d || !d.tagName || d.tagName !== "DETAILS") return;
        const all = Array.from(sr.querySelectorAll("details"));
        const k = skinDetKey(d, all.indexOf(d));
        if (d.open) { st.open.add(k); st.seen.add(k); d.classList.remove("new"); }
        else st.open.delete(k);
      }, true);
    });
  }

  // 캐릭터 접기 버튼 표시 여부(실효값): 스킨별 설정이 전역 설정보다 우선한다.
  function charCollapseEnabledFor(status) {
    const m = status && status.charCollapseMode;
    if (m === "on") return true;
    if (m === "off") return false;
    if (isInlineDisplayMode()) return true;
    return !!config.ui.charCollapseEnabled; // "global" 또는 미지정 → 전역 설정 따름
  }

  function renderNav(container, status, scene, subjects, key) {
    container.innerHTML = "";
    // 표시 숨김(눈 토글): 현재 채팅의 라이브 표시에서만 숨긴 캐릭터를 제외한다.
    //   (기록/미리보기 위젯은 당시 스냅샷을 그대로 보여주므로 숨김을 적용하지 않는다.)
    const isLiveChatKey = key && key !== HISTORY_PREVIEW_KEY && key !== PREVIEW_KEY;
    const hiddenSet = isLiveChatKey ? getHiddenSet(key) : null;
    const list = (Array.isArray(subjects) ? subjects : [])
      .filter((s) => !(hiddenSet && hiddenSet.size && s && hiddenSet.has(normLabel(s.label))));
    const sceneOn = Array.isArray(status.sceneFields) && status.sceneFields.length > 0;
    const historyPreview = key === HISTORY_PREVIEW_KEY;
    const transientPreview = historyPreview || key === PREVIEW_KEY || String(key || "").startsWith("__inline__");
    if (sceneOn && scene) {
      const chatKey = key;
      const saved = chatKey && !transientPreview ? config.ui.sceneCollapsed[chatKey] : undefined;
      const sceneCollapsed = typeof saved === "boolean" ? saved : (isInlineDisplayMode() ? !!config.ui.inlineSceneDefaultCollapsed : !!status.sceneDefaultCollapsed);
      const slot = document.createElement("div"); slot.className = "us-scene-slot";
      const toggleScene = (nextCollapsed) => {
        if (transientPreview) {
          drawScene(nextCollapsed);
          return;
        }
        if (!chatKey) return;
        config.ui.sceneCollapsed[chatKey] = !!nextCollapsed;
        saveConfig();
        lastFloatSig = null;
        renderFloat();
      };
      const drawScene = (collapsed) => {
        slot.innerHTML = "";
        // 버튼은 항상 표시, 화살표 방향으로 접힘/펼침 상태 표현
        const sceneButton = buildSceneButton(status);
        const arrow = sceneButton.querySelector(".us-scene-arrow");
        if (arrow) arrow.textContent = collapsed ? "▸" : "▾";
        sceneButton.setAttribute("aria-label", collapsed ? "장면 띠 펼치기" : "장면 띠 접기");
        sceneButton.setAttribute("title", collapsed ? "장면 띠 펼치기" : "장면 띠 접기");
        sceneButton.onclick = () => toggleScene(!collapsed);
        slot.appendChild(sceneButton);
        if (!collapsed) {
          const sceneBody = document.createElement("div");
          sceneBody.className = "us-scene-body";
          sceneBody.appendChild(buildSceneHost(status, scene));
          slot.appendChild(sceneBody);
        }
        wireSkinUiState(slot, key); // 스킨 내부 탭·펼침 상태 복원/기록
      };
      drawScene(sceneCollapsed);
      container.appendChild(slot);
    }
    // ── 장면 전용 스킨: 캐릭터 필드가 없으면 캐릭터 영역(탭·카드)을 아예 그리지 않는다.
    //    (과거에 저장된 subjects 나 카드 로스터 이월분이 남아 있어도 무시)
    if (!Array.isArray(status.fields) || !status.fields.length) return;
    if (!list.length) return;
    let idx = activeTabByChat[key] ?? 0; if (idx >= list.length) idx = 0; activeTabByChat[key] = idx;
    // 탭 전환은 캐릭터 영역만 다시 그린다.
    //   예전엔 renderNav 를 통째로 다시 불렀는데, 그러면 접힘 상태를 '저장값 없으면 기본값'으로
    //   다시 계산한다. 인라인 기본값이 접힘이라(inlineCharDefaultCollapsed / inlineSceneDefaultCollapsed)
    //   접기 버튼을 한 번도 안 누른 채팅에서는 탭만 눌러도 캐릭터·장면이 접혀 버렸다.
    //   접기는 접기 버튼으로만 일어나야 한다 — 장면 띠는 아예 건드리지 않는다.
    const go = (i) => {
      idx = (i + list.length) % list.length;
      activeTabByChat[key] = idx;
      drawChars(charCollapsedNow);
    };
    // ── 캐릭터 영역 접기 (전역 설정 + 스킨별 오버라이드) — 장면 띠 접기와 동일한 패턴 ──
    const charCollapseOn = charCollapseEnabledFor(status);
    const charSlot = document.createElement("div"); charSlot.className = "us-char-slot";
    container.appendChild(charSlot);
    const isLivePreviewKey = !key || String(key).startsWith("__"); // __history__/__preview__/__tester__ — 상태 저장 안 함(로컬 토글)
    const savedChar = key && !isLivePreviewKey ? config.ui.charCollapsed[key] : undefined;
    const charCollapsed = charCollapseOn ? (typeof savedChar === "boolean" ? savedChar : (isInlineDisplayMode() && !!config.ui.inlineCharDefaultCollapsed)) : false;
    // 지금 화면에 그려져 있는 접힘 상태. 탭 전환은 이 값을 그대로 유지한다.
    let charCollapsedNow = charCollapsed;
    const toggleChars = (nextCollapsed) => {
      charCollapsedNow = !!nextCollapsed;
      if (isLivePreviewKey) { drawChars(nextCollapsed); return; }
      if (!key) return;
      config.ui.charCollapsed[key] = !!nextCollapsed;
      saveConfig();
      lastFloatSig = null;
      renderFloat();
    };
    const drawChars = (collapsed) => {
      charSlot.innerHTML = "";
      if (charCollapseOn) {
        // 장면 버튼(buildSceneButton)과 '완전히 같은 구조'로 만든다 — 같은 클래스, 같은
        // buildUiHost 렌더, 장면 버튼 CSS(sceneButtonCss)까지 공유 → 정렬·크기·스킨 스타일이
        // 항상 장면 접기 버튼과 동일해진다. 라벨은 접힘 여부와 무관하게 "캐릭터" 고정.
        const btn = document.createElement("button");
        btn.className = "us-scene-button us-char-button";
        btn.type = "button";
        btn.appendChild(buildUiHost("캐릭터", status.sceneButtonCss || "", {}, ""));
        const arrow = document.createElement("span");
        arrow.className = "us-scene-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = collapsed ? "▸" : "▾";
        btn.appendChild(arrow);
        btn.setAttribute("aria-label", collapsed ? "캐릭터 영역 펼치기" : "캐릭터 영역 접기");
        btn.title = collapsed ? "캐릭터 영역 펼치기" : "캐릭터 영역 접기";
        btn.onclick = () => toggleChars(!collapsed);
        charSlot.appendChild(btn);
        if (collapsed) return;
      }
      if (list.length > 1) {
        const bar = document.createElement("div"); bar.className = "us-tabs";
        const pills = document.createElement("div"); pills.className = "us-pills";
        list.forEach((s, i) => {
          const b = document.createElement("button");
          b.className = "us-tab" + (i === idx ? " on" : "");
          b.type = "button";
          b.setAttribute("aria-pressed", i === idx ? "true" : "false");
          b.title = s.label || ("#" + (i + 1));
          b.appendChild(buildUiHost(status.tabTemplate || DEFAULT_TAB_TEMPLATE, status.tabCss || "", { index: i + 1, 순번: i + 1, active: i === idx ? "on" : "", 상태: i === idx ? "on" : "" }, s.label || ("#" + (i + 1)), valueOptsOf(status)));
          b.onclick = () => go(i);
          pills.appendChild(b);
        });
        wireDragScroll(pills);
        bar.appendChild(pills);
        charSlot.appendChild(bar);
      }
      const bodyEl = document.createElement("div"); bodyEl.className = "us-f-body";
      bodyEl.appendChild(buildStatusHost(status, list[idx].values, list[idx].label || ""));
      charSlot.appendChild(bodyEl);
      if (list.length > 1) attachSwipe(bodyEl, () => go(idx + 1), () => go(idx - 1));
      wireSkinUiState(charSlot, key); // 스킨 내부 탭·펼침 상태 복원/기록
    };
    drawChars(charCollapsed);
  }

  // ── 메시지 말풍선 내부 표시 ────────────────────────────────────────────
  // 채팅 내부 모드에서는 각 어시스턴트 메시지의 말풍선/첨부 뒤, 스와이프·액션 아이콘 바 앞에
  // 상태창 슬롯을 둔다. 최신은 전체 도구막대, 과거 기록은 기본 접힘 위젯으로 렌더한다.
  const inlinePastCollapsed = {};
  const inlineLatestSeenByChat = {};
  function inlineMountForMessage(node) {
    if (!node || !node.querySelector) return null;
    const msgId = node.getAttribute("data-message-id") || "";
    const existingSlots = Array.from(node.querySelectorAll(`[${INLINE_SLOT_ATTR}]`))
      .filter((candidate) => candidate.getAttribute(INLINE_SLOT_ATTR) === msgId);
    let slot = existingSlots.shift() || null;
    existingSlots.forEach((duplicate) => duplicate.remove());
    const ensureSlot = (container) => {
      if (!container) return null;
      if (!slot) {
        slot = document.createElement("div");
        slot.setAttribute(INLINE_SLOT_ATTR, msgId);
      }
      return slot;
    };
    // 두 지원 버전 모두 스와이프(.mari-message-swipes)와 액션(.mari-message-actions)을
    // 말풍선 본문 열의 하단 자식으로 둔다. 그 둘 중 먼저 나오는 요소 바로 앞이 정확한 삽입점이다.
    const body = node.querySelector(".mari-message-body");
    const actionBar = node.querySelector(".mari-message-actions");
    const container = (actionBar && actionBar.parentElement) || body;
    if (container) {
      ensureSlot(container);
      const anchor = Array.from(container.children).find((child) =>
        child !== slot && child.classList &&
        (child.classList.contains("mari-message-swipes") || child.classList.contains("mari-message-actions"))
      );
      if (anchor) {
        if (slot.nextElementSibling !== anchor) container.insertBefore(slot, anchor);
      } else if (slot.parentElement !== container || container.lastElementChild !== slot) {
        container.appendChild(slot);
      }
      return slot;
    }
    const bubble = node.querySelector(".mari-message-bubble");
    const content = node.querySelector(".mari-message-content");
    const fallbackContainer = (bubble && bubble.parentElement) || (content && content.parentElement) || node;
    ensureSlot(fallbackContainer);
    if (slot.parentElement !== fallbackContainer || fallbackContainer.lastElementChild !== slot) fallbackContainer.appendChild(slot);
    return slot;
  }
  function firstStoredEntryForMessage(chatId, msgId) {
    const store = loadStore(chatId);
    const bySwipe = store.byMsg && store.byMsg[msgId];
    if (!bySwipe || typeof bySwipe !== "object") return null;
    for (const raw of Object.values(bySwipe)) {
      if (raw != null) return normalizeMsgEntry(raw, store.statusId || null);
    }
    return null;
  }
  function renderPastInlineWidget(host, chatId, msgId, swipe, entry, fallbackEntry) {
    const emptySwipe = !entry;
    const status = statusForEntry(chatId, entry || fallbackEntry);
    if (!status || (!emptySwipe && !entry.scene && !entry.subjects.length)) { host.remove(); return; }
    const key = `${chatId}:${msgId}:${swipe}`;
    const collapsed = inlinePastCollapsed[key] !== false;
    const turn = computeTurn(chatId, msgId);
    const widgetTitle = (chatId && config.perChatTitle[chatId]) || chatNameCache[chatId] || status.name || "상태 기록";
    const showTitle = config.ui.inlineShowTitle !== false;
    const promptAvailable = getSettings(chatId).dataMode === DATA_MODES.api;
    // 이 메시지를 대상으로 상태 생성이 진행 중이면(수동 '이 메시지의 상태 생성'·프롬프트 재생성)
    // 플로팅 새로고침처럼 생성 버튼을 스피너로 돌리고, '기록 없음' 문구는 그동안 표시하지 않는다.
    const busyHere = ((refreshing && refreshingChatId === chatId) || !!captureBusyByChat[chatId]) && genTargetByChat[chatId] === msgId;
    const signature = JSON.stringify([status.id, entry, fallbackEntry && fallbackEntry.statusId, collapsed, turn, widgetTitle, showTitle, promptAvailable, busyHere, barToggleMode()]);
    if (host.dataset.usSignature === signature) return;
    host.dataset.usSignature = signature;
    host.className = "us-hist-widget" + (!emptySwipe && collapsed ? " collapsed" : "");
    const actions = `
      <div class="us-inline-actions">
        <button type="button" class="us-inline-action" data-inline-act="edit" title="값 수정" aria-label="값 수정" ${emptySwipe ? "disabled" : ""}>${ICON.edit}</button>
        <button type="button" class="us-inline-action" data-inline-act="regen" title="프롬프트 재생성${promptAvailable ? "" : " (API 따로 연결 방식에서 사용)"}" aria-label="프롬프트 재생성" ${promptAvailable ? "" : "disabled"}>${ICON.prompt}</button>
        <button type="button" class="us-inline-action${busyHere ? " spinning" : ""}" data-inline-act="generate" title="${busyHere ? "상태 생성 중" : "이 메시지의 상태 생성"}" aria-label="${busyHere ? "상태 생성 중" : "이 메시지의 상태 생성"}">${ICON.refresh}</button>
        <button type="button" class="us-inline-action" data-inline-act="settings" title="설정" aria-label="설정">${ICON.settings}</button>
      </div>`;
    host.innerHTML = `
      <div class="us-inline-head">
        ${emptySwipe ? `<div class="us-inline-main us-inline-empty" role="status">
          <span class="us-inline-chevron">—</span>
          ${showTitle ? `<span class="us-inline-title">${esc(widgetTitle)}</span>` : ""}
          <span class="us-inline-turn">${busyHere ? (turn ? `턴 ${turn}` : "") : `${turn ? `턴 ${turn} · ` : ""}이 스와이프에는 기록 없음`}</span>
        </div>` : `<button type="button" class="us-inline-main" data-inline-act="collapse" aria-expanded="${collapsed ? "false" : "true"}">
          <span class="us-inline-chevron">${collapsed ? ICON.chevronRight : ICON.chevronDown}</span>
          ${showTitle ? `<span class="us-inline-title">${esc(widgetTitle)}</span>` : ""}
          <span class="us-inline-turn">${turn ? `턴 ${turn}` : "이전 기록"}</span>
        </button>`}
        ${actions}
      </div>
      ${emptySwipe ? "" : `<div class="us-inline-content"></div>`}`;
    applyWidgetWindowCss(host, status);
    applyFloatPos(host);
    const togglePast = () => {
      inlinePastCollapsed[key] = !collapsed;
      delete host.dataset.usSignature;
      renderPastInlineWidget(host, chatId, msgId, swipe, entry, fallbackEntry);
    };
    const collapseBtn = host.querySelector('[data-inline-act="collapse"]');
    if (collapseBtn) collapseBtn.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      // 더블클릭해도 두 번 토글돼 제자리로 돌아오지 않게 두 번째 클릭은 무시
      if (event.detail > 1) return;
      togglePast();
    };
    // 과거 기록 카드도 헤더 띠 전체를 접기/펼치기 영역으로 (버튼 사이 빈 곳 포함).
    if (!emptySwipe) wireBarToggle(host.querySelector(".us-inline-head"), togglePast);
    const editBtn = host.querySelector('[data-inline-act="edit"]');
    if (editBtn && !emptySwipe) editBtn.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      openHistoryEditModal({ entry, msgId, swipe, turn }, chatId, null);
    };
    const regenBtn = host.querySelector('[data-inline-act="regen"]');
    if (regenBtn && promptAvailable) regenBtn.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      promptBubbleTargetMeta = { id: msgId, swipe };
      promptBubbleOpen = true; promptBubblePos = null;
      renderPromptBubble(); invalidateFloat();
    };
    host.querySelector('[data-inline-act="generate"]').onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      void doFloatRefresh(undefined, { id: msgId, swipe });
    };
    host.querySelector('[data-inline-act="settings"]').onclick = (event) => {
      event.preventDefault(); event.stopPropagation(); openPanel();
    };
    if (!emptySwipe && !collapsed) renderNav(host.querySelector(".us-inline-content"), status, entry.scene, entry.subjects, `__inline__:${key}`);
  }
  function syncInlineStatusMounts(chatId) {
    if (!chatId) return null;
    // ── 이 채팅에서 꺼져 있는 경우 ──
    //   꺼지면 syncMessages가 latestAsstByChat을 {id:null}로 비우므로 아래 '최신 메시지' 매칭이
    //   전부 실패해 마운트가 하나도 안 잡혔다 → 플로팅과 달리 "꺼져 있습니다" 안내가 안 뜨던 원인.
    //   이때는 과거 기록 위젯을 모두 걷어내고, DOM 상의 마지막 어시스턴트 말풍선에 안내 창만 붙인다.
    if (!isChatWindowActive(chatId)) {
      // CONVO 모드 채팅(사용자가 직접 켠 적 없음)에서는 대사창 안에 아무것도 붙이지 않는다.
      //   '대사창 내 삽입' 표시 설정이어도 마찬가지 — RP 채팅으로 넘어가거나 이 채팅에서
      //   직접 켰을 때만 말풍선 안에 나타난다. (안내 문구조차 띄우지 않음)
      if (isChatConvoDisabled(chatId)) {
        document.querySelectorAll(`[${INLINE_STATUS_ATTR}="past"]`).forEach((old) => old.remove());
        document.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((slot) => slot.remove());
        return null;
      }
      const nodesOff = Array.from(getMsgNodes());
      const knownAssistantOff = assistantIdsByChat[chatId];
      let lastAssistant = null;
      for (let i = nodesOff.length - 1; i >= 0; i--) {
        const node = nodesOff[i];
        const mid = node.getAttribute("data-message-id");
        const role = node.getAttribute("data-message-role");
        if (!mid || (role && role !== "assistant")) continue;
        if (!role && knownAssistantOff && knownAssistantOff.size && !knownAssistantOff.has(mid)) continue;
        lastAssistant = node; break;
      }
      document.querySelectorAll(`[${INLINE_STATUS_ATTR}="past"]`).forEach((old) => old.remove());
      const keepSlot = lastAssistant ? inlineMountForMessage(lastAssistant) : null;
      document.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((slot) => { if (slot !== keepSlot) slot.remove(); });
      return keepSlot;
    }
    // 인라인은 메시지마다 자기 위젯이 있으므로, 실제 최신 메시지가 숨김이면 그 자리를
    // 이전 메시지의 큰 최신 창으로 대체하지 않는다. 이전 메시지들은 원래대로 접힌 기록으로 남는다.
    const actualLatest = latestAsstByChat[chatId];
    const latest = actualLatest && actualLatest.id && !isStatusMessageHidden(chatId, actualLatest.id) ? actualLatest : null;
    const latestId = latest && latest.id;
    const latestSwipe = latestId ? resolveSwipeForMsg(chatId, latestId, latest.swipe || 0) : 0;
    const latestKey = latestId ? `${latestId}:${latestSwipe}` : null;
    const seen = inlineLatestSeenByChat[chatId];
    if (latestKey && seen && seen !== latestKey) {
      // 새 상태가 도착하면 방금 전 최신 기록은 과거 위젯으로 자동 접고,
      // 새 최신 창 전체는 고급 설정의 인라인 기본값으로 시작한다.
      config.ui.inlineWindowCollapsed[chatId] = !!config.ui.inlineWindowDefaultCollapsed;
      saveConfig();
    }
    if (latestKey) inlineLatestSeenByChat[chatId] = latestKey;

    let latestMount = null;
    const hideLatestWhileGenerating = !!isGeneratingByChat[chatId];
    const nodes = Array.from(getMsgNodes());
    const latestNodeIndex = latestId ? nodes.findIndex((node) => node.getAttribute("data-message-id") === latestId) : -1;
    const generatingTarget = genTargetByChat[chatId] || null;
    const pendingTarget = pendingTurnDisplayByChat[chatId] && pendingTurnDisplayByChat[chatId].targetId;
    const visibleMessageIds = new Set(nodes.map((node) => node.getAttribute("data-message-id")).filter(Boolean));
    document.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((slot) => {
      if (!visibleMessageIds.has(slot.getAttribute(INLINE_SLOT_ATTR))) slot.remove();
    });
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const node = nodes[nodeIndex];
      const msgId = node.getAttribute("data-message-id");
      const role = node.getAttribute("data-message-role");
      if (!msgId || (role && role !== "assistant")) continue;
      const knownAssistant = assistantIdsByChat[chatId];
      if (!role && knownAssistant && knownAssistant.size && !knownAssistant.has(msgId)) continue;
      if (isStatusMessageHidden(chatId, msgId)) {
        node.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((oldSlot) => oldSlot.remove());
        continue;
      }
      // 재생성 대상에는 옛 기록을 남겨 두지 않는다. 새 답변 생성 중 서버 메타보다 먼저 생긴
      // 스트리밍 assistant 노드도 이전 기록/빈 기록 위젯으로 오인되지 않게 숨긴다.
      const targetBusy = (hideLatestWhileGenerating && generatingTarget === msgId) ||
        (!!pendingTarget && pendingTarget !== "__latest__" && pendingTarget === msgId);
      const awaitingNewLatest = (hideLatestWhileGenerating && !generatingTarget) || pendingTarget === "__latest__";
      // latest 노드가 DOM에 없거나(가상화) 아직 최신이 하나도 없는 첫 생성이면 latestNodeIndex가 -1이다.
      // 이때 스트리밍 중인 새 노드가 빈 '기록 없음' 위젯으로 렌더되지 않도록, 저장 기록이 전혀 없는
      // 노드는 미커밋으로 간주해 숨긴다 (기록이 있는 과거 메시지 위젯은 그대로 유지).
      const uncommittedAfterLatest = awaitingNewLatest && (latestNodeIndex >= 0
        ? nodeIndex > latestNodeIndex
        : !firstStoredEntryForMessage(chatId, msgId));
      if (targetBusy || uncommittedAfterLatest) {
        node.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((oldSlot) => oldSlot.remove());
        continue;
      }
      const mount = inlineMountForMessage(node);
      if (!mount) continue;
      if (msgId === latestId) {
        mount.querySelectorAll(`[${INLINE_STATUS_ATTR}="past"]`).forEach((old) => old.remove());
        // 생성 중이어도 이 창은 지우지 않는다. 인라인에서는 창이 '자기 메시지'에 붙어 있어
        //   직전 턴의 값이 새 턴의 값으로 오인될 수 없기 때문이다(그 우려는 창이 하나뿐인
        //   플로팅 모드의 이야기다). 사용자가 입력을 보낸 순간 위 칸이 통째로 사라지는 대신,
        //   바의 새로고침 아이콘이 스피너로 돌아간다(isBusy → spinning).
        //   ※ 이 메시지 자체를 재생성(리롤)하는 중이면 위쪽 targetBusy 에서 이미 걸러졌다 —
        //     그때는 값이 곧 갈아치워지므로 남기면 안 된다.
        // 같은 메시지가 두 레이아웃에 중복 렌더되면 화면에 보이는 쪽을 우선한다.
        if (!latestMount || node.getClientRects().length) latestMount = mount;
        continue;
      }
      const swipe = resolveSwipeForMsg(chatId, msgId, 0, node);
      const exactEntry = getMsgEntry(chatId, msgId, swipe);
      const entry = exactEntry && (exactEntry.scene || exactEntry.subjects.length) ? exactEntry : null;
      const fallbackEntry = entry ? entry : firstStoredEntryForMessage(chatId, msgId);
      let host = mount.querySelector(`:scope > [${INLINE_STATUS_ATTR}="past"]`);
      if (!host) {
        host = document.createElement("div");
        host.setAttribute(INLINE_STATUS_ATTR, "past");
        host.setAttribute("data-us-message-id", msgId);
        host.addEventListener("click", (event) => event.stopPropagation());
        host.addEventListener("dblclick", (event) => event.stopPropagation());
        mount.appendChild(host);
      }
      renderPastInlineWidget(host, chatId, msgId, swipe, entry, fallbackEntry);
    }
    return latestMount;
  }

  // ── 최신 상태창(말풍선 내부) ──
  // 창이 화면 안에 완전히 들어오도록 좌표를 조인다.
  //   창이 화면보다 큰 경우(세로로 길어진 상태창 등)에는 왼쪽·위 끝에 붙여 최소한
  //   제목 바가 보이게 한다 — 바를 못 잡으면 창을 옮길 방법이 사라진다.
  function clampPos(x, y, el) {
    const w = (el && el.offsetWidth) || FLOAT_W;
    const h = (el && el.offsetHeight) || 120;
    const maxX = window.innerWidth - w - FLOAT_EDGE_GAP;
    const maxY = window.innerHeight - h - FLOAT_EDGE_GAP;
    return {
      x: maxX <= FLOAT_EDGE_GAP ? FLOAT_EDGE_GAP : Math.min(Math.max(FLOAT_EDGE_GAP, x), maxX),
      y: maxY <= FLOAT_EDGE_GAP ? FLOAT_EDGE_GAP : Math.min(Math.max(FLOAT_EDGE_GAP, y), maxY)
    };
  }
  function latestMessageVisible(chatId) {
    const latest = latestVisibleAssistantMeta(chatId);
    if (!latest || !latest.id) return false;
    const nodes = getMsgNodes();
    const vh = window.innerHeight || 0;
    for (const n of nodes) {
      if (n.getAttribute("data-message-id") !== latest.id) continue;
      const r = n.getBoundingClientRect();
      if (r.top < vh / 2) return true;
    }
    return false;
  }
  let lastFloatSig = null;
  function invalidateFloat() { lastFloatSig = null; renderFloat(); }
  function floatSignature(chatId) {
    // 아이콘 최소화 모드: 아이콘 표시에 영향 주는 최소 요소만 시그니처에 포함한다.
    //   → 스크롤·포커스·subjects/scene 변화(이전 메시지 열람)로 아이콘이 매 프레임 재생성되어
    //     "잠깐 원래 창처럼 깜빡였다 다시 최소화"되던 문제를 없앤다.
    if (!isInlineDisplayMode() && !!config.ui.floatCollapsed && config.ui.floatMinimizeMode === "icon") {
      const w2 = statusForChat(chatId);
      const iconTitle = (chatId && config.perChatTitle[chatId]) || (w2 && w2.name) || "";
      return JSON.stringify(["__icon__", chatId, iconTitle, config.ui.iconPos, promptBubbleOpen, !!activeFloatNotice, config.ui.displayMode]);
    }
    const st = getSettings(chatId), w = displayedStatus(chatId), subs = st.enabled ? currentSubjects(chatId) : null, scene = st.enabled ? currentScene(chatId) : null;
    const title = chatId && w ? (config.perChatTitle[chatId] || chatNameCache[chatId] || w.name) : (w && w.name);
    const inlineMode = isInlineDisplayMode();
    const latestCollapsed = isLatestWindowCollapsed(chatId);
    const focus = !inlineMode && chatId ? (focusedMsgByChat[chatId] || null) : null;
    const sceneCollapsed = st.enabled && w && w.sceneFields && w.sceneFields.length && scene
      ? (typeof config.ui.sceneCollapsed[chatId] === "boolean" ? config.ui.sceneCollapsed[chatId] : (inlineMode ? !!config.ui.inlineSceneDefaultCollapsed : !!w.sceneDefaultCollapsed))
      : null;
    const generating = !!isGeneratingByChat[chatId];
    const capturing = !!captureBusyByChat[chatId];
    const regenPast = !!genTargetByChat[chatId];
    const refreshingHere = refreshing && refreshingChatId === chatId; // 이 채팅에서 시작한 새로고침만
    const pendingTurn = !!pendingTurnDisplayByChat[chatId];
    const captureNotice = captureNoticeByChat[chatId] || null;
    const isConvoDefault = getChatModeCached(chatId) === "conversation" && !config.perChatSettings[chatId];
    const charCollapseOn = charCollapseEnabledFor(w);
    const charCollapsed = charCollapseOn
      ? (typeof config.ui.charCollapsed[chatId] === "boolean" ? config.ui.charCollapsed[chatId] : (inlineMode && !!config.ui.inlineCharDefaultCollapsed))
      : null;
    const placementSig = inlineMode
      ? ["inline", !!config.ui.inlineFullWidth]
      : ["floating", config.ui.floatPos, config.ui.iconPos, config.ui.floatMinimizeMode, focus && focus.id, focus && focus.swipe];
    return JSON.stringify([chatId, st.enabled, isConvoDefault, latestCollapsed, w && w.id, title, refreshingHere, generating, capturing, regenPast, pendingTurn, captureNotice, placementSig, sceneCollapsed, scene, subs, promptBubbleOpen, hiddenSig(chatId), charCollapseOn, charCollapsed, barToggleMode()]);
  }
  function renderFloat() {
    if (editingFloat) return;
    const chatId = getChatId();
    const inlineMode = isInlineDisplayMode();
    const actualLatest = chatId && latestAsstByChat[chatId];
    const noVisibleAssistant = !!(actualLatest && actualLatest.id && !latestVisibleAssistantMeta(chatId));
    if (!inlineMode) {
      document.querySelectorAll(`[${INLINE_STATUS_ATTR}="past"]`).forEach((old) => old.remove());
      document.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((slot) => slot.remove());
    }
    // 생성 중에는 직전 상태창을 숨긴다. 완료 뒤 새 상태를 받은 다음 다시 나타난다.
    const latestMount = noVisibleAssistant ? null : (inlineMode
      ? syncInlineStatusMounts(chatId)
      : (isGeneratingByChat[chatId] ? null : document.body));
    if (!latestMount) {
      const stale = document.getElementById(FLOAT_ID);
      if (stale) stale.remove();
      lastFloatSig = null;
      return;
    }
    // sig 체크 전에 항상 호출: !isLast 조건 덕분에 이미 끝에 있으면 DOM 조작 없이 반환.
    // marinara.addStyle 이 비동기로 base 스타일을 삽입하더라도 매 렌더마다 순서를 보정한다.
    applyWindowCss();
    const sig = floatSignature(chatId);
    const mountedFloat = document.getElementById(FLOAT_ID);
    if (sig === lastFloatSig && mountedFloat && mountedFloat.parentElement === latestMount) return;
    lastFloatSig = sig;

    let el = document.getElementById(FLOAT_ID);
    if (!el) {
      el = document.createElement("div"); el.id = FLOAT_ID;
      // 첫 생성 시 window CSS 를 <head> 맨 끝으로 재이동: marinara.addStyle 이 비동기로 base 스타일을
      // 삽입할 경우 applyWindowCss() 가 그보다 앞에 위치해 덮이는 타이밍 문제를 막기 위함.
      setTimeout(() => { const wcss = document.getElementById(WINDOW_CSS_STYLE_ID); if (wcss) document.head.appendChild(wcss); }, 0);
    }
    el.setAttribute(INLINE_STATUS_ATTR, "latest");
    if (el.parentElement !== latestMount) latestMount.appendChild(el);
    el.classList.toggle("inline-mode", inlineMode);
    el.classList.toggle("floating-mode", !inlineMode);
    el.classList.toggle("inline-full-width", inlineMode && !!config.ui.inlineFullWidth);
    el.classList.toggle("inline-title-hidden", inlineMode && config.ui.inlineShowTitle === false);
    if (!el._usInlineEventGuard) {
      el._usInlineEventGuard = true;
      el.addEventListener("click", (event) => event.stopPropagation());
      el.addEventListener("dblclick", (event) => event.stopPropagation());
    }
    const latestCollapsed = isLatestWindowCollapsed(chatId);
    el.classList.toggle("collapsed", latestCollapsed);
    // ── 아이콘 최소화 모드: 정사각형 아이콘 버튼만 표시 ──
    const isIconMode = !inlineMode && !!config.ui.floatCollapsed && config.ui.floatMinimizeMode === "icon";
    el.classList.toggle("icon-mode", isIconMode);
    if (isIconMode) {
      // 아이콘 제목은 '현재 이 채팅에 선택된 스킨'을 기준으로 한다.
      //   floatSignature(__icon__ 분기)과 동일하게 statusForChat()을 사용해야 채팅별 스킨 배정
      //   (config.perChat[chatId])이 반영된다.
      //   (구버전은 존재하지 않는 perChatSettings[chatId].activeId 를 읽어 항상 전역 activeId 로 폴백 →
      //    per-chat 스킨의 이모지 대신 엉뚱한 스킨/기본 아이콘이 표시되던 버그)
      const _iconTitle = (function() {
        const _s = statusForChat(chatId);
        const _t = chatId && config.perChatTitle && config.perChatTitle[chatId];
        return _t || (_s && _s.name) || "상태창";
      })();
      // 아이콘 자체를 드래그 핸들 겸 클릭(펼치기) 버튼으로 사용한다. 제목 첫 글자의
      // 이모지를 쓰던 방식은 모바일마다 글리프가 달라져 고정 SVG로 교체했다.
      el.innerHTML = '<button class="us-float-icon-btn" data-drag title="' + esc(_iconTitle) + ' — 클릭하여 펼치기 / 드래그하여 이동" aria-label="' + esc(_iconTitle) + ' 열기">' + ICON.status + '</button>';
      applyFloatPos(el);
      const _iconBtn = el.querySelector(".us-float-icon-btn");
      // 클릭 vs 드래그 판정: 누른 지점과 뗀 지점의 거리차가 작으면 클릭(펼치기), 크면 드래그(이동).
      //   리스너는 버튼 자신에만 부착 — 버튼은 매 렌더마다 새 DOM 노드라 누적되지 않는다.
      let _downXY = null;
      const _onDown = (e) => { const p = "touches" in e ? e.touches[0] : e; _downXY = p ? { x: p.clientX, y: p.clientY } : null; };
      _iconBtn.addEventListener("mousedown", _onDown);
      _iconBtn.addEventListener("touchstart", _onDown, { passive: true });
      _iconBtn.onclick = (e) => {
        // mouseup 좌표는 click 이벤트의 client 좌표로 확인 (드래그면 큰 이동량)
        if (_downXY && (Math.abs(e.clientX - _downXY.x) > 5 || Math.abs(e.clientY - _downXY.y) > 5)) { _downXY = null; return; }
        _downXY = null;
        config.ui.floatCollapsed = false; saveConfig(); invalidateFloat();
      };
      // 드래그 배선: 아이콘 버튼(data-drag)을 핸들로 — wireDrag가 floatPos를 저장한다.
      wireDrag(el, _iconBtn);
      renderPromptBubble();
      if (activeFloatNotice) renderFloatNotice();
      if (activeCaptureModal && activeCaptureModal.chatId && activeCaptureModal.chatId !== getChatId()) hideCaptureModalDom();
      return;
    }
    ensureChatValues(chatId);
    const st = getSettings(chatId);
    // 채팅 생성·수동 새로고침·자동 상태 캡처를 모두 같은 스피너 상태로 표시한다.
    // captureBusy를 빼면 백그라운드 dryRun 중 버튼은 평상시처럼 보이면서 클릭만 무시되는 문제가 생긴다.
    const isBusy = (refreshing && refreshingChatId === chatId) || !!isGeneratingByChat[chatId] || !!captureBusyByChat[chatId];
    // isPastFocus: historyHoverPreview ON + 과거 메시지에 포커스된 상태
    const isPastFocus = pastFocusNow(chatId);
    // '이전 메시지 재생성' 라벨은 타겟이 최신 메시지와 다를 때만. (최신 재생성은 regenerateMessageId가
    //  최신 id로 채워져 genTarget이 non-null이 되므로, 단순 non-null 검사는 최신 재생성을 오표시함)
    const gTgt = genTargetByChat[chatId];
    const latestId = latestAsstByChat[chatId] && latestAsstByChat[chatId].id;
    const regenPastLabel = isBusy && !!gTgt && (!latestId || gTgt !== latestId);
    // 추가: 실제로 '표시 중인' 메시지가 최신이 아니면(=이전 메시지 데이터를 보여주는 중이면) 라벨을 띄운다.
    //  → 최신 메시지 재생성 중 포커스가 이전 메시지로 옮겨가 그 데이터를 표시할 때, 라벨이 빠지던 문제 해결.
    //  (최신의 이전 '스와이프'를 표시하는 경우는 dispMeta.id === latestId 라 라벨이 안 뜸 — 기존 동작 유지)
    const dispMeta = currentRenderMeta(chatId);
    const displayingPast = !!(dispMeta && dispMeta.id && latestId && dispMeta.id !== "__latest__" && dispMeta.id !== latestId);
    const showPastLabel = !inlineMode && (isPastFocus || regenPastLabel || displayingPast);
    // 스킨(템플릿/CSS) 선택:
    //   '상태창 설정도 함께 전환' ON  → 과거 포커스 시 과거 스킨 그대로
    //   OFF → 항상 현재 스킨 템플릿 사용(데이터 값만 과거 것). 과거에만 있던 필드는 자연히 미표시.
    const usePastSkin = isPastFocus && config.ui.dynamicWindowCss;
    // 인라인에서는 현재 렌더 대상 기록에 찍힌 statusId를 먼저 사용한다. 재생성 직후에도
    // 해당 채팅/스와이프의 맞춤 CSS가 기본 스킨으로 잠깐 되돌아가지 않게 한다.
    const status = inlineMode
      ? (displayedStatus(chatId) || statusForChat(chatId))
      : (usePastSkin ? displayedStatus(chatId) : (statusForChat(chatId) || displayedStatus(chatId)));
    const title = status ? (chatId ? (config.perChatTitle[chatId] || chatNameCache[chatId] || status.name) : status.name) : "유저 상태창";
    const subjects = st.enabled ? currentSubjects(chatId) : null;
    const scene = st.enabled ? currentScene(chatId) : null;
    const chev = latestCollapsed ? ICON.chevronRight : ICON.chevronDown;
    // CONVO 기본 비활성: 사용자가 직접 perChatSettings를 만들어 켠 경우는 제외
    const isConvoDisabledTop = isChatConvoDisabled(chatId);
    // convo 비활성 또는 이 채팅에서 꺼짐(st.enabled=false) 시 스피너/새로고침/편집 등 동작 버튼은 표시하지 않음
    const barActive = !isConvoDisabledTop && st.enabled;
    const spinning = isBusy && barActive;
    // 이 채팅에서 시작된 수동 새로고침만 '생성 중지' 버튼/중단 동작으로 취급 (다른 채팅 새로고침은 무시)
    const refreshingHere = refreshing && refreshingChatId === chatId;
    const captureBusyHere = !!captureBusyByChat[chatId];
    const canStopDryRun = (refreshingHere || captureBusyHere) && !!activeDryRunIdByChat[chatId];
    const showRegen = barActive && status && subjects && st.dataMode === DATA_MODES.api;
    const showBarActions = barActive;

    el.innerHTML = `
      <div class="us-f-bar" ${inlineMode ? "" : "data-drag"}>
        <button class="us-f-btn" data-act="collapse" title="접기/펼치기">${chev}</button>
        ${inlineMode && config.ui.inlineShowTitle === false ? "" : `<span class="us-f-title">${esc(title)}</span>`}
        ${showPastLabel ? `<span class="us-f-ctx" title="이전 메시지 기준 상태" aria-label="이전 메시지 기준 상태">이전 메시지</span>` : ""}
        ${showBarActions && st.enabled && status && (subjects || scene) ? `<button class="us-f-btn" data-act="edit" title="값 수정" aria-label="값 수정">${ICON.edit}</button>` : ""}
        ${showRegen ? `<button class="us-f-btn${promptBubbleOpen ? " on" : ""}" data-act="regen" title="프롬프트 재생성" aria-label="프롬프트 재생성">${ICON.prompt}</button>` : ""}
        ${showBarActions ? `<button class="us-f-btn${spinning ? " spinning" : ""}" data-act="refresh" title="${canStopDryRun ? "생성 중지" : "새로고침"}" aria-label="${canStopDryRun ? "생성 중지" : "새로고침"}">${ICON.refresh}</button>` : ""}
        ${barActive ? "" : `<button class="us-f-btn us-f-power" data-act="power" title="이 채팅에서 켜기" aria-label="이 채팅에서 상태창 켜기">${ICON.power}</button>`}
        <button class="us-f-btn" data-act="settings" title="설정" aria-label="설정">${ICON.settings}</button>
      </div>
      <div class="us-f-content"></div>`;
    const content = el.querySelector(".us-f-content");
    // CONVO 기본 비활성: 사용자가 직접 perChatSettings를 만들어 켠 경우는 제외
    const isConvoDisabled = isChatConvoDisabled(chatId);
    // 안내 문구 안의 버튼(켜기·설정 열기)은 두지 않는다 — 위 바의 전원·설정 버튼이 같은 역할을 한다.
    if (isConvoDisabled) content.innerHTML = `<div class="us-f-empty">CONVO 모드에서는<br/>작동하지 않습니다.</div>`;
    else if (!st.enabled) content.innerHTML = `<div class="us-f-empty">이 채팅에서 꺼져 있습니다.</div>`;
    else if (!status) {
      // 채팅에는 '어떤 상태창을 쓰던 방인지'(ID)만 남아 있다. 그 상태창이 이 기기에 없으면
      // 어떤 걸 가져와야 하는지 ID 를 함께 알려준다 (정의는 채팅에 저장하지 않는다).
      const missing = chatId && missingSkinByChat[chatId];
      content.innerHTML = missing
        ? `<div class="us-f-empty">이 채팅이 쓰던 상태창이 이 기기에 없습니다.<br/><span style="opacity:.7;font-size:11px;word-break:break-all;">ID: ${esc(missing)}</span><br/><span style="opacity:.7;font-size:11px;">해당 상태창 JSON을 가져오면 자동으로 연결됩니다.</span></div>`
        : `<div class="us-f-empty">이 채팅에 적용된 상태창이 없습니다.</div>`;
    }
    else if (!subjects && !scene) {
      // valuesCache에 없으면 hydrateChatValues가 아직 서버에서 받아오는 중.
      // 로딩 완료 시 invalidateFloat()로 재렌더되므로, 그 전엔 빈 상태를 유지해 잔상(메시지 전환)을 방지.
      const loaded = !chatId || (chatId in valuesCache);
      if (!loaded) {
        content.innerHTML = `<div class="us-f-empty"></div>`;
      } else {
        const anyExists = hasAnyStoredValues(chatId);
        const hasRaw = !!(chatId && lastRawOutputByChat[chatId] && lastRawOutputByChat[chatId].text);
        const displayMeta = currentRenderMeta(chatId);
        const exactEntry = getMsgEntry(chatId, displayMeta.id, displayMeta.swipe);
        const otherSwipeEntry = exactEntry ? exactEntry : firstStoredEntryForMessage(chatId, displayMeta.id);
        const pendingNow = isPendingTurnDisplay(chatId, displayMeta);
        const noticeNow = captureNoticeForMeta(chatId, displayMeta);
        const manualBtns = `<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:8px;">`
          + `<button class="us-f-manual-add">✏️ 값 직접 입력</button>`
          + (hasRaw ? `<button class="us-f-manual-fromraw">${ICON.clipboard} 출력에서 가져오기</button>` : `<button class="us-f-manual-paste">${ICON.clipboard} JSON 붙여넣기</button>`)
          + `</div>`;
        if (pendingNow) {
          // 문구 없이 빈 영역만 유지 — 상단 바의 새로고침 스피너가 진행 중임을 이미 표시한다.
          content.innerHTML = `<div class="us-f-empty"></div>`;
        } else if (noticeNow && noticeNow.status === "noformat") {
          content.innerHTML = `<div class="us-f-empty">출력 형식을 인식하지 못했습니다.${manualBtns}</div>`;
        } else if (noticeNow && noticeNow.status === "empty") {
          content.innerHTML = `<div class="us-f-empty">상태값 출력을 받지 못했습니다.${manualBtns}</div>`;
        } else if (noticeNow && noticeNow.status === "error") {
          content.innerHTML = `<div class="us-f-empty">상태값을 가져오는 중 오류가 발생했습니다.${manualBtns}</div>`;
        } else if (noticeNow && noticeNow.status === "aborted") {
          content.innerHTML = `<div class="us-f-empty">상태값 갱신을 중지했습니다.${manualBtns}</div>`;
        } else if (!exactEntry && otherSwipeEntry) {
          content.innerHTML = `<div class="us-f-empty">이 스와이프에는 상태 기록이 없습니다.${manualBtns}</div>`;
        } else {
          content.innerHTML = anyExists
            ? `<div class="us-f-empty">출력된 값이 없습니다.${manualBtns}</div>`
            : `<div class="us-f-empty">아직 값이 없습니다.<br/>${st.dataMode === DATA_MODES.api ? "새로고침 버튼을 누르면 API 로 불러옵니다." : "메시지를 주고받으면 채워집니다."}${manualBtns}</div>`;
        }
      }
    }
    else renderNav(content, status, scene, subjects || [], chatId);



    applyFloatPos(el);
    // 윈도우 CSS 의 font-family 를 #us-float 인라인으로 심어서
    // window CSS 규칙에 열거되지 않은 요소(.us-f-ctx 등)도 font-family:inherit 로 따라오게 함
    { const wCss = document.getElementById(WINDOW_CSS_STYLE_ID);
      const wSrc = wCss ? wCss.textContent : "";
      const fRe = /#us-float\b[^{]*\{([^}]+)\}/g; let fm2, floatFont = null;
      while ((fm2 = fRe.exec(wSrc)) !== null) {
        const bm = fm2[1].match(/font-family\s*:\s*([^;}\n]+)/);
        if (bm) { floatFont = bm[1].trim(); break; }
      }
      el.style.fontFamily = floatFont || "";
    }

    const toggleLatestCollapsed = () => {
      if (inlineMode && chatId) config.ui.inlineWindowCollapsed[chatId] = !isLatestWindowCollapsed(chatId);
      else config.ui.floatCollapsed = !config.ui.floatCollapsed;
      saveConfig(); invalidateFloat();
    };
    el.querySelector('[data-act="collapse"]').onclick = (e) => {
      // 화살표 버튼을 빠르게 두 번 눌러도 한 번만 토글 (제자리로 돌아오는 현상 방지)
      if (e && e.detail > 1) return;
      toggleLatestCollapsed();
    };
    el.querySelector('[data-act="settings"]').onclick = openPanel;
    const pw = el.querySelector('[data-act="power"]');
    if (pw) pw.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      turnOnStatusForChat(getChatId());
    };
    const eb = el.querySelector('[data-act="edit"]');
    if (eb) eb.onclick = () => { promptBubbleOpen = false; renderPromptBubble(); editingFloat = true; renderEditForm(); };
    const rb = el.querySelector('[data-act="refresh"]');
    const STALE_REFRESH_GRACE_MS = 90000; // 새로고침 잠금이 이만큼 굳어 있으면 사용자의 클릭으로 해제
    if (rb) rb.onclick = () => {
      // 클릭 시점의 라이브 값으로 판단 (렌더 시점 캡처값 X)
      const cidNow = getChatId();
      const hereNow = refreshing && refreshingChatId === cidNow;
      const captureHereNow = !!captureBusyByChat[cidNow];
      const activeRunId = activeDryRunIdByChat[cidNow];
      if ((hereNow || captureHereNow) && activeRunId) {
        // 수동 새로고침뿐 아니라 완료 직후 자동 상태 캡처도 같은 버튼으로 중지한다.
        dryRunAborted = true;
        const abortId = activeRunId;
        const abortChatId = cidNow;
        marinara.apiFetch("/generate/dryRun/abort", {
          method: "POST", body: JSON.stringify({ runId: abortId, chatId: abortChatId }),
        }).catch(() => {});
        if (hereNow) { refreshing = false; refreshingChatId = null; refreshingStartTs = 0; }
        invalidateFloat();
      } else if (!refreshing
                 || refreshingChatId !== cidNow            // 다른 채팅의 새로고침은 이 채팅을 막지 않는다
                 || (Date.now() - (refreshingStartTs || 0) >= STALE_REFRESH_GRACE_MS)) { // 굳은 잠금 해제
        // 잠금이 이 채팅 것이 아니거나 오래 굳어 있으면 해제하고 진행한다.
        //   (예전엔 refreshing 이 전역 플래그라, 다른 채팅에서 시작한 새로고침이 끝나지 않으면
        //    모든 채팅의 새로고침 버튼이 영구히 먹통이 됐다 — '재생성이 안 눌리는' 경우의 수)
        if (refreshing && (refreshingChatId !== cidNow || Date.now() - (refreshingStartTs || 0) >= STALE_REFRESH_GRACE_MS)) {
          refreshing = false; refreshingChatId = null; refreshingStartTs = 0;
        }
        // stale 스피너 복구(escape hatch):
        //  이 채팅이 '생성 중'으로 표시돼 있지만 마리나라의 complete/idle 이벤트가
        //  누락·오귀속되면 스피너만 영영 굳는다. 예전엔 이때 버튼이 disabled 라
        //  페이지 새로고침 전까지 아무것도 못 했다 — 이제 클릭으로 풀 수 있게 한다.
        //  단, 진짜 생성 중 오클릭 보호: 스피너가 켜진 지 12초 미만이면 기존처럼 무시.
        //  (12초 이후의 클릭은 사용자가 의도적으로 누른 것 — 스피너를 해제하고 새로고침 진행.
        //   실제 생성이 아직 진행 중이었더라도 dryRun 은 채팅 생성과 별개 요청이라 충돌하지 않고,
        //   생성 완료 시 generation-complete 가 자동 캡처를 다시 돌리므로 안전하다.)
        const STALE_SPINNER_GRACE_MS = 12000;
        if (isGeneratingByChat[cidNow] && !captureBusyByChat[cidNow]) {
          const started = genStartTsByChat[cidNow] || 0;
          if (!started || Date.now() - started >= STALE_SPINNER_GRACE_MS) {
            isGeneratingByChat[cidNow] = false;
            delete genStartTsByChat[cidNow];
            invalidateFloat();
          }
        }
        if (!isGeneratingByChat[cidNow] && !captureBusyByChat[cidNow]) {
          doFloatRefresh();
        } else if (captureBusyByChat[cidNow]) {
          // 요청 바디를 준비하는 아주 짧은 구간에는 아직 runId가 없을 수 있다.
          // 이때도 무음 no-op 대신 현재 자동 갱신 중임을 알려준다.
          showFloatNotice("상태값을 갱신하는 중입니다", "info");
        }
      }
    };
    const regenBtn = el.querySelector('[data-act="regen"]');
    if (regenBtn) regenBtn.onclick = () => { promptBubbleOpen = !promptBubbleOpen; promptBubbleTargetMeta = null; invalidateFloat(); renderPromptBubble(); };
    // ── 빈 상태: 수동 값 입력 버튼들 ──
    el.querySelector(".us-f-manual-add")?.addEventListener("click", async () => {
      // 값 편집 폼만 연다 — 여기서 빈 항목을 미리 저장하지 않는다.
      //   (예전엔 열자마자 빈 entry 를 저장해서, 취소해도 '값 없음' 상태로 돌아가지 않고
      //    빈 상태창이 생겨버렸다. 저장은 폼의 [저장] 버튼에서만 일어난다.)
      const status = statusForChat(chatId);
      if (!status) { openPanel(); return; }
      // 저장 위치(스와이프)를 기록 저장과 동일하게 최신 서버 메타 기준으로 확정
      try { await syncAssistantMetaNow(chatId, getSettings(chatId).historyDepth); } catch (_) {}
      editingFloat = true; renderEditForm();
    });
    el.querySelector(".us-f-manual-fromraw")?.addEventListener("click", () => {
      openManualJsonModal(chatId, { prefillFromRaw: true });
    });
    el.querySelector(".us-f-manual-paste")?.addEventListener("click", () => {
      openManualJsonModal(chatId, { prefillFromRaw: false });
    });
    const bar = el.querySelector(".us-f-bar");
    if (!inlineMode) wireDrag(el, bar);
    // 제목이 있는 가장 위 바 자체를 접기/펼치기 영역으로 사용한다.
    //   버튼(접기·값수정·재생성·새로고침·설정)은 바 '위에 얹힌' 상태로 각자 동작하고,
    //   그 사이의 빈 곳·제목 글자를 (기본) 더블클릭하면 창이 접히거나 펼쳐진다.
    wireBarToggle(bar, toggleLatestCollapsed);
    renderPromptBubble();
    if (activeFloatNotice) renderFloatNotice(); // innerHTML 재생성으로 사라진 알림 재부착
    // 모달은 떠 있는 동안 가만히 둔다. 단 다른 채팅으로 넘어갔으면 즉시 숨김(상태는 유지 → 복귀 시 복원).
    if (activeCaptureModal && activeCaptureModal.chatId && activeCaptureModal.chatId !== getChatId()) hideCaptureModalDom();
  }

  // 프롬프트 버블 독립 드래그 가능 창
  function renderPromptBubble() {
    let el = document.getElementById(PROMPT_BUBBLE_ID);
    if (!promptBubbleOpen) { if (el) el.remove(); promptBubbleTargetMeta = null; return; }
    const isNew = !el;
    if (!el) {
      el = document.createElement("div");
      el.id = PROMPT_BUBBLE_ID;
      document.body.appendChild(el);
    }
    // 기존 textarea 값 보존
    const prevText = el.querySelector(".us-prompt-input")?.value || "";
    el.innerHTML = `
      <div class="us-pb-handle" data-drag>
        <span class="us-pb-title">${ICON.prompt} 추가 요청사항${promptBubbleTargetMeta && promptBubbleTargetMeta.id ? " · 이전 메시지" : ""}</span>
        <button class="us-f-btn" data-act="bubble-close" title="닫기" aria-label="닫기">${ICON.close}</button>
      </div>
      <div class="us-pb-body">
        <textarea class="us-prompt-input" placeholder="재생성 시 추가로 요청할 사항을 입력하세요..." rows="3">${esc(prevText)}</textarea>
        <div class="us-pb-foot">
          <button class="us-btn sm" data-act="bubble-close2">닫기</button>
          <button class="us-btn sm primary" data-act="bubble-send">보내기</button>
        </div>
      </div>`;
    // 위치 설정: 저장된 위치(드래그) > 누른 버튼 바로 아래 > 상태창 근처
    if (isNew || !promptBubblePos) {
      // 이 버블을 연 💬 버튼을 찾아 그 바로 아래에 붙인다.
      //   창 전체 기준으로 잡으면(예전 방식) 상태창이 길 때 버튼에서 멀찍이 떨어진 곳에 떠서
      //   방금 누른 버튼과 입력창이 이어져 보이지 않았다.
      //   버튼 DOM 은 재렌더마다 새로 만들어지므로 '지금' 화면에서 다시 찾는다.
      const anchorBtn = (() => {
        const targetId = promptBubbleTargetMeta && promptBubbleTargetMeta.id;
        if (targetId) {
          const hosts = Array.from(document.querySelectorAll("[data-us-message-id]"));
          const host = hosts.find((h) => h.getAttribute("data-us-message-id") === targetId);
          return host ? host.querySelector('[data-inline-act="regen"]') : null;
        }
        const floatNow = document.getElementById(FLOAT_ID);
        return floatNow ? floatNow.querySelector('[data-act="regen"]') : null;
      })();
      const anchorRect = anchorBtn && anchorBtn.getClientRects().length ? anchorBtn.getBoundingClientRect() : null;
      const floatEl = document.getElementById(FLOAT_ID);
      if (anchorRect || floatEl) { el.style.removeProperty("right"); el.style.removeProperty("bottom"); }
      if (anchorRect) {
        const bw = el.offsetWidth || Math.min(300, window.innerWidth * 0.88);
        const bh = el.offsetHeight || 170;
        let bx = anchorRect.left;
        let by = anchorRect.bottom + 6; // 버튼 바로 아래
        // 아래에 자리가 없으면 버튼 위로 뒤집는다
        if (by + bh > window.innerHeight - 8) {
          const above = anchorRect.top - bh - 6;
          if (above >= 8) by = above;
        }
        bx = Math.min(Math.max(8, bx), Math.max(8, window.innerWidth - bw - 8));
        by = Math.min(Math.max(8, by), Math.max(8, window.innerHeight - bh - 8));
        el.style.left = bx + "px"; el.style.top = by + "px";
      } else if (floatEl) {
        const r = floatEl.getBoundingClientRect();
        const bw = Math.min(300, window.innerWidth * 0.88);
        const bh = 170; // 버블 예상 높이 (핸들 + 텍스트영역 + 버튼)
        let bx = r.left;
        let by = r.top - 180;
        if (by < 8) by = r.bottom + 8;
        bx = Math.min(Math.max(8, bx), window.innerWidth - bw - 8);
        // 세로도 뷰포트 안으로 클램프 — 커스텀 윈도우 CSS 로 플로팅 창이 화면 하단에 크게
        // 자리하면 r.bottom + 8 이 화면 밖이 되어, 재생성(💬) 버튼을 눌러도 버블이
        // 보이지 않아 '버튼이 안 먹는 것'처럼 보이던 문제 수정.
        by = Math.min(Math.max(8, by), window.innerHeight - bh - 8);
        el.style.left = bx + "px"; el.style.top = by + "px";
      } else {
        el.style.right = "14px"; el.style.bottom = "200px";
      }
      promptBubblePos = null;
    } else {
      // 저장된 위치도 항상 뷰포트 안으로 클램프 (창 크기 변경·CSS 변경 후 화면 밖 고착 방지)
      const bw = el.offsetWidth || 300, bh = el.offsetHeight || 170;
      const cx = Math.min(Math.max(8, promptBubblePos.x), window.innerWidth - bw - 8);
      const cy = Math.min(Math.max(8, promptBubblePos.y), window.innerHeight - bh - 8);
      el.style.left = cx + "px";
      el.style.top = cy + "px";
    }
    // 이벤트
    el.querySelector('[data-act="bubble-close"]').onclick = () => { promptBubbleOpen = false; promptBubbleTargetMeta = null; promptBubblePos = null; el.remove(); invalidateFloat(); };
    el.querySelector('[data-act="bubble-close2"]').onclick = () => { promptBubbleOpen = false; promptBubbleTargetMeta = null; promptBubblePos = null; el.remove(); invalidateFloat(); };
    el.querySelector('[data-act="bubble-send"]').onclick = async () => {
      const textarea = el.querySelector(".us-prompt-input");
      const extraPrompt = textarea ? textarea.value.trim() : "";
      const targetMeta = promptBubbleTargetMeta;
      promptBubbleOpen = false; promptBubbleTargetMeta = null; promptBubblePos = null; el.remove(); invalidateFloat();
      await doFloatRefresh(extraPrompt || undefined, targetMeta);
    };
    // 드래그 (wireDrag 직접 사용하지 않고 별도 로직 — floatPos 건드리지 않음)
    const handle = el.querySelector("[data-drag]");
    if (handle && !handle._usBubbleDrag) {
      handle._usBubbleDrag = true;
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      const down = (e) => {
        if (e.target.closest(".us-f-btn,input,textarea,select,button")) return;
        dragging = true;
        const p = "touches" in e ? e.touches[0] : e;
        const r = el.getBoundingClientRect();
        sx = p.clientX; sy = p.clientY; ox = r.left; oy = r.top;
        el.style.left = r.left + "px"; el.style.top = r.top + "px";
        if (e.cancelable) e.preventDefault();
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        window.addEventListener("touchmove", move, { passive: false });
        window.addEventListener("touchend", up);
      };
      const move = (e) => {
        if (!dragging) return;
        const p = "touches" in e ? e.touches[0] : e;
        const nx = ox + (p.clientX - sx), ny = oy + (p.clientY - sy);
        const bw = el.offsetWidth || 300, bh = el.offsetHeight || 150;
        const cx = Math.min(Math.max(8, nx), window.innerWidth - bw - 8);
        const cy = Math.min(Math.max(8, ny), window.innerHeight - bh - 8);
        el.style.left = cx + "px"; el.style.top = cy + "px";
        if (e.cancelable) e.preventDefault();
      };
      const up = () => {
        if (!dragging) return; dragging = false;
        const r = el.getBoundingClientRect();
        promptBubblePos = { x: r.left, y: r.top };
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
        window.removeEventListener("touchmove", move); window.removeEventListener("touchend", up);
      };
      handle.addEventListener("mousedown", down);
      handle.addEventListener("touchstart", down, { passive: false });
    }
  }

  // 플로팅 값 수정 (+ 캐릭터 추가/삭제 — 모든 탭 동일)
  function renderEditForm() {
    let el = document.getElementById(FLOAT_ID);
    if (!el) { el = document.createElement("div"); el.id = FLOAT_ID; document.body.appendChild(el); }
    el.classList.remove("collapsed");
    const chatId = getChatId();
    const status = statusForChat(chatId);
    if (!status) { editingFloat = false; invalidateFloat(); return; }
    // 편집 폼을 열 때마다 접기 상태 초기화: 장면은 접힘, 캐릭터는 펼침 (자주 수정하는 캐릭터를 바로 보이게).
    config.ui.editSceneFold = true;
    config.ui.editCharFold = false;
    let subs = currentSubjects(chatId);
    if (!subs) {
      // 캡처가 한 번도 없었던 채팅: 카드에 배정된 캐릭터가 있으면 그걸 빈 값으로 기본 채움.
      const cardNames = getCardRosterSync(chatId).filter((n) => !isLabelDropped(chatId, n));
      subs = cardNames.length ? cardNames.map((name) => ({ label: name, values: {} })) : [{ label: "", values: {} }];
    } else {
      subs = clone(subs);
    }
    let idx = activeTabByChat[chatId] ?? 0; if (idx >= subs.length) idx = 0;
    // '이 캐릭터 삭제'로 지운 이름을 모아 둔다. 저장을 눌러야 제외 목록에 확정되고(취소하면 없던 일),
    //   그래야 캐릭터 카드 로스터 병합이 같은 이름을 다시 끼워 넣지 않는다.
    const droppedPending = [];
    // 제목 기본값은 플로팅 창 표시와 동일한 규칙: 사용자 지정 제목 → 채팅방 이름 → 스킨 이름
    const defaultTitle = (chatId && chatNameCache[chatId]) || status.name;
    let nameVal = (chatId && config.perChatTitle[chatId]) || defaultTitle;
    const hasSceneFields = Array.isArray(status.sceneFields) && status.sceneFields.length > 0;
    let sceneVals = hasSceneFields ? (currentScene(chatId) ? clone(currentScene(chatId)) : {}) : null;

    // 값 그룹(접기 마커) 펼침 상태 — draw() 재렌더 사이에 유지된다. 기본은 접힘.
    const valueFoldOpen = {};
    // 값 칸은 input 이 아니라 textarea 다.
    //   <input> 은 값에 줄바꿈을 담을 수 없어(브라우저가 CR/LF 를 제거한다) 여러 줄 값을
    //   열었다 저장만 해도 한 줄로 뭉개진다. 목록형 값이 있는 스킨에서 실제로 데이터가 상한다.
    const autoGrowEl = (t) => { if (!t) return; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 220) + "px"; };
    // 줄바꿈이 들어 있는 값만 textarea 로, 한 줄짜리는 예전처럼 input 으로 그린다.
    //   input 은 브라우저가 CR/LF 를 지우므로 여러 줄 값에는 절대 쓸 수 없지만,
    //   한 줄 값까지 전부 textarea 로 바꾸면 칸이 커지고 모양이 달라져 보기 나쁘다.
    const isMultilineValue = (v) => /[\r\n]/.test(v == null ? "" : String(v));
    const makeValueInput = (attrName, key, val) => {
      const text = val == null ? "" : String(val);
      if (!isMultilineValue(text)) {
        const inp = document.createElement("input");
        inp.className = "us-input";
        inp.type = "text";
        inp.setAttribute(attrName, key);
        inp.value = text;
        return inp;
      }
      const t = document.createElement("textarea");
      t.className = "us-input us-vval";
      t.rows = 1;
      t.setAttribute(attrName, key);
      t.value = text;
      t.oninput = () => autoGrowEl(t);
      return t;
    };
    const makeValueRow = (labelText, attrName, key, val) => {
      const row = document.createElement("label");
      const multi = isMultilineValue(val);
      row.className = "us-erow" + (multi ? " us-erow-multi" : "");
      row.innerHTML = `<span>${esc(labelText)}</span>`;
      row.appendChild(makeValueInput(attrName, key, val));
      return row;
    };
    function collect() {
      el.querySelectorAll(".us-edit [data-k]").forEach((i) => { subs[idx].values[i.dataset.k] = i.value; });
      const lab = el.querySelector(".us-edit [data-label]"); if (lab) subs[idx].label = lab.value.trim();
      const wn = el.querySelector("[data-wname]"); if (wn) nameVal = wn.value;
      if (hasSceneFields && sceneVals) {
        el.querySelectorAll(".us-edit [data-sk]").forEach((i) => { sceneVals[i.dataset.sk] = i.value; });
      }
    }
    function draw() {
      const chatNm = chatId ? (chatNameCache[chatId] || "").trim() : "";
      const fillBtn = chatNm
        ? `<button class="us-f-btn" data-act="fillchatname" title="채팅방 이름 넣기 (${escAttr(chatNm)})" aria-label="채팅방 이름 넣기" style="flex:none;">${ICON.copy}</button>`
        : "";
      el.innerHTML = `<div class="us-f-bar" data-drag><span class="us-f-title us-edit-title" style="flex:none;" title="값 수정" aria-label="값 수정">${ICON.edit}</span><input class="us-input us-name-edit" data-wname placeholder="상태창 제목" value="${escAttr(nameVal)}"/>${fillBtn}<button class="us-f-btn" data-act="cancel" title="닫기" aria-label="닫기">${ICON.close}</button></div><div class="us-f-content"></div>`;
      el.querySelector("[data-wname]").oninput = (e) => { nameVal = e.target.value; };
      const fb = el.querySelector('[data-act="fillchatname"]');
      if (fb) fb.onclick = () => {
        const inp = el.querySelector("[data-wname]");
        nameVal = chatNm;
        if (inp) { inp.value = chatNm; inp.focus(); }
      };
      const content = el.querySelector(".us-f-content");
      // 값 편집 폼은 길어질 수 있으므로 세로 스크롤. 스크롤바가 생겨도 좌우 패딩이 대칭이 되도록 gutter 안정화.
      content.style.maxHeight = "60vh";
      content.style.overflowY = "auto";
      content.style.overflowX = "hidden";
      // '값 수정' 헤더 바와 스크롤 영역 사이에 고정 여백 → 스크롤해도 헤더 아래가 분리되어 보인다.
      content.style.marginTop = "10px";
      content.style.padding = "0 0 8px"; // 상단 내부 패딩 없음(헤더와의 분리는 위 margin이 담당)
      content.style.boxSizing = "border-box";
      content.style.scrollbarWidth = "thin"; // Firefox (얇은 오버레이형 → 폭 영향 최소)
      content.style.scrollbarColor = "var(--us-float-border,#666) transparent"; // Firefox: thumb track
      content.classList.add("us-edit-scroll"); // ::-webkit-scrollbar 테마 적용 대상

      const form = document.createElement("div"); form.className = "us-edit"; form.style.paddingTop = "0";

      // 접기 섹션 헬퍼 — 헤더 띠를 기존 플로팅 창의 장면 버튼(.us-scene-button) 띠와 동일한 크기·스타일로.
      const makeSection = (titleText, collapsed) => {
        const sec = document.createElement("div");
        sec.style.cssText = "margin-bottom:8px;";
        const head = document.createElement("div");
        head.style.cssText = [
          "position:relative", "display:flex", "align-items:center", "justify-content:space-between",
          "width:100%", "min-height:32px", "padding:6px 12px", "box-sizing:border-box",
          "border-radius:8px",
          "border:1px solid var(--us-float-border,var(--border,#444))",
          "background:var(--us-float-secondary,var(--secondary,#232323))",
          "color:var(--us-float-fg,var(--foreground,#eee))",
          "cursor:pointer", "font-family:inherit", "font-size:12px", "font-weight:600",
        ].join(";");
        head.innerHTML = `<span>${titleText}</span><span style="font-size:13px;line-height:1;color:var(--us-float-muted,#aaa);">${collapsed ? "▸" : "▾"}</span>`;
        const body = document.createElement("div");
        body.style.cssText = "display:" + (collapsed ? "none" : "block") + ";padding:" + (collapsed ? "0" : "8px 2px 2px") + ";";
        sec.appendChild(head); sec.appendChild(body);
        return { sec, head, body };
      };

      // ── 장면 접기 섹션 (기본 접힘) ──
      if (hasSceneFields && sceneVals !== null) {
        const collapsed = config.ui.editSceneFold !== false;
        const { sec, head, body } = makeSection("장면", collapsed);
        // 장면 값도 스킨의 접기 마커(sceneFolds) 단위로 묶는다 (마커가 없으면 예전처럼 나열).
        fieldSegments(status.sceneFields, status.sceneFolds).forEach((seg, gi) => {
          const segFields = status.sceneFields.slice(seg.from, seg.to).filter((f) => f && f.key);
          if (!segFields.length) return;
          if (!seg.name) {
            segFields.forEach((f) => body.appendChild(makeValueRow(f.key, "data-sk", f.key, sceneVals[f.key])));
            return;
          }
          const gkey = "scene#" + seg.name + "#" + gi;
          const open = valueFoldOpen[gkey] === true;
          const grp = document.createElement("div"); grp.className = "us-vgroup";
          const gh = document.createElement("div"); gh.className = "us-vgroup-head";
          gh.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(seg.name)} <span style="opacity:.6;font-weight:400;">(${segFields.length})</span></span>`
            + `<span style="font-size:12px;line-height:1;color:var(--us-float-muted,#aaa);flex:none;">${open ? "▾" : "▸"}</span>`;
          const gb = document.createElement("div"); gb.className = "us-vgroup-body";
          if (!open) gb.style.display = "none";
          segFields.forEach((f) => gb.appendChild(makeValueRow(f.key, "data-sk", f.key, sceneVals[f.key])));
          gh.onclick = () => {
            collect();
            valueFoldOpen[gkey] = !open;
            const sc = content.scrollTop; draw();
            const nc = el.querySelector(".us-f-content"); if (nc) nc.scrollTop = sc;
          };
          grp.appendChild(gh); grp.appendChild(gb); body.appendChild(grp);
        });
        head.onclick = () => { collect(); const sc = content.scrollTop; config.ui.editSceneFold = collapsed ? false : true; saveConfig(); draw(); const nc = el.querySelector(".us-f-content"); if (nc) nc.scrollTop = sc; };
        form.appendChild(sec);
      }

      // ── 캐릭터 접기 섹션 (기본 접힘) — 탭 + 활성 캐릭터 필드 + 삭제 버튼 ──
      {
        const collapsed = config.ui.editCharFold !== false;
        const { sec, head, body } = makeSection("캐릭터", collapsed);
        const bar = document.createElement("div"); bar.className = "us-tabs";
        bar.style.paddingTop = "0";      // 캐릭터 띠↔탭 간격을 장면 띠↔값과 동일하게 (us-tabs 기본 위패딩 8px 상쇄)
        bar.style.marginBottom = "8px";  // 탭↔값 간격을 원래 플로팅 표시뷰와 동일하게
        const pills = document.createElement("div"); pills.className = "us-pills";
        subs.forEach((s, i) => {
          const b = document.createElement("button");
          const pillHidden = isLabelHidden(chatId, s.label);
          b.className = "us-tab" + (i === idx ? " on" : "");
          b.type = "button";
          b._usSub = s; // 데이터 객체 참조 보관 — 드래그로 DOM 순서가 바뀌어도 정확한 항목을 추적하기 위함
          if (pillHidden) { b.style.opacity = "0.4"; b.style.borderStyle = "dashed"; b.title = "숨김 — 상태창에 표시되지 않음"; }
          b.appendChild(buildUiHost(status.tabTemplate || DEFAULT_TAB_TEMPLATE, status.tabCss || "", { index: i + 1, 순번: i + 1, active: i === idx ? "on" : "", 상태: i === idx ? "on" : "" }, (pillHidden ? "🚫 " : "") + (s.label || ("#" + (i + 1))), valueOptsOf(status)));
          // ── 순서 변경은 전용 그립(⠿)에서만 시작한다 ──
          //   예전엔 탭 몸통 전체가 순서변경 트리거라, 탭이 띠를 꽉 채우면 가로 스크롤(wireDragScroll)을
          //   시작할 여백이 없어 스크롤과 충돌했다. 그립으로 분리해 탭 몸통·빈 곳은 모두 스크롤로 넘긴다.
          //   buildUiHost 의 :host{display:block} 탓에 그립이 라벨 위로 올라가므로, 탭을 가로 flex 로 둔다.
          b.style.display = "inline-flex";
          b.style.alignItems = "center";
          b.style.gap = "5px";
          const grip = document.createElement("span");
          grip.className = "us-tab-grip";
          grip.innerHTML = ICON.grip;
          grip.title = "드래그하여 순서 변경";
          grip.setAttribute("aria-label", "순서 변경 손잡이");
          b.insertBefore(grip, b.firstChild);
          //   순서 변경은 mouseup/touchend 시점에만 subs 배열에 확정 반영(중간엔 DOM만 옮김) → 재렌더 없이 가벼움.
          let downXY = null, dragging = false, justDragged = false, grabOffsetX = 0;
          // 잡은 탭이 포인터를 따라오게 (재정렬 직후에도 기준점을 다시 재어 튀지 않게)
          const follow = (clientX) => {
            b.style.transform = "none";
            const r = b.getBoundingClientRect();
            b.style.transform = `translateX(${clientX - (r.left + grabOffsetX)}px) scale(1.06)`;
          };
          const onMove = (e) => {
            if (!downXY) return;
            const p = "touches" in e ? e.touches[0] : e;
            const dx = p.clientX - downXY.x, dy = p.clientY - downXY.y;
            if (!dragging && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
              dragging = true;
              b.style.opacity = "0.45";
              b.style.cursor = "grabbing";
              b.style.boxShadow = "0 4px 14px rgba(0,0,0,.45)";
              b.style.zIndex = "5";
              b.style.position = "relative";
              b.style.pointerEvents = "none";
              document.body.style.userSelect = "none";
            }
            if (!dragging) return;
            if (e.cancelable) e.preventDefault();
            const px = p.clientX;
            const siblings = Array.from(pills.children).filter((c) => c !== b);
            let target = null;
            for (const sib of siblings) {
              const r = sib.getBoundingClientRect();
              if (!r.width) continue;
              if (px < r.left + r.width / 2) { target = sib; break; }
            }
            if (target) { if (b.nextSibling !== target) pills.insertBefore(b, target); }
            else if (pills.lastElementChild !== b) pills.appendChild(b);
            follow(px);
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("touchmove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("touchend", onUp);
            window.removeEventListener("touchcancel", onUp);
            b.style.transform = "";
            b.style.pointerEvents = "";
            document.body.style.userSelect = "";
            if (dragging) {
              justDragged = true;
              const activeSub = subs[idx]; // 재정렬 전 '현재 활성 탭'의 데이터 참조를 먼저 보관
              collect(); // 활성 탭 입력값을 그 객체에 반영 (객체 참조 기반이라 순서가 바뀌어도 안전)
              subs = Array.from(pills.children).map((btn) => btn._usSub);
              idx = subs.indexOf(activeSub);
              if (idx < 0) idx = 0;
              draw();
            }
            downXY = null; dragging = false;
          };
          const onDown = (e) => {
            e.stopPropagation(); // 그립 드래그는 가로 스크롤(wireDragScroll)로 번지지 않게 차단
            const p = "touches" in e ? e.touches[0] : e;
            downXY = { x: p.clientX, y: p.clientY };
            grabOffsetX = p.clientX - b.getBoundingClientRect().left;
            dragging = false;
            if (e.type === "mousedown" && e.cancelable) e.preventDefault();
            window.addEventListener("mousemove", onMove);
            window.addEventListener("touchmove", onMove, { passive: false });
            window.addEventListener("mouseup", onUp);
            window.addEventListener("touchend", onUp);
            window.addEventListener("touchcancel", onUp);
          };
          // 리스너는 탭 몸통(b)이 아니라 그립에만 — 몸통을 잡으면 스크롤, 그립을 잡으면 순서변경.
          grip.addEventListener("mousedown", onDown);
          grip.addEventListener("touchstart", onDown, { passive: true });
          b.onclick = (e) => {
            if (justDragged) { e.preventDefault(); e.stopPropagation(); return; } // 드래그 직후 발생하는 가짜 클릭 무시
            collect(); idx = i; draw();
          };
          pills.appendChild(b);
        });
        wireDragScroll(pills);
        bar.appendChild(pills);
        const addB = document.createElement("button"); addB.className = "us-nav"; addB.textContent = "＋"; addB.title = "캐릭터 추가";
        addB.onclick = () => { collect(); subs.push({ label: "", values: {} }); idx = subs.length - 1; config.ui.editCharFold = false; saveConfig(); draw(); };
        bar.appendChild(addB);
        body.appendChild(bar);
        const lr = document.createElement("label"); lr.className = "us-erow"; lr.innerHTML = `<span>표시 이름</span>`;
        const li = document.createElement("input"); li.className = "us-input"; li.setAttribute("data-label", "1"); li.placeholder = "이 채팅에서 {{이름}}으로 표시"; li.value = subs[idx].label || ""; lr.appendChild(li); body.appendChild(lr);
        // 상태값은 스킨의 접기 마커(status.folds) 단위로 묶어서 그린다.
        //   마커가 없으면 세그먼트가 하나뿐이라 예전처럼 그냥 쭉 나열된다.
        fieldSegments(status.fields, status.folds).forEach((seg, gi) => {
          const segFields = status.fields.slice(seg.from, seg.to).filter((f) => f && f.key);
          if (!segFields.length) return;
          if (!seg.name) {
            segFields.forEach((f) => body.appendChild(makeValueRow(f.key, "data-k", f.key, subs[idx].values[f.key])));
            return;
          }
          const gkey = seg.name + "#" + gi;
          const open = valueFoldOpen[gkey] === true; // 기본 접힘
          const grp = document.createElement("div"); grp.className = "us-vgroup";
          const gh = document.createElement("div"); gh.className = "us-vgroup-head";
          gh.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(seg.name)} <span style="opacity:.6;font-weight:400;">(${segFields.length})</span></span>`
            + `<span style="font-size:12px;line-height:1;color:var(--us-float-muted,#aaa);flex:none;">${open ? "▾" : "▸"}</span>`;
          const gb = document.createElement("div"); gb.className = "us-vgroup-body";
          if (!open) gb.style.display = "none";
          segFields.forEach((f) => gb.appendChild(makeValueRow(f.key, "data-k", f.key, subs[idx].values[f.key])));
          // 접기 전에 collect() 로 편집 중인 값을 먼저 반영해야 입력이 날아가지 않는다.
          gh.onclick = () => {
            collect();
            valueFoldOpen[gkey] = !open;
            const sc = content.scrollTop; draw();
            const nc = el.querySelector(".us-f-content"); if (nc) nc.scrollTop = sc;
          };
          grp.appendChild(gh); grp.appendChild(gb); body.appendChild(grp);
        });
        // 표시/숨김 토글 + 이 캐릭터 삭제 — 한 줄에 오른쪽 정렬로 나란히 둔다.
        //   ("상태창에 표시" 설명 문구는 버튼 자체가 상태를 보여주므로 없앴다)
        {
          const eyeRow = document.createElement("div"); eyeRow.className = "us-erow";
          eyeRow.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:10px;";
          const eyeBtn = document.createElement("button"); eyeBtn.type = "button";
          const paint = () => {
            const h = isLabelHidden(chatId, subs[idx].label);
            eyeBtn.textContent = h ? "🚫 숨김" : "👁 표시";
            eyeBtn.title = h ? "이 캐릭터는 상태창에 표시되지 않습니다. 눌러서 다시 표시" : "눌러서 이 캐릭터를 상태창에서 숨기기 (데이터는 유지)";
            eyeBtn.style.cssText = "flex:none;cursor:pointer;font-family:inherit;font-size:11px;line-height:1;padding:5px 12px;border-radius:7px;border:1px solid var(--us-float-border,#666);"
              + (h ? "background:transparent;color:var(--us-float-muted,#999);border-style:dashed;"
                   : "background:var(--us-float-primary,#6c8cff);color:var(--us-float-primary-fg,#fff);border-color:transparent;");
          };
          paint();
          eyeBtn.onclick = () => {
            collect(); // 편집 중인 라벨을 반영해 그 라벨로 숨김 처리
            const label = subs[idx].label;
            if (!normLabel(label)) { alert("표시 이름이 있는 캐릭터만 숨길 수 있어요. 먼저 이름을 입력해 주세요."); return; }
            setLabelHidden(chatId, label, !isLabelHidden(chatId, label));
            const sc = content.scrollTop; draw(); const nc = el.querySelector(".us-f-content"); if (nc) nc.scrollTop = sc;
          };
          eyeRow.appendChild(eyeBtn);
          // 이 캐릭터 삭제 — 표시/숨김 버튼 바로 오른쪽 (캐릭터가 2개 이상일 때만)
          if (subs.length > 1) {
            const delB = document.createElement("button"); delB.type = "button";
            delB.setAttribute("data-act", "delsub"); delB.textContent = "이 캐릭터 삭제";
            delB.style.cssText = "flex:none;background:transparent;border:1px solid var(--us-float-border,#666);color:var(--us-float-muted,#999);cursor:pointer;font-family:inherit;font-size:11px;line-height:1;padding:5px 12px;border-radius:7px;transition:background .12s,color .12s;";
            delB.onmouseenter = () => { delB.style.background = "var(--us-float-primary,#6c8cff)"; delB.style.color = "var(--us-float-primary-fg,#fff)"; delB.style.borderColor = "transparent"; };
            delB.onmouseleave = () => { delB.style.background = "transparent"; delB.style.color = "var(--us-float-muted,#999)"; delB.style.borderColor = "var(--us-float-border,#666)"; };
            eyeRow.appendChild(delB);
          }
          body.appendChild(eyeRow);
        }
        head.onclick = () => { collect(); const sc = content.scrollTop; config.ui.editCharFold = collapsed ? false : true; saveConfig(); draw(); const nc = el.querySelector(".us-f-content"); if (nc) nc.scrollTop = sc; };
        form.appendChild(sec);
      }

      content.appendChild(form);
      // DOM 에 붙은 뒤에야 scrollHeight 를 잴 수 있다 (접혀 있는 그룹은 펼칠 때 다시 계산됨)
      form.querySelectorAll("textarea.us-vval").forEach(autoGrowEl);
      // 여러 줄 값 칸(textarea)의 색을 옆 한 줄 칸(input)의 '실제 계산된 값'에서 복사한다.
      //   스킨 윈도우 CSS 가 input 만 겨냥하거나 변수를 안 쓰는 경우가 있어, CSS 규칙만으로는
      //   두 칸의 색이 어긋나는 환경이 생긴다. 계산값 복사는 어떤 CSS 가 이기든 결과가 같다.
      const refInput = form.querySelector("input.us-input");
      if (refInput) {
        const cs = getComputedStyle(refInput);
        form.querySelectorAll("textarea.us-vval").forEach((t) => {
          t.style.backgroundColor = cs.backgroundColor;
          t.style.color = cs.color;
          t.style.borderColor = cs.borderTopColor;
          t.style.borderRadius = cs.borderTopLeftRadius;
        });
      }

      // 푸터: 취소/저장 (삭제 버튼은 캐릭터 섹션 안으로 이동)
      const foot = document.createElement("div"); foot.className = "us-erow-foot";
      foot.innerHTML = `<span></span><span><button class="us-btn sm" data-act="cancel2">취소</button> <button class="us-btn sm primary" data-act="save">저장</button></span>`;
      content.appendChild(foot);

      el.querySelector('[data-act="cancel"]').onclick = el.querySelector('[data-act="cancel2"]').onclick = () => { editingFloat = false; invalidateFloat(); };
      const ds = el.querySelector('[data-act="delsub"]');
      if (ds) ds.onclick = () => {
        collect();
        const gone = subs[idx] && subs[idx].label;
        subs.splice(idx, 1);
        if (gone) droppedPending.push(gone);
        if (idx >= subs.length) idx = subs.length - 1;
        draw();
      };
      el.querySelector('[data-act="save"]').onclick = () => {
        collect();
        const newName = (nameVal || "").trim();
        if (chatId) {
          // 기본값(채팅방 이름/스킨 이름) 그대로면 저장하지 않는다 — 채팅방 이름이 바뀌면 따라가게.
          if (newName && newName !== defaultTitle) config.perChatTitle[chatId] = newName;
          else delete config.perChatTitle[chatId];
          saveConfig();
          saveTitleToMeta(chatId, (newName && newName !== defaultTitle) ? newName : null);
        }
        // 삭제 확정: 화면에서 지운 이름을 이 채팅의 제외 목록에 넣는다.
        //   (넣지 않으면 캐릭터 카드에 있는 이름이 다음 렌더에서 빈 값으로 되살아나
        //    "삭제하고 저장해도 그대로"로 보인다. ＋로 다시 추가하면 아래에서 해제된다.)
        if (chatId) {
          const alive = new Set(subs.map((s) => normLabel(s && s.label)).filter(Boolean));
          droppedPending.forEach((lb) => { if (!alive.has(normLabel(lb))) setLabelDropped(chatId, lb, true); });
          droppedPending.length = 0;
          alive.forEach((k) => { if (isLabelDropped(chatId, k)) setLabelDropped(chatId, k, false); });
        }
        // 포커스된 메시지(이전 메시지 포함)에 저장 — latest 고정 시 이전 메시지 수정 불가 버그 수정
        const meta = currentRenderMeta(chatId);
        const mid = meta.id || "__latest__", swipe = meta.swipe || 0;
        setMsgValues(chatId, status.id, mid, swipe, subs);
        if (hasSceneFields && sceneVals !== null) {
          setMsgScene(chatId, status.id, mid, swipe, sceneVals);
        }
        if (!manualIds[chatId]) manualIds[chatId] = new Set();
        manualIds[chatId].add(mid + "#" + swipe);
        activeTabByChat[chatId] = Math.min(idx, subs.length - 1);
        editingFloat = false; invalidateFloat();
      };
      applyFloatPos(el);
      if (!isInlineDisplayMode()) wireDrag(el, el.querySelector("[data-drag]"));
    }
    draw();
  }
  const DRAG_EXCLUSION_SEL = ".us-f-btn,.us-tab,.us-nav,input,textarea,select";
  function wireDrag(el, handle) {
    if (!handle || handle._usDrag) return;
    handle._usDrag = true;
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const down = (e) => {
      // 폼 컨트롤(입력창 등)은 핸들 내부에 있어도 드래그 시작점으로 쓰지 않는다.
      //   예전엔 핸들 내부면 제외 검사를 통째로 건너뛰고 preventDefault 까지 해버려,
      //   값 수정 폼 상단 바의 '상태창 제목' 입력이 포커스를 못 받아 타이핑이 안 됐다.
      if (e.target.closest("input,textarea,select")) return;
      // 핸들 '자신'을 눌렀을 때만 제외 셀렉터 검사를 건너뛴다.
      //   (아이콘 최소화 모드: 핸들이 <button>이라 DRAG_EXCLUSION_SEL에 걸려 드래그가 막히던 문제 해결)
      //   예전엔 `e.currentTarget === handle || handle.contains(e.target)` 로 판정했는데,
      //   리스너를 handle 에 붙이므로 currentTarget 은 항상 handle → 조건이 늘 참이 되어
      //   제외 검사가 아예 실행되지 않았다. 그 탓에 툴바 안의 버튼(재생성·값수정·새로고침·설정,
      //   버블 닫기 등)을 눌러도 드래그가 시작되고, 손이 몇 px 만 밀리면 패널이 커서 밑에서
      //   빠져나가 mouseup 이 다른 요소에서 발생 → click 이 버튼에 도달하지 못해
      //   "가끔 버튼이 안 눌리는" 증상이 났다.
      if (e.target !== handle && e.target.closest(DRAG_EXCLUSION_SEL)) return;
      dragging = true;
      const p = "touches" in e ? e.touches[0] : e;
      const r = el.getBoundingClientRect();
      sx = p.clientX; sy = p.clientY; ox = r.left; oy = r.top;
      el.style.left = r.left + "px"; el.style.top = r.top + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
      if (e.cancelable) e.preventDefault();
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
    };
    const move = (e) => {
      if (!dragging) return;
      const p = "touches" in e ? e.touches[0] : e;
      const c = clampPos(ox + (p.clientX - sx), oy + (p.clientY - sy), el);
      el.style.left = c.x + "px"; el.style.top = c.y + "px";
      if (e.cancelable) e.preventDefault();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      const r = el.getBoundingClientRect();
      setActivePos({ x: r.left, y: r.top });
      saveConfig();
      lastFloatSig = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
    handle.addEventListener("mousedown", down);
    handle.addEventListener("touchstart", down, { passive: false });
  }

  // ── 오버레이 ──
  function overlay(id, innerHtml) { closeOverlay(id); const o = document.createElement("div"); o.id = id; o.innerHTML = `<div class="us-box">${innerHtml}</div>`; document.body.appendChild(o); o.addEventListener("mousedown", (e) => { if (e.target === o) closeOverlay(id); }); return o; }
  function closeOverlay(id) { const e = document.getElementById(id); if (e) e.remove(); }
  function closeAllOverlays() {
    closeOverlay(MODAL_ID); closeOverlay(PANEL_ID); closeOverlay(STATUS_MANAGER_ID);
    // 기록 탭 CSS override 해제
    if (historyWindowCssOverride !== null) { historyWindowCssOverride = null; applyWindowCss(); }
    // 기록 미리보기/편집기 팝업 스코프 <style> 정리
    const s1 = document.getElementById("us-hist-preview-scope"); if (s1) s1.remove();
    const s2 = document.getElementById("us-preview-popup-scope"); if (s2) s2.remove();
  }

  // ── 설정 패널 ──
  // openPanel이 자신의 selectTab을 여기에 노출 → 모드 라디오 변경 시 탭 바를 다시 그릴 때 사용
  let panelSelectTab = null;
  // 설정 패널의 '설정 적용 범위' ("chat" | "default" | null). 렌더 때 이 채팅이 실제로 따르는 쪽으로 정해진다.
  //   범위 버튼은 이 채팅이 어느 쪽을 따를지 정한다(followDefault). 전용 값은 지우지 않는다.
  //   (전용 설정 삭제는 '기본 디폴트 설정으로 초기화' 버튼만 담당)
  let settingsPanelScope = null;
  // 설정창을 닫을 때 호출: 다음에 열면 항상 [상태창 설정] 탭으로 시작한다.
  function resetPanelUiState() {
    settingsPanelScope = null; // 다음에 열면 범위는 이 채팅이 따르는 쪽으로 다시 정해진다
    if (config && config.ui) {
      config.ui.panelTab = "status";
      saveConfig();
    }
    panelSelectTab = null;
  }
  // 데이터 방식(inline/api)에 따라 '출력 결과' 탭 버튼을 즉시 추가/제거한다.
  // ※ 원문 슬롯(lastRawOutputByChat)은 절대 건드리지 않음 — 모드를 오가도 보관된 미인식 원문은 유지된다.
  function rebuildPanelTabBar() {
    const o = document.getElementById(PANEL_ID);
    if (!o) return;
    const bar = o.querySelector(".us-ptabs");
    if (!bar) return;
    const wantRaw = getSettings(getChatId()).dataMode === DATA_MODES.api;
    let rawBtn = bar.querySelector('.us-ptab[data-ptab="rawout"]');
    if (wantRaw && !rawBtn) {
      rawBtn = document.createElement("button");
      rawBtn.className = "us-ptab";
      rawBtn.dataset.ptab = "rawout";
      rawBtn.textContent = "출력 결과";
      rawBtn.onclick = () => { if (panelSelectTab) panelSelectTab("rawout"); };
      // 우측 정렬되는 '켜기' 라벨 앞(=고급 탭 뒤)에 삽입
      const label = bar.querySelector("#us-enabled-label");
      if (label) bar.insertBefore(rawBtn, label); else bar.appendChild(rawBtn);
    } else if (!wantRaw && rawBtn) {
      rawBtn.remove();
      // 지금 보던 탭이 '출력 결과'였다면 상태창 설정으로 돌려보낸다 (슬롯 값은 그대로 보존)
      if (config.ui && config.ui.panelTab === "rawout" && panelSelectTab) panelSelectTab("status");
    }
  }

  function openPanel() {
    const showRawTab = getSettings(getChatId()).dataMode === DATA_MODES.api;
    const o = overlay(PANEL_ID, `
      <div class="us-h"><span class="us-head-icon">${ICON.settings}</span><h2>유저 상태창</h2><button class="us-x" id="us-close" aria-label="닫기">${ICON.close}</button></div>
      <div class="us-ptabs">
        <button class="us-ptab" data-ptab="status">상태창 설정</button>
        <button class="us-ptab" data-ptab="history">기록</button>
        <button class="us-ptab" data-ptab="advanced">고급</button>
        ${showRawTab ? `<button class="us-ptab" data-ptab="rawout">출력 결과</button>` : ""}
        <span id="us-enabled-label" style="margin-left:auto;align-self:center;margin-bottom:6px;font-size:11px;color:var(--us-box-muted,var(--muted-foreground,#999));white-space:nowrap;">이 채팅에서 켜기</span>
        <label class="us-switch" style="align-self:center;margin-bottom:6px;transform:scale(.8);transform-origin:right center;"><input type="checkbox" id="us-enabled-top"/><span class="us-track"></span></label>
      </div>
      <div id="us-tabbody"></div>`);
    const $ = (q) => o.querySelector(q);
    $("#us-close").onclick = () => { resetPanelUiState(); closeAllOverlays(); };
    // 바깥 영역 클릭으로 닫힐 때도 상태 초기화 (overlay()의 기본 핸들러가 DOM은 제거함)
    o.addEventListener("mousedown", (e) => { if (e.target === o) resetPanelUiState(); });
    function selectTab(tab) {
      config.ui.panelTab = tab; saveConfig();
      // 기록 탭을 벗어날 때 CSS override 해제
      if (tab !== "history" && historyWindowCssOverride !== null) { historyWindowCssOverride = null; applyWindowCss(); }
      o.querySelectorAll(".us-ptab").forEach((b) => b.classList.toggle("on", b.dataset.ptab === tab));
      const body = $("#us-tabbody");
      if (tab === "history") {
        // 기록 탭 진입 시 현재 플로팅에 표시 중인 상태창 항목을 선택해 둔다.
        // 과거 기록 전환(historyHoverPreview)이 꺼져 있으면 항상 최신 항목.
        const cid = getChatId();
        if (cid) {
          let dispId = null, dispSwipe = 0;
          if (config.ui.historyHoverPreview !== false) {
            const meta = currentRenderMeta(cid);
            dispId = meta.id; dispSwipe = meta.swipe;
          } else {
            const latest = latestAsstByChat[cid] || {};
            dispId = latest.id; dispSwipe = latest.swipe || 0;
          }
          if (dispId) historySelectedKeyByChat[cid] = JSON.stringify([dispId, dispSwipe]);
        }
      }
      if (tab === "history") renderHistoryTab(body);
      else if (tab === "advanced") renderAdvancedTab(body);
      else if (tab === "rawout") renderRawOutputTab(body);
      else renderStatusTab(body);
    }
    o.querySelectorAll(".us-ptab").forEach((b) => b.onclick = () => selectTab(b.dataset.ptab));
    panelSelectTab = selectTab; // 모드 라디오 변경 시 탭 바 재구성에서 호출할 수 있도록 노출
    // 상단 '이 채팅에서 켜기' 토글 (모든 탭 공통)
    (function setupEnableToggle() {
      const cid = getChatId();
      const enTop = $("#us-enabled-top");
      const enLabel = $("#us-enabled-label");
      if (!enTop) return;
      enTop.checked = !!getSettings(cid).enabled;
      if (!cid) {
        enTop.disabled = true;
        if (enLabel) { enLabel.style.opacity = ".5"; enLabel.title = "채팅 화면에서 열어주세요."; }
      }
      enTop.onchange = (e) => {
        // 항상 해당 채팅 전용 설정에만 적용 (전역 건드려 모든 채팅이 함께 꺼지던 버그 방지)
        if (cid) ensureChatSettings(cid);
        const set = (cid && config.perChatSettings[cid]) ? config.perChatSettings[cid] : config.settings;
        set.enabled = e.target.checked;
        saveConfig(); invalidateFloat();
        selectTab(config.ui.panelTab || "status"); // 현재 탭 다시 렌더
      };
    })();
    // 설정창을 열 때 config.ui.panelTab 에 지정된 탭으로 시작 (기본값: "status").
    // openRawOutputTab 등이 열기 전 panelTab 을 미리 세팅하면 이중 렌더 없이 바로 그 탭으로 열린다.
    selectTab(config.ui.panelTab || "status");
  }

  function renderStatusTab(root) {
    const chatId = getChatId();
    ensureChatValues(chatId);
    const hasOverride = chatUsesOwnSettings(chatId);
    // 범위 = 이 채팅이 지금 실제로 따르는 쪽 (범위 버튼을 마지막에 누른 쪽). 폼도 그 설정을 편집한다.
    const scope = hasOverride ? "chat" : "default";
    settingsPanelScope = scope;
    // 폼에는 '선택한 범위'의 설정을 보여준다 (실제 적용값이 아니라 편집 대상)
    const st = scope === "chat"
      ? { ...DEFAULT_SETTINGS, ...config.perChatSettings[chatId] }
      : { ...DEFAULT_SETTINGS, ...config.settings };
    root.innerHTML = `
      <div class="us-sec" style="margin-top:4px;">
        <h3>내 상태창</h3>
        <div class="us-row us-status-default-row" style="align-items:center;gap:8px;margin-bottom:8px;">
          <span class="us-note" style="margin:0;flex:none;white-space:nowrap;">새 채팅 기본:</span>
          <select class="us-sel" id="us-default-status" style="flex:1;min-width:0;max-width:240px;font-size:12px;">
            ${config.statuses.map((w) => `<option value="${escAttr(w.id)}"${w.id === config.activeId ? " selected" : ""}>${esc(w.name)}</option>`).join("")}
          </select>
          <button type="button" class="us-iconbtn us-scan-skin" id="us-recognize-chat-skin" title="채팅에 저장된 상태창 스킨 인식" aria-label="채팅에 저장된 상태창 스킨 인식" ${chatId ? "" : "disabled"}>${ICON.scan}</button>
        </div>
        <div class="us-list" id="us-wlist"></div>
        <div class="us-row" style="margin-top:8px;">
          <button class="us-btn primary" id="us-new">＋ 새 상태창</button>
          <button class="us-btn" id="us-export-statuses">전체 상태창 내보내기</button>
          <button class="us-btn" id="us-import">상태창 가져오기</button>
        </div>
        ${serverSyncAvailable() ? `<div class="us-row us-sync-all" style="margin-top:6px;align-items:center;gap:6px;">
          <span class="us-note" style="margin:0;flex:none;">서버 연동</span>
          <button class="us-btn sm" id="us-sync-all-on">모두 켜기</button>
          <button class="us-btn sm" id="us-sync-all-off">모두 끄기</button>
        </div>` : ""}
      </div>

      <div class="us-sec">
        <h3>설정 적용 범위</h3>
        <div class="us-scope-toggle">
          <button class="us-btn sm ${scope === "chat" ? "on" : ""}" id="us-scope-chat" data-scope="chat" ${chatId ? "" : "disabled"}>해당 채팅 전용</button>
          <button class="us-btn sm ${scope === "default" ? "on" : ""}" id="us-scope-default" data-scope="default">공용</button>
        </div>
        ${chatId ? `<div class="us-note">마지막에 누른 쪽을 이 채팅이 따릅니다. 공용으로 바꿔도 전용 값은 남아 있어서 다시 '해당 채팅 전용'을 누르면 돌아옵니다.${hasOverride ? " (이 채팅: 전용 설정 사용 중)" : " (이 채팅: 공용 설정 따름)"}</div>` : `<div class="us-note">채팅 화면이 아니어서 디폴트 공통만 편집할 수 있습니다.</div>`}
      </div>

      <div class="us-sec">
        <h3>데이터 방식 ${scope === "chat" ? "· <span style='color:var(--us-box-primary,var(--primary,#6c8cff))'>이 채팅 전용 설정</span>" : "· 디폴트 공통 설정"}</h3>
        <div class="us-radio">
          <label><input type="radio" name="us-mode" value="inline" ${st.dataMode === "inline" ? "checked" : ""}/> <span><b>채팅 출력</b> — AI 답변에 값 블록을 함께 출력해 읽어옵니다.</span></label>
          <label><input type="radio" name="us-mode" value="api" ${st.dataMode === "api" ? "checked" : ""}/> <span><b>API 따로 연결(권장)</b> — 답변과 별도 호출로 값만 받아와 채팅을 더 깔끔하게 유지합니다.</span></label>
        </div>
        <div class="us-row" id="us-conn-wrap" style="margin-top:8px;">
          <span class="us-note" style="margin:0;">API 연결:</span>
          <select class="us-sel" id="us-conn" style="max-width:280px;"><option value="">(채팅 기본 연결)</option></select>
        </div>
        <label class="us-toggle" style="margin-top:8px;display:flex;">
          <input type="checkbox" id="us-injectvals" ${st.injectCurrentValues ? "checked" : ""}/> 현재 상태창 값을 입력 프롬프트에 포함(직전 상태 이어가기)
        </label>
        <div class="us-note" style="margin-top:10px;">상태값 생성 시 참조 범위:</div>
        <div class="us-sw-row">
          <label class="us-sw-item">채팅 히스토리 <span class="us-sw"><input type="checkbox" id="us-inc-history" ${st.incHistory ? "checked" : ""}/><span class="tr"></span></span></label>
          <label class="us-sw-item" title="마리나라가 이 채팅에 저장한 요약을 함께 보냅니다. 채팅 히스토리를 끈 채 이전 흐름을 짧게 넘기고 싶을 때 쓰세요. 요약이 없는 채팅이면 아무것도 붙지 않습니다. 켤 때 히스토리 범위가 '전체'면 최근 ${SUMMARY_HISTORY_TURNS}개 답변으로 함께 좁힙니다(직접 넣은 값은 그대로 둡니다).">채팅 요약 <span class="us-sw"><input type="checkbox" id="us-inc-summary" ${st.incChatSummary ? "checked" : ""}/><span class="tr"></span></span></label>
          <label class="us-sw-item">로어북 <span class="us-sw"><input type="checkbox" id="us-inc-lorebook" ${st.incLorebook ? "checked" : ""}/><span class="tr"></span></span></label>
          <label class="us-sw-item">캐릭터 카드 <span class="us-sw"><input type="checkbox" id="us-inc-characters" ${st.incCharacters ? "checked" : ""}/><span class="tr"></span></span></label>
          <label class="us-sw-item">유저 페르소나 <span class="us-sw"><input type="checkbox" id="us-inc-persona" ${st.incPersona ? "checked" : ""}/><span class="tr"></span></span></label>
          ${''}
        </div>
        <div class="us-row" style="margin-top:8px;align-items:center;" title="'채팅 히스토리'를 켰을 때 최근 몇 개 답변까지 보낼지 정합니다. 0 = 제한 없음(전체). 오래된 턴에 섞인 옛 호칭·애칭이 캐릭터 탭으로 새어 들어오는 것을 막고 토큰도 아낍니다. 히스토리가 꺼져 있으면 아무 영향이 없습니다.">
          <span class="us-note" style="margin:0;">히스토리 범위:</span>
          <input type="number" min="0" max="200" class="us-input us-num" id="us-hist-turns" value="${st.historyTurns}"/>
          <span class="us-note" style="margin:0;">개 답변 (0 = 전체)</span>
        </div>
        <label class="us-toggle" style="margin-top:8px;display:flex;" title="눈 아이콘으로 숨긴 캐릭터를 상태 생성 프롬프트에서도 제외합니다 (필수 인물 목록 + 캐릭터 카드). 저장된 값은 유지됩니다.">
          <input type="checkbox" id="us-hidden-exclude" ${st.hiddenExcludeFromPrompt ? "checked" : ""}/> 숨긴 캐릭터는 프롬프트에서도 제외 (인물 목록·캐릭터 카드)
        </label>
        <label class="us-toggle" style="margin-top:8px;display:flex;">
          <input type="checkbox" id="us-imp" ${st.allowImpersonate ? "checked" : ""}/> {{user}} 발화(impersonate) 생성 시에도 작동
        </label>
        <div class="us-row" style="margin-top:10px;align-items:center;">
          <span class="us-note" style="margin:0;">보관 깊이(스와이프 미포함):</span>
          <input type="number" min="1" max="200" class="us-input us-num" id="us-depth" value="${st.historyDepth}"/>
          <span class="us-note" style="margin:0;">개 답변</span>
        </div>
        <div class="us-row" style="margin-top:6px;align-items:center;" title="상태값 기록을 몇 턴까지 보관할지 정합니다. 초과분은 오래된 턴부터 자동 삭제(선입선출)됩니다. 0을 입력하면 삭제 없이 전부 보관합니다.">
          <span class="us-note" style="margin:0;">기록 보관 개수:</span>
          <input type="number" min="0" max="10000" class="us-input us-num" id="us-record-limit" value="${st.recordLimit}"/>
          <span class="us-note" style="margin:0;">턴 (0 = 전부 보관)</span>
        </div>
        <div class="us-row" style="margin-top:10px;">
          <button class="us-btn sm" id="us-savedefault">이 설정을 디폴트로 설정</button>
          <button class="us-btn sm" id="us-loaddefault" ${chatId ? "" : "disabled"}>기본 디폴트 설정으로 초기화</button>
        </div>
      </div>

      `;
    const $ = (q) => root.querySelector(q);
    // 편집 대상 설정 객체 — '설정 적용 범위'에서 고른 쪽에만 쓴다.
    const curSet = () => (settingsPanelScope === "chat" && chatId && config.perChatSettings[chatId])
      ? config.perChatSettings[chatId]
      : config.settings;

    const defaultSel = $("#us-default-status");
    if (defaultSel) defaultSel.onchange = () => { config.activeId = defaultSel.value || null; saveConfig(); renderStatusList($("#us-wlist")); invalidateFloat(); };
    const recognizeBtn = $("#us-recognize-chat-skin");
    if (recognizeBtn) recognizeBtn.onclick = () => recognizeChatSkin(chatId);

    $("#us-new").onclick = () => openEditor(null);
    $("#us-export-statuses").onclick = exportStatuses;
    $("#us-import").onclick = importStatuses;
    const setSyncAll = (localOnly) => { config.statuses.forEach((w) => { w.localOnly = localOnly; }); saveConfig(); renderStatusList($("#us-wlist")); };
    if ($("#us-sync-all-on")) $("#us-sync-all-on").onclick = () => setSyncAll(false);
    if ($("#us-sync-all-off")) $("#us-sync-all-off").onclick = () => setSyncAll(true);

    $("#us-scope-chat").onclick = () => {
      if (!chatId) return;
      const own = ensureChatSettings(chatId);
      // 한 번도 전용으로 쓴 적 없는 항목(켜기/끄기로 생긴 것)은 지금 공용 값으로 다시 채운다.
      if (own.neverCustom) {
        config.perChatSettings[chatId] = { ...DEFAULT_SETTINGS, ...config.settings, enabled: own.enabled, followDefault: false };
      } else {
        own.followDefault = false;
      }
      saveConfig(); invalidateFloat(); renderStatusTab(root); rebuildPanelTabBar();
    };
    $("#us-scope-default").onclick = () => {
      // 공용 설정 '편집'으로 전환만 한다 — 이 채팅의 전용 설정은 삭제하지 않는다.
      //   (예전엔 여기서 perChatSettings 를 지워서, 공용 탭을 갔다 오기만 해도 채팅 전용
      //    설정이 날아가고 모든 채팅이 공용대로 바뀌던 문제가 있었다. 전용 설정 삭제는
      //    '기본 디폴트 설정으로 초기화' 버튼의 역할)
      if (chatId) { ensureChatSettings(chatId).followDefault = true; saveConfig(); invalidateFloat(); }
      renderStatusTab(root); rebuildPanelTabBar();
    };
    root.querySelectorAll('input[name="us-mode"]').forEach((r) => r.onchange = (e) => {
      curSet().dataMode = e.target.value; saveConfig();
      $("#us-conn-wrap").style.opacity = e.target.value === "api" ? "1" : ".45";
      if (e.target.value === "api") hideRawBlocksInChat();
      // 모드에 따라 '출력 결과' 탭을 즉시 추가/제거. 보관 중인 미인식 원문 슬롯은 건드리지 않으므로,
      // api→inline→api 로 오가도 같은 실패 원문이 그대로 다시 보인다.
      rebuildPanelTabBar();
    });
    $("#us-conn-wrap").style.opacity = st.dataMode === "api" ? "1" : ".45";
    $("#us-injectvals").onchange = (e) => { curSet().injectCurrentValues = e.target.checked; saveConfig(); };
    $("#us-inc-history").onchange = (e) => { curSet().incHistory = e.target.checked; saveConfig(); };
    $("#us-hist-turns").onchange = (e) => {
      let v = parseInt(e.target.value, 10);
      if (!(v >= 0)) v = 0;
      v = Math.min(200, v);
      const s = curSet();
      s.historyTurns = v;
      s.historyTurnsAuto = false; // 직접 정한 값 — 요약을 껐다고 되돌리지 않는다
      e.target.value = v; saveConfig();
    };
    $("#us-inc-summary").onchange = (e) => {
      const s = curSet();
      s.incChatSummary = e.target.checked;
      // 요약 ON: 히스토리 범위가 '전체(0)'면 최근 N개로 함께 좁힌다. 이미 값을 정해 둔 사람은 건드리지 않는다.
      // 요약 OFF: 그때 우리가 넣어 준 값이었을 때만 '전체'로 되돌린다.
      if (e.target.checked) {
        if (!(s.historyTurns > 0)) { s.historyTurns = SUMMARY_HISTORY_TURNS; s.historyTurnsAuto = true; }
      } else if (s.historyTurnsAuto) {
        s.historyTurns = 0; s.historyTurnsAuto = false;
      }
      saveConfig();
      const turnsInput = $("#us-hist-turns");
      if (turnsInput) turnsInput.value = s.historyTurns;
    };
    $("#us-inc-lorebook").onchange = (e) => { curSet().incLorebook = e.target.checked; saveConfig(); };
    $("#us-inc-characters").onchange = (e) => { curSet().incCharacters = e.target.checked; saveConfig(); };
    $("#us-inc-persona").onchange = (e) => { curSet().incPersona = e.target.checked; saveConfig(); };
    
    $("#us-hidden-exclude").onchange = (e) => { curSet().hiddenExcludeFromPrompt = e.target.checked; saveConfig(); };
    $("#us-imp").onchange = (e) => { curSet().allowImpersonate = e.target.checked; saveConfig(); };
    $("#us-depth").onchange = (e) => { let v = parseInt(e.target.value, 10); if (!(v >= 1)) v = DEFAULT_HISTORY_DEPTH; v = Math.min(200, v); curSet().historyDepth = v; e.target.value = v; saveConfig(); };
    $("#us-record-limit").onchange = (e) => {
      let v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v) || v < 0) v = DEFAULT_RECORD_LIMIT;
      v = Math.min(10000, v);
      curSet().recordLimit = v; e.target.value = v; saveConfig();
      // 줄인 경우 즉시 반영 (선입선출 삭제) — 지금 편집한 범위가 이 채팅에 실제로 적용될 때만
      if (chatId && getSettings(chatId).recordLimit === v) pruneStore(chatId, [], v);
    };
    $("#us-savedefault").onclick = () => {
      // '지금 편집 중인 범위'의 설정을 공용 디폴트로 복사한다.
      const base = { ...curSet() };
      delete base.followDefault; delete base.neverCustom;
      // enabled 는 디폴트로 복사하지 않는다 — CONVO 모드 채팅은 getSettings 가 enabled=false 를
      // 자동 주입하는데, 그게 공용 설정에 저장되면 오버라이드 없는 '모든' 채팅의 상태창이
      // 한꺼번에 꺼져버린다. 공용 enabled 는 기존 값을 그대로 유지.
      const prevEnabled = (config.settings && typeof config.settings.enabled === "boolean")
        ? config.settings.enabled : DEFAULT_SETTINGS.enabled;
      config.settings = { ...DEFAULT_SETTINGS, ...base, enabled: prevEnabled };
      saveConfig();
      alert("현재 설정을 디폴트로 저장했습니다. (켜짐/꺼짐 상태는 채팅별 설정이라 복사되지 않습니다)");
      renderStatusTab(root);
    };
    $("#us-loaddefault").onclick = () => { if (!chatId) return; if (!confirm("이 채팅 설정을 기본 디폴트로 되돌릴까요?")) return; delete config.perChatSettings[chatId]; settingsPanelScope = null; saveConfig(); invalidateFloat(); renderStatusTab(root); };

    const connSel = $("#us-conn");
    marinara.apiFetch("/connections").then((list) => {
      if (!Array.isArray(list)) return;
      for (const c of list) { connNameCache[c.id] = c.name; const opt = document.createElement("option"); opt.value = c.id; opt.textContent = c.name + (c.model ? ` (${c.model})` : ""); connSel.appendChild(opt); }
      // 표시값도 '지금 편집 중인 범위'의 설정을 따른다 (실효값이 아니라 편집 대상)
      if (st.apiConnectionId) connSel.value = st.apiConnectionId;
    }).catch(() => {});
    connSel.onchange = () => { curSet().apiConnectionId = connSel.value || null; saveConfig(); };

    renderStatusList($("#us-wlist"));
  }

  async function renderHistoryTab(root) {
    const chatId = getChatId();
    await ensureChatValues(chatId);
    const status = statusForChat(chatId);
    root.innerHTML = `
      <div class="us-history-layout">
        <div class="us-sec us-history-col us-history-list-col">
          <h3>저장 기록</h3>
          <div class="us-history-list-scroll" id="us-hist-list"></div>
          <div class="us-hist-pager-row" id="us-hist-pager"></div>
        </div>
        <div class="us-sec us-history-col us-history-preview-col">
          <h3>미리보기</h3>
          <div class="us-hist-preview-scroll">
            <div class="us-preview us-hist-preview" id="us-hist-preview"></div>
          </div>
          <div class="us-hist-preview-actions">
            <span class="us-note" id="us-hist-skin-name" style="margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
            <button class="us-btn sm us-hist-action-btn" id="us-hist-edit" disabled>수정</button>
            <button class="us-btn sm us-hist-action-btn danger" id="us-hist-del" disabled>삭제</button>
            <button class="us-btn sm us-hist-action-btn" id="us-hist-apply" disabled>적용</button>
          </div>
        </div>
      </div>
      <div class="us-sec" style="margin-top:12px;">
        <h3>빈 턴 채우기 <span class="us-note" style="font-weight:400;font-size:11px;margin-left:4px;display:inline;">— 첫 기록 이후 상태값이 없는 턴을 오래된 것부터 차례로 생성합니다.</span></h3>
        <div class="us-note" style="margin-top:4px;">중간 턴이 비어 있으면 다음 상태가 몇 턴 전 값을 이어받습니다. 채워 두면 턴마다 바로 앞 값을 기준으로 이어집니다. 기존 기록은 바꾸지 않습니다.</div>
        <div class="us-row" style="margin-top:6px;">
          <button class="us-btn sm" id="us-hist-fill">빈 턴 채우기</button>
        </div>
      </div>
      <div class="us-sec" style="margin-top:12px;">
        <h3>저장데이터 <span class="us-note" style="font-weight:400;font-size:11px;margin-left:4px;display:inline;">— 기록만 삭제합니다. 디자인/설정은 유지됩니다.</span></h3>
        <div class="us-row" style="margin-top:6px;">
          <button class="us-btn sm danger" id="us-hdel-chat">이 채팅 기록 삭제</button>
          <button class="us-btn sm danger" id="us-hdel-all">모든 채팅 기록 삭제</button>
        </div>
      </div>`;
    const $ = (q) => root.querySelector(q);
    $("#us-hdel-chat").onclick = clearChatValues;
    $("#us-hdel-all").onclick = clearAllChatValues;
    $("#us-hist-fill").onclick = () => {
      const run = fillRunByChat[chatId];
      if (run) {
        run.cancel = true;
        const runId = activeDryRunIdByChat[chatId];
        if (runId) marinara.apiFetch("/generate/dryRun/abort", { method: "POST", body: JSON.stringify({ runId, chatId }) }).catch(() => {});
        return;
      }
      void fillEmptyTurns(chatId);
    };
    updateFillButton(chatId);
    if (!chatId || !status) {
      $("#us-hist-list").innerHTML = `<div class="us-note">현재 채팅에서 상태창을 먼저 선택해 주세요.</div>`;
      return;
    }
    const store = loadStore(chatId);
    if (!store || !store.byMsg || !Object.keys(store.byMsg).length) {
      $("#us-hist-list").innerHTML = `<div class="us-note">저장된 기록이 없습니다.</div>`;
      return;
    }
    const byMsg = store.byMsg || {};
    const preview = $("#us-hist-preview");
    const list = $("#us-hist-list");
    const applyBtn = $("#us-hist-apply");
    const editBtn = $("#us-hist-edit");
    const delBtn = $("#us-hist-del");
    let messages = [];
    // 턴 번호를 절대값으로 표시하려면 전체 메시지가 필요하다(limit=40 이면 최근 40개 안에서 1번부터
    // 다시 세어 300턴인데 20턴으로 보이는 버그 발생). 전체 개수를 받아 그만큼 가져온다.
    try {
      const total = await fetchMessageCount(chatId);
      // (1) message-count 가 실패(null)하면 40으로 떨어져 오래된 메시지의 턴을 못 찾는다 → 넉넉한 상한 사용
      // (2) updateTurnMap 은 list.length < requestedLimit 로 '전체인지'를 판정하므로
      //     정확히 total 을 요청하면 항상 '잘린 꼬리'로 오판된다 → +1 요청
      const lim = Number.isFinite(total) && total > 0 ? total + 1 : 2000;
      messages = await fetchMessages(chatId, lim) || [];
    } catch {}
    const order = {};
    const assistantTurn = {};
    let turn = 0;
    messages.forEach((m, i) => {
      if (!m || !m.id) return;
      order[m.id] = i;
      // 캐릭터(assistant) 메시지만 카운트
      if (m.role === "assistant") { turn++; assistantTurn[m.id] = turn; }
    });
    // fetch 목록에 없는 msgId(조회 실패·서버에서 사라진 메시지 등)도 순서가 뒤엉키지 않도록
    // store.order(영속 시간순 기록)를 폴백으로 사용한다. 이 항목들은 fetch된 것들보다
    // 오래된 것으로 취급하되, 서로 간의 시간순은 store.order 그대로 유지한다.
    const storeOrderPos = {};
    (Array.isArray(store.order) ? store.order : []).forEach((id, i) => { storeOrderPos[id] = i; });
    const ORDER_FALLBACK_BASE = -1000000;
    const orderOf = (id) => {
      if (order[id] !== undefined) return order[id];
      if (storeOrderPos[id] !== undefined) return ORDER_FALLBACK_BASE + storeOrderPos[id];
      return ORDER_FALLBACK_BASE - 1;
    };
    const entries = [];
    for (const msgId of Object.keys(byMsg)) {
      const sw = byMsg[msgId];
      if (!sw || typeof sw !== "object") continue;
      for (const key of Object.keys(sw)) {
        const swipe = Number.parseInt(key, 10);
        const entry = normalizeMsgEntry(sw[key]);
        // 이번 조회 목록에 없으면 전역 턴 맵(computeTurn)으로 한 번 더 시도한다.
        const t = assistantTurn[msgId] || computeTurn(chatId, msgId) || null;
        entries.push({ msgId, swipe: Number.isFinite(swipe) ? swipe : 0, turn: t, entry });
      }
    }
    const placeholderEntries = entries.filter((e) => e.msgId === "__latest__");
    const normalEntries = entries.filter((e) => e.msgId !== "__latest__");
    normalEntries.sort((a, b) => {
      const oa = orderOf(a.msgId);
      const ob = orderOf(b.msgId);
      if (oa !== ob) return ob - oa;
      return b.swipe - a.swipe;
    });
    if (!normalEntries.length && !placeholderEntries.length) {
      list.innerHTML = `<div class="us-note">저장된 기록이 없습니다.</div>`;
      return;
    }
    const entryMap = new Map();
    const entryKey = (ent) => JSON.stringify([ent.msgId, ent.swipe]);
    placeholderEntries.forEach((ent) => entryMap.set(entryKey(ent), ent));
    normalEntries.forEach((ent) => entryMap.set(entryKey(ent), ent));

    const turnMap = new Map();
    for (const ent of normalEntries) {
      const gk = ent.turn ? `turn:${ent.turn}` : `msg:${ent.msgId}`;
      if (!turnMap.has(gk)) turnMap.set(gk, { key: gk, turn: ent.turn, msgId: ent.msgId, entries: [] });
      turnMap.get(gk).entries.push(ent);
    }
    const turnGroups = Array.from(turnMap.values()).sort((a, b) => {
      const oa = orderOf(a.msgId);
      const ob = orderOf(b.msgId);
      return ob - oa;
    });
    turnGroups.forEach((g) => g.entries.sort((a, b) => b.swipe - a.swipe));
    // 턴 번호를 끝내 못 찾은 그룹(원본 메시지가 삭제됐거나 조회에서 빠진 경우)은
    // 시간순으로 이웃한 그룹의 확정 턴에서 거리를 빼/더해 추정치(~N)를 만든다.
    // turnGroups 는 최신순(desc)이므로 인덱스가 커질수록 턴은 작아진다.
    for (let i = 0; i < turnGroups.length; i++) {
      const g = turnGroups[i];
      if (g.turn) continue;
      let est = null;
      for (let j = i - 1; j >= 0; j--) {
        if (turnGroups[j].turn) { const v = turnGroups[j].turn - (i - j); if (v > 0) est = v; break; }
      }
      if (!est) {
        for (let j = i + 1; j < turnGroups.length; j++) {
          if (turnGroups[j].turn) { est = turnGroups[j].turn + (j - i); break; }
        }
      }
      if (est) { g.approxTurn = est; g.entries.forEach((e) => { e.approxTurn = est; }); }
    }

    let selectedKey = historySelectedKeyByChat[chatId] || null;
    function drawPreview(ent) {
      preview.innerHTML = "";
      const skinLabel = root.querySelector("#us-hist-skin-name");
      if (!ent) {
        preview.innerHTML = `<span class="us-note">기록을 클릭하면 미리보기가 표시됩니다.</span>`;
        if (applyBtn) applyBtn.disabled = true;
        if (editBtn) editBtn.disabled = true;
        if (delBtn) delBtn.disabled = true;
        if (skinLabel) skinLabel.textContent = "";
        return;
      }
      if (applyBtn) applyBtn.disabled = false;
      if (editBtn) editBtn.disabled = false;
      if (delBtn) delBtn.disabled = false;
      activeTabByChat[HISTORY_PREVIEW_KEY] = 0;
      const originalStatus = statusForEntry(chatId, ent.entry) || status;
      if (skinLabel) {
        const modeTag = originalStatus.windowCssMode === "custom" ? " · 윈도우 CSS" : " · 마리나라";
        skinLabel.textContent = (originalStatus.name || "") + modeTag;
      }
      // 미리보기 클릭: 플로팅 창은 건드리지 않는다 — "적용" 버튼 클릭 시에만 창이 전환됨.
      // 미리보기 위젯에는 originalStatus 의 windowCss 에서 직접 변수를 추출해 inline 적용.
      const frame = document.createElement("div");
      frame.className = "us-hist-widget";
      const title = (chatId && config.perChatTitle[chatId]) || originalStatus.name || "상태창";
      frame.innerHTML = `<div class="us-f-bar"><span class="us-f-title">${esc(title)}</span></div><div class="us-f-content"></div>`;
      preview.appendChild(frame);
      applyWidgetWindowCss(frame, originalStatus);
      const content = frame.querySelector(".us-f-content");
      renderNav(content, originalStatus, ent.entry.scene, ent.entry.subjects, HISTORY_PREVIEW_KEY);
    }
    async function applyToLatest(ent) {
      await syncAssistantMetaNow(chatId, getSettings(chatId).historyDepth);
      const meta = latestAsstByChat[chatId] || { id: "__latest__", swipe: 0 };
      if (!meta.id) { alert("최신 assistant 메시지를 찾지 못했습니다."); return; }
      // 기록의 원래 상태창으로 완전히 전환: perChat 도 변경해야
      // applyWindowCss·renderFloat·statusForChat 이 모두 같은 스킨을 보게 됨.
      // historyWindowCssOverride 만 쓰면 CSS 와 템플릿 기준이 달라 둘이 섞이는 문제가 생긴다.
      const appliedStatus = statusById(ent.entry && ent.entry.statusId) || status;
      if (chatId && appliedStatus.id) {
        config.perChat[chatId] = appliedStatus.id;
        saveConfig();
        saveChatSkinSnapshot(chatId, appliedStatus).catch(() => {});
      }
      setMsgEntry(chatId, appliedStatus.id, meta.id, meta.swipe || 0, ent.entry);
      if (!manualIds[chatId]) manualIds[chatId] = new Set();
      manualIds[chatId].add(meta.id + "#" + (meta.swipe || 0));
      historyWindowCssOverride = null; // perChat 이 변경됐으므로 override 불필요
      applyWindowCss();
      lastFloatSig = null;
      renderFloat();
      await renderHistoryTab(root);
    }
    function cardHtml(ent, isPlaceholder) {
      const key = entryKey(ent);
      const turnText = ent.turn ? `${ent.turn}-${ent.swipe}`
        : ent.approxTurn ? `~${ent.approxTurn}-${ent.swipe}`
        : (isPlaceholder ? `latest-${ent.swipe}` : `?-${ent.swipe}`);
      return `<button class="us-btn sm us-hist-action-btn us-hturn-btn ${selectedKey === key ? "on" : ""}" data-hselect="${escAttr(key)}" title="턴-스와이프 표기">${turnText}</button>`;
    }
    function drawHistoryPage() {
      const totalPages = Math.max(1, Math.ceil(turnGroups.length / HISTORY_TURN_PAGE_SIZE));
      let page = historyTurnPageByChat[chatId] || 0;
      if (page >= totalPages) page = totalPages - 1;
      if (page < 0) page = 0;
      historyTurnPageByChat[chatId] = page;
      const start = page * HISTORY_TURN_PAGE_SIZE;
      const pageGroups = turnGroups.slice(start, start + HISTORY_TURN_PAGE_SIZE);

      if (!selectedKey || !entryMap.has(selectedKey)) {
        const first = pageGroups[0]?.entries[0] || placeholderEntries[0] || null;
        if (first) selectedKey = entryKey(first);
      }
      historySelectedKeyByChat[chatId] = selectedKey;

      const pagerHtml = turnGroups.length ? `<div class="us-hist-toolbar" style="margin-top:0;margin-bottom:0;">
        <div class="us-hist-pager">
          <button class="us-btn sm" id="us-turn-prev" ${page <= 0 ? "disabled" : ""}>이전</button>
          <span class="us-note" style="margin:0;">${page + 1} / ${totalPages}</span>
          <button class="us-btn sm" id="us-turn-next" ${page >= totalPages - 1 ? "disabled" : ""}>다음</button>
          ${totalPages >= 5 ? `<input class="us-input us-num" id="us-turn-jump" type="number" min="1" max="${totalPages}" value="${page + 1}" inputmode="numeric" aria-label="페이지 번호"/>` : ""}
        </div>
      </div>` : "";

      let html = "";
      if (placeholderEntries.length) {
        html += `<div class="us-note">__latest__ placeholder 기록이 있습니다.</div>`;
        html += `<div class="us-row" style="margin-top:6px;"><button class="us-btn sm" id="us-hist-migrate">최신 메시지로 이전(마이그레이션)</button></div>`;
        html += `<div class="us-hturn-grid">${placeholderEntries.map((ent) => cardHtml(ent, true)).join("")}</div>`;
      }
      pageGroups.forEach((group) => {
        const title = group.turn ? `turn ${group.turn}`
          : group.approxTurn ? `turn ~${group.approxTurn} <span style="font-weight:400;opacity:.6;">(추정)</span>`
          : `삭제된 턴 <span style="font-weight:400;opacity:.6;">${esc(group.msgId.slice(0, 8))}</span>`;
        html += `<div class="us-hturn">
          <div class="us-hturn-head">
            <div class="us-hturn-title">${title}</div>
            <div class="us-hturn-meta">swipe ${group.entries.length}개</div>
          </div>
          <div class="us-hturn-grid">${group.entries.map((ent) => cardHtml(ent, false)).join("")}</div>
        </div>`;
      });
      list.innerHTML = html || `<div class="us-note">저장된 기록이 없습니다.</div>`;

      // 페이저는 #us-hist-pager 에 별도 렌더 (이전/다음 ↔ 적용 버튼 정렬)
      const pagerEl = root.querySelector("#us-hist-pager");
      if (pagerEl) pagerEl.innerHTML = pagerHtml;
      const pagerSrc = pagerEl || list;

      const btnPrev = pagerSrc.querySelector("#us-turn-prev");
      const btnNext = pagerSrc.querySelector("#us-turn-next");
      const changePage = (delta) => { historyTurnPageByChat[chatId] = page + delta; drawHistoryPage(); };
      const jumpInput = pagerSrc.querySelector("#us-turn-jump");
      if (btnPrev) btnPrev.onclick = () => changePage(-1);
      if (btnNext) btnNext.onclick = () => changePage(1);
      if (jumpInput) {
        const jump = () => {
          let nextPage = parseInt(jumpInput.value, 10);
          if (!Number.isFinite(nextPage)) nextPage = page + 1;
          nextPage = Math.min(totalPages, Math.max(1, nextPage));
          historyTurnPageByChat[chatId] = nextPage - 1;
          drawHistoryPage();
        };
        jumpInput.onchange = jump;
        jumpInput.onkeydown = (ev) => { if (ev.key === "Enter") jump(); };
      }

      list.querySelectorAll("[data-hselect]").forEach((b) => {
        b.onclick = () => {
          selectedKey = b.getAttribute("data-hselect");
          historySelectedKeyByChat[chatId] = selectedKey;
          drawPreview(entryMap.get(selectedKey) || null);
          drawHistoryPage();
        };
      });

      const mig = list.querySelector("#us-hist-migrate");
      if (mig) {
        mig.onclick = async () => {
          await syncAssistantMetaNow(chatId, getSettings(chatId).historyDepth);
          const meta = latestAsstByChat[chatId];
          if (!meta || !meta.id) { alert("최신 assistant 메시지를 찾지 못했습니다."); return; }
          const ok = migrateLatestPlaceholder(chatId, meta.id, meta.swipe || 0);
          if (!ok) alert("이전할 placeholder 데이터가 없거나 이미 최신에 반영되어 있습니다.");
          lastFloatSig = null;
          renderFloat();
          await renderHistoryTab(root);
        };
      }
    }
    drawHistoryPage();
    drawPreview(entryMap.get(selectedKey) || null);
    if (applyBtn) {
      applyBtn.onclick = () => {
        const ent = selectedKey ? entryMap.get(selectedKey) : null;
        if (ent) applyToLatest(ent);
      };
    }
    if (editBtn) {
      editBtn.onclick = () => {
        const ent = selectedKey ? entryMap.get(selectedKey) : null;
        if (ent) openHistoryEditModal(ent, chatId, root);
      };
    }
    if (delBtn) {
      delBtn.onclick = async () => {
        const ent = selectedKey ? entryMap.get(selectedKey) : null;
        if (!ent) return;
        const label = ent.turn ? `턴 ${ent.turn} · 스와이프 ${ent.swipe + 1}` : `스와이프 ${ent.swipe + 1}`;
        if (!confirm(`이 기록(${label})을 삭제할까요?\n되돌릴 수 없습니다.`)) return;
        deleteMsgEntry(chatId, ent.msgId, ent.swipe);
        historySelectedKeyByChat[chatId] = null;
        invalidateFloat();
        await renderHistoryTab(root);
      };
    }
  }

  function openHistoryEditModal(ent, chatId, root) {
    const status = statusForEntry(chatId, ent.entry);
    const subjects = (ent.entry.subjects || []).map((s) => ({ label: s.label || "", values: Object.assign({}, s.values) }));
    const scene = ent.entry.scene ? Object.assign({}, ent.entry.scene) : null;

    // 스킨이 있으면 그 필드 순서를, 없으면 entry 에 있는 키를 그대로 사용
    const hasSkinFields = !!(status && status.fields && status.fields.length);
    const subjectFields = hasSkinFields
      ? status.fields.map((f) => f.key).filter(Boolean)
      : subjects.flatMap((s) => Object.keys(s.values || {})).filter((v, i, a) => a.indexOf(v) === i);
    // 스킨에 접기 마커가 있으면 값 입력칸도 같은 그룹으로 묶어 접을 수 있게 한다.
    const valueSegs = hasSkinFields ? fieldSegments(status.fields, status.folds) : [{ name: null, from: 0, to: subjectFields.length }];
    // 값 칸은 한 줄 input 이 아니라 textarea 다.
    //   input 의 value 속성은 줄바꿈을 담을 수 없어(escAttr 이 공백으로 바꾼다) AI가 넣은
    //   여러 줄 값이나 <i>·<small> 같은 태그가 편집 중에 뭉개졌다 → 저장된 문자열을 글자
    //   그대로 보여주고, 고친 그대로만 저장되도록 textarea 로 바꾼다.
    // 줄바꿈이 든 값만 textarea. 한 줄 값은 예전처럼 input 이라 칸 모양이 그대로다.
    //   (input 에 여러 줄 값을 넣으면 escAttr/브라우저가 줄바꿈을 지워 저장 시 뭉개진다)
    const isMultiline = (v) => /[\r\n]/.test(v == null ? "" : String(v));
    const valueField = (attrs, val, ph) => (isMultiline(val)
      ? `<textarea class="us-input us-vval" rows="1" ${attrs} placeholder="${ph}">${esc(val)}</textarea>`
      : `<input class="us-input" ${attrs} value="${escAttr(val)}" placeholder="${ph}"/>`);
    const valueRow = (si, k) => {
      const v = subjects[si] && subjects[si].values && subjects[si].values[k] != null ? subjects[si].values[k] : "";
      return `
            <div class="us-field us-vrow${isMultiline(v) ? " us-vrow-multi" : ""}" style="grid-template-columns:110px minmax(0,1fr);margin-bottom:6px;">
              <label style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(k)}</label>
              ${valueField(`data-subj-val="${si}" data-key="${escAttr(k)}"`, v, escAttr(k))}
            </div>`;
    };
    const subjectValuesHtml = (si) => valueSegs.map((seg, gi) => {
      const keys = subjectFields.slice(seg.from, seg.to).filter(Boolean);
      if (!keys.length) return "";
      const rows = keys.map((k) => valueRow(si, k)).join("");
      if (!seg.name) return rows;
      // 그룹은 기본 접힘 — 값이 많은 상태창에서 한눈에 훑기 쉽게.
      return `
          <div class="us-efold us-vfold" data-fold="subj-${si}-g${gi}">
            <div class="us-efold-head" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(seg.name)} <span style="opacity:.6;font-weight:400;">(${keys.length})</span></span>
              <span class="us-efold-arrow" style="font-size:12px;opacity:.7;flex-shrink:0;">▸</span>
            </div>
            <div class="us-efold-body" style="display:none;">${rows}</div>
          </div>`;
    }).join("");
    const sceneFields = (status && status.sceneFields && status.sceneFields.length)
      ? status.sceneFields.map((f) => f.key).filter(Boolean)
      : (scene ? Object.keys(scene) : []);

    const sceneOn = sceneFields.length > 0;
    const hasSkinSceneFields = !!(status && status.sceneFields && status.sceneFields.length);
    const sceneSegs = hasSkinSceneFields ? fieldSegments(status.sceneFields, status.sceneFolds) : [{ name: null, from: 0, to: sceneFields.length }];
    const sceneRow = (k) => `
          <div class="us-field us-vrow${isMultiline(scene && scene[k]) ? " us-vrow-multi" : ""}" style="grid-template-columns:110px minmax(0,1fr);margin-bottom:6px;">
            <label style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(k)}</label>
            ${valueField(`data-scene-key="${escAttr(k)}"`, scene && scene[k] != null ? scene[k] : "", escAttr(k))}
          </div>`;
    const sceneValuesHtml = () => sceneSegs.map((seg, gi) => {
      const keys = sceneFields.slice(seg.from, seg.to).filter(Boolean);
      if (!keys.length) return "";
      const rows = keys.map(sceneRow).join("");
      if (!seg.name) return rows;
      return `
          <div class="us-efold us-vfold" data-fold="scene-g${gi}">
            <div class="us-efold-head" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(seg.name)} <span style="opacity:.6;font-weight:400;">(${keys.length})</span></span>
              <span class="us-efold-arrow" style="font-size:12px;opacity:.7;flex-shrink:0;">▸</span>
            </div>
            <div class="us-efold-body" style="display:none;">${rows}</div>
          </div>`;
    }).join("");

    const sceneHtml = sceneOn ? `
      <div class="us-sec us-efold" data-fold="scene">
        <div class="us-efold-head" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">장면</h3>
          <span class="us-efold-arrow" style="font-size:12px;opacity:.7;">▸</span>
        </div>
        <div class="us-efold-body" style="display:none;margin-top:8px;">
        ${sceneValuesHtml()}
        </div>
      </div>` : "";

    const subjectsHtml = subjects.length ? subjects.map((s, si) => `
      <div class="us-sec us-efold" data-fold="subj-${si}" data-subj-sec="${si}">
        <div class="us-efold-head" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">대상 ${si + 1}${s.label ? " · " + esc(s.label) : ""}</h3>
          <span class="us-efold-arrow" style="font-size:12px;opacity:.7;flex-shrink:0;">▸</span>
        </div>
        <div class="us-efold-body" style="display:none;margin-top:8px;">
          <div class="us-field" style="grid-template-columns:110px 1fr;margin-bottom:6px;align-items:center;">
            <label style="font-size:12px;">이름/레이블</label>
            <input class="us-input" data-subj-label="${si}" value="${escAttr(s.label)}" placeholder="이름"/>
          </div>
          ${subjectValuesHtml(si)}
          <div style="display:flex;justify-content:flex-end;margin-top:10px;">
            <button type="button" class="us-subj-del" data-del-subj="${si}" title="이 대상 삭제" style="background:transparent;border:1px solid var(--us-float-border,#a55);color:#c66;cursor:pointer;font-size:11px;line-height:1;padding:5px 12px;border-radius:6px;">이 캐릭터 삭제</button>
          </div>
        </div>
      </div>`).join("") : `<div class="us-note" style="margin-top:8px;">저장된 subjects 데이터가 없습니다.</div>`;

    const turnText = ent.turn ? `turn ${ent.turn}-${ent.swipe}`
      : ent.approxTurn ? `turn ~${ent.approxTurn}-${ent.swipe} (추정)`
      : `삭제된 턴 -${ent.swipe}`;
    const statusName = status ? esc(status.name) : "(스킨 없음 — 원본 키 표시)";

    const o = overlay(MODAL_ID, `
      <div class="us-h"><span class="us-head-icon">${ICON.edit}</span><h2>기록 수정</h2><button class="us-x" id="he-close" aria-label="닫기">${ICON.close}</button></div>
      <div class="us-sub" style="margin-top:-4px;">${esc(turnText)} · ${statusName}</div>
      ${sceneHtml}
      ${subjectsHtml}
      <div class="us-sec">
        <details class="us-det"><summary>원본 JSON으로 수정</summary>
          <div class="us-note us-det-note">이 기록에 실제로 저장된 값입니다. 여기를 고치면 <b>위 입력칸 대신 이 JSON이 저장</b>됩니다. (형식이 잘못되면 저장되지 않습니다)</div>
          <textarea class="us-ta" id="he-json" spellcheck="false">${esc(JSON.stringify({ scene: scene || null, subjects }, null, 2))}</textarea>
        </details>
      </div>
      <div class="us-foot">
        <button class="us-btn" id="he-cancel">취소</button>
        <button class="us-btn primary" id="he-save">저장</button>
      </div>`);

    const $ = (q) => o.querySelector(q);
    $("#he-close").onclick = () => closeOverlay(MODAL_ID);
    $("#he-cancel").onclick = () => closeOverlay(MODAL_ID);
    // 값 칸 자동 높이 — 한 줄이면 한 줄, 길면 내용만큼 늘어난다 (접힌 그룹은 펼칠 때 다시 계산)
    const autoGrow = (el) => { if (!el) return; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight + 2, 260) + "px"; };
    const growAll = () => o.querySelectorAll(".us-vval").forEach(autoGrow);
    o.querySelectorAll(".us-vval").forEach((el) => { el.oninput = () => autoGrow(el); });
    growAll();
    // 원본 JSON 칸을 직접 고쳤으면 저장 때 그쪽을 우선한다.
    let jsonDirty = false;
    const jsonTa = $("#he-json");
    if (jsonTa) jsonTa.oninput = () => { jsonDirty = true; };
    // 접기/펼치기 — 헤더 클릭으로 토글 (삭제 버튼 클릭은 제외). 기본은 모두 접힘.
    o.querySelectorAll(".us-efold-head").forEach((head) => {
      head.onclick = (e) => {
        if (e.target.closest(".us-subj-del")) return; // 삭제 버튼은 토글 안 함
        const sec = head.closest(".us-efold");
        const body = sec.querySelector(".us-efold-body");
        const arrow = sec.querySelector(".us-efold-arrow");
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "";
        if (arrow) arrow.textContent = open ? "▸" : "▾";
        // 접혀 있던 칸은 scrollHeight 가 0이라 높이 계산이 안 된다 → 펼칠 때 다시 잰다.
        if (!open) body.querySelectorAll(".us-vval").forEach(autoGrow);
      };
    });
    // 캐릭터 삭제 — 해당 섹션을 DOM에서 제거 (저장 시 수집 대상에서 빠져 실제 삭제됨)
    o.querySelectorAll(".us-subj-del").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const si = btn.dataset.delSubj;
        const sec = o.querySelector(`[data-subj-sec="${si}"]`);
        if (sec) sec.remove();
      };
    });
    $("#he-save").onclick = async () => {
      // ── 원본 JSON 을 직접 고쳤으면 그쪽을 그대로 저장한다 ──
      if (jsonDirty && jsonTa) {
        let parsed = null;
        try { parsed = JSON.parse(jsonTa.value); }
        catch (e) { alert("원본 JSON 형식이 잘못되었습니다:\n" + ((e && e.message) || e)); return; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { alert("원본 JSON 은 { scene, subjects } 형태여야 합니다."); return; }
        const subjOk = Array.isArray(parsed.subjects)
          ? parsed.subjects.map((s) => ({ label: (s && s.label != null ? String(s.label) : ""), values: (s && s.values && typeof s.values === "object") ? Object.fromEntries(Object.entries(s.values).map(([k, v]) => [k, v == null ? "" : String(v)])) : {} }))
          : [];
        const sceneOk = (parsed.scene && typeof parsed.scene === "object" && !Array.isArray(parsed.scene))
          ? Object.fromEntries(Object.entries(parsed.scene).map(([k, v]) => [k, v == null ? "" : String(v)]))
          : null;
        setMsgEntry(chatId, ent.entry.statusId || (status && status.id) || null, ent.msgId, ent.swipe, { scene: sceneOk, subjects: subjOk });
        if (!manualIds[chatId]) manualIds[chatId] = new Set();
        manualIds[chatId].add(ent.msgId + "#" + ent.swipe);
        invalidateFloat();
        closeOverlay(MODAL_ID);
        if (root && root.isConnected) await renderHistoryTab(root);
        return;
      }
      // 장면 수집
      let newScene = null;
      if (sceneOn) {
        newScene = {};
        o.querySelectorAll("[data-scene-key]").forEach((el) => { newScene[el.dataset.sceneKey] = el.value; });
      } else if (scene) {
        newScene = scene;
      }
      // subjects 수집 — DOM에서 삭제된(제거된) 대상은 제외
      const newSubjects = [];
      subjects.forEach((s, si) => {
        const sec = o.querySelector(`[data-subj-sec="${si}"]`);
        if (!sec) return; // 삭제됨
        const labelEl = o.querySelector(`[data-subj-label="${si}"]`);
        const label = labelEl ? labelEl.value : s.label;
        const values = Object.assign({}, s.values);
        o.querySelectorAll(`[data-subj-val="${si}"]`).forEach((el) => { values[el.dataset.key] = el.value; });
        newSubjects.push({ label, values });
      });
      setMsgEntry(chatId, ent.entry.statusId || (status && status.id) || null, ent.msgId, ent.swipe, { scene: newScene, subjects: newSubjects });
      if (!manualIds[chatId]) manualIds[chatId] = new Set();
      manualIds[chatId].add(ent.msgId + "#" + ent.swipe);
      invalidateFloat();
      closeOverlay(MODAL_ID);
      if (root && root.isConnected) await renderHistoryTab(root);
    };
  }

  // '출력 결과' 탭 — API 모드 전용. 형식 미인식으로 보관 중인 마지막 원문을 보여준다.
  function renderRawOutputTab(root) {
    const chatId = getChatId();
    const st = getSettings(chatId);
    if (st.dataMode !== DATA_MODES.api) {
      root.innerHTML = `<div class="us-sec"><div class="us-note">이 탭은 '<b>API 따로 연결</b>' 방식일 때만 사용합니다. (채팅 출력 방식은 답변이 채팅에 그대로 보입니다.)</div></div>`;
      return;
    }
    const slot = chatId && lastRawOutputByChat[chatId];
    if (!slot || !slot.text) {
      root.innerHTML = `
        <div class="us-sec">
          <h3>출력 결과 (마지막 API 원문)</h3>
          <div class="us-note">보관 중인 API 원문이 없습니다.<br/>아직 이 채팅에서 API 캡처가 일어나지 않았거나, 페이지를 새로고침해 휘발되었습니다.<br/><span style="opacity:.7;">원문은 저장되지 않으며(휘발성), API 캡처가 일어날 때마다 가장 최근 출력으로 갱신됩니다.</span></div>
        </div>`;
      return;
    }
    const tag = slot.recognized
      ? `<span style="color:var(--us-accent,#3a8);font-weight:600;">형식 인식됨</span>`
      : `<span style="color:var(--us-danger,#c55);font-weight:600;">형식 미인식</span>`;
    const hint = slot.recognized
      ? "정상 인식되어 상태창에 반영된 응답입니다. 모델이 실제로 무엇을 반환했는지 확인용입니다."
      : "상태창 형식으로 인식하지 못한 응답입니다. 아래에서 직접 고친 뒤 [형식 인식]을 누르면 상태창에 반영됩니다.";
    root.innerHTML = `
      <div class="us-sec">
        <h3>출력 결과 (마지막 API 원문)</h3>
        <div class="us-note" style="margin-bottom:8px;">${tag} <span style="opacity:.7;">(${esc(new Date(slot.ts).toLocaleString())})</span><br/>${hint}</div>
        <textarea class="us-ta" id="us-rawtab-text" style="min-height:320px;white-space:pre-wrap;font-size:12px;">${esc(slot.text)}</textarea>
        <div class="us-row" style="margin-top:8px;">
          <button class="us-btn sm" id="us-rawtab-copy">복사</button>
          <button class="us-btn sm" id="us-rawtab-clear">지우기</button>
          <button class="us-btn sm primary" id="us-rawtab-parse">형식 인식</button>
        </div>
      </div>`;
    const ta = root.querySelector("#us-rawtab-text");
    root.querySelector("#us-rawtab-copy").onclick = () => {
      ta.select();
      try { navigator.clipboard.writeText(ta.value); } catch (e) { try { document.execCommand("copy"); } catch (e2) {} }
    };
    root.querySelector("#us-rawtab-clear").onclick = () => {
      delete lastRawOutputByChat[chatId];
      renderRawOutputTab(root);
    };
    // 보관된 원문을 다시 파싱해 상태창에 반영한다.
    //  형식을 못 읽으면 조용히 넘어가지 않고 왜 실패했는지 알린다.
    root.querySelector("#us-rawtab-parse").onclick = async () => {
      const text = ta.value || "";
      if (!text.trim()) { showFloatNotice("원문이 비어 있습니다", "warn"); return; }
      const status = statusForChat(chatId);
      if (!status) { showFloatNotice("이 채팅에 지정된 상태창이 없습니다", "warn"); return; }
      const subjects = parseSubjects(text);
      const scene = parseScene(text);
      const hasScene = !!(scene && Object.keys(scene).length);
      if (!subjects.length && !hasScene) {
        showFloatNotice("형식을 인식하지 못했습니다 — 유효한 us-status JSON이 아닙니다", "warn");
        return;
      }
      // 저장 위치를 최신 서버 메타 기준으로 확정한 뒤 반영
      try { await syncAssistantMetaNow(chatId, getSettings(chatId).historyDepth); } catch (_) {}
      const tgt = manualTargetMeta(chatId);
      // 저장 방식은 '수동 JSON 입력'과 동일하게 맞춘다:
      //  캐릭터 필드가 있는 스킨은 카드 로스터를 병합(장면에 안 나온 캐릭터도 탭 유지),
      //  장면 전용 스킨은 subjects 를 비워 저장.
      const charFieldsOn = Array.isArray(status.fields) && status.fields.length > 0;
      let keepSubjects;
      if (charFieldsOn) {
        keepSubjects = (subjects && subjects.length) ? subjects : [{ label: "", values: {} }];
        keepSubjects = dropDeleted(chatId, mergeCardRosterIntoSubs(keepSubjects, getCardRosterSync(chatId), chatId));
      } else {
        keepSubjects = [];
      }
      setMsgEntry(chatId, status.id, tgt.msgId, tgt.swipe, {
        scene: hasScene ? scene : null,
        subjects: keepSubjects,
      });
      if (!manualIds[chatId]) manualIds[chatId] = new Set();
      manualIds[chatId].add(tgt.msgId + "#" + tgt.swipe);
      lastRawOutputByChat[chatId] = { ...lastRawOutputByChat[chatId], recognized: true };
      hideRawBlocksInChat();
      invalidateFloat();
      refreshHistoryUiIfOpen();
      renderRawOutputTab(root);
      showFloatNotice(`인식 완료 — 캐릭터 ${keepSubjects.length}명${hasScene ? ", 장면 값 포함" : ""}`, "info");
    };
  }

  // 고급 탭의 '모드 전용' 섹션 접힘 상태.
  //   기본값은 표시 모드 토글을 따라간다 (인라인이면 인라인 섹션만 펼침, 플로팅이면 그 반대).
  //   사용자가 직접 접거나 펴면 그 값만 여기에 남고, 모드 토글을 바꾸면 다시 자동으로 정리된다.
  let advFoldOverride = {};
  function renderAdvancedTab(root) {
    const chatId = getChatId();
    const globalDefaultInstructions = ((config.settings && typeof config.settings.defaultInstructions === "string")
      ? config.settings.defaultInstructions
      : DEFAULT_CONTINUITY_PROMPT);
    const panelsOn = config.ui.applyWindowCssToPanels !== false;
    const inlineOn = isInlineDisplayMode();
    const barMode = barToggleMode();
    // 모드 전용 섹션 — 지금 쓰는 모드의 것만 펼쳐서 보여준다.
    const foldOpen = (key, mode) => (typeof advFoldOverride[key] === "boolean")
      ? advFoldOverride[key]
      : (mode === "inline" ? inlineOn : !inlineOn);
    const foldSec = (key, mode, title, bodyHtml) => {
      const open = foldOpen(key, mode);
      const badge = mode === "inline" ? "채팅창 안 모드" : "화면에 띄우기 모드";
      return `<div class="us-sec us-sec-fold${open ? " open" : ""}" data-fold="${escAttr(key)}">
        <h3 class="us-fold-head" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
          <span class="us-fold-arrow">${open ? "▾" : "▸"}</span>
          <span class="us-fold-title">${title}</span>
          <span class="us-fold-badge">${badge}</span>
        </h3>
        <div class="us-fold-body">${bodyHtml}</div>
      </div>`;
    };
    root.innerHTML = `
      <div class="us-sec">
        <details class="us-det" id="us-definstr-details">
          <summary>공용 기본 규칙 (상태창에 규칙이 없을 때)</summary>
          <div style="padding:10px 12px 12px;">
            <textarea class="us-ta" id="us-definstr" style="min-height:120px;white-space:pre-wrap;border-top:none;border-radius:0 0 7px 7px;">${esc(globalDefaultInstructions)}</textarea>
            <div class="us-row" style="margin-top:8px;">
              <button class="us-btn sm" id="us-definstr-reset">초기화</button>
              <button class="us-btn sm primary" id="us-definstr-save">저장</button>
            </div>
            <div class="us-note">저장 버튼을 눌러야 변경사항이 반영됩니다. 초기화는 기본 제공 공용 규칙으로 되돌립니다.</div>
            <div class="us-note">개별 상태창의 "연속성·작성 규칙"이 비어 있을 때 이 문구가 대신 사용됩니다. (영어 권장 — 토큰 절약)</div>
          </div>
        </details>
      </div>
      <div class="us-sec">
        <h3>동작</h3>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;">
          <label class="us-switch"><input type="checkbox" id="us-prompt-first" ${config.ui.promptFirstCapture !== false ? "checked" : ""}/><span class="us-track"></span></label>
          <span>첫 상태창 생성 시 풀 컨텍스트 여부 묻기</span>
        </label>
        <div class="us-note">켜져 있으면, 채팅에 저장된 상태값이 전혀 없을 때 첫 생성 시 "전부 포함할까요?" 확인창을 띄웁니다. 끄면 묻지 않고 데이터 설정 토글대로 진행합니다.</div>
      </div>
      <div class="us-sec">
        <h3>상태창 표시 위치와 너비</h3>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;">
          <label class="us-switch"><input type="checkbox" id="us-display-inline" ${inlineOn ? "checked" : ""}/><span class="us-track"></span></label>
          <span>상태창을 채팅창 안에 표시</span>
        </label>
        <div class="us-note">끄면 기존처럼 상태창을 화면에 띄우며, 헤더 드래그와 아이콘 최소화를 다시 사용할 수 있습니다.</div>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;margin-top:8px;${inlineOn ? "" : "opacity:.55;"}">
          <label class="us-switch"><input type="checkbox" id="us-inline-full-width" ${config.ui.inlineFullWidth ? "checked" : ""} ${inlineOn ? "" : "disabled"}/><span class="us-track"></span></label>
          <span>채팅창 너비에 맞춤 <span style="font-size:11px;opacity:.7;">(끄면 기존 최대 340px)</span></span>
        </label>
        <div class="us-note">채팅창 안 모드에서만 적용됩니다. 최신 상태와 과거 메시지의 접힌 기록에 같은 너비 기준을 적용합니다.</div>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;margin-top:8px;${inlineOn ? "" : "opacity:.55;"}">
          <label class="us-switch"><input type="checkbox" id="us-inline-show-title" ${config.ui.inlineShowTitle !== false ? "checked" : ""} ${inlineOn ? "" : "disabled"}/><span class="us-track"></span></label>
          <span>인라인 상태창 제목 표시</span>
        </label>
        <div class="us-note">끄면 최신·과거 인라인 상태창에서 제목만 숨깁니다. 접기와 동작 버튼은 그대로 유지됩니다.</div>
      </div>
      <div class="us-sec">
        <h3>제목 바로 접기/펼치기</h3>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;">
          <label class="us-switch"><input type="checkbox" id="us-bartoggle" ${barMode === "click" ? "checked" : ""}/><span class="us-track"></span></label>
          <span>제목 바를 클릭하면 접기/펼치기</span>
        </label>
        <div class="us-note">제목이 있는 가장 위 바 전체가 접기 영역이 됩니다. 바 위에 얹힌 버튼(접기·값 수정·재생성·새로고침·설정)은 그대로 각자 동작합니다. 화면에 띄우기 모드에서는 바를 잡고 끌어 창을 옮기는 동작과 자동으로 구분됩니다. 끄면 화살표 버튼으로만 접고 펼 수 있습니다.</div>
      </div>
      ${foldSec("inlineFold", "inline", "채팅창 안 기본 접힘", `
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;">
          <label class="us-switch"><input type="checkbox" id="us-inline-window-default" ${config.ui.inlineWindowDefaultCollapsed ? "checked" : ""}/><span class="us-track"></span></label>
          <span>상태창 전체를 기본으로 접기</span>
        </label>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;margin-top:8px;">
          <label class="us-switch"><input type="checkbox" id="us-inline-scene-default" ${config.ui.inlineSceneDefaultCollapsed ? "checked" : ""}/><span class="us-track"></span></label>
          <span>장면 영역을 기본으로 접기</span>
        </label>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;margin-top:8px;">
          <label class="us-switch"><input type="checkbox" id="us-inline-char-default" ${config.ui.inlineCharDefaultCollapsed ? "checked" : ""}/><span class="us-track"></span></label>
          <span>캐릭터 영역을 기본으로 접기</span>
        </label>
        <div class="us-note">세 항목은 서로 독립적입니다. 변경하면 현재 채팅에도 즉시 적용되고, 새 채팅·새 최신 상태의 기본값으로 사용됩니다. 과거 메시지 기록 카드 자체는 새 기록이 생기면 계속 자동으로 접힙니다.</div>
      `)}
      <div class="us-sec">
        <h3>윈도우 CSS 적용 범위</h3>
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;">
          <label class="us-switch"><input type="checkbox" id="us-panel-window-css" ${panelsOn ? "checked" : ""}/><span class="us-track"></span></label>
          <span>설정창·편집기 창도 윈도우 CSS 따라가기 <span style="font-size:11px;opacity:.7;">(끄면 항상 마리나라 테마)</span></span>
        </label>
        <div class="us-note">켜면 설정창·편집기 창 색이 플로팅 창(#us-float) 색을 그대로 따라갑니다(프리셋 포함). 끄면 항상 마리나라 기본 테마로 표시됩니다.</div>
      </div>
      ${foldSec("floatHistory", "floating", "기록 표시", `
        <label class="us-toggle" style="display:flex;${inlineOn ? "opacity:.55;" : ""}"><input type="checkbox" id="us-history-hover" ${config.ui.historyHoverPreview !== false ? "checked" : ""} ${inlineOn ? "disabled" : ""}/> <span>마우스/스크롤로 과거 메시지에 포커스될 때 상태창을 과거 기록으로 전환</span></label>
        <div class="us-note">화면에 띄우기 모드에서만 적용됩니다. 채팅창 안 모드는 각 메시지 아래에서 그 메시지·스와이프의 기록을 직접 표시합니다.</div>
        <label class="us-toggle" style="display:flex;margin-top:8px;${inlineOn ? "opacity:.55;" : ""}"><input type="checkbox" id="us-dynamic-window-css" ${config.ui.dynamicWindowCss ? "checked" : ""} ${inlineOn ? "disabled" : ""}/> <span>플로팅 창이 이전 메시지의 상태창 디자인도 따라가기</span></label>
        <div class="us-note">화면에 띄우기 모드에서만 적용됩니다. 채팅창 안 모드는 과거 위젯마다 저장 당시 스킨과 CSS를 직접 사용합니다.</div>
      `)}
      ${foldSec("floatCharFold", "floating", "캐릭터 영역 접기", `
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;${inlineOn ? "opacity:.65;" : ""}">
          <label class="us-switch"><input type="checkbox" id="us-char-collapse" ${inlineOn || config.ui.charCollapseEnabled ? "checked" : ""} ${inlineOn ? "disabled" : ""}/><span class="us-track"></span></label>
          <span>캐릭터 접기 버튼 표시</span>
        </label>
        <div class="us-note">채팅창 안 모드에서는 접기 버튼이 항상 표시됩니다. 처음 접힐지는 위의 인라인 기본 접힘 설정을 따르며, 스킨 편집기의 '항상 숨김' 설정은 그대로 우선합니다.</div>
      `)}
      ${foldSec("floatMinimize", "floating", "창 최소화 모드", `
        <label class="us-toggle" style="display:flex;gap:8px;align-items:center;${inlineOn ? "opacity:.55;" : ""}">
          <label class="us-switch"><input type="checkbox" id="us-icon-minimize" ${config.ui.floatMinimizeMode === "icon" ? "checked" : ""} ${inlineOn ? "disabled" : ""}/><span class="us-track"></span></label>
          <span>접힘 시 제목 바 대신 앱 아이콘으로 표시</span>
        </label>
        <div class="us-note">화면에 띄우기 모드에서만 적용됩니다. 켜면 접힌 창을 정사각형 아이콘으로 표시하며, 클릭하면 펼쳐집니다.</div>
      `)}
      <div class="us-sec">
        <h3>백업 &amp; 초기화</h3>
        <div class="us-row">
          <button class="us-btn sm primary" id="us-bkp-full-out">전체 백업</button>
          <button class="us-btn sm" id="us-bkp-rec-out">기록 내보내기</button>
          <button class="us-btn sm" id="us-bkp-rec-in">가져오기</button>
          <button class="us-btn sm danger" id="us-resetall">모두 초기화</button>
        </div>
        <div class="us-note">[전체 백업]은 모든 채팅의 기록과 상태창(스킨)·설정을 파일 하나로 저장합니다. 기기를 옮기거나 되돌릴 때 이것만 있으면 됩니다.<br>[가져오기]는 전체 백업·기록 파일 어느 쪽이든 자동으로 알아보고, 채팅방도 스스로 찾아 맞춥니다.</div>
      </div>`;
    const $ = (q) => root.querySelector(q);
    let defaultInstrDraft = globalDefaultInstructions;
    $("#us-definstr").oninput = (e) => { defaultInstrDraft = e.target.value; };
    $("#us-definstr-reset").onclick = () => {
      defaultInstrDraft = DEFAULT_CONTINUITY_PROMPT;
      $("#us-definstr").value = defaultInstrDraft;
    };
    $("#us-definstr-save").onclick = () => {
      if (!config.settings || typeof config.settings !== "object") config.settings = { ...DEFAULT_SETTINGS };
      config.settings.defaultInstructions = defaultInstrDraft;
      saveConfig();
      alert("공용 기본 규칙을 저장했습니다.");
    };
    $("#us-panel-window-css").onchange = (e) => {
      config.ui.applyWindowCssToPanels = e.target.checked;
      saveConfig(); applyWindowCss();
    };
    $("#us-prompt-first").onchange = (e) => { config.ui.promptFirstCapture = e.target.checked; saveConfig(); };
    // 모드 전용 섹션 헤더 — 클릭으로 직접 접고 펼 수 있다 (그 값은 모드를 바꾸기 전까지 유지).
    root.querySelectorAll(".us-sec-fold > .us-fold-head").forEach((head) => {
      const wrap = head.parentElement;
      const key = wrap.dataset.fold;
      const toggle = () => {
        const next = !wrap.classList.contains("open");
        wrap.classList.toggle("open", next);
        head.setAttribute("aria-expanded", next ? "true" : "false");
        const arrow = head.querySelector(".us-fold-arrow");
        if (arrow) arrow.textContent = next ? "▾" : "▸";
        advFoldOverride[key] = next;
      };
      head.onclick = toggle;
      head.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    });
    $("#us-bartoggle").onchange = (e) => {
      config.ui.barToggleMode = e.target.checked ? "click" : "off";
      saveConfig(); invalidateFloat();
    };
    $("#us-display-inline").onchange = (e) => {
      config.ui.displayMode = e.target.checked ? "inline" : "floating";
      saveConfig();
      invalidateFloat();
      // 모드가 바뀌면 섹션 접힘도 새 모드 기준으로 자동 정리 (직접 접었던 기억은 리셋)
      advFoldOverride = {};
      renderAdvancedTab(root);
    };
    $("#us-inline-full-width").onchange = (e) => {
      config.ui.inlineFullWidth = e.target.checked;
      saveConfig(); invalidateFloat();
    };
    $("#us-inline-show-title").onchange = (e) => {
      config.ui.inlineShowTitle = e.target.checked;
      saveConfig(); invalidateFloat();
    };
    $("#us-inline-window-default").onchange = (e) => {
      config.ui.inlineWindowDefaultCollapsed = e.target.checked;
      if (chatId) config.ui.inlineWindowCollapsed[chatId] = e.target.checked;
      saveConfig(); invalidateFloat();
    };
    $("#us-inline-scene-default").onchange = (e) => {
      config.ui.inlineSceneDefaultCollapsed = e.target.checked;
      if (chatId) config.ui.sceneCollapsed[chatId] = e.target.checked;
      saveConfig(); invalidateFloat();
    };
    $("#us-inline-char-default").onchange = (e) => {
      config.ui.inlineCharDefaultCollapsed = e.target.checked;
      if (chatId) config.ui.charCollapsed[chatId] = e.target.checked;
      saveConfig(); invalidateFloat();
    };
    $("#us-history-hover").onchange = (e) => { config.ui.historyHoverPreview = e.target.checked; saveConfig(); invalidateFloat(); };
    $("#us-dynamic-window-css").onchange = (e) => {
      config.ui.dynamicWindowCss = e.target.checked;
      saveConfig();
      if (!e.target.checked) { historyWindowCssOverride = null; }
      applyWindowCss();
    };
    $("#us-icon-minimize").onchange = (e) => { config.ui.floatMinimizeMode = e.target.checked ? "icon" : "bar"; saveConfig(); invalidateFloat(); };
    $("#us-char-collapse").onchange = (e) => { config.ui.charCollapseEnabled = e.target.checked; saveConfig(); invalidateFloat(); };
    const chatId4bkp = getChatId();
    $("#us-bkp-rec-out").onclick = () => openChoiceModal("기록 내보내기", "내보낼 범위를 선택하세요.", [
      { label: "전체 채팅 기록", primary: true, action: () => exportRecordsAll() },
      { label: "이 채팅 기록만", action: () => exportRecordsChat(chatId4bkp) },
    ]);
    $("#us-bkp-full-out").onclick = exportFullBackup;
    $("#us-bkp-rec-in").onclick = importStatusValues;
    $("#us-resetall").onclick = resetAllToDefault;
  }


  function syncDefaultSelInPanel() {
    const sel = document.getElementById("us-default-status");
    if (!sel) return;
    sel.innerHTML = config.statuses.map((w) => `<option value="${escAttr(w.id)}"${w.id === config.activeId ? " selected" : ""}>${esc(w.name)}</option>`).join("");
  }

  const descOpenIds = new Set(); // 목록에서 설명을 펼쳐 둔 스킨 ID (세션 동안만)
  function renderStatusList(listEl) {
    if (!listEl) return;
    if (!config.statuses.length) { listEl.innerHTML = `<div class="us-note">아직 상태창이 없습니다. "새 상태창"으로 만들어 보세요.</div>`; return; }
    const chatId = getChatId();
    const appliedId = (statusForChat(chatId) || {}).id || null;
    const primary = config.statuses.find((w) => w.id === appliedId)
      || config.statuses.find((w) => w.id === config.activeId)
      || config.statuses[0];
    const modeBadge = (w) => `<span style="font-size:10px;opacity:.65;white-space:nowrap;">${w.windowCssMode === "custom" ? "윈도우 CSS" : "마리나라"}</span>`;
    // 필드 개수: 캐릭터 필드만 세던 것을 장면/캐릭터로 분리 표기
    const fieldMeta = (w) => {
      const c = Array.isArray(w.fields) ? w.fields.length : 0;
      const s = Array.isArray(w.sceneFields) ? w.sceneFields.length : 0;
      return `장면 ${s} · 캐릭터 ${c}`;
    };
    // 설명이 있으면 이름 앞에 ▸ 를 달고, 누르면 행 아래에 펼친다.
    const nameHtml = (w) => {
      if (!(w.description || "").trim()) return `<span class="nm">${esc(w.name)}</span>`;
      const open = descOpenIds.has(w.id);
      return `<span class="nm has-desc" data-desc="${esc(w.id)}" role="button" tabindex="0" aria-expanded="${open}" title="설명 ${open ? "접기" : "보기"}"><span class="us-desc-chev">${open ? "▾" : "▸"}</span>${esc(w.name)}</span>`;
    };
    // 서버 연동 스위치 — marinara.storage 가 있을 때만
    const syncBtn = (w) => !serverSyncAvailable() ? "" : (w.localOnly
      ? `<button class="us-iconbtn us-syncbtn off" data-sync="${esc(w.id)}" title="이 기기에만 저장 — 누르면 서버 연동" aria-label="서버 연동 꺼짐">${ICON.cloudOff}</button>`
      : `<button class="us-iconbtn us-syncbtn" data-sync="${esc(w.id)}" title="서버 연동 중 — 누르면 이 기기에만 저장" aria-label="서버 연동 켜짐">${ICON.cloud}</button>`);
    const descHtml = (w) => ((w.description || "").trim() && descOpenIds.has(w.id))
      ? `<div class="us-wdesc">${esc(w.description.trim())}</div>` : "";
    const itemHtml = (w) => `
      <div class="us-item ${w.id === appliedId ? "active" : ""}" data-wid="${esc(w.id)}">
        <button class="us-iconbtn" data-star="${esc(w.id)}" title="활성 상태창(기본)" aria-label="활성 상태창(기본)">${w.id === config.activeId ? ICON.star : ICON.starOutline}</button>
        ${nameHtml(w)}<span class="meta">${fieldMeta(w)} · ${modeBadge(w)}</span>${syncBtn(w)}
        <button class="us-btn sm ${w.id === appliedId ? "on" : ""}" data-apply="${esc(w.id)}" title="이 채팅에 적용">${w.id === appliedId ? "✓ 적용" : "적용"}</button>
        <button class="us-btn sm" data-edit="${esc(w.id)}">편집</button>
        <button class="us-btn sm" data-dup="${esc(w.id)}">복제</button>
        <button class="us-btn sm" data-export="${esc(w.id)}">추출</button>
        <button class="us-btn sm danger" data-del="${esc(w.id)}">삭제</button>
        ${descHtml(w)}
      </div>`;
    const others = config.statuses.filter((w) => w !== primary);
    let html = itemHtml(primary);
    if (others.length) {
      const othersHtml = others.map((w) => `
        <div class="us-manager-item ${w.id === appliedId ? "active" : ""}" data-wid="${esc(w.id)}">
          <span class="us-wgrip" data-wgrip title="드래그하여 순서 변경">${ICON.grip}</span>
          <button class="us-iconbtn" data-star="${esc(w.id)}" title="활성 상태창(기본)" aria-label="활성 상태창(기본)">${w.id === config.activeId ? ICON.star : ICON.starOutline}</button>
          ${nameHtml(w)}
          <span class="meta">${fieldMeta(w)} · ${modeBadge(w)}</span>${syncBtn(w)}
          <button class="us-btn sm ${w.id === appliedId ? "on" : ""}" data-apply="${esc(w.id)}" ${chatId ? "" : "disabled"}>${w.id === appliedId ? "✓ 적용" : "적용"}</button>
          <button class="us-btn sm" data-edit="${esc(w.id)}">편집</button>
          <button class="us-btn sm" data-dup="${esc(w.id)}">복제</button>
          <button class="us-btn sm" data-export="${esc(w.id)}">추출</button>
          <button class="us-btn sm danger" data-del="${esc(w.id)}">삭제</button>
          ${descHtml(w)}
        </div>`).join("");
      html += `
        <div class="us-wbox${othersBoxOpen ? " open" : ""}" id="us-others-box">
          <div class="us-wfold" id="us-others-fold">${othersBoxOpen ? "▾" : "▸"} 다른 상태창 (${others.length}개)</div>
          <div class="us-wothers"${othersBoxOpen ? "" : ' style="display:none"'} id="us-others-list">
            ${othersHtml}
          </div>
        </div>`;
    }
    listEl.innerHTML = html;
    const refresh = () => { renderStatusList(listEl); syncDefaultSelInPanel(); invalidateFloat(); applyWindowCss(); };
    listEl.querySelectorAll("[data-apply]").forEach((b) => b.onclick = () => {
      if (!chatId) { alert("채팅 화면에서 열어주세요."); return; }
      config.perChat[chatId] = b.dataset.apply; saveConfig();
      const applied = statusById(b.dataset.apply);
      if (applied) saveChatSkinSnapshot(chatId, applied).catch(() => {});
      refresh();
    });
    listEl.querySelectorAll("[data-sync]").forEach((b) => b.onclick = () => { const w = statusById(b.dataset.sync); if (!w) return; w.localOnly = !w.localOnly; saveConfig(); renderStatusList(listEl); });
    listEl.querySelectorAll("[data-star]").forEach((b) => b.onclick = () => { config.activeId = b.dataset.star; saveConfig(); refresh(); });
    listEl.querySelectorAll("[data-desc]").forEach((el) => {
      const toggle = () => {
        const id = el.dataset.desc;
        if (descOpenIds.has(id)) descOpenIds.delete(id); else descOpenIds.add(id);
        renderStatusList(listEl);
      };
      el.onclick = toggle;
      el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    });
    listEl.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => openEditor(b.dataset.edit));
    listEl.querySelectorAll("[data-dup]").forEach((b) => b.onclick = () => { const w = config.statuses.find((x) => x.id === b.dataset.dup); if (!w) return; config.statuses.push(normalizeStatus({ ...w, id: uid(), name: w.name + " 사본" })); saveConfig(); refresh(); });
    listEl.querySelectorAll("[data-export]").forEach((b) => b.onclick = () => { const w = config.statuses.find((x) => x.id === b.dataset.export); if (w) exportStatus(w); });
    listEl.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { if (!confirm("이 상태창을 삭제할까요?")) return; const id = b.dataset.del; config.statuses = config.statuses.filter((x) => x.id !== id); if (config.activeId === id) config.activeId = config.statuses[0]?.id || null; for (const k of Object.keys(config.perChat)) if (config.perChat[k] === id) delete config.perChat[k]; saveConfig(); refresh(); });
    const othersBox = listEl.querySelector("#us-others-box");
    if (othersBox) {
      listEl.querySelector("#us-others-fold").onclick = () => {
        othersBoxOpen = !othersBoxOpen;
        othersBox.classList.toggle("open", othersBoxOpen);
        const listDiv = listEl.querySelector("#us-others-list");
        listDiv.style.display = othersBoxOpen ? "" : "none";
        listEl.querySelector("#us-others-fold").textContent = `${othersBoxOpen ? "▾" : "▸"} 다른 상태창 (${others.length}개)`;
      };
      // ── 드래그로 순서 변경 (⠿ 그립) ──
      //   '다른 상태창' 목록 안에서 행을 잡아 옮기면 config.statuses 순서에 반영된다.
      //   현재 적용 중인 스킨(맨 위 카드)은 목록 로직상 항상 최상단에 고정 표시되므로 제외.
      //   커밋 순서 = [적용 중 스킨, ...드래그 후 나머지 순서] — 화면에 보이는 그대로 저장.
      const olist = listEl.querySelector("#us-others-list");
      if (olist) {
        olist.querySelectorAll(".us-manager-item[data-wid]").forEach((row) => {
          row._usStatus = config.statuses.find((x) => x.id === row.dataset.wid) || null;
          const grip = row.querySelector("[data-wgrip]");
          if (!grip || !row._usStatus) return;
          grip.style.cursor = "grab";
          grip.style.touchAction = "none";
          let downXY = null, dragging = false;
          const onMove = (e) => {
            if (!downXY) return;
            const p = "touches" in e ? e.touches[0] : e;
            if (!dragging && (Math.abs(p.clientX - downXY.x) > 5 || Math.abs(p.clientY - downXY.y) > 5)) {
              dragging = true;
              row.style.opacity = "0.55";
              row.style.boxShadow = "0 4px 14px rgba(0,0,0,.4)";
              row.style.position = "relative";
              row.style.zIndex = "5";
              grip.style.cursor = "grabbing";
            }
            if (!dragging) return;
            if (e.cancelable) e.preventDefault();
            const py = p.clientY;
            const siblings = Array.from(olist.querySelectorAll(".us-manager-item[data-wid]")).filter((c) => c !== row);
            let target = null;
            for (const sib of siblings) {
              const r = sib.getBoundingClientRect();
              if (py < r.top + r.height / 2) { target = sib; break; }
            }
            if (target) olist.insertBefore(row, target); else olist.appendChild(row);
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("touchmove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("touchend", onUp);
            window.removeEventListener("touchcancel", onUp);
            if (dragging) {
              const orderedOthers = Array.from(olist.querySelectorAll(".us-manager-item[data-wid]"))
                .map((r) => r._usStatus).filter(Boolean);
              if (orderedOthers.length === others.length) {
                config.statuses = [primary, ...orderedOthers];
                saveConfig();
              }
              refresh();
            }
            downXY = null; dragging = false;
          };
          const onDown = (e) => {
            const p = "touches" in e ? e.touches[0] : e;
            downXY = { x: p.clientX, y: p.clientY };
            dragging = false;
            if (e.type === "mousedown" && e.cancelable) e.preventDefault(); // 텍스트 선택 방지
            window.addEventListener("mousemove", onMove);
            window.addEventListener("touchmove", onMove, { passive: false });
            window.addEventListener("mouseup", onUp);
            window.addEventListener("touchend", onUp);
            window.addEventListener("touchcancel", onUp);
          };
          grip.addEventListener("mousedown", onDown);
          grip.addEventListener("touchstart", onDown, { passive: true });
        });
      }
    }
  }

  // ── 편집기 ──
  function openEditor(id) {
    const editing = id ? config.statuses.find((w) => w.id === id) : null;
    const draft = editing ? clone(editing) : { id: uid(), name: "새 상태창", fields: [{ key: "", instruction: "" }], sceneFields: [], template: "", css: "", sceneTemplate: "", sceneCss: "", tabTemplate: DEFAULT_TAB_TEMPLATE, tabCss: "", sceneButtonTemplate: DEFAULT_SCENE_BUTTON_TEMPLATE, sceneButtonCss: "", sceneDefaultCollapsed: false, instructions: "", windowCss: "", windowCssMode: "marinara" };
    if (!draft.fields.length) draft.fields = [{ key: "", instruction: "" }];
    if (!Array.isArray(draft.sceneFields)) draft.sceneFields = [];
    if (!Array.isArray(draft.folds)) draft.folds = [];
    if (!Array.isArray(draft.sceneFolds)) draft.sceneFolds = [];
    // 편집 시작 시점의 필드 키 — 저장 때 삭제된 필드를 감지해 템플릿에서 해당 row 를 제거하는 데 사용
    const originalFieldKeys = (editing ? (editing.fields || []) : []).map((f) => (f.key || "").toString().trim()).filter(Boolean);
    const originalSceneKeys = (editing ? (editing.sceneFields || []) : []).map((f) => (f.key || "").toString().trim()).filter(Boolean);
    if (typeof draft.tabTemplate !== "string") draft.tabTemplate = DEFAULT_TAB_TEMPLATE;
    if (typeof draft.tabCss !== "string") draft.tabCss = "";
    if (typeof draft.sceneButtonTemplate !== "string") draft.sceneButtonTemplate = DEFAULT_SCENE_BUTTON_TEMPLATE;
    if (typeof draft.sceneButtonCss !== "string") draft.sceneButtonCss = "";
    if (typeof draft.sceneDefaultCollapsed !== "boolean") draft.sceneDefaultCollapsed = false;
    if (typeof draft.instructions !== "string") draft.instructions = "";
    if (typeof draft.windowCss !== "string") draft.windowCss = "";
    if (draft.windowCssMode !== "custom" && draft.windowCssMode !== "marinara") draft.windowCssMode = "marinara";
    const sceneOn = draft.sceneFields.length > 0;
    // 캐릭터 필드 사용 여부 — 저장된 스킨에 유효한 캐릭터 필드가 하나도 없으면(장면 전용) OFF 로 시작.
    //   새 스킨은 기본 ON. 장면 전용으로 저장하며 백업해 둔 필드가 있으면 편집칸에 복원해
    //   토글만 다시 켜면 그대로 되살아난다 (껐다 켜도 필드값이 날아가지 않게).
    const charOn = editing ? (editing.fields || []).some((f) => (f.key || "").toString().trim()) : true;
    if (!charOn && Array.isArray(draft.charFieldsBackup) && draft.charFieldsBackup.length) {
      draft.fields = clone(draft.charFieldsBackup);
    }
    if (!Array.isArray(draft.charFieldsBackup)) draft.charFieldsBackup = [];
    const o = overlay(MODAL_ID, `
      <div class="us-h"><span class="us-head-icon">${ICON.settings}</span><h2>유저 상태창</h2><button class="us-x" id="e-close" aria-label="닫기">${ICON.close}</button></div>
      <div class="us-ptabs">
        <button type="button" class="us-ptab on" data-etab="form">칸 입력</button>
        <button type="button" class="us-ptab" data-etab="json">JSON</button>
      </div>
      <div id="e-json-pane" style="display:none;">
        <div class="us-note" style="margin:0 0 6px;">이 상태창 전체가 담긴 JSON입니다. 고친 뒤 <b>칸 입력</b> 탭으로 돌아가거나 저장하면 그대로 반영됩니다. (형식이 잘못되면 저장되지 않습니다)</div>
        <textarea class="us-ta" id="e-json" spellcheck="false" style="min-height:200px;"></textarea>
      </div>
      <div id="e-form">
      <div class="us-row"><input class="us-input" id="e-name" value="${escAttr(draft.name)}" placeholder="디자인 이름(스킨) — 목록·팝업 제목에만 사용"/></div>
      <div class="us-row" style="margin-top:6px;"><textarea class="us-input" id="e-desc" rows="2" placeholder="설명 (선택) — 목록에서 이름을 누르면 보입니다" style="resize:vertical;font-family:inherit;line-height:1.5;">${esc(draft.description || "")}</textarea></div>
      <div class="us-row" style="align-items:center;gap:8px;margin-top:6px;">
        <span style="flex:none;font-size:12px;color:var(--muted-foreground,#999);">ID</span>
        <input class="us-input" id="e-id" value="${escAttr(draft.id || "")}" placeholder="고유 ID — 내보내기·채팅 적용에서 이 상태창을 가리키는 값" style="font-family:ui-monospace,Menlo,monospace;"/>
      </div>
      <div class="us-note" style="margin-top:4px;">ID를 바꾸면 이 상태창을 쓰던 채팅 설정도 함께 옮겨집니다. 다른 상태창과 겹칠 수 없습니다.</div>

      <!-- 장면 필드 -->
      <div class="us-sec">
        <div class="us-row" style="align-items:center;gap:8px;">
          <label class="us-switch"><input type="checkbox" id="e-scene-on" ${sceneOn ? "checked" : ""}/><span class="us-track"></span></label>
          <h3 style="margin:0;">장면(공유) 필드</h3>
        </div>
        <div id="e-scene-body" style="${sceneOn ? "" : "display:none;"}">
          <div class="us-note" style="margin-top:6px;margin-bottom:8px;">캐릭터별 반복이 아닌 채팅 공통 장면 띠에 사용할 필드입니다.</div>
          <div id="e-scene-fields"></div>
          <div class="us-addrow">
            <button class="us-btn sm" id="e-addscenefold" title="아래 장면 필드들을 묶어 접을 수 있는 구분선">＋ 접기</button>
            <button class="us-btn sm" id="e-addscene">＋ 장면 필드</button>
            <span class="us-addrow-gap" aria-hidden="true">${ICON.trash}</span>
          </div>
          <div style="margin-top:10px;">
            <label class="us-toggle" id="e-scene-collapsed-wrap"><input type="checkbox" id="e-scene-default-collapsed" ${draft.sceneDefaultCollapsed ? "checked" : ""}/> 장면 띠 기본 접힘<span class="us-note us-note-inline">처음 표시할 때 접힌 상태로 시작합니다. 채팅별로 기억됩니다.</span></label>
          </div>
          <details class="us-det"><summary>장면 띠 HTML</summary>
            <textarea class="us-ta" id="e-scene-tpl" placeholder="&lt;div&gt;🕒 {{시간}} · 📍 {{장소}}&lt;/div&gt;">${esc(draft.sceneTemplate || "")}</textarea>
          </details>
          <details class="us-det"><summary>장면 띠 CSS</summary>
            <textarea class="us-ta" id="e-scene-css" placeholder=".scene{width:100%;box-sizing:border-box}">${esc(draft.sceneCss || "")}</textarea>
          </details>
        </div>
      </div>

      <!-- 캐릭터 필드 -->
      <div class="us-sec">
        <div class="us-row" style="align-items:center;gap:8px;">
          <label class="us-switch"><input type="checkbox" id="e-char-on" ${charOn ? "checked" : ""}/><span class="us-track"></span></label>
          <h3 style="margin:0;">캐릭터 필드</h3>
        </div>
        <div id="e-char-body" style="${charOn ? "" : "display:none;"}">
          <div class="us-note" style="margin-top:6px;margin-bottom:8px;">왼쪽: 표시 이름 · 오른쪽: AI 가 그 값을 어떤 기준/형식으로 출력할지. 템플릿의 <code>{{이름}}</code>은 대상 이름으로 치환됩니다.</div>
          <div id="e-fields"></div>
          <div class="us-addrow">
            <button class="us-btn sm" id="e-addfold" title="아래 상태값들을 묶어 접을 수 있는 구분선">＋ 접기</button>
            <button class="us-btn sm" id="e-addfield">＋ 상태값</button>
            <span class="us-addrow-gap" aria-hidden="true">${ICON.trash}</span>
          </div>
          <div style="margin-top:10px;">
            <label class="us-toggle" style="display:flex;align-items:center;gap:8px;">캐릭터 접기 버튼
              <select class="us-sel" id="e-char-collapse-mode" style="max-width:180px;">
                <option value="global" ${draft.charCollapseMode !== "on" && draft.charCollapseMode !== "off" ? "selected" : ""}>전역 설정 따름</option>
                <option value="on" ${draft.charCollapseMode === "on" ? "selected" : ""}>이 스킨은 항상 표시</option>
                <option value="off" ${draft.charCollapseMode === "off" ? "selected" : ""}>이 스킨은 항상 숨김</option>
              </select>
            </label>
          </div>
        </div>
        <div class="us-note" id="e-char-off-note" style="${charOn ? "display:none;" : ""}margin-top:6px;">끄면 캐릭터 없이 <b>장면 띠만</b> 표시하는 스킨이 됩니다. (장면 필드가 1개 이상 필요)</div>
      </div>

      <!-- 값 표시 방식 -->
      <div class="us-sec">
        <h3 style="margin:0 0 6px;">값 표시 방식</h3>
        <div class="us-note" style="margin:0 0 8px;">AI가 채운 <b>값</b>을 그릴 때만 적용됩니다. 캐릭터 값과 장면 값에 함께 적용되며, 템플릿(HTML)에는 영향이 없습니다.</div>
        <label class="us-toggle" style="display:flex;align-items:center;gap:8px;">값 안의 줄바꿈
          <select class="us-sel" id="e-value-linebreaks" style="max-width:200px;">
            <option value="off" ${draft.valueLineBreaks !== "br" && draft.valueLineBreaks !== "div" ? "selected" : ""}>무시 (기본)</option>
            <option value="br" ${draft.valueLineBreaks === "br" ? "selected" : ""}>줄 바꿔 표시 &lt;br&gt;</option>
            <option value="div" ${draft.valueLineBreaks === "div" ? "selected" : ""}>줄마다 블록 .us-vline</option>
          </select>
        </label>
        <div class="us-note">여러 줄로 들어온 값(목록 등)을 줄 그대로 보여줍니다. <code>.us-vline</code>은 카드 CSS에서 꾸밀 수 있습니다.</div>
        <div style="margin-top:10px;">
          <label class="us-toggle"><input type="checkbox" id="e-value-html" ${draft.valueHtml ? "checked" : ""}/> 값 안의 간단한 서식 태그 허용</label>
          <div class="us-note">기울임·굵게 같은 태그만 살려서 그립니다: <code>i em b strong small u s del ins code mark sub sup span br</code>. 그 외 태그와 <code>on…</code> 속성은 글자로만 보입니다(<code>class</code>만 허용).</div>
        </div>
      </div>

      <!-- 콘텐츠 HTML / CSS -->
      <div class="us-sec" id="e-content-sec" style="${charOn ? "" : "display:none;"}">
        <details class="us-det"><summary>콘텐츠 (HTML)</summary>
          <div class="us-note us-det-note"><code>{{상태값}}</code>로 값, <code>{{이름}}</code>로 대상 이름. 표시 영역: <b>최대 폭 약 ${DESIGN_MAX_W}px · 최대 높이 ${BODY_MAX_H}px</b>.<br/>상태값을 추가하면 저장할 때 HTML에 자동으로 한 줄씩 등록됩니다.</div>
          <textarea class="us-ta" id="e-tpl" placeholder="&lt;div&gt;{{이름}} 💗 {{호감도}}&lt;/div&gt;">${esc(draft.template)}</textarea>
        </details>
        <details class="us-det"><summary>CSS (선택)</summary>
          <div class="us-note us-det-note">Shadow DOM 격리. 카드는 <code>width:100%;box-sizing:border-box</code>로 두면 플로팅 폭에 꽉 찹니다.</div>
          <textarea class="us-ta" id="e-css" placeholder=".card{width:100%;box-sizing:border-box}">${esc(draft.css)}</textarea>
        </details>
      </div>

      <!-- 연속성 규칙 -->
      <div class="us-sec">
        <details class="us-det"><summary>연속성·작성 규칙 (선택)</summary>
          <div class="us-note us-det-note">이 상태창 값을 만들 때 AI가 지킬 규칙. 비워두면 공용 기본 규칙을 사용합니다. (영어 권장)</div>
          <textarea class="us-ta" id="e-instr" style="min-height:90px;white-space:pre-wrap;" placeholder="예: Keep affinity within ±10 of its previous value.">${esc(draft.instructions || "")}</textarea>
        </details>
      </div>

      <!-- 윈도우 CSS (이 상태창 전용) -->
      <div class="us-sec">
        <details class="us-det"><summary>윈도우 디자인 CSS</summary>
          <div style="padding:0 12px 8px;">
            <div class="us-note" style="margin:0 0 8px;">마리나라 기본 스타일을 따르거나, 아래 CSS를 직접 입력해 이 상태창 전용 윈도우 디자인을 적용합니다.<br/>@import / url() 은 보안상 제거됩니다.</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;">
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;"><input type="radio" name="e-winmode" value="marinara" ${draft.windowCssMode !== "custom" ? "checked" : ""}/> 마리나라 기본</label>
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;"><input type="radio" name="e-winmode" value="custom" ${draft.windowCssMode === "custom" ? "checked" : ""}/> 직접 입력</label>
            </div>
          </div>
          <div id="e-wincss-wrap" style="${draft.windowCssMode === "custom" ? "" : "display:none;"}">
            <textarea class="us-ta" id="e-wincss" placeholder="/* 예시 — 플로팅 창 */\n#us-float { background: #1a1a2e; border-color: #444; border-radius: 14px; }\n#us-float .us-f-title { color: #aabbff; }\n/* 설정·편집기 창 */\n.us-box { background: #1a1a2e; border-color: #444; color: #eee; }">${esc(draft.windowCss || "")}</textarea>
          </div>
        </details>
      </div>

      </div><!-- /#e-form -->

      <div class="us-foot">
        <button class="us-btn" id="e-preview-btn"><span class="us-btn-icon">${ICON.search}</span>미리보기</button>
        <button class="us-btn" id="e-cancel">취소</button>
        <button class="us-btn primary" id="e-save">저장</button>
      </div>`);
    const $ = (q) => o.querySelector(q);
    // 필드 행 드래그 정렬: 핸들(⠿)을 잡으면 '실제 행'이 즉시 따라 움직이고, 놓는 순간 arr 에 확정된다.
    //   (예전 HTML5 드래그는 브라우저 고스트(반투명)만 움직이고 원본 행은 제자리 + 드롭 표시선이
    //    캐릭터/장면 다른 목록에도 떠서 헷갈렸다 → 탭 순서 변경과 같은 포인터 방식으로 통일)
    //   각 목록(wrap) 안에서만 이동 — 캐릭터↔장면 목록 간 이동은 없다.
    function wireFieldReorder(wrap, arr, rerender) {
      wrap.querySelectorAll(".us-field-drag").forEach((row) => {
        row.draggable = false; // HTML5 DnD 미사용
        row._usField = arr[+row.dataset.fi]; // DOM 순서가 바뀌어도 데이터 항목을 추적
        const handle = row.querySelector(".us-drag-handle");
        if (!handle || !row._usField) return;
        handle.style.cursor = "grab";
        handle.style.touchAction = "none";
        let downXY = null, dragging = false, grabOffsetY = 0, grabOffsetX = 0, lastX = 0;
        // 잡은 행을 포인터에 붙여 따라오게 한다.
        //   transform 을 잠깐 지우고 실제 배치 위치를 다시 재기 때문에, 중간에 DOM 순서가
        //   바뀌어도 기준점이 자동으로 갱신된다(재정렬 직후 행이 튀지 않음).
        const follow = (clientX, clientY) => {
          row.style.transform = "none";
          const r = row.getBoundingClientRect();
          row.style.transform = `translate(${clientX - (r.left + grabOffsetX)}px, ${clientY - (r.top + grabOffsetY)}px)`;
        };
        // 왼쪽으로 충분히 끌면 '그룹 밖으로 빼기'. 접기 그룹은 마커 이후의 행들을 묶는
        //   구조라, 세로 이동만으로는 그룹 밖 자리를 겨냥하기 어렵다(그룹 앞이 비어 있으면
        //   조준할 여백 자체가 없다). 아웃라이너처럼 가로 제스처로 그룹 밖으로 빼 준다.
        const OUTDENT_PX = 28;
        const willOutdent = () => !row._usField.fold && (lastX - downXY.x) <= -OUTDENT_PX;
        const onMove = (e) => {
          if (!downXY) return;
          const p = "touches" in e ? e.touches[0] : e;
          if (!dragging && (Math.abs(p.clientX - downXY.x) > 5 || Math.abs(p.clientY - downXY.y) > 5)) {
            dragging = true;
            row.style.opacity = "0.55";
            row.style.boxShadow = "0 4px 14px rgba(0,0,0,.4)";
            row.style.position = "relative";
            row.style.zIndex = "5";
            row.style.pointerEvents = "none"; // 자기 자신이 드롭 판정을 가리지 않게
            handle.style.cursor = "grabbing";
            document.body.style.userSelect = "none";
          }
          if (!dragging) return;
          if (e.cancelable) e.preventDefault();
          const py = p.clientY;
          const siblings = Array.from(wrap.querySelectorAll(".us-field-drag")).filter((c) => c !== row);
          let target = null;
          for (const sib of siblings) {
            const r = sib.getBoundingClientRect();
            if (!r.height) continue;               // 접힌 그룹 안의 숨은 행은 판정에서 제외
            if (py < r.top + r.height / 2) { target = sib; break; }
          }
          if (target) { if (row.nextSibling !== target) wrap.insertBefore(row, target); }
          else if (wrap.lastElementChild !== row) wrap.appendChild(row);
          lastX = p.clientX;
          row.classList.toggle("us-field-outdent", willOutdent());
          follow(p.clientX, py);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("touchmove", onMove);
          window.removeEventListener("mouseup", onUp);
          window.removeEventListener("touchend", onUp);
          window.removeEventListener("touchcancel", onUp);
          row.style.transform = "";
          row.style.pointerEvents = "";
          row.classList.remove("us-field-outdent");
          document.body.style.userSelect = "";
          if (dragging) {
            const next = Array.from(wrap.querySelectorAll(".us-field-drag")).map((r) => r._usField).filter(Boolean);
            if (next.length === arr.length) {
              if (willOutdent()) {
                // '그룹 밖'은 첫 마커보다 앞쪽 구간 하나뿐이다(그 뒤는 전부 어느 그룹엔가 속한다).
                //   그래서 왼쪽으로 빼면 첫 마커 바로 앞, 즉 그룹에 속하지 않는 자리로 옮긴다.
                const at = next.indexOf(row._usField);
                const firstMarker = next.findIndex((it) => it && it.fold);
                if (firstMarker >= 0 && at > firstMarker) {
                  next.splice(at, 1);
                  next.splice(firstMarker, 0, row._usField);
                }
              }
              arr.length = 0; arr.push(...next); // 참조 유지한 채 제자리 정렬
            }
            rerender();
          }
          downXY = null; dragging = false;
        };
        const onDown = (e) => {
          const p = "touches" in e ? e.touches[0] : e;
          downXY = { x: p.clientX, y: p.clientY };
          const rect0 = row.getBoundingClientRect();
          grabOffsetY = p.clientY - rect0.top;   // 잡은 지점이 행 안 어디인지
          grabOffsetX = p.clientX - rect0.left;
          lastX = p.clientX;
          dragging = false;
          e.stopPropagation(); // 핸들을 잡은 동안에는 상위(스크롤·창 이동)로 넘기지 않는다
          if (e.type === "mousedown" && e.cancelable) e.preventDefault(); // 드래그 중 텍스트 선택 방지
          window.addEventListener("mousemove", onMove);
          window.addEventListener("touchmove", onMove, { passive: false });
          window.addEventListener("mouseup", onUp);
          window.addEventListener("touchend", onUp);
          window.addEventListener("touchcancel", onUp);
        };
        handle.addEventListener("mousedown", onDown);
        handle.addEventListener("touchstart", onDown, { passive: true });
      });
    }
    // 상태값 목록은 '상태값 행 + 접기 마커 행'을 한 배열(fieldItems)로 다룬다.
    //   드래그 정렬이 마커까지 함께 옮기므로, 마커를 끌어 올리면 묶이는 범위도 그대로 바뀐다.
    //   저장 직전(syncFieldItems)에 순수 값 목록(draft.fields)과 마커 위치(draft.folds)로 되돌린다.
    let fieldItems = buildFieldItems(draft.fields, draft.folds);
    const foldOpenInEditor = {}; // 마커 행 인덱스가 아닌 '이름' 기준 — 재렌더돼도 접힘 상태 유지
    function syncFieldItems() {
      draft.fields = fieldItems.filter((it) => !it.fold).map((it) => ({ key: it.key || "", instruction: it.instruction || "" }));
      const folds = []; let n = 0;
      fieldItems.forEach((it) => { if (it.fold) folds.push({ name: (it.name || "").toString(), at: n }); else n++; });
      draft.folds = folds.filter((g) => g.name.trim());
    }
    function foldKeyOf(item, idx) { return (item.name || "").trim() || `__fold${idx}`; }
    function renderFields() {
      const wrap = $("#e-fields");
      let curFold = null; // 지금 열려 있는 그룹의 키 (null = 그룹 밖)
      wrap.innerHTML = fieldItems.map((f, i) => {
        if (f.fold) {
          curFold = foldKeyOf(f, i);
          const open = foldOpenInEditor[curFold] === true; // 편집기도 기본 접힘 (값 수정 화면과 동일)
          return `
        <div class="us-field us-field-drag us-fold-row" draggable="true" data-fi="${i}" data-foldkey="${escAttr(curFold)}">
          <span class="us-drag-handle" title="드래그하여 순서 변경" aria-label="순서 변경 핸들">${ICON.grip}</span>
          <button type="button" class="us-fold-caret" data-fc="${i}" title="접기/펼치기" aria-label="접기/펼치기">${open ? "▾" : "▸"}</button>
          <input class="us-input" data-fn="${i}" value="${escAttr(f.name || "")}" placeholder="접기 그룹 이름 (예: 신체 상태)"/>
          <button class="us-iconbtn" data-rm="${i}" title="이 접기 삭제" aria-label="이 접기 삭제">${ICON.trash}</button>
        </div>`;
        }
        // ⚠ 위 open 판정(=== true, 기본 접힘)과 반드시 같은 기준이어야 한다.
        //   예전엔 여기만 === false 라서 '기본 접힘인데 행은 보이는' 상태가 됐고,
        //   그 탓에 한 번 클릭해도 안 접히는 것처럼 보였다(두 번 눌러야 반영).
        const hidden = curFold && foldOpenInEditor[curFold] !== true;
        return `
        <div class="us-field us-field-drag${curFold ? " us-field-row-in-fold" : ""}" draggable="true" data-fi="${i}"${hidden ? ' style="display:none;"' : ""}>
          <span class="us-drag-handle" title="드래그하여 순서 변경" aria-label="순서 변경 핸들">${ICON.grip}</span>
          <input class="us-input" data-k="${i}" value="${escAttr(f.key)}" placeholder="상태값"/>
          <input class="us-input" data-ins="${i}" value="${escAttr(f.instruction)}" placeholder="지시사항"/>
          <button class="us-iconbtn" data-rm="${i}" title="삭제" aria-label="삭제">${ICON.trash}</button>
        </div>`;
      }).join("");
      wrap.querySelectorAll("[data-k]").forEach((el) => el.oninput = () => { fieldItems[+el.dataset.k].key = el.value; syncFieldItems(); });
      wrap.querySelectorAll("[data-ins]").forEach((el) => el.oninput = () => { fieldItems[+el.dataset.ins].instruction = el.value; syncFieldItems(); });
      wrap.querySelectorAll("[data-fn]").forEach((el) => el.oninput = () => { fieldItems[+el.dataset.fn].name = el.value; syncFieldItems(); });
      wrap.querySelectorAll("[data-fc]").forEach((el) => el.onclick = (e) => {
        e.preventDefault();
        const i = +el.dataset.fc; const k = foldKeyOf(fieldItems[i], i);
        foldOpenInEditor[k] = foldOpenInEditor[k] !== true;
        renderFields();
      });
      wrap.querySelectorAll("[data-rm]").forEach((el) => el.onclick = () => {
        fieldItems.splice(+el.dataset.rm, 1);
        if (!fieldItems.some((it) => !it.fold)) fieldItems.push({ key: "", instruction: "" });
        syncFieldItems(); renderFields();
      });
      wireFieldReorder(wrap, fieldItems, () => { syncFieldItems(); renderFields(); });
      syncFieldItems();
    }
    // 장면 필드도 상태값과 같은 방식(마커 + 값 행을 한 배열로)으로 다룬다.
    let sceneItems = buildFieldItems(draft.sceneFields, draft.sceneFolds);
    const sceneFoldOpenInEditor = {};
    function syncSceneItems() {
      draft.sceneFields = sceneItems.filter((it) => !it.fold).map((it) => ({ key: it.key || "", instruction: it.instruction || "" }));
      const folds = []; let n = 0;
      sceneItems.forEach((it) => { if (it.fold) folds.push({ name: (it.name || "").toString(), at: n }); else n++; });
      draft.sceneFolds = folds.filter((g) => g.name.trim());
    }
    function renderSceneFields() {
      const wrap = $("#e-scene-fields");
      let curFold = null;
      wrap.innerHTML = sceneItems.map((f, i) => {
        if (f.fold) {
          curFold = foldKeyOf(f, i);
          const open = sceneFoldOpenInEditor[curFold] === true; // 기본 접힘
          return `
        <div class="us-field us-field-drag us-fold-row" draggable="true" data-fi="${i}">
          <span class="us-drag-handle" title="드래그하여 순서 변경" aria-label="순서 변경 핸들">${ICON.grip}</span>
          <button type="button" class="us-fold-caret" data-sfc="${i}" title="접기/펼치기" aria-label="접기/펼치기">${open ? "▾" : "▸"}</button>
          <input class="us-input" data-sfn="${i}" value="${escAttr(f.name || "")}" placeholder="접기 그룹 이름 (예: 시간·장소)"/>
          <button class="us-iconbtn" data-srm="${i}" title="이 접기 삭제" aria-label="이 접기 삭제">${ICON.trash}</button>
        </div>`;
        }
        const hidden = curFold && sceneFoldOpenInEditor[curFold] !== true;
        return `
        <div class="us-field us-field-drag${curFold ? " us-field-row-in-fold" : ""}" draggable="true" data-fi="${i}"${hidden ? ' style="display:none;"' : ""}>
          <span class="us-drag-handle" title="드래그하여 순서 변경" aria-label="순서 변경 핸들">${ICON.grip}</span>
          <input class="us-input" data-sk="${i}" value="${escAttr(f.key)}" placeholder="장면 필드"/>
          <input class="us-input" data-sins="${i}" value="${escAttr(f.instruction)}" placeholder="지시사항"/>
          <button class="us-iconbtn" data-srm="${i}" title="삭제" aria-label="삭제">${ICON.trash}</button>
        </div>`;
      }).join("");
      wrap.querySelectorAll("[data-sk]").forEach((el) => el.oninput = () => { sceneItems[+el.dataset.sk].key = el.value; syncSceneItems(); });
      wrap.querySelectorAll("[data-sins]").forEach((el) => el.oninput = () => { sceneItems[+el.dataset.sins].instruction = el.value; syncSceneItems(); });
      wrap.querySelectorAll("[data-sfn]").forEach((el) => el.oninput = () => { sceneItems[+el.dataset.sfn].name = el.value; syncSceneItems(); });
      wrap.querySelectorAll("[data-sfc]").forEach((el) => el.onclick = (e) => {
        e.preventDefault();
        const i = +el.dataset.sfc; const k = foldKeyOf(sceneItems[i], i);
        sceneFoldOpenInEditor[k] = sceneFoldOpenInEditor[k] !== true;
        renderSceneFields();
      });
      wrap.querySelectorAll("[data-srm]").forEach((el) => el.onclick = () => { sceneItems.splice(+el.dataset.srm, 1); syncSceneItems(); renderSceneFields(); });
      wireFieldReorder(wrap, sceneItems, () => { syncSceneItems(); renderSceneFields(); });
      syncSceneItems();
      updateSceneCollapseControl();
    }
    function updateSceneCollapseControl() {
      const cb = $("#e-scene-default-collapsed");
      const hasSceneFields = (draft.sceneFields || []).some((f) => (f.key || "").toString().trim());
      cb.disabled = !hasSceneFields;
      cb.setAttribute("aria-disabled", String(!hasSceneFields));
      const wrap = $("#e-scene-collapsed-wrap");
      if (wrap) wrap.style.opacity = hasSceneFields ? "1" : ".6";
    }
    function collectDraft() {
      draft.template = $("#e-tpl").value; draft.css = $("#e-css").value;
      draft.sceneTemplate = $("#e-scene-tpl").value; draft.sceneCss = $("#e-scene-css").value;
      draft.sceneDefaultCollapsed = $("#e-scene-default-collapsed").checked;
      const ccSel = $("#e-char-collapse-mode");
      if (ccSel) draft.charCollapseMode = ccSel.value;
      draft.instructions = $("#e-instr").value;
      const vlb = $("#e-value-linebreaks"); if (vlb) draft.valueLineBreaks = vlb.value;
      const vht = $("#e-value-html"); if (vht) draft.valueHtml = vht.checked;
      draft.windowCssMode = o.querySelector('input[name="e-winmode"]:checked')?.value || "marinara";
      draft.windowCss = $("#e-wincss").value || "";
    }
    renderFields(); renderSceneFields();
    // Character fields toggle — OFF 이면 장면 전용 스킨(저장 시 fields=[])
    $("#e-char-on").onchange = (e) => {
      const on = e.target.checked;
      $("#e-char-body").style.display = on ? "" : "none";
      $("#e-content-sec").style.display = on ? "" : "none";
      const offNote = $("#e-char-off-note"); if (offNote) offNote.style.display = on ? "none" : "";
      if (on && !fieldItems.some((it) => !it.fold)) { fieldItems.push({ key: "", instruction: "" }); renderFields(); }
      // 장면 전용으로 전환하면서 장면 필드가 아직 없으면 장면 섹션을 자동으로 켜준다.
      if (!on && !$("#e-scene-on").checked) {
        $("#e-scene-on").checked = true;
        $("#e-scene-body").style.display = "";
        if (!sceneItems.some((it) => !it.fold)) { sceneItems.push({ key: "", instruction: "" }); renderSceneFields(); }
      }
    };
    // Scene toggle
    $("#e-scene-on").onchange = (e) => {
      const body = $("#e-scene-body");
      body.style.display = e.target.checked ? "" : "none";
      if (e.target.checked && !sceneItems.some((it) => !it.fold)) { sceneItems.push({ key: "", instruction: "" }); renderSceneFields(); }
    };
    $("#e-addfield").onclick = () => { fieldItems.push({ key: "", instruction: "" }); renderFields(); };
    $("#e-addfold").onclick = () => { fieldItems.push({ fold: true, name: "" }); renderFields(); };
    $("#e-addscene").onclick = () => { sceneItems.push({ key: "", instruction: "" }); renderSceneFields(); };
    $("#e-addscenefold").onclick = () => { sceneItems.push({ fold: true, name: "" }); renderSceneFields(); };
    o.querySelectorAll('input[name="e-winmode"]').forEach((r) => r.onchange = (e) => {
      const isCustom = e.target.value === "custom";
      $("#e-wincss-wrap").style.display = isCustom ? "" : "none";
      // 직접 입력으로 전환할 때 초기값이 없으면 draft.windowCss로 채움
      if (isCustom && draft.windowCss && !$("#e-wincss").value.trim()) {
        $("#e-wincss").value = draft.windowCss;
      }
    });
    $("#e-name").oninput = () => { draft.name = $("#e-name").value; };
    $("#e-desc").oninput = () => { draft.description = $("#e-desc").value; };

    // ── 칸 입력 ↔ JSON 탭 ───────────────────────────────────
    //   JSON 은 이 상태창 전체(스킨 정의)를 그대로 담는다. 탭을 옮기거나 저장할 때
    //   양쪽을 맞춰 주므로, 어느 쪽에서 고쳐도 마지막 내용이 남는다.
    let editTab = "form";
    function draftFromForm() {
      collectDraft();
      draft.name = $("#e-name").value;
      draft.description = $("#e-desc").value;
      draft.id = ($("#e-id").value || "").trim() || draft.id;
      // 토글 상태도 JSON 에 그대로 반영 (캐릭터/장면 끄기 = 해당 필드 비움)
      const out = clone(draft);
      if (!$("#e-scene-on").checked) { out.sceneFields = []; out.sceneFolds = []; }
      if (!$("#e-char-on").checked) { out.fields = []; out.folds = []; }
      return normalizeStatus(out);
    }
    function fillFormFromDraft() {
      $("#e-name").value = draft.name || "";
      $("#e-desc").value = draft.description || "";
      $("#e-id").value = draft.id || "";
      $("#e-tpl").value = draft.template || "";
      $("#e-css").value = draft.css || "";
      $("#e-scene-tpl").value = draft.sceneTemplate || "";
      $("#e-scene-css").value = draft.sceneCss || "";
      $("#e-instr").value = draft.instructions || "";
      $("#e-wincss").value = draft.windowCss || "";
      $("#e-scene-default-collapsed").checked = !!draft.sceneDefaultCollapsed;
      const ccSel = $("#e-char-collapse-mode"); if (ccSel) ccSel.value = draft.charCollapseMode || "global";
      const vlb2 = $("#e-value-linebreaks"); if (vlb2) vlb2.value = draft.valueLineBreaks || "off";
      const vht2 = $("#e-value-html"); if (vht2) vht2.checked = !!draft.valueHtml;
      const isCustom = draft.windowCssMode === "custom";
      o.querySelectorAll('input[name="e-winmode"]').forEach((r) => { r.checked = (r.value === (isCustom ? "custom" : "marinara")); });
      $("#e-wincss-wrap").style.display = isCustom ? "" : "none";
      const sOn = (draft.sceneFields || []).length > 0;
      $("#e-scene-on").checked = sOn;
      $("#e-scene-body").style.display = sOn ? "" : "none";
      const cOn = (draft.fields || []).some((f) => (f.key || "").toString().trim());
      $("#e-char-on").checked = cOn;
      $("#e-char-body").style.display = cOn ? "" : "none";
      $("#e-content-sec").style.display = cOn ? "" : "none";
      const offNote = $("#e-char-off-note"); if (offNote) offNote.style.display = cOn ? "none" : "";
      if (!draft.fields.length) draft.fields = [{ key: "", instruction: "" }];
      fieldItems = buildFieldItems(draft.fields, draft.folds);
      sceneItems = buildFieldItems(draft.sceneFields, draft.sceneFolds);
      renderFields(); renderSceneFields();
    }
    // JSON 칸 → draft. 실패하면 false 를 돌려주고 탭을 옮기지 않는다.
    function applyJsonToDraft() {
      const raw = $("#e-json").value || "";
      let parsed = null;
      try { parsed = JSON.parse(raw); }
      catch (e) { alert("JSON 형식이 잘못되었습니다:\n" + ((e && e.message) || e)); return false; }
      const cand = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? (parsed.status || parsed.widget || parsed) : null;
      const clean = cand ? normalizeStatus(cand) : null;
      if (!clean) { alert("상태창 형식이 아닙니다. { name, fields, template … } 형태여야 합니다."); return false; }
      // charFieldsBackup 처럼 JSON 에 없을 수 있는 값은 기존 것을 유지
      const keepBackup = draft.charFieldsBackup;
      Object.assign(draft, clean);
      if (!Array.isArray(draft.charFieldsBackup) || !draft.charFieldsBackup.length) draft.charFieldsBackup = keepBackup || [];
      fillFormFromDraft();
      return true;
    }
    function setEditTab(tab) {
      if (tab === editTab) return;
      if (tab === "json") {
        // 탭을 옮겨도 창 크기가 흔들리지 않게, JSON 칸 높이를 '칸 입력' 화면 높이에 맞춘다.
        const formH = $("#e-form").offsetHeight;
        if (formH > 0) $("#e-json").style.height = Math.max(240, formH - 56) + "px";
        $("#e-json").value = JSON.stringify(draftFromForm(), null, 2);
      }
      else if (!applyJsonToDraft()) return;
      editTab = tab;
      $("#e-form").style.display = tab === "form" ? "" : "none";
      $("#e-json-pane").style.display = tab === "json" ? "" : "none";
      o.querySelectorAll("[data-etab]").forEach((b) => b.classList.toggle("on", b.dataset.etab === tab));
    }
    o.querySelectorAll("[data-etab]").forEach((b) => { b.onclick = () => setEditTab(b.dataset.etab); });
    $("#e-close").onclick = () => closeOverlay(MODAL_ID);
    $("#e-cancel").onclick = () => closeOverlay(MODAL_ID);
    $("#e-preview-btn").onclick = () => {
      if (editTab === "json" && !applyJsonToDraft()) return;
      collectDraft();
      // 미리보기는 스위치 상태를 그대로 반영 — 캐릭터/장면 토글이 꺼져 있으면 해당 영역 없이 렌더
      const pv = clone(draft);
      if (!$("#e-char-on").checked) pv.fields = [];
      if (!$("#e-scene-on").checked) pv.sceneFields = [];
      openPreviewPopup(pv);
    };

    // 추가된 필드 중 템플릿에 {{필드}} 플레이스홀더가 없는 것은 기본 row 를 자동으로 덧붙인다.
    // 마지막 </div> 안쪽(닫는 태그 직전)에 삽입해 카드 컨테이너 바깥으로 새는 것을 방지한다.
    function appendMissingFieldRows(template, fields, rowFn) {
      let out = template || "";
      const rows = [];
      for (const f of fields) {
        const key = (f.key || "").toString().trim();
        if (!key) continue;
        // 조건 블록({{#키}}…)으로만 쓰인 필드도 '이미 템플릿에 있음'으로 본다 — 중복 행 방지
        if (out.indexOf("{{" + key + "}}") !== -1) continue;
        if (new RegExp("\\{\\{\\s*[#^/]\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}\\}").test(out)) continue;
        rows.push(rowFn(key));
      }
      if (!rows.length) return out;
      const block = rows.join("\n");
      const lastClose = out.lastIndexOf("</div>");
      if (lastClose !== -1) {
        return out.slice(0, lastClose) + block + "\n" + out.slice(lastClose);
      }
      return out + (out && !/\n\s*$/.test(out) ? "\n" : "") + block;
    }
    // 삭제된 필드의 {{필드}} 가 들어간 row 를 템플릿에서 제거한다.
    function removeFieldRows(template, keys) {
      let out = template || "";
      const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const key of keys) {
        if (!key) continue;
        // 0) 이 필드를 조건으로 쓰던 블록은 내용까지 통째로 제거 (빈 껍데기 블록이 남지 않게)
        const k = escRe(key);
        out = out.replace(new RegExp("[ \\t]*\\{\\{\\s*[#^]\\s*" + k + "\\s*\\}\\}[\\s\\S]*?\\{\\{\\s*/\\s*" + k + "\\s*\\}\\}[ \\t]*\\n?", "g"), "");
        const ph = "{{" + key + "}}";
        if (out.indexOf(ph) === -1) continue;
        // 1) 플레이스홀더를 감싼 단일 div row(중첩 div 없음)를 통째로 제거
        const rowRe = new RegExp("[ \\t]*<div\\b[^>]*>(?:(?!</?div\\b)[\\s\\S])*?" + escRe(ph) + "(?:(?!</?div\\b)[\\s\\S])*?</div>[ \\t]*\\n?", "g");
        const before = out;
        out = out.replace(rowRe, "");
        // 2) div row 형태가 아니면 해당 플레이스홀더가 든 줄 제거
        if (out === before) {
          out = out.split("\n").filter((ln) => ln.indexOf(ph) === -1).join("\n");
        }
      }
      return out;
    }

    $("#e-save").onclick = () => {
      // JSON 탭에서 바로 저장하면 그 내용을 먼저 칸에 반영한다 (형식 오류면 저장 중단)
      if (editTab === "json" && !applyJsonToDraft()) return;
      collectDraft();
      draft.name = $("#e-name").value.trim() || "상태창";
      draft.description = $("#e-desc").value.trim();
      // sync scene fields from toggle state
      if (!$("#e-scene-on").checked) { draft.sceneFields = []; draft.sceneFolds = []; }
      // sync character fields from toggle state — OFF = 장면 전용 스킨
      const charFieldsOn = $("#e-char-on").checked;
      if (!charFieldsOn) {
        // 필드 정의를 지우지 않고 백업에 보존 — 토글을 다시 켜면 그대로 복원된다.
        const hasDefs = (draft.fields || []).some((f) => (f.key || "").toString().trim());
        if (hasDefs) draft.charFieldsBackup = clone(draft.fields);
        draft.fields = [];
        draft.folds = [];
      } else {
        draft.charFieldsBackup = []; // 실제 필드로 저장되므로 백업 불필요
      }
      // 삭제된 필드의 row 를 템플릿에서 제거
      const curFieldKeys = new Set(draft.fields.map((f) => (f.key || "").toString().trim()).filter(Boolean));
      const curSceneKeys = new Set(draft.sceneFields.map((f) => (f.key || "").toString().trim()).filter(Boolean));
      // 제거 대상 = (편집기 열 때 있던 키 ∪ 현재 템플릿에 {{}} 로 박혀있는 키) 중 현재 필드에 없는 것.
      //   originalFieldKeys 만 보면 "이번 세션에 추가→삭제한 필드"(자동 삽입됐다가 지워진 것)가
      //   누락돼 템플릿에 {{키}} row 가 남는 버그가 있었다. 템플릿 자체에서 스캔해 보강한다.
      // ⚠ 조건 블록 토큰({{#키}} {{^키}} {{/키}})은 '필드 키'가 아니다.
      //   걸러내지 않으면 "#부상" 같은 이름을 삭제된 필드로 오인해 저장할 때 블록이 뜯긴다.
      const placeholdersIn = (tpl) => {
        const set = new Set(); const re = /\{\{\s*([^}]+?)\s*\}\}/g; let m;
        while ((m = re.exec(tpl || "")) !== null) {
          const k = (m[1] || "").trim();
          if (!k || /^[#^/]/.test(k)) continue;
          set.add(k);
        }
        return set;
      };
      const tplFieldKeys = placeholdersIn(draft.template);
      const tplSceneKeys = placeholdersIn(draft.sceneTemplate);
      // 캐릭터 토글 OFF 저장 시엔 템플릿 row 를 지우지 않는다 — 필드가 백업으로 잠시 빠진 것일 뿐,
      //   토글을 다시 켰을 때 디자인(콘텐츠 HTML)도 그대로 되살아나야 하기 때문.
      const removedFieldKeys = charFieldsOn
        ? Array.from(new Set([...originalFieldKeys, ...tplFieldKeys])).filter((k) => !curFieldKeys.has(k))
        : [];
      const removedSceneKeys = Array.from(new Set([...originalSceneKeys, ...tplSceneKeys])).filter((k) => !curSceneKeys.has(k));
      if (removedFieldKeys.length) draft.template = removeFieldRows(draft.template, removedFieldKeys);
      if (removedSceneKeys.length) draft.sceneTemplate = removeFieldRows(draft.sceneTemplate, removedSceneKeys);
      // 필드 추가 시 템플릿에 누락된 {{필드}} 를 기본 클래스 row 로 자동 추가 (캐릭터 필드 사용 시에만)
      if (draft.fields.length) {
        draft.template = appendMissingFieldRows(draft.template, draft.fields,
          (key) => `<div class="row"><span class="lab">${key}</span><span class="val">{{${key}}}</span></div>`);
      }
      if (draft.sceneFields.length) {
        draft.sceneTemplate = appendMissingFieldRows(draft.sceneTemplate, draft.sceneFields,
          (key) => `<div class="sub">${key}: {{${key}}}</div>`);
      }
      // ── ID 변경 ──
      //   ID는 채팅별 적용·내보내기에서 이 상태창을 가리키는 고유 값. 바꾸면 이 ID를 쓰던
      //   설정(활성 스킨·채팅별 지정)을 새 ID로 옮긴다. 기록 항목은 스킨을 못 찾으면 채팅에
      //   적용된 스킨으로 되돌아가므로 그대로 표시된다.
      const prevId = draft.id;
      const newId = ($("#e-id").value || "").trim();
      if (!newId) { alert("ID를 입력하세요."); return; }
      if (/[\s"'\\]/.test(newId)) { alert("ID에는 공백과 따옴표를 쓸 수 없습니다."); return; }
      if (newId !== prevId && config.statuses.some((w) => w.id === newId)) { alert("이미 같은 ID를 쓰는 상태창이 있습니다."); return; }
      draft.id = newId;

      // 조건 블록 짝 검사 — 막지는 않고, 이대로 저장할지 물어본다 (작성 중 저장을 허용)
      const blockProblems = [
        ...checkBlockBalance(draft.template).map((t) => "콘텐츠(HTML): " + t),
        ...checkBlockBalance(draft.sceneTemplate).map((t) => "장면 띠 HTML: " + t),
      ];
      if (blockProblems.length && !confirm(
        "조건 블록의 짝이 맞지 않습니다:\n\n" + blockProblems.slice(0, 8).join("\n") +
        (blockProblems.length > 8 ? `\n… 외 ${blockProblems.length - 8}건` : "") +
        "\n\n짝이 없는 블록은 조건 없이 항상 표시됩니다. 이대로 저장할까요?")) return;

      const cleanW = normalizeStatus(draft);
      if (!cleanW.fields.length && !cleanW.sceneFields.length) { alert("캐릭터 상태값 또는 장면 필드를 1개 이상 입력하세요."); return; }
      if (charFieldsOn && !cleanW.fields.length) { alert("상태값을 1개 이상 입력하세요. (캐릭터 없이 장면만 쓰려면 '캐릭터 필드' 스위치를 끄세요)"); return; }
      if (cleanW.fields.length && !cleanW.template.trim()) { alert("콘텐츠(HTML)를 입력하세요."); return; }
      if (newId !== prevId) {
        const oldIdx = config.statuses.findIndex((w) => w.id === prevId);
        if (oldIdx >= 0) config.statuses.splice(oldIdx, 1);
        if (config.activeId === prevId) config.activeId = newId;
        Object.keys(config.perChat || {}).forEach((cid) => { if (config.perChat[cid] === prevId) config.perChat[cid] = newId; });
      }
      const idx = config.statuses.findIndex((w) => w.id === cleanW.id);
      if (idx >= 0) config.statuses[idx] = cleanW; else config.statuses.push(cleanW);
      if (!config.activeId) config.activeId = cleanW.id;
      saveConfig(); closeOverlay(MODAL_ID); invalidateFloat(); applyWindowCss();
      const currentChatId = getChatId();
      if (currentChatId && statusForChat(currentChatId)?.id === cleanW.id) saveChatSkinSnapshot(currentChatId, cleanW).catch(() => {});
      const list = document.querySelector("#us-wlist"); if (list) renderStatusList(list);
      syncDefaultSelInPanel();
    };
  }

  function openPreviewPopup(draft) {
    const PREVIEW_ID = "us-preview-popup";
    const existing = document.getElementById(PREVIEW_ID); if (existing) existing.remove();
    const nw = normalizeStatus(draft);
    const sampleScene = nw.sceneFields.length ? sampleValuesFor({ fields: nw.sceneFields }) : null;
    // 장면 전용 스킨(캐릭터 필드 없음)은 캐릭터 샘플 없이 장면만 미리보기
    const sampleSubjects = nw.fields.length ? [
      { label: "캐릭터A", values: sampleValuesFor(nw) },
      { label: "캐릭터B", values: sampleValuesFor(nw) },
    ] : [];
    const popup = document.createElement("div");
    popup.id = PREVIEW_ID;
    popup.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);";
    const inner = document.createElement("div");
    // 팝업 너비를 하드코딩(FLOAT_W) 대신 실제 플로팅 창의 런타임 너비에 맞춤 —
    // 윈도우 CSS 로 #us-float 너비를 바꾼 경우도 반영됨. 창이 없으면 FLOAT_W 로 폴백.
    const floatEl = document.getElementById(FLOAT_ID);
    const floatWidth = floatEl && floatEl.offsetWidth ? floatEl.offsetWidth : FLOAT_W;
    inner.style.cssText = `display:flex;flex-direction:column;width:min(${floatWidth + 20}px,94vw);max-height:90vh;border-radius:14px;overflow:hidden;background:var(--card,#1c1c1c);border:1px solid var(--border,#333);box-shadow:0 10px 30px rgba(0,0,0,.4);`;
    // 미리보기도 이 스킨의 윈도우 디자인을 그대로 입는다 — 창 색·테두리·폰트가 빠지면
    //   "미리보기"라는 이름이 무색해진다. 위젯과 같은 변수 주입 방식을 팝업 전체에 적용.
    applyWidgetWindowCss(inner, nw);
    inner.style.background = "var(--us-float-bg, var(--card,#1c1c1c))";
    inner.style.color = "var(--us-float-fg, var(--foreground,#eee))";
    inner.style.borderColor = "var(--us-float-border, var(--border,#333))";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--us-float-border,var(--border,#333));flex-shrink:0;";
    const headerTitle = document.createElement("span");
    headerTitle.innerHTML = `<span style="display:inline-flex;vertical-align:-2px;margin-right:6px;">${ICON.search}</span>미리보기`;
    headerTitle.style.cssText = "font-size:13px;font-weight:600;color:var(--us-float-fg,var(--foreground,#eee));";
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = ICON.close;
    closeBtn.title = "닫기"; closeBtn.setAttribute("aria-label", "닫기");
    closeBtn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--us-float-border,var(--border,#444));background:transparent;color:var(--us-float-muted,var(--muted-foreground,#999));border-radius:7px;cursor:pointer;font-family:inherit;";
    closeBtn.onclick = () => popup.remove();
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    popup.addEventListener("mousedown", (e) => { if (e.target === popup) popup.remove(); });
    const handleKey = (e) => { if (e.key === "Escape") { popup.remove(); document.removeEventListener("keydown", handleKey); } };
    document.addEventListener("keydown", handleKey);
    const scrollable = document.createElement("div");
    scrollable.style.cssText = "overflow:auto;padding:10px;flex:1;";
    const nwrap = document.createElement("div");
    nwrap.className = "us-hist-widget";
    nwrap.style.cssText = "border:none;border-radius:0;padding:0;box-shadow:none;background:transparent;";
    renderNav(nwrap, nw, sampleScene, sampleSubjects, PREVIEW_KEY);
    scrollable.appendChild(nwrap);
    inner.appendChild(header);
    inner.appendChild(scrollable);
    popup.appendChild(inner);
    document.body.appendChild(popup);
  }

  function exportStatus(status) {
    if (!status) return;
    const safe = ((status.name || "status").replace(/[^\w가-힣\- ]+/g, "").trim().replace(/\s+/g, "_")) || "status";
    const payload = { type: STATUS_ITEM_EXPORT_TYPE, version: 1, exportedAt: new Date().toISOString(), status: shareableStatus(status) };
    saveFile(`${safe}-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
  }
  // 내 상태창 전부를 JSON 1개로 (디자인 라이브러리 백업)
  function exportStatuses() {
    if (!config.statuses.length) { alert("내보낼 상태창이 없습니다."); return; }
    const payload = {
      type: "marinara-user-status-pack",
      version: 1,
      exportedAt: new Date().toISOString(),
      count: config.statuses.length,
      statuses: config.statuses.map(shareableStatus),
    };
    saveFile(`user-status-pack-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
  }
  function pickStatusesFromData(data) {
    const arr = Array.isArray(data?.statuses) ? data.statuses : (Array.isArray(data?.widgets) ? data.widgets : []);
    const many = arr.map(normalizeStatus).filter(Boolean);
    if (many.length) return many;
    if (!data || typeof data !== "object") return [];
    const single = normalizeStatus(data.status || data.widget || data);
    // 장면 전용 스킨(fields 없음, sceneFields만 있음)도 유효한 가져오기 대상
    return single && ((single.fields && single.fields.length) || (single.sceneFields && single.sceneFields.length)) ? [single] : [];
  }
  function importStatuses() {
    // 여러 파일을 한 번에 고를 수 있다 — 파일별로 순서대로 읽어 같은 규칙으로 합친다.
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json"; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []); if (!files.length) return;
      const multi = files.length > 1;
      let added = 0, replaced = 0;
      const badJson = [], noStatus = [];
      for (const f of files) {
        let ws = [];
        try { ws = pickStatusesFromData(JSON.parse(await f.text())); }
        catch (e) { badJson.push(f.name); continue; }
        if (!ws.length) { noStatus.push(f.name); continue; }
        for (const w of ws) {
          // id 를 보존한다 — 수정본 스킨을 다시 가져와도 기존 채팅 기록(statusId 연결)이
          // 그대로 이어지도록. (예전엔 항상 새 id 를 발급해, 재가져온 스킨을 적용한 채팅에서
          // 과거 기록이 '다른 스킨의 기록'이 되어 직전 값 인계가 끊기던 문제가 있었다)
          const incomingId = (typeof w.id === "string" && w.id.trim()) ? w.id.trim() : null;
          const existingIdx = incomingId ? config.statuses.findIndex((x) => x.id === incomingId) : -1;
          if (existingIdx >= 0) {
            const exName = config.statuses[existingIdx].name || "이름 없음";
            const overwrite = confirm(
              `같은 스킨이 이미 있습니다: "${exName}"\n` +
              (multi ? `가져오는 파일: ${f.name}\n` : "") + `\n` +
              `확인: 덮어쓰기 (기존 채팅 기록과의 연결 유지 — 수정본 갱신에 권장)\n` +
              `취소: 새 스킨으로 복제 (기존 것은 그대로 둠)`);
            if (overwrite) { config.statuses[existingIdx] = { ...w, id: incomingId }; replaced++; }
            else { w.id = uid(); config.statuses.push(w); added++; }
          } else {
            if (!incomingId) w.id = uid();
            config.statuses.push(w); added++;
          }
        }
      }
      if (!added && !replaced) {
        alert("상태창을 찾을 수 없습니다." +
          (badJson.length ? `\n· 읽지 못한 파일: ${badJson.join(", ")}` : "") +
          (noStatus.length ? `\n· 상태창이 없는 파일: ${noStatus.join(", ")}` : ""));
        return;
      }
      if (!config.activeId && config.statuses.length) config.activeId = config.statuses[0].id;
      saveConfig();
      const list = document.querySelector("#us-wlist"); if (list) renderStatusList(list);
      syncDefaultSelInPanel(); invalidateFloat();
      alert(`가져오기 완료: 추가 ${added}개${replaced ? `, 덮어쓰기 ${replaced}개` : ""}.` +
        (badJson.length ? `\n· 읽지 못한 파일: ${badJson.join(", ")}` : "") +
        (noStatus.length ? `\n· 상태창이 없는 파일: ${noStatus.join(", ")}` : ""));
    };
    inp.click();
  }
  function resetAllToDefault() {
    if (!confirm("정말 모두 초기화할까요?\n\n• 되돌릴 수 없습니다\n• 현재 상태창 디자인/설정이 모두 초기 상태로 돌아갑니다\n• 채팅별 상태창 값(기록)은 삭제되지 않습니다")) return;
    config.statuses = STARTERS.map((s) => normalizeStatus({ ...clone(s), id: uid() }));
    config.activeId = config.statuses[0]?.id || null;
    config.settings = { ...DEFAULT_SETTINGS };
    config.perChat = {};
    config.perChatSettings = {};
    config.perChatTitle = {};
    config.ui = { ...DEFAULT_UI };
    config.seeded = true;
    saveConfig();
    applyWindowCss();
    invalidateFloat();
    syncDefaultSelInPanel();
    // 초기화 결과를 즉시 반영: 상태창 설정 탭으로 전환해 토글 상태를 바로 보여준다
    if (panelSelectTab) panelSelectTab("status");
    else { const body = document.getElementById("us-tabbody"); if (body) renderAdvancedTab(body); }
    alert("모두 초기화가 완료되었습니다. 샘플 상태창과 기본 설정이 복원되었습니다.");
  }

  // 설정을 채팅 metadata 에 백업 / 복구 (기기 간)

  // ── 백업 팝업 / 설정·기록 내보내기·가져오기 ──
  // 채팅 목록 완전 열거.
  //  /chats/ 는 브랜치 그룹에 속한 채팅을 전부 돌려주지 않는다(그룹 멤버는 /chats/group/:groupId).
  //  삭제·백업·자동매칭이 그 채팅들을 놓치면 "전체 삭제했는데 남아있다 / 새 방에 되살아난다"가 된다.
  async function listAllChats() {
    let base = [];
    try { base = await marinara.apiFetch("/chats/") || []; } catch (_) { base = []; }
    base = Array.isArray(base) ? base.filter((c) => c && c.id) : [];
    const byId = new Map(base.map((c) => [c.id, c]));
    const groupIds = new Set();
    for (const c of base) {
      const g = c.groupId || (c.metadata && c.metadata.groupId) || null;
      if (g) groupIds.add(g);
    }
    for (const g of groupIds) {
      let sibs = [];
      try { sibs = await marinara.apiFetch(`/chats/group/${encodeURIComponent(g)}`) || []; } catch (_) { sibs = []; }
      if (Array.isArray(sibs)) for (const c of sibs) if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
    }
    return Array.from(byId.values());
  }
  function openChoiceModal(title, note, options) {
    const btns = options.map((o, i) =>
      `<button class="us-btn${o.primary ? " primary" : ""}" style="flex:1;min-width:120px;justify-content:center;" data-ci="${i}">${esc(o.label)}</button>`
    ).join("");
    const o = overlay(MODAL_ID, `
      <div class="us-h" style="margin-bottom:8px;"><h2>${esc(title)}</h2><button class="us-x" id="us-cm-close">×</button></div>
      ${note ? `<div class="us-sub">${esc(note)}</div>` : ""}
      <div class="us-row" style="gap:8px;flex-wrap:wrap;margin-top:12px;">${btns}</div>`);
    o.querySelector("#us-cm-close").onclick = () => closeOverlay(MODAL_ID);
    o.querySelectorAll("[data-ci]").forEach((b) => {
      b.onclick = () => { closeOverlay(MODAL_ID); options[+b.dataset.ci].action(); };
    });
  }
  function exportRecordsChat(chatId) {
    if (!chatId) { alert("채팅 화면에서 실행하세요."); return; }
    const store = loadStore(chatId);
    if (!store || !store.byMsg || !Object.keys(store.byMsg).length) { alert("이 채팅에 저장된 기록이 없습니다."); return; }
    // chatId 를 파일 안에 명시 → 가져오기에서 채팅방을 자동으로 찾아 매칭할 수 있다.
    const payload = { chatId, statusId: store.statusId || null, byMsg: store.byMsg, order: Array.isArray(store.order) ? store.order : [] };
    saveFile(`user-status-records-${chatId}-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
  }
  async function exportRecordsAll() {
    // valuesCache 는 방문한 채팅만 들어있으므로, 서버에서 전체 채팅 목록을 받아
    // 각각 metadata 를 hydrate 한 뒤 내보낸다(현재 채팅 하나만 나가던 버그 방지).
    let chats = [];
    try { chats = await listAllChats(); }
    catch (e) { alert("채팅 목록 조회 실패: " + e.message); return; }
    // 전체 채팅을 훑는 동안 활성 채팅 감지가 오염되면, 백업 이후 다른 방 기록이
    // 현재 방에 보이는 문제가 생긴다. 스캔 구간을 명시적으로 감싼다.
    await withInternalChatScan(async () => {
      for (const c of chats) {
        if (!c || !c.id) continue;
        try { await ensureChatValues(c.id); } catch {}
      }
    });
    const backup = {};
    for (const [cid, store] of Object.entries(valuesCache)) {
      if (store && store.byMsg && Object.keys(store.byMsg).length) backup[cid] = store;
    }
    if (!Object.keys(backup).length) { alert("저장된 기록이 없습니다."); return; }
    saveFile(`user-status-records-all-${Date.now()}.json`, JSON.stringify(backup, null, 2), "application/json");
  }

  // ── 저장 데이터 삭제 ──
  async function clearChatValues() {
    const chatId = getChatId(); if (!chatId) { alert("채팅 화면에서 실행하세요."); return; }
    await ensureChatValues(chatId);
    const store = loadStore(chatId);
    const hasData = store && store.byMsg && Object.keys(store.byMsg).length;
    if (hasData && confirm("삭제 전 백업 JSON을 다운로드할까요?\n취소를 누르면 백업 없이 계속합니다.")) {
      saveFile(`user-status-values-${chatId}-${Date.now()}.json`,
        JSON.stringify({ chatId, statusId: store.statusId || null, byMsg: store.byMsg, order: Array.isArray(store.order) ? store.order : [] }, null, 2),
        "application/json");
    }
    if (!confirm("이 채팅의 기록을 모두 삭제할까요?")) return;
    valuesCache[chatId] = { statusId: null, byMsg: {}, order: [] };
    valuesHydrated[chatId] = true;
    delete latestAsstByChat[chatId];
    delete focusedMsgByChat[chatId];
    delete assistantIdsByChat[chatId];
    delete swipeByMsgByChat[chatId];
    delete lastLatestSwipeByChat[chatId];
    delete seenLatestIdsByChat[chatId];
    delete lastMsgCountByChat[chatId];
    delete firstCapturePromptedByChat[chatId]; // 지웠으니 다음 첫 생성 때 다시 확인하도록 가드 해제
    // 캡처 관련 휘발 상태도 함께 초기화 — 삭제 직후 새로고침/재생성이 깨끗한 상태에서 돌게 한다.
    delete captureNoticeByChat[chatId];
    delete pendingTurnDisplayByChat[chatId];
    delete genTargetByChat[chatId];
    delete genTargetExplicit[chatId];
    delete genBaselineByChat[chatId];
    if (activeDryRunIdByChat[chatId]) {
      marinara.apiFetch("/generate/dryRun/abort", {
        method: "POST", body: JSON.stringify({ runId: activeDryRunIdByChat[chatId], chatId }),
      }).catch(() => {});
    }
    delete activeDryRunIdByChat[chatId];
    delete captureBusyByChat[chatId];
    delete captureBusyTsByChat[chatId];
    clearTimeout(captureTimerByChat[chatId]); delete captureTimerByChat[chatId];
    if (manualIds[chatId]) delete manualIds[chatId];
    if (config.ui && config.ui.firstCaptureAskedChats) { delete config.ui.firstCaptureAskedChats[chatId]; saveConfig(); }
    try { localStorage.removeItem(VALUES_PREFIX + chatId); } catch {}
    clearTimeout(savePending[chatId]); delete savePending[chatId]; // 대기 중인 저장이 삭제를 되돌리지 못하게
    delete branchHealDone[chatId];
    delete _importMsgIdSetCache[chatId];
    try {
      await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/metadata`, {
        // 빈 껍데기를 남기면 새 채팅으로 계속 복제된다. 키 자체를 지운다.
        method: "PATCH", body: JSON.stringify({ [META_VALUES_KEY]: null }),
      });
    } catch (e) { alert("metadata 삭제 실패: " + e.message); return; }
    await refreshHistoryUiIfOpen();
    alert("이 채팅의 기록을 삭제했습니다.");
  }
  async function refreshHistoryUiIfOpen() {
    const body = document.getElementById("us-tabbody");
    if (body && config.ui.panelTab === "history") await renderHistoryTab(body);
    else { invalidateFloat(); }
  }
  async function clearAllChatValues() {
    if (!confirm("모든 채팅의 저장된 상태창 값을 삭제합니다.\n\n• 되돌릴 수 없습니다\n• 각 채팅 metadata 에서 값 제거\n\n계속할까요?")) return;
    const typed = prompt("정말 삭제하려면 '삭제' 라고 입력하세요:");
    if (typed === null) return;
    if (typed.trim() !== "삭제") { alert("입력이 일치하지 않아 취소합니다."); return; }
    const backup = {};
    for (const [cid, st] of Object.entries(valuesCache)) {
      if (st && st.byMsg && Object.keys(st.byMsg).length) backup[cid] = st;
    }
    if (Object.keys(backup).length && confirm("삭제 전 백업 JSON을 다운로드할까요?\n취소를 누르면 백업 없이 계속합니다.")) {
      saveFile(`user-status-values-all-${Date.now()}.json`, JSON.stringify(backup, null, 2), "application/json");
    }
    let chats = [];
    try { chats = await listAllChats(); } catch (e) { alert("채팅 목록 조회 실패: " + e.message); return; }
    internalChatScanDepth++;
    let done = 0, fail = 0;
    for (const c of chats) {
      if (!c || !c.id) continue;
      try {
        // 캐시가 이미 비어 있으면 카운트에서 제외 (재삭제 시 0 표시 방지)
        const cached = valuesCache[c.id];
        const alreadyEmpty = cached && !cached.statusId && (!cached.byMsg || !Object.keys(cached.byMsg).length);
        await marinara.apiFetch(`/chats/${encodeURIComponent(c.id)}/metadata`, {
          // 빈 껍데기({byMsg:{}})를 남기면 그 키가 새 채팅으로 계속 복제된다. 키 자체를 지운다.
          method: "PATCH", body: JSON.stringify({ [META_VALUES_KEY]: null }),
        });
        if (!alreadyEmpty) done++;
      } catch { fail++; }
    }
    internalChatScanDepth = Math.max(0, internalChatScanDepth - 1);
    // 대기 중인 디바운스 저장(saveStore 600ms)이 남아 있으면 삭제 직후 옛 값이 다시 PATCH 된다.
    // = "전체 기록을 삭제했는데도 데이터가 남아있다"의 직접 원인. 먼저 전부 취소한다.
    for (const k of Object.keys(savePending)) { clearTimeout(savePending[k]); delete savePending[k]; }
    for (const k of Object.keys(valuesCache)) delete valuesCache[k];
    for (const k of Object.keys(valuesReady)) delete valuesReady[k];
    for (const k of Object.keys(branchHealDone)) delete branchHealDone[k];
    for (const k of Object.keys(lastMsgCountByChat)) delete lastMsgCountByChat[k];
    for (const k of Object.keys(_importMsgIdSetCache)) delete _importMsgIdSetCache[k];
    for (const k of Object.keys(valuesHydrated)) delete valuesHydrated[k];
    for (const k of Object.keys(firstCapturePromptedByChat)) delete firstCapturePromptedByChat[k]; // 첫 생성 확인 가드 전부 해제
    if (config.ui) { config.ui.firstCaptureAskedChats = {}; saveConfig(); }
    for (const k of Object.keys(latestAsstByChat)) delete latestAsstByChat[k];
    for (const k of Object.keys(focusedMsgByChat)) delete focusedMsgByChat[k];
    for (const k of Object.keys(assistantIdsByChat)) delete assistantIdsByChat[k];
    for (const k of Object.keys(swipeByMsgByChat)) delete swipeByMsgByChat[k];
    for (const k of Object.keys(lastLatestSwipeByChat)) delete lastLatestSwipeByChat[k];
    for (const k of Object.keys(seenLatestIdsByChat)) delete seenLatestIdsByChat[k];
    try {
      const rm = [];
      for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key && key.indexOf(VALUES_PREFIX) === 0) rm.push(key); }
      rm.forEach((key) => localStorage.removeItem(key));
    } catch {}
    await refreshHistoryUiIfOpen();
    alert(`완료: ${done}개 채팅방 기록 삭제${fail ? `, ${fail}개 실패` : ""}.`);
  }

  // ── 기록 가져오기 (채팅 ID 자동 매칭) ──
  // 파일명에서 채팅 ID 후보 추출: user-status-(values|records)-<chatId>-<timestamp>.json
  function chatIdHintFromFilename(name) {
    if (typeof name !== "string") return null;
    const m = name.match(/user-status-(?:values|records)-([A-Za-z0-9_-]+)-\d{10,}\.json$/);
    if (!m || m[1] === "all") return null;
    return m[1];
  }
  const _importMsgIdSetCache = {};   // chatId -> Set(msgId)
  async function chatMsgIdSet(chatId) {
    if (_importMsgIdSetCache[chatId]) return _importMsgIdSetCache[chatId];
    let list = null;
    try {
      const total = await fetchMessageCount(chatId);
      const lim = Number.isFinite(total) && total > 0 ? total + 1 : 2000;
      list = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}/messages?limit=${lim}`);
    } catch (_) { list = null; }
    // 조회 실패는 null, '메시지가 0개'는 빈 Set 으로 구분한다.
    //  (이걸 뭉뚱그리면 메시지 0개인 새 방 = 오염이 가장 확실한 케이스를 놓친다)
    if (!Array.isArray(list)) return null;
    const set = new Set();
    for (const m of list) if (m && m.id) set.add(m.id);
    _importMsgIdSetCache[chatId] = set;
    return set;
  }
  // 저장된 메시지 ID 로 어느 채팅방의 기록인지 역추적한다 (메시지 ID 는 전역 고유).
  async function resolveChatIdByMsgIds(byMsg, chats, onProgress) {
    const ids = Object.keys(byMsg || {}).filter((k) => k && k !== "__latest__");
    if (!ids.length) return null;
    let bestId = null, bestHit = 0;
    for (let i = 0; i < chats.length; i++) {
      const c = chats[i];
      if (!c || !c.id) continue;
      if (onProgress) onProgress(i + 1, chats.length, c.name || c.id.slice(0, 8));
      const set = await chatMsgIdSet(c.id);
      if (!set) continue;
      let hit = 0;
      for (const id of ids) if (set.has(id)) hit++;
      if (hit > bestHit) { bestId = c.id; bestHit = hit; }
      if (bestHit === ids.length) break;   // 전부 일치하면 더 찾을 필요 없음
    }
    return bestHit > 0 ? { chatId: bestId, hit: bestHit, total: ids.length } : null;
  }
  const IMPORT_PROGRESS_ID = "us-import-progress";
  function openProgressModal(title) {
    const o = overlay(IMPORT_PROGRESS_ID, `
      <div class="us-h" style="margin-bottom:8px;"><h2>${esc(title)}</h2></div>
      <div class="us-sub" id="us-imp-msg" style="white-space:pre-line;min-height:38px;">준비 중…</div>`);
    const msgEl = o.querySelector("#us-imp-msg");
    return {
      set(t) { if (msgEl) msgEl.textContent = t; },
      close() { closeOverlay(IMPORT_PROGRESS_ID); },
    };
  }
  // 버킷 목록 [{chatId|null, hintId, store}] 을 실제 채팅방에 복원한다.
  // (기록 파일 가져오기 / 전체 백업 가져오기가 공용으로 쓴다)
  async function restoreRecordBuckets(buckets) {
    if (!buckets || !buckets.length) { alert("복원할 기록이 없습니다."); return 0; }
    const prog = openProgressModal("기록 가져오기");
    internalChatScanDepth++;
    try {
      prog.set("채팅방 목록을 불러오는 중…");
      let chats = [];
      try { chats = await listAllChats(); } catch (_) { chats = []; }
      if (!chats.length) { prog.close(); alert("채팅방 목록을 가져오지 못했습니다."); return 0; }
      const byId = new Map(chats.map((c) => [c.id, c]));
      const nameOf = (id) => { const c = byId.get(id); return (c && c.name) || id.slice(0, 8); };

      // 채팅 ID 확정: ① 정확 일치 → ② 접두사 일치(구버전 8자 파일명) → ③ 메시지 ID 역추적
      for (const b of buckets) {
        if (b.hintId && byId.has(b.hintId)) { b.chatId = b.hintId; continue; }
        if (b.hintId) {
          const cand = chats.filter((c) => c.id.startsWith(b.hintId));
          if (cand.length === 1) { b.chatId = cand[0].id; b.viaPrefix = true; continue; }
        }
        const found = await resolveChatIdByMsgIds(b.store.byMsg, chats,
          (i, n, nm) => prog.set(`메시지 ID로 채팅방을 찾는 중… (${i}/${n})\n${nm}`));
        if (found) { b.chatId = found.chatId; b.match = found; }
      }
      prog.close();

      const matched = buckets.filter((b) => b.chatId);
      const skipped = buckets.length - matched.length;
      if (!matched.length) {
        alert("가져온 기록과 일치하는 채팅방을 찾지 못했습니다.\n원본 메시지가 삭제되었거나 다른 서버의 백업일 수 있습니다.");
        return 0;
      }
      // 같은 채팅으로 매칭된 항목이 여럿이면 병합
      const merged = new Map();
      for (const b of matched) {
        const cur = merged.get(b.chatId);
        if (!cur) { merged.set(b.chatId, b); continue; }
        Object.assign(cur.store.byMsg, b.store.byMsg);
        for (const id of b.store.order) if (!cur.store.order.includes(id)) cur.store.order.push(id);
      }
      const targets = Array.from(merged.values());

      const lines = targets.map((b) => {
        const n = Object.keys(b.store.byMsg).length;
        const how = b.match ? `자동매칭 ${b.match.hit}/${b.match.total}` : (b.viaPrefix ? "파일명 매칭" : "ID 일치");
        return `· ${nameOf(b.chatId)} — 기록 ${n}개 (${how})`;
      });
      let q = `다음 ${targets.length}개 채팅방에 기록을 복원합니다.\n\n${lines.join("\n")}`;
      if (skipped) q += `\n\n매칭 실패 ${skipped}건은 건너뜁니다.`;
      q += "\n\n해당 채팅방의 기존 기록은 덮어쓰기 됩니다. 진행할까요?";
      if (!confirm(q)) return 0;

      const prog2 = openProgressModal("기록 복원 중");
      let ok = 0, fail = 0, skinLinked = 0, cfgTouched = false;
      const skinMissing = new Set();
      for (const b of targets) {
        prog2.set(`${nameOf(b.chatId)} 복원 중… (${ok + fail + 1}/${targets.length})`);
        clearTimeout(savePending[b.chatId]); delete savePending[b.chatId];
        valuesCache[b.chatId] = b.store;
        valuesHydrated[b.chatId] = true;
        // delete valuesReady[...] 로 두면 다음 ensureChatValues 가 서버 값을 다시 읽어와
        // 방금 넣은 기록을 덮어써 버린다(= 불러와도 아무것도 안 뜨던 원인). 완료로 고정한다.
        valuesReady[b.chatId] = Promise.resolve();
        // 아래 파생 캐시들이 남아 있으면 화면이 옛 상태 그대로라 '새로고침해야 보이는' 증상이 난다.
        delete latestAsstByChat[b.chatId];
        delete focusedMsgByChat[b.chatId];
        delete assistantIdsByChat[b.chatId];
        delete swipeByMsgByChat[b.chatId];
        delete lastLatestSwipeByChat[b.chatId];
        delete seenLatestIdsByChat[b.chatId];
        delete lastMsgCountByChat[b.chatId];
        delete branchHealDone[b.chatId];
        delete _importMsgIdSetCache[b.chatId];
        // 스킨 연결: 기록에 담긴 statusId 와 같은 상태창이 로컬에 있으면 그 채팅의 상태창으로 지정.
        const wantSid = b.store.statusId;
        if (wantSid) {
          if (config.statuses.some((x) => x && x.id === wantSid)) {
            if (!config.perChat[b.chatId]) { config.perChat[b.chatId] = wantSid; cfgTouched = true; }
            skinLinked++;
          } else skinMissing.add(wantSid);
        }
        try { await saveStoreNow(b.chatId, b.store); ok++; }
        catch (e) { fail++; try { console.log("[User Status] import save failed:", b.chatId, (e && e.message) || e); } catch (_) {} }
      }
      if (cfgTouched) saveConfig();
      prog2.close();
      // 현재 보고 있는 채팅이 복원 대상이면 메시지 메타를 다시 만들어야 화면이 갱신된다.
      const curId = getChatId();
      if (curId && merged.has(curId)) { try { await syncMessages({ chatId: curId }); } catch (_) {} }
      lastFloatSig = null;
      applyWindowCss();
      invalidateFloat();
      await refreshHistoryUiIfOpen();
      if (panelSelectTab && config.ui && config.ui.panelTab) panelSelectTab(config.ui.panelTab);
      let done = `복원 완료 — 성공 ${ok}개${fail ? `, 실패 ${fail}개` : ""}${skipped ? `, 건너뜀 ${skipped}개` : ""}`;
      if (skinLinked) done += `\n스킨 연결 ${skinLinked}개 (기록에 기록된 상태창으로 지정)`;
      if (skinMissing.size) done += `\n※ 기록이 쓰던 상태창 ${skinMissing.size}개가 이 기기에 없습니다 — 현재 상태창으로 표시됩니다.`;
      alert(done + "\n채팅방을 하나씩 열지 않아도 이미 반영되었습니다.");
      return ok;
    } catch (e) {
      prog.close();
      alert("불러오기 실패: " + ((e && e.message) || e));
      return 0;
    } finally {
      internalChatScanDepth = Math.max(0, internalChatScanDepth - 1);
    }
  }
  // 파일 JSON → 복원 버킷 목록. 기록 파일의 3가지 형식을 모두 받는다.
  function bucketsFromRecordJson(data, fileName) {
    const mkStore = (v) => ({
      statusId: v.statusId || v.widgetId || null,
      byMsg: v.byMsg,
      order: Array.isArray(v.order) ? v.order : [],   // order 를 버리면 정렬/턴 표시가 깨진다
    });
    const buckets = [];
    if (data && data.byMsg && typeof data.byMsg === "object") {
      buckets.push({ chatId: null, hintId: data.chatId || chatIdHintFromFilename(fileName), store: mkStore(data) });
    } else if (data && typeof data === "object") {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (!v || !v.byMsg || typeof v.byMsg !== "object") continue;
        buckets.push({ chatId: null, hintId: v.chatId || k, store: mkStore(v) });
      }
    }
    return buckets;
  }
  // ── 전체 백업 (기록 + 설정) ──────────────────────────────
  const FULL_BACKUP_TYPE = "user-status-full-backup";
  function pickJsonFile() {
    return new Promise((resolve) => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".json,application/json";
      inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
      inp.click();
    });
  }
  function isFullBackup(d) {
    return !!(d && typeof d === "object" && (d.type === FULL_BACKUP_TYPE || (d.config && d.records)));
  }
  // 모든 채팅의 기록을 서버에서 모아 온다 (valuesCache 는 방문한 채팅만 갖고 있다).
  async function collectAllRecords() {
    let chats = [];
    try { chats = await listAllChats(); } catch (e) { throw new Error("채팅 목록 조회 실패: " + e.message); }
    const out = {};
    await withInternalChatScan(async () => {
      for (const c of chats) {
        if (!c || !c.id) continue;
        try { await ensureChatValues(c.id); } catch (_) {}
        const st = valuesCache[c.id];
        if (st && st.byMsg && Object.keys(st.byMsg).length) {
          out[c.id] = { chatId: c.id, statusId: st.statusId || null, byMsg: st.byMsg, order: Array.isArray(st.order) ? st.order : [] };
        }
      }
    });
    return out;
  }
  async function exportFullBackup() {
    const prog = openProgressModal("전체 백업 만드는 중");
    try {
      prog.set("모든 채팅의 기록을 모으는 중…");
      const records = await collectAllRecords();
      prog.set("파일을 만드는 중…");
      const payload = {
        type: FULL_BACKUP_TYPE,
        version: 1,
        exportedAt: new Date().toISOString(),
        counts: { chats: Object.keys(records).length, statuses: config.statuses.length },
        config,     // 스킨(statuses) + 공용/채팅별 설정 + UI 상태 전부
        records,    // { chatId: {chatId, statusId, byMsg, order} }
      };
      prog.close();
      saveFile(`user-status-full-backup-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
      alert(`전체 백업을 저장했습니다.\n· 상태창(스킨) ${config.statuses.length}개\n· 기록이 있는 채팅 ${Object.keys(records).length}개`);
    } catch (e) {
      prog.close();
      alert("백업 실패: " + ((e && e.message) || e));
    }
  }
  // 설정(스킨/옵션)만 적용. mode: "replace" = 통째로 교체, "merge" = 스킨 추가·갱신 + 매핑 병합
  function applyConfigBackup(cfg, mode) {
    if (!cfg || typeof cfg !== "object") return { added: 0, updated: 0 };
    let added = 0, updated = 0;
    if (mode === "replace") {
      const incoming = Array.isArray(cfg.statuses) ? cfg.statuses.map(normalizeStatus).filter(Boolean) : [];
      added = incoming.length;
      config.statuses = incoming;
      config.activeId = cfg.activeId || (incoming[0] && incoming[0].id) || null;
      config.settings = migrateSettings(cfg.settings);
      config.perChatSettings = {};
      if (cfg.perChatSettings && typeof cfg.perChatSettings === "object") {
        for (const k of Object.keys(cfg.perChatSettings)) config.perChatSettings[k] = migrateSettings(cfg.perChatSettings[k]);
      }
      config.perChat = (cfg.perChat && typeof cfg.perChat === "object") ? { ...cfg.perChat } : {};
      config.perChatTitle = (cfg.perChatTitle && typeof cfg.perChatTitle === "object") ? { ...cfg.perChatTitle } : {};
      config.perChatHidden = (cfg.perChatHidden && typeof cfg.perChatHidden === "object") ? { ...cfg.perChatHidden } : {};
      config.perChatDropped = (cfg.perChatDropped && typeof cfg.perChatDropped === "object") ? { ...cfg.perChatDropped } : {};
      config.ui = normalizeUi(cfg.ui);
    } else {
      const incoming = Array.isArray(cfg.statuses) ? cfg.statuses.map(normalizeStatus).filter(Boolean) : [];
      // 같은 ID 의 스킨이 이미 있으면 어떻게 할지 한 번 물어본다 (스킨 파일 하나씩 가져올 때와 같은 선택).
      //   백업에는 스킨이 여러 개 들어 있을 수 있어 개별로 묻지 않고 한 번에 적용한다.
      const conflicts = incoming.filter((st) => config.statuses.some((x) => x && x.id === st.id));
      let overwriteSame = true;
      if (conflicts.length) {
        const names = conflicts.slice(0, 6).map((st) => `· ${st.name || "이름 없음"}`).join("\n");
        overwriteSame = confirm(
          `같은 ID 의 상태창 ${conflicts.length}개가 이미 있습니다:\n${names}` +
          (conflicts.length > 6 ? `\n… 외 ${conflicts.length - 6}개` : "") + `\n\n` +
          `확인: 덮어쓰기 (기존 채팅 기록과의 연결 유지 — 백업본으로 갱신)\n` +
          `취소: 새 스킨으로 복제 (지금 쓰던 것은 그대로 둠)`);
      }
      for (const st of incoming) {
        const i = config.statuses.findIndex((x) => x && x.id === st.id);
        if (i >= 0) {
          if (overwriteSame) { config.statuses[i] = st; updated++; }
          else { config.statuses.push({ ...st, id: uid() }); added++; }
        } else { config.statuses.push(st); added++; }
      }
      // 채팅별 매핑은 기존 값을 존중하고 비어 있는 것만 채운다
      for (const key of ["perChat", "perChatTitle", "perChatHidden"]) {
        const src = cfg[key];
        if (!src || typeof src !== "object") continue;
        if (!config[key] || typeof config[key] !== "object") config[key] = {};
        for (const k of Object.keys(src)) if (!(k in config[key])) config[key][k] = src[k];
      }
      if (cfg.perChatSettings && typeof cfg.perChatSettings === "object") {
        for (const k of Object.keys(cfg.perChatSettings)) {
          if (!(k in config.perChatSettings)) config.perChatSettings[k] = migrateSettings(cfg.perChatSettings[k]);
        }
      }
      if (!config.activeId && config.statuses.length) config.activeId = config.statuses[0].id;
    }
    if (config.activeId && !config.statuses.some((w) => w.id === config.activeId)) {
      config.activeId = config.statuses[0] ? config.statuses[0].id : null;
    }
    saveConfig();
    return { added, updated };
  }
  function applyFullBackup(data) {
    const nRec = data.records && typeof data.records === "object" ? Object.keys(data.records).length : 0;
    const nSkin = data.config && Array.isArray(data.config.statuses) ? data.config.statuses.length : 0;
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "(시각 정보 없음)";
    const note = `백업 시각: ${when}\n· 상태창(스킨) ${nSkin}개\n· 기록이 있는 채팅 ${nRec}개\n\n무엇을 복원할까요?`;
    const doRecords = async () => {
      const buckets = bucketsFromRecordJson(data.records, "");
      if (!buckets.length) { alert("백업 안에 기록이 없습니다."); return; }
      await restoreRecordBuckets(buckets);
    };
    const doConfig = () => {
      const mode = confirm(
        "설정을 어떻게 복원할까요?\n\n" +
        "[확인] 병합 — 백업의 스킨을 추가하고, 같은 스킨은 갱신합니다. 지금 설정은 최대한 유지됩니다.\n" +
        "[취소] 덮어쓰기 — 지금의 스킨과 설정을 전부 버리고 백업 상태로 되돌립니다."
      ) ? "merge" : "replace";
      if (mode === "replace" && !confirm("정말 덮어쓸까요?\n현재 스킨과 모든 설정이 사라집니다.")) return null;
      const r = applyConfigBackup(data.config, mode);
      applyWindowCss(); invalidateFloat();
      if (panelSelectTab && config.ui && config.ui.panelTab) panelSelectTab(config.ui.panelTab);
      return r;
    };
    openChoiceModal("전체 백업 가져오기", note, [
      { label: "기록 + 설정 모두", primary: true, action: async () => {
        const r = doConfig();
        if (r === null) return;
        await doRecords();
        alert(`설정 복원 완료 — 스킨 추가 ${r.added}개, 갱신 ${r.updated}개`);
      } },
      { label: "기록만", action: doRecords },
      { label: "설정만", action: () => {
        const r = doConfig();
        if (r === null) return;
        alert(`설정 복원 완료 — 스킨 추가 ${r.added}개, 갱신 ${r.updated}개`);
      } },
    ]);
  }
  async function importStatusValues() {
    const f = await pickJsonFile();
    if (!f) return;
    let data = null;
    try { data = JSON.parse(await f.text()); }
    catch (e) { alert("불러오기 실패: JSON 을 읽을 수 없습니다 — " + e.message); return; }
    if (isFullBackup(data)) { applyFullBackup(data); return; }   // 전체 백업 파일이면 자동 분기
    const buckets = bucketsFromRecordJson(data, f.name);
    if (!buckets.length) { alert("올바른 기록 JSON이 아닙니다."); return; }
    await restoreRecordBuckets(buckets);
  }

  // ── 루프/마운트 ──
  let lastChatSeen = null, hideDebounce = null;
  let focusDebounce = null;
  function scheduleFocusUpdate(delay) {
    clearTimeout(focusDebounce);
    if (isInlineDisplayMode()) {
      const chatId = getChatId();
      if (chatId && focusedMsgByChat[chatId]) { delete focusedMsgByChat[chatId]; invalidateFloat(); }
      return;
    }
    focusDebounce = setTimeout(() => updateFocusedMessage(getChatId()), delay || 90);
  }
  // 채팅방 전환 감지 및 처리 — tick과 URL 변경 리스너 양쪽에서 호출
  function checkChatSwitch() {
    const chatId = getChatId();
    if (chatId === lastChatSeen) return;
    lastChatSeen = chatId;
    lastSwipeSig = null; // 새 채팅에서는 스와이프 지문을 처음부터 다시 잡는다
    // 전환 즉시 새 채팅 기준으로 float 를 다시 그린다 (하이드레이션을 기다리지 않음).
    //  → 이전 채팅에서 돌던 스피너가 새 채팅으로 남아 보이지 않도록 한다.
    invalidateFloat();
    dismissFloatNotice(); // 이전 채팅에서 떠 있던 알림이 새 채팅으로 따라오지 않도록 닫는다
    renderCaptureModal(); // 실패 모달은 닫지 않고 재렌더 → 그 채팅으로 돌아오면 복원, 타 채팅에선 숨김
    // 완료 신호 누락으로 스피너가 멈추지 않은 경우 정리 (정상 생성은 수 분 내 끝나므로 8분 초과면 stale)
    if (chatId && isGeneratingByChat[chatId] && genStartTsByChat[chatId] && (Date.now() - genStartTsByChat[chatId] > 480000)) {
      isGeneratingByChat[chatId] = false; delete genStartTsByChat[chatId];
    }
    applyWindowCss();
    if (chatId) {
      delete latestAsstByChat[chatId];
      delete focusedMsgByChat[chatId];
      delete assistantIdsByChat[chatId];
      delete swipeByMsgByChat[chatId];
      delete lastLatestSwipeByChat[chatId];
      delete seenLatestIdsByChat[chatId];
      lastMsgCountByChat[chatId] = undefined;
      ensureChatValues(chatId).then(() => { invalidateFloat(); applyWindowCss(); });
    }
  }
  function tick() {
    if (document.visibilityState === "hidden") return;
    // stale 스피너 워치독 — 모든 채팅 순회 (기존엔 채팅 '전환 순간'에 현재 채팅만 검사해서,
    // 같은 채팅에 머무는 동안엔 8분이 지나도 안 풀렸다). 완료 신호 누락으로 스피너가
    // 멈추지 않은 채팅을 3초 주기로 정리한다.
    {
      const now = Date.now();
      let cleared = false;
      for (const k of Object.keys(genStartTsByChat)) {
        if (isGeneratingByChat[k] && now - (genStartTsByChat[k] || 0) > 480000) {
          isGeneratingByChat[k] = false; delete genStartTsByChat[k]; cleared = true;
        }
      }
      // 응답이 영구 pending 된 dryRun도 화면상 정상 버튼인 채 무음 잠금으로 남지 않게 정리한다.
      for (const k of Object.keys(captureBusyTsByChat)) {
        if (captureBusyByChat[k] && now - (captureBusyTsByChat[k] || 0) > 300000) {
          const runId = activeDryRunIdByChat[k];
          if (runId) {
            marinara.apiFetch("/generate/dryRun/abort", {
              method: "POST", body: JSON.stringify({ runId, chatId: k }),
            }).catch(() => {});
          }
          captureBusyByChat[k] = false;
          delete captureBusyTsByChat[k];
          delete activeDryRunIdByChat[k];
          cleared = true;
        }
      }
      if (cleared) invalidateFloat();
    }
    renderFloat();
    const st = S();
    if (st.enabled && (st.dataMode === DATA_MODES.api || (st.dataMode === DATA_MODES.inline && st.stripFromMessage))) { clearTimeout(hideDebounce); hideDebounce = setTimeout(hideRawBlocksInChat, 150); }
    if (st.enabled) scheduleFocusUpdate(120);
    checkChatSwitch();
    const chatId = getChatId();
    if (st.enabled && chatId) {
      chatChangedSinceLast(chatId).then((changed) => { if (changed) syncMessages({ chatId }); });
    }
  }
  // URL 변경 즉시 감지: popstate(뒤로/앞으로) + pushState 인터셉트(링크 클릭)
  // → tick의 최대 3초 딜레이 없이 채팅 전환 즉시 반영
  (function installNavHook() {
    const orig = history.pushState;
    if (orig.__usWrapped) return;
    const wrapped = function(...args) { orig.apply(history, args); checkChatSwitch(); };
    wrapped.__usWrapped = true;
    history.pushState = wrapped;
    window.addEventListener("popstate", checkChatSwitch);
    if (marinara.onCleanup) marinara.onCleanup(() => {
      if (history.pushState === wrapped) history.pushState = orig;
      window.removeEventListener("popstate", checkChatSwitch);
    });
  })();
  let observeDebounce = null;
  let inlineMountDebounce = null;
  // ── 스와이프 추적 ────────────────────────────────────────────────
  //   메시지를 이전/다음 스와이프로 넘기면 그 스와이프에 저장된 상태 기록을 따라간다.
  //   스와이프 카운터를 못 읽는 레이아웃도 있으므로, '카운터 값' 뿐 아니라
  //   '말풍선 본문(.mari-message-content)이 통째로 교체됐는지'까지 지문으로 묶어 본다.
  //   본문만 보면 우리 위젯이 다시 그려질 때 스스로를 다시 감지하는 순환이 생기므로
  //   위젯이 들어가지 않는 .mari-message-content 만 읽는다.
  function swipeTrackSignature() {
    const parts = [];
    for (const node of getMsgNodes()) {
      const id = node.getAttribute("data-message-id");
      if (!id) continue;
      const role = node.getAttribute("data-message-role");
      if (role && role !== "assistant") continue;
      const swipe = readActiveSwipeFromNode(node);
      const content = node.querySelector(".mari-message-content");
      let fp;
      if (content) {
        const text = content.textContent || "";
        fp = text.length + "#" + text.slice(0, 32);
      } else {
        // 본문 클래스를 못 찾는 레이아웃: 메시지 전체 글자 수에서 우리 위젯 몫을 뺀 값만 쓴다.
        // (위치와 무관하게 우리 렌더가 지문을 흔들지 않도록 길이 차이만 비교)
        const full = (node.textContent || "").length;
        let own = 0;
        node.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((s) => { own += (s.textContent || "").length; });
        fp = "L" + (full - own);
      }
      parts.push(id + "#" + (swipe == null ? "?" : swipe) + "#" + fp);
    }
    return parts.join("|");
  }
  function checkSwipeChange() {
    const chatId = getChatId();
    if (!chatId) { lastSwipeSig = null; return false; }
    const sig = swipeTrackSignature();
    if (sig === lastSwipeSig) return false;
    const first = lastSwipeSig === null;
    lastSwipeSig = sig;
    if (first) return false; // 최초 1회는 기준값만 잡는다
    // 생성 중에는 본문이 스트리밍으로 계속 바뀌므로 스와이프 전환으로 보지 않는다.
    if (isGeneratingByChat[chatId]) return false;
    invalidateFloat();
    // DOM 카운터를 못 읽는 경우를 대비해 서버의 activeSwipeIndex 를 다시 받아온다.
    // (이게 없으면 swipeByMsgByChat 이 옛 스와이프에 머물러 값이 그대로 보인다)
    const now = Date.now();
    if (now - lastSwipeSyncTs > 700) {
      lastSwipeSyncTs = now;
      Promise.resolve(syncMessages({ chatId })).then(() => invalidateFloat()).catch(() => {});
    }
    return true;
  }
  marinara.setInterval(checkSwipeChange, 300);
  // 스와이프 버튼을 누른 직후에는 폴링을 기다리지 않고 바로 확인한다.
  const onSwipeClick = () => {
    setTimeout(checkSwipeChange, 50);
    setTimeout(checkSwipeChange, 200);
    setTimeout(checkSwipeChange, 600);
  };
  document.addEventListener("click", onSwipeClick, true);
  marinara.onCleanup(() => document.removeEventListener("click", onSwipeClick, true));
  marinara.observe(document.body, () => {
    // 마리나라는 채팅 전환 시 URL을 바꾸지 않아(상태만 변경) nav 훅이 안 먹는다.
    //  전환은 메시지 DOM 교체를 동반하므로 여기서 즉시 감지한다(변화 없으면 즉시 return, 비용 낮음).
    checkChatSwitch();
    // 스와이프 전환(메시지 본문 교체)도 여기서 즉시 잡는다.
    checkSwipeChange();
    // React가 메시지/스와이프 DOM을 교체하면 최신/과거 인라인 위젯을 새 노드에 다시 붙인다.
    clearTimeout(inlineMountDebounce);
    inlineMountDebounce = setTimeout(renderFloat, 60);
    const st = S();
    if (st.enabled && (st.dataMode === DATA_MODES.api || (st.dataMode === DATA_MODES.inline && st.stripFromMessage))) { clearTimeout(observeDebounce); observeDebounce = setTimeout(hideRawBlocksInChat, 100); }
    if (st.enabled) scheduleFocusUpdate(180);
  }, { childList: true, subtree: true });
  const onWindowScroll = () => scheduleFocusUpdate(60);
  const onWindowResize = () => { reclampFloatPos(); scheduleFocusUpdate(60); };
  window.addEventListener("scroll", onWindowScroll, true);
  window.addEventListener("resize", onWindowResize, true);
  marinara.onCleanup(() => {
    window.removeEventListener("scroll", onWindowScroll, true);
    window.removeEventListener("resize", onWindowResize, true);
  });

  const outputStartedByChat = {};
  const pendingForceFullByChat = {}; // thinking 시점에 띄운 첫 생성 confirm 응답을 보관 → scheduleAutoCapture가 사용
  const generationErrorByChat = {}; // generation-error 발생 → 바로 뒤 generation-complete 캡처 억제용
  // ── 에이전트 백스톱: 생성 직전의 '최신 어시스턴트 메시지 상태'를 스냅샷 ──
  //   요청 바디로 에이전트를 감지 못한 경우에도, 생성 완료 후 채팅 메시지가 그대로면
  //   (새 메시지 없음 · 스와이프 그대로 · 내용 길이 그대로) 채팅 답변이 아닌 것이므로
  //   자동 캡처(dryRun, 토큰 소모)를 건너뛰기 위한 기준값. /messages 조회라 토큰 비용 없음.
  async function snapshotGenBaseline(chatId, regenId) {
    const token = {};
    genBaselineByChat[chatId] = { ready: false, token };
    try {
      const st = getSettings(chatId);
      const meta = await syncAssistantMetaNow(chatId, st.historyDepth);
      const cur = genBaselineByChat[chatId];
      if (!cur || cur.token !== token) return; // 그 사이 새 생성이 시작돼 덮어씀 — 이 스냅샷 폐기
      if (!meta) { delete genBaselineByChat[chatId]; return; } // 조회 실패 → 가드 없이 기존 동작
      const a = meta.asst;
      const base = {
        ready: true, token,
        id: a ? a.id : null,
        swipe: a ? meta.swipe : 0,
        len: a && typeof a.content === "string" ? a.content.length : -1,
      };
      if (regenId) {
        const tm = Array.isArray(meta.list) ? meta.list.find((m) => m && m.id === regenId) : null;
        base.tgtId = regenId;
        base.tgtSwipe = resolveSwipeForMsg(chatId, regenId, 0);
        base.tgtLen = tm && typeof tm.content === "string" ? tm.content.length : -1;
      }
      genBaselineByChat[chatId] = base;
    } catch (_) { delete genBaselineByChat[chatId]; }
  }
  // 생성 완료 후 메시지가 실제로 바뀌었는지 판정. true=바뀜(캡처 진행), 판정 불가 시에도 true(fail-open).
  async function chatChangedSinceBaseline(cid, base, genTgt) {
    try {
      const st = getSettings(cid);
      const meta = await syncAssistantMetaNow(cid, st.historyDepth);
      if (!meta) return true;
      if (genTgt && base.tgtId === genTgt) {
        const tm = Array.isArray(meta.list) ? meta.list.find((m) => m && m.id === genTgt) : null;
        if (!tm) return true;
        const swNow = resolveSwipeForMsg(cid, genTgt, 0);
        const lenNow = typeof tm.content === "string" ? tm.content.length : -1;
        return swNow !== base.tgtSwipe || lenNow !== base.tgtLen;
      }
      const a = meta.asst;
      const idNow = a ? a.id : null;
      const lenNow = a && typeof a.content === "string" ? a.content.length : -1;
      return idNow !== base.id || meta.swipe !== base.swipe || lenNow !== base.len;
    } catch (_) { return true; }
  }
  // 캡처 스케줄러 — generation-complete(주 트리거) / mari-phase idle(보조)에서 공용 호출.
  // 700ms 디바운스로 연속 호출 시 마지막 1회만 실행 → 중복 캡처 방지.
  function scheduleAutoCapture(cid) {
    if (!cid) return;
    // 임퍼소네이트/에이전트 차단으로 표시된 생성이면 캡처하지 않음 (플래그 소거)
    if (suppressPhaseByChat[cid]) {
      delete suppressPhaseByChat[cid]; delete genBaselineByChat[cid]; outputStartedByChat[cid] = false;
      clearPendingTurnDisplay(cid);
      if (isGeneratingByChat[cid]) { isGeneratingByChat[cid] = false; invalidateFloat(); }
      return;
    }
    outputStartedByChat[cid] = false;
    // 생성 시작 시 스냅샷한 타겟(이전 메시지 재생성이면 그 msgId), 없으면 null=최신
    const genTgt = genTargetByChat[cid];
    delete genTargetByChat[cid];
    delete genTargetExplicit[cid];
    if (isGeneratingByChat[cid]) { isGeneratingByChat[cid] = false; delete genStartTsByChat[cid]; invalidateFloat(); scheduleFocusUpdate(80); }
    hideRawBlocksInChat();
    clearTimeout(captureTimerByChat[cid]);
    const st0 = getSettings(cid);
    if (!st0.enabled) { clearPendingTurnDisplay(cid); return; }
    // thinking 시점에 이미 confirm을 띄워 응답을 받아뒀으면 그 값을 사용(중복 confirm 방지).
    // 그렇지 않은 경로(예: mari-phase 미발생)면 여기서 묻는다.
    let forceFull;
    if (cid in pendingForceFullByChat) { forceFull = pendingForceFullByChat[cid]; delete pendingForceFullByChat[cid]; }
    else forceFull = (st0.dataMode === DATA_MODES.api) ? maybeAskFirstCapture(cid) : false;
    const willPrompt = false; // confirm은 위에서 이미 처리됨
    // 현재 엔진은 메시지 영속화 뒤 generation-complete를 보내므로 고정 200ms 대기를 두지 않는다.
    // 서버 반영이 늦은 예외는 아래 baseline 재확인이 짧은 간격으로 처리한다.
    const delay = 0;
    captureTimerByChat[cid] = setTimeout(async () => {
      const st = getSettings(cid);
      const base = genBaselineByChat[cid]; delete genBaselineByChat[cid];
      if (!st.enabled) { clearPendingTurnDisplay(cid); return; }
      // ── 생성 결과 메타 즉시 확정 + 에이전트 백스톱 ──
      // 새 턴/스와이프가 REST 목록에 보일 때까지 짧게 재확인한다. 이 동안 pending 표시가
      // 이전 값을 가리고 있으므로 사용자는 과거 상태를 현재 상태로 오인하지 않는다.
      if (base && base.ready) {
        let changed = await chatChangedSinceBaseline(cid, base, genTgt);
        if (!changed) {
          for (let i = 0; i < 6 && !changed; i++) {
            await new Promise((r) => setTimeout(r, 170));
            changed = await chatChangedSinceBaseline(cid, base, genTgt);
          }
        }
        if (!changed) {
          clearPendingTurnDisplay(cid);
          if (cid === getChatId()) invalidateFloat();
          diag.captureSkippedNoChange = Date.now();
          console.log("[User Status] 자동 캡처 건너뜀 — 생성 완료 후 채팅 메시지 변화 없음 (에이전트 등 보조 생성으로 판단, 1초 후 재확인 포함)");
          return;
        }
      } else {
        // 기준 스냅샷이 늦거나 실패한 경우에도 먼저 최신 메타를 한 번 읽어 3초 tick을 기다리지 않는다.
        await syncAssistantMetaNow(cid, st.historyDepth);
      }
      if (cid === getChatId()) invalidateFloat();

      if (st.dataMode === DATA_MODES.api) {
        let res;
        try {
          res = await captureApi(true, null, genTgt || undefined, undefined, forceFull, cid, true);
        } catch (e) {
          res = { status: "error", message: String((e && e.message) || e) };
          const latest = latestAsstByChat[cid] || { id: "__latest__", swipe: 0 };
          const failId = genTgt || latest.id || "__latest__";
          const failSwipe = resolveSwipeForMsg(cid, failId, latest.swipe || 0);
          deleteMsgEntry(cid, failId, failSwipe);
          setCaptureNotice(cid, "error", failId, failSwipe);
        } finally {
          // 같은 msgId/swipe가 재사용돼도 이번 캡처 판정이 끝날 때까지 옛 값을 계속 가린다.
          clearPendingTurnDisplay(cid);
          if (cid === getChatId()) { invalidateFloat(); scheduleFocusUpdate(80); }
        }
        notifyCaptureResult(cid, res, { quiet: true });
      } else {
        // inline 파싱도 완료 이벤트에서 즉시 실행하고 반드시 기다린다.
        // 실패/미인식 판정까지 끝난 뒤 렌더되어 이전 턴 값이 되살아나지 않는다.
        try {
          await syncMessages({ chatId: cid, generationComplete: true, targetMsgId: genTgt || null });
        } finally {
          clearPendingTurnDisplay(cid);
          if (cid === getChatId()) { invalidateFloat(); scheduleFocusUpdate(80); }
        }
      }
    }, delay);
  }
  // ── message_saved 조기 캡처 ────────────────────────────────
  //  /api/generate 응답 스트림(clone)에서 SSE 이벤트를 직접 읽는다. 엔진은 채팅 답변을
  //  저장한 뒤(message_saved) 에이전트 파이프라인을 이어서 돌리므로, 이 시점에 캡처를
  //  시작하면 상태창 생성이 에이전트들과 병렬로 진행된다.
  async function watchGenerateStream(res, cid) {
    let reader = null;
    try { reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null; } catch (_) {}
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = "";
    // 그룹 턴(한 턴에 캐릭터 여러 명) 감지 — 엔진은 각 캐릭터 답변 '전에' group_turn을
    // 먼저 보내므로, 이 플래그가 서면 조기 캡처를 걸지 않는다. 그룹 턴 중간 상태를 찍고
    // 완료 후 또 찍으면 캡처 LLM 호출이 2회가 되기 때문. 그룹은 기존대로 완료 시 1회만.
    let groupTurn = false;
    const handlePayload = (payload) => {
      if (!payload || payload === "[DONE]") return;
      let ev = null;
      try { ev = JSON.parse(payload); } catch (_) { return; }
      if (!ev || typeof ev.type !== "string") return;
      if (ev.type === "group_turn") {
        groupTurn = true;
        // 혹시 group_turn보다 먼저 저장된 메시지에 조기 캡처가 걸렸으면 stale 처리(방어)
        const state = earlyCaptureByChat[cid];
        if (state) state.stale = true;
      } else if (ev.type === "message_saved") {
        const msg = ev.data;
        if (msg && msg.role === "assistant" && !groupTurn) onAssistantMessageSaved(cid, msg);
      } else if (ev.type === "text_rewrite" || ev.type === "content_replace") {
        // 조기 캡처 뒤 본문이 재작성되면 그 캡처는 낡은 텍스트 기준 → complete에서 재캡처
        const state = earlyCaptureByChat[cid];
        if (state) state.stale = true;
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE 이벤트 구분자는 빈 줄. 이벤트 안의 data: 라인만 모아 JSON 파싱한다.
        let m;
        while ((m = buf.match(/\r?\n\r?\n/))) {
          const rawEvent = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const dataLines = [];
          for (const line of rawEvent.split(/\r?\n/)) {
            if (line.lastIndexOf("data:", 0) === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          if (dataLines.length) handlePayload(dataLines.join("\n"));
        }
      }
    } catch (_) {
      // 스트림 중단(취소/네트워크)은 무시 — generation-error/complete 경로가 뒷정리한다
    } finally {
      try { reader.cancel(); } catch (_) {}
    }
  }
  function onAssistantMessageSaved(cid, msg) {
    if (!cid || suppressPhaseByChat[cid] || generationErrorByChat[cid]) return;
    const st = getSettings(cid);
    if (!st.enabled) return;
    // 후처리 에이전트(prose-guardian/continuity/html/text-rewrite)가 본문을 다시 쓸 턴이면
    // 지금 캡처해도 재작성 전 텍스트를 읽게 된다 → 조기 캡처를 포기하고 기존대로
    // generation-complete를 기다린다. (엔진이 저장 메시지 extra에 postProcessingPending을 남긴다)
    let extra = msg.extra;
    if (typeof extra === "string") { try { extra = JSON.parse(extra); } catch (_) { extra = null; } }
    if (extra && extra.postProcessingPending) {
      const held = earlyCaptureByChat[cid];
      if (held) held.stale = true;
      return;
    }
    const state = earlyCaptureByChat[cid];
    // 같은 스트림의 두 번째 assistant 메시지(그룹 턴 등) — 조기 캡처가 중간 상태를 찍었으니
    // complete 시점에 최종 상태로 다시 캡처한다.
    if (state) { state.stale = true; return; }
    earlyCaptureByChat[cid] = { stale: false, msgId: msg.id };
    diag.earlyCaptureTs = Date.now();
    beginCaptureForCompletedTurn(cid);
  }
  // 완료된 턴에 대한 캡처 진입 — generation-complete 핸들러와 message_saved 조기 경로가 공용.
  function beginCaptureForCompletedTurn(cid) {
    if (cid && !suppressPhaseByChat[cid] && getSettings(cid).enabled) {
      const completedTarget = genTargetByChat[cid] || "__latest__";
      const knownLatestId = latestAsstByChat[cid] && latestAsstByChat[cid].id;
      // 새 답변/최신 답변 재생성인데 생성 중 포커스 계산이 직전 메시지를 '과거 포커스'로
      // 남겨 둔 경우 pending 가드가 우회된다. 최신 대상이면 포커스를 메타 동기화 뒤까지 비운다.
      if (completedTarget === "__latest__" || (knownLatestId && completedTarget === knownLatestId)) {
        delete focusedMsgByChat[cid];
      }
      markPendingTurnDisplay(cid, completedTarget);
      setCaptureNotice(cid, null);
      invalidateFloat();
    }
    scheduleAutoCapture(cid);
  }
  // marinara.on이 없는 빌드에서도 이벤트 등록이 무음으로 빠지지 않도록 폴백
  const onWinEvent = (name, fn) => { if (marinara.on) marinara.on(window, name, fn); else window.addEventListener(name, fn); };
  {
    // mari-phase: 생성 중 UI 상태(스피너·타겟 스냅샷·원문 블록 숨김)만 담당. 캡처는 하지 않음.
    onWinEvent("marinara:mari-phase", (e) => {
      const d = e && e.detail; if (!d) return;
      // 이벤트가 chatId를 명시했는지 구분한다. 명시 안 됐으면(=폴백으로 getChatId 사용)
      //  스피너를 '켜는' 판단에는 쓰지 않는다 — 다른 채팅 생성 이벤트가 현재 보는 채팅으로
      //  오귀속되어 스피너가 엉뚱한 채팅에서 도는 누수를 막기 위함.
      const explicitCid = (typeof d.chatId === "string" && d.chatId) ? d.chatId : null;
      const cid = explicitCid || getChatId();
      const phase = d.phase;
      if (phase === "thinking" || phase === "updating") {
        if (suppressPhaseByChat[cid]) {
          outputStartedByChat[cid] = false;
          if (isGeneratingByChat[cid]) { isGeneratingByChat[cid] = false; invalidateFloat(); }
          return;
        }
        outputStartedByChat[cid] = true;
        // 생성 시작 시 타겟 메시지 결정.
        //   fetch 훅이 /api/generate 의 regenerateMessageId로 이미 정확히 잡았으면(genTargetExplicit) 그대로 사용.
        //   못 잡은 경우(훅 미작동 등)에만 포커스로 보조 추측하되, 최신이 화면에 보이면 최신(null)으로.
        // earlyCaptureByChat 가드: 조기 캡처가 이미 타겟을 소비한 뒤 에이전트 단계의
        // mari-phase가 포커스 추측으로 엉뚱한 타겟을 다시 채우는 것을 막는다.
        if (!genTargetExplicit[cid] && !(cid in genTargetByChat) && !earlyCaptureByChat[cid]) {
          const fNow = focusedMsgByChat[cid] || (isInlineDisplayMode() ? findFocusedAssistantMessage(cid) : null);
          const lNow = latestAsstByChat[cid];
          const isTrulyPast = fNow && fNow.id && lNow && lNow.id && fNow.id !== lNow.id && !latestMessageVisible(cid);
          genTargetByChat[cid] = isTrulyPast ? fNow.id : null;
        }
        // 스피너 ON은 chatId가 명시된 이벤트에서만. (chatId 없는 mari-phase는 현재 활성
        //  채팅으로 폴백되므로, 다른 채팅 생성이 활성 채팅 스피너를 켜는 것을 방지)
        if (explicitCid && !isGeneratingByChat[explicitCid]) { isGeneratingByChat[explicitCid] = true; invalidateFloat(); }
        const stLive = getSettings(cid);
        if (stLive.enabled && (stLive.dataMode === DATA_MODES.api || stLive.dataMode === DATA_MODES.inline)) hideRawBlocksInChat();
      } else if (phase === "idle") {
        // 보조 정리만 — 캡처는 generation-complete가 담당 (이 환경에서 idle이 안 뜨는 경우 대비)
        if (isGeneratingByChat[cid]) { isGeneratingByChat[cid] = false; invalidateFloat(); scheduleFocusUpdate(80); }
      }
    });
    // 주 캡처 트리거: 생성이 끝나고 메시지가 커밋된 뒤 매번 무조건 발생하는 이벤트.
    // (mari-phase idle은 SSE 흐름에 따라 누락될 수 있어 신뢰할 수 없음)
    onWinEvent("marinara:generation-complete", (e) => {
      const d = e && e.detail;
      // 이벤트에 chatId가 없으면 '실제 생성 중이던 채팅'으로 귀속 (getChatId 폴백 금지 —
      //  생성 중 다른 채팅으로 이동해 있으면 그 채팅으로 오귀속돼 원래 채팅 캡처가 누락된다)
      const cid = resolveGenChatId(d && d.chatId);
      if (cid && generationErrorByChat[cid]) {
        delete generationErrorByChat[cid];
        delete earlyCaptureByChat[cid];
        clearPendingTurnDisplay(cid);
        return;
      }
      // message_saved 조기 캡처가 이미 이 턴을 처리했으면 중복 캡처(중복 LLM 호출)를 막는다.
      // stale(같은 턴에 추가 저장·재작성 발생)이면 최종 내용 기준으로 정상 캡처를 다시 돈다.
      const early = cid ? earlyCaptureByChat[cid] : null;
      if (cid) delete earlyCaptureByChat[cid];
      // mari-phase idle이 안 뜨는 환경 대비: 생성 완료 시 여기서 스피너 상태를 확실히 정리한다.
      if (cid && isGeneratingByChat[cid]) { isGeneratingByChat[cid] = false; delete genStartTsByChat[cid]; invalidateFloat(); }
      if (early && !early.stale) {
        // 조기 캡처가 이미 소비하지 못한 잔여 생성 상태 정리 — 에이전트 단계 중 mari-phase가
        // 포커스 추측으로 genTargetByChat을 다시 채웠을 수 있다(조기 캡처가 explicit 표식을
        // 소비한 뒤라서). 다음 턴에 새어 들어가지 않게 여기서 비운다.
        delete genTargetByChat[cid]; delete genTargetExplicit[cid]; delete genBaselineByChat[cid];
        outputStartedByChat[cid] = false;
        return;
      }
      // 완료 이벤트를 받은 바로 이 순간 이전 턴/이전 스와이프 표시를 가린다.
      // 실제 메시지 ID·스와이프는 scheduleAutoCapture의 즉시 메타 동기화가 확정한다.
      beginCaptureForCompletedTurn(cid);
    });
    // 생성 실패 시 스피너 정리 (+ API 모드면 알림)
    onWinEvent("marinara:generation-error", (e) => {
      const d = e && e.detail;
      const cid = resolveGenChatId(d && d.chatId);
      if (!cid) return;
      delete pendingForceFullByChat[cid]; // 보류 중이던 첫 생성 confirm 응답 폐기
      delete earlyCaptureByChat[cid];
      delete genTargetByChat[cid];
      delete genTargetExplicit[cid];
      delete genBaselineByChat[cid];
      clearPendingTurnDisplay(cid);
      outputStartedByChat[cid] = false;
      generationErrorByChat[cid] = true; // complete가 와도 캡처 건너뜀
      if (isGeneratingByChat[cid]) { isGeneratingByChat[cid] = false; delete genStartTsByChat[cid]; invalidateFloat(); }
      const st = getSettings(cid);
      if (st.enabled && st.dataMode === DATA_MODES.api) {
        // 인라인 모드: 브라우저 중앙 모달 대신 최신 상태창 위 알림으로 (그 채팅을 보고 있을 때만)
        if (isInlineDisplayMode()) {
          if (cid === getChatId()) showFloatNotice("생성에 실패했습니다 — 출력을 받지 못했습니다", "error");
        } else {
          showCaptureModal(cid, "생성에 실패했습니다", "출력을 받지 못했습니다");
        }
      }
    });
  }

  marinara.addStyle(`#${FLOAT_ID} .us-f-ctx{font-size:11px;color:var(--us-float-fg,var(--foreground,#eee));font-family:inherit;padding:0 2px;}`);

  // ── 콘솔 디버그 API ────────────────────────────────────────
  //  브라우저 콘솔(F12)에서 실행:
  //    await __usDebug.dump()          — 카드 로스터 파이프라인 전체 상태 덤프
  //    await __usDebug.refetchRoster() — 로스터 강제 재조회
  //  카드 캐릭터가 값에 안 나오는 원인이 (1)로스터 조회 실패 (2)이름 매칭 (3)프롬프트 주입 누락
  //  (4)저장 병합 누락 (5)표시 필터 중 어디인지 이 덤프 하나로 판별할 수 있다.
  async function usDebugDump() {
    const chatId = getChatId();
    const out = { chatId };
    // ① 서버가 주는 원자료: 이 채팅의 characterIds + 전체 캐릭터 목록에서의 매칭
    try {
      const chatInfo = await marinara.apiFetch(`/chats/${encodeURIComponent(chatId)}`);
      out["①characterIds원문"] = chatInfo && chatInfo.characterIds;
      const raw = chatInfo && chatInfo.characterIds;
      const ids = Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw || "[]"); } catch { return "JSON파싱실패"; } })();
      out["①characterIds파싱"] = ids;
      const allChars = await marinara.apiFetch("/characters");
      out["①전체캐릭터수"] = Array.isArray(allChars) ? allChars.length : String(allChars);
      if (Array.isArray(allChars) && Array.isArray(ids)) {
        out["①매칭된카드"] = allChars.filter((c) => ids.includes(c.id)).map((c) => {
          try {
            let d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
            if (d && d.data && typeof d.data === "object") d = d.data;
            return { id: c.id, name: (d && d.name) || "(name 없음)" };
          } catch (e) { return { id: c.id, 카드파싱오류: String(e && e.message || e) }; }
        });
        out["①매칭실패ID"] = ids.filter((id) => !allChars.some((c) => c.id === id));
      }
    } catch (e) { out["①서버조회오류"] = String((e && e.message) || e); }
    // ② 확장 내부 로스터 캐시 상태
    out["②로스터캐시"] = (cardRosterByChat[chatId] || []).slice();
    out["②빈로스터TTL시각"] = cardRosterEmptyTsByChat[chatId] || null;
    out["②카드본문캐시"] = (cardDataByChat[chatId] || []).map((c) => c && c.name);
    // ③ 설정/숨김 상태
    const st = getSettings(chatId);
    out["③설정"] = { enabled: st.enabled, dataMode: st.dataMode, hiddenExcludeFromPrompt: st.hiddenExcludeFromPrompt, incCharacters: st.incCharacters };
    out["③숨긴캐릭터"] = getHiddenArr(chatId).slice();
    // ④ 프롬프트에 주입될 필수 인물 목록 (지금 다시 계산)
    try { out["④필수인물목록"] = await resolveSubjectNames(chatId, statusForChat(chatId)); }
    catch (e) { out["④계산오류"] = String((e && e.message) || e); }
    // ⑤ 저장/표시 상태 — 현재 표시 대상 턴의 저장 라벨 vs 화면 표시 라벨
    const meta = currentRenderMeta(chatId);
    out["⑤표시대상"] = meta;
    const entrySubs = getMsgValues(chatId, meta.id, meta.swipe);
    out["⑤저장된라벨"] = Array.isArray(entrySubs) ? entrySubs.map((s) => s && s.label) : null;
    out["⑤화면표시라벨"] = (currentSubjects(chatId) || []).map((s) => s && s.label);
    // ⑥ 마지막 캡처 진단 (캡처를 한 번이라도 돌린 뒤에 채워짐)
    out["⑥마지막캡처"] = {
      프롬프트주입인물: diag.lastSubjectNames || "(캡처 전)",
      카드로스터: diag.lastCardNames || "(캡처 전)",
      AI출력라벨: diag.lastParsedLabels || "(캡처 전)",
      최종저장라벨: diag.lastKeepLabels || "(캡처 전)",
      apiErr: diag.apiErr, captureTs: diag.captureTs ? new Date(diag.captureTs).toLocaleTimeString() : null,
    };
    const rawOut = lastRawOutputByChat[chatId];
    out["⑥마지막출력원문(앞4000자)"] = rawOut && rawOut.text ? rawOut.text.slice(0, 4000) : null;
    out["⑦실행상태"] = {
      채팅생성중: !!isGeneratingByChat[chatId],
      상태캡처중: !!captureBusyByChat[chatId],
      수동새로고침중: refreshing && refreshingChatId === chatId,
      dryRunId: activeDryRunIdByChat[chatId] || null,
      새턴표시대기: pendingTurnDisplayByChat[chatId] || null,
      현재턴판정: captureNoticeByChat[chatId] || null,
    };
    console.log("[User Status DEBUG]", out);
    return out;
  }
  try {
    window.__usDebug = {
      dump: usDebugDump,
      refetchRoster: () => ensureCardRoster(getChatId(), { force: true }),
    };
    if (marinara.onCleanup) marinara.onCleanup(() => { try { delete window.__usDebug; } catch (_) {} });
  } catch (_) {}

  marinara.setInterval(tick, 3000);
  // base 스타일(위 marinara.addStyle)이 모두 <head> 에 들어간 뒤 윈도우 CSS 를 적용해야
  // <head> 마지막에 위치해 base 를 덮어쓴다(스킨이 첫 로드부터 바로 먹도록).
  applyWindowCss();
  renderFloat();
  syncMessages();
  // 확장 제거/정리 시 주입한 DOM을 모두 걷어낸다 (스타일만 사라지고 잔상이 남는 문제 방지)
  if (marinara.onCleanup) marinara.onCleanup(() => {
    try {
      [FLOAT_ID, PANEL_ID, MODAL_ID, FLOAT_NOTICE_ID, CAPTURE_MODAL_ID, PROMPT_BUBBLE_ID,
       WINDOW_CSS_STYLE_ID, WINDOW_CSS_PANEL_OVERRIDE_ID].forEach((id) => {
        const e = document.getElementById(id); if (e) e.remove();
      });
      // 혹시 모를 잔여 노드(클래스 기반)도 정리
      document.querySelectorAll("#" + CAPTURE_MODAL_ID + ", #" + FLOAT_NOTICE_ID).forEach((e) => e.remove());
      Object.values(savePending).forEach((id) => clearTimeout(id));
      Object.values(captureTimerByChat).forEach((id) => clearTimeout(id));
      [stripReapplyDebounce, hideDebounce, focusDebounce, observeDebounce, inlineMountDebounce].forEach((id) => clearTimeout(id));
      document.querySelectorAll(`[${INLINE_STATUS_ATTR}]`).forEach((e) => e.remove());
      document.querySelectorAll(`[${INLINE_SLOT_ATTR}]`).forEach((e) => e.remove());
      document.documentElement.classList.remove("us-custom-css-active");
    } catch (e) {}
  });
  console.log(`[User Status] v2.1.0 loaded (${runtime.mode})`);
})(marinara);