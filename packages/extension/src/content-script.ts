export {};

const MODAL_ID = "claude-blocker-modal";
const TOAST_ID = "claude-blocker-toast";
const OVERLAY_ID = "claude-blocker-overlay";
const MINI_BTN_ID = "claude-blocker-mini-btn";
const DEFAULT_DOMAINS = ["x.com", "youtube.com"];

// Session info from server
interface SessionInfo {
  id: string;
  status: "idle" | "working" | "waiting_for_input";
  project: string;
}

// State shape from service worker
interface PublicState {
  serverConnected: boolean;
  sessions: number;
  working: number;
  waitingForInput: number;
  blocked: boolean;
  bypassActive: boolean;
  sessionList: SessionInfo[];
}

// Track current state so we can re-render if modal gets removed
let lastKnownState: PublicState | null = null;
let shouldBeBlocked = false;
let blockedDomains: string[] = [];
let blockAllSites = false;
let toastDismissed = false;
let overlayVisible = true; // Default to visible

// Load overlay visibility preference
function loadOverlayVisibility(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["overlayVisible"], (result) => {
      resolve(result.overlayVisible !== false); // Default to true
    });
  });
}

// Save overlay visibility preference
function saveOverlayVisibility(visible: boolean): void {
  chrome.storage.sync.set({ overlayVisible: visible });
}

// Load domains from storage
function loadDomains(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["blockedDomains"], (result) => {
      if (result.blockedDomains && Array.isArray(result.blockedDomains)) {
        resolve(result.blockedDomains);
      } else {
        resolve(DEFAULT_DOMAINS);
      }
    });
  });
}

// Load block all setting from storage
function loadBlockAllSetting(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["blockAllSites"], (result) => {
      resolve(result.blockAllSites === true);
    });
  });
}

function isBlockedDomain(): boolean {
  if (blockAllSites) return true;
  const hostname = window.location.hostname.replace(/^www\./, "");
  return blockedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

function getModal(): HTMLElement | null {
  return document.getElementById(MODAL_ID);
}

function getShadow(): ShadowRoot | null {
  return getModal()?.shadowRoot ?? null;
}

function createModal(): void {
  if (getModal()) return;

  const container = document.createElement("div");
  container.id = MODAL_ID;
  const shadow = container.attachShadow({ mode: "open" });

  // Use inline styles with bulletproof Arial font (won't change when page loads custom fonts)
  shadow.innerHTML = `
    <div style="all:initial;position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;z-index:2147483647;-webkit-font-smoothing:antialiased;">
      <div style="all:initial;background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:40px;max-width:480px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased;">
        <svg style="width:64px;height:64px;margin-bottom:24px;" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="11" width="18" height="11" rx="2" fill="#FFD700" stroke="#B8860B" stroke-width="1"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#888" stroke-width="2" fill="none"/>
        </svg>
        <div style="color:#fff;font-size:24px;font-weight:bold;margin:0 0 16px;line-height:1.2;">Time to Work</div>
        <div id="message" style="color:#888;font-size:16px;line-height:1.5;margin:0 0 24px;font-weight:normal;">Loading...</div>
        <div style="display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:#2a2a2a;border-radius:20px;font-size:14px;color:#666;line-height:1;">
          <span id="dot" style="width:8px;height:8px;border-radius:50%;background:#666;flex-shrink:0;"></span>
          <span id="status" style="color:#666;font-size:14px;font-family:Arial,Helvetica,sans-serif;">...</span>
        </div>
        <div id="hint" style="margin-top:24px;font-size:13px;color:#555;line-height:1.4;font-family:Arial,Helvetica,sans-serif;"></div>
        <button id="bypass-btn" style="all:initial;margin-top:24px;padding:12px 24px;background:#333;border:1px solid #444;border-radius:8px;color:#888;font-family:Arial,Helvetica,sans-serif;font-size:13px;cursor:pointer;transition:all 0.2s;">
          Give me 5 minutes (1x per day)
        </button>
      </div>
    </div>
  `;

  // Wire up bypass button
  const bypassBtn = shadow.getElementById("bypass-btn");
  if (bypassBtn) {
    // Check if already used today
    chrome.runtime.sendMessage({ type: "GET_BYPASS_STATUS" }, (status) => {
      if (status?.usedToday) {
        bypassBtn.textContent = "Bypass already used today";
        (bypassBtn as HTMLButtonElement).disabled = true;
        bypassBtn.style.opacity = "0.5";
        bypassBtn.style.cursor = "not-allowed";
      }
    });

    bypassBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "ACTIVATE_BYPASS" }, (response) => {
        if (response?.success) {
          removeModal();
        } else if (response?.reason) {
          bypassBtn.textContent = response.reason;
          (bypassBtn as HTMLButtonElement).disabled = true;
          bypassBtn.style.opacity = "0.5";
          bypassBtn.style.cursor = "not-allowed";
        }
      });
    });

    // Hover effect
    bypassBtn.addEventListener("mouseenter", () => {
      if (!(bypassBtn as HTMLButtonElement).disabled) {
        bypassBtn.style.background = "#444";
        bypassBtn.style.color = "#aaa";
      }
    });
    bypassBtn.addEventListener("mouseleave", () => {
      bypassBtn.style.background = "#333";
      bypassBtn.style.color = "#888";
    });
  }

  // Mount to documentElement (html) instead of body - more resilient to React hydration
  document.documentElement.appendChild(container);
}

function removeModal(): void {
  getModal()?.remove();
}

function getToast(): HTMLElement | null {
  return document.getElementById(TOAST_ID);
}

function showToast(): void {
  if (getToast() || toastDismissed) return;

  const container = document.createElement("div");
  container.id = TOAST_ID;
  const shadow = container.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <div style="all:initial;position:fixed;bottom:24px;right:24px;background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#fff;z-index:2147483647;display:flex;align-items:center;gap:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);-webkit-font-smoothing:antialiased;">
      <span style="font-size:18px;">💬</span>
      <span>Claude has a question for you!</span>
      <button id="dismiss" style="all:initial;margin-left:8px;padding:4px 8px;background:#333;border:none;border-radius:6px;color:#888;font-family:Arial,Helvetica,sans-serif;font-size:12px;cursor:pointer;">Dismiss</button>
    </div>
  `;

  const dismissBtn = shadow.getElementById("dismiss");
  dismissBtn?.addEventListener("click", () => {
    toastDismissed = true;
    removeToast();
  });

  document.documentElement.appendChild(container);
}

function removeToast(): void {
  getToast()?.remove();
}

// ============= STATUS OVERLAY (always-on widget) =============

function getOverlay(): HTMLElement | null {
  return document.getElementById(OVERLAY_ID);
}

function getOverlayShadow(): ShadowRoot | null {
  return getOverlay()?.shadowRoot ?? null;
}

function createOverlay(): void {
  if (getOverlay()) return;

  const container = document.createElement("div");
  container.id = OVERLAY_ID;
  const shadow = container.attachShadow({ mode: "open" });

  // Load saved position or use default
  const savedPos = localStorage.getItem("claude-blocker-overlay-pos");
  let posStyle = "bottom:24px;left:24px;";
  if (savedPos) {
    try {
      const pos = JSON.parse(savedPos);
      posStyle = `top:${pos.top}px;left:${pos.left}px;`;
    } catch {}
  }

  // Create wrapper
  const wrapper = document.createElement("div");
  wrapper.id = "overlay-wrapper";
  wrapper.style.cssText = `all:initial;position:fixed;${posStyle}background:#1a1a1a;border:1px solid #333;border-radius:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#fff;z-index:2147483646;box-shadow:0 4px 12px rgba(0,0,0,0.3);-webkit-font-smoothing:antialiased;min-width:200px;max-width:280px;`;

  // Header (draggable)
  const header = document.createElement("div");
  header.id = "drag-handle";
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #333;cursor:grab;user-select:none;";

  const headerText = document.createElement("span");
  headerText.id = "header-text";
  headerText.style.cssText = "font-weight:600;font-size:12px;color:#888;pointer-events:none;";
  headerText.textContent = "0 Sessions";

  const closeBtn = document.createElement("button");
  closeBtn.id = "close-btn";
  closeBtn.style.cssText = "all:initial;width:20px;height:20px;display:flex;align-items:center;justify-content:center;background:#333;border:none;border-radius:4px;color:#666;font-family:Arial,Helvetica,sans-serif;font-size:14px;cursor:pointer;line-height:1;";
  closeBtn.textContent = "×";

  header.appendChild(headerText);
  header.appendChild(closeBtn);

  // Session list
  const sessionList = document.createElement("div");
  sessionList.id = "session-list";
  sessionList.style.cssText = "padding:8px 0;max-height:200px;overflow-y:auto;";

  const placeholder = document.createElement("div");
  placeholder.style.cssText = "padding:8px 14px;color:#666;font-size:12px;";
  placeholder.textContent = "No sessions";
  sessionList.appendChild(placeholder);

  wrapper.appendChild(header);
  wrapper.appendChild(sessionList);
  shadow.appendChild(wrapper);

  // Wire up close button
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    overlayVisible = false;
    saveOverlayVisibility(false);
    hideOverlay();
  });
  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.background = "#444";
    closeBtn.style.color = "#999";
  });
  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.background = "#333";
    closeBtn.style.color = "#666";
  });

  // Drag functionality - using window instead of document for better cross-origin compatibility
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    const newLeft = e.clientX - dragOffsetX;
    const newTop = e.clientY - dragOffsetY;

    // Keep within viewport bounds
    const maxLeft = window.innerWidth - wrapper.offsetWidth - 10;
    const maxTop = window.innerHeight - wrapper.offsetHeight - 10;
    const clampedLeft = Math.max(10, Math.min(newLeft, maxLeft));
    const clampedTop = Math.max(10, Math.min(newTop, maxTop));

    wrapper.style.left = `${clampedLeft}px`;
    wrapper.style.top = `${clampedTop}px`;
    wrapper.style.bottom = "auto";
    wrapper.style.right = "auto";
  };

  const onMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = "grab";
      // Save position
      const rect = wrapper.getBoundingClientRect();
      localStorage.setItem("claude-blocker-overlay-pos", JSON.stringify({
        top: rect.top,
        left: rect.left
      }));
      // Remove listeners when not dragging to prevent memory leaks
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    }
  };

  header.addEventListener("mousedown", (e) => {
    // Check if click is on close button or its children
    if (closeBtn.contains(e.target as Node)) return;
    isDragging = true;
    header.style.cursor = "grabbing";
    const rect = wrapper.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
    e.stopPropagation();
    // Add listeners in capture phase for better event handling
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  });

  document.documentElement.appendChild(container);
}

function hideOverlay(): void {
  const overlay = getOverlay();
  if (overlay) {
    overlay.style.display = "none";
  }
  // Show mini button when overlay is hidden
  showMiniBtn();
}

function showOverlay(): void {
  // Hide mini button when overlay is shown
  hideMiniBtn();
  const overlay = getOverlay();
  if (overlay) {
    overlay.style.display = "block";
  } else {
    createOverlay();
  }
}

function createStatusDot(status: SessionInfo["status"]): HTMLElement {
  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;flex-shrink:0;";
  switch (status) {
    case "working":
      dot.style.background = "#22c55e";
      dot.style.boxShadow = "0 0 6px #22c55e";
      break;
    case "waiting_for_input":
      dot.style.background = "#eab308";
      dot.style.boxShadow = "0 0 6px #eab308";
      break;
    default:
      dot.style.background = "#666";
      break;
  }
  return dot;
}

function renderOverlay(state: PublicState): void {
  const shadow = getOverlayShadow();
  if (!shadow) return;

  const headerText = shadow.getElementById("header-text");
  const sessionList = shadow.getElementById("session-list");
  if (!headerText || !sessionList) return;

  // Update header
  const workingText = state.working > 0 ? ` (${state.working} working)` : "";
  headerText.textContent = `${state.sessions} Session${state.sessions !== 1 ? "s" : ""}${workingText}`;

  // Clear session list
  sessionList.textContent = "";

  // Update session list
  if (!state.serverConnected) {
    const row = document.createElement("div");
    row.style.cssText = "padding:8px 14px;color:#ef4444;font-size:12px;display:flex;align-items:center;gap:8px;";
    const dot = document.createElement("span");
    dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#ef4444;flex-shrink:0;";
    const text = document.createElement("span");
    text.textContent = "Server offline";
    row.appendChild(dot);
    row.appendChild(text);
    sessionList.appendChild(row);
  } else if (!state.sessionList || state.sessionList.length === 0) {
    const row = document.createElement("div");
    row.style.cssText = "padding:8px 14px;color:#666;font-size:12px;";
    row.textContent = "No active sessions";
    sessionList.appendChild(row);
  } else {
    for (const s of state.sessionList) {
      const row = document.createElement("div");
      row.style.cssText = "padding:6px 14px;display:flex;align-items:center;gap:10px;";
      const dot = createStatusDot(s.status);
      const name = document.createElement("span");
      name.style.cssText = "flex:1;min-width:0;color:#ccc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      name.title = s.project;
      name.textContent = s.project;
      row.appendChild(dot);
      row.appendChild(name);
      sessionList.appendChild(row);
    }
  }
}

// ============= MINI BUTTON (shows when overlay hidden) =============

function getMiniBtn(): HTMLElement | null {
  return document.getElementById(MINI_BTN_ID);
}

function createMiniBtn(): void {
  if (getMiniBtn()) return;

  const container = document.createElement("div");
  container.id = MINI_BTN_ID;
  const shadow = container.attachShadow({ mode: "open" });

  // Load saved position from overlay or use default
  const savedPos = localStorage.getItem("claude-blocker-overlay-pos");
  let posStyle = "bottom:24px;left:24px;";
  if (savedPos) {
    try {
      const pos = JSON.parse(savedPos);
      posStyle = `top:${pos.top}px;left:${pos.left}px;`;
    } catch {}
  }

  const btn = document.createElement("button");
  btn.id = "mini-btn";
  btn.style.cssText = `all:initial;position:fixed;${posStyle}width:36px;height:36px;background:#1a1a1a;border:1px solid #333;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#888;cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);transition:all 0.15s;`;
  btn.textContent = "📊";
  btn.title = "Show Claude Sessions";

  // Track if this was a drag or a click
  let wasDragged = false;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    wasDragged = true;
    const newLeft = e.clientX - dragOffsetX;
    const newTop = e.clientY - dragOffsetY;

    // Keep within viewport bounds
    const maxLeft = window.innerWidth - btn.offsetWidth - 10;
    const maxTop = window.innerHeight - btn.offsetHeight - 10;
    const clampedLeft = Math.max(10, Math.min(newLeft, maxLeft));
    const clampedTop = Math.max(10, Math.min(newTop, maxTop));

    btn.style.left = `${clampedLeft}px`;
    btn.style.top = `${clampedTop}px`;
    btn.style.bottom = "auto";
    btn.style.right = "auto";
  };

  const onMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      btn.style.cursor = "pointer";
      // Save position (same key as overlay so they share position)
      const rect = btn.getBoundingClientRect();
      localStorage.setItem("claude-blocker-overlay-pos", JSON.stringify({
        top: rect.top,
        left: rect.left
      }));
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    }
  };

  btn.addEventListener("mousedown", (e) => {
    isDragging = true;
    wasDragged = false;
    btn.style.cursor = "grabbing";
    const rect = btn.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  });

  btn.addEventListener("click", (e) => {
    // Only open overlay if it wasn't a drag
    if (wasDragged) {
      wasDragged = false;
      return;
    }
    overlayVisible = true;
    saveOverlayVisibility(true);
    hideMiniBtn();
    showOverlay();
    if (lastKnownState) {
      renderOverlay(lastKnownState);
    }
  });

  btn.addEventListener("mouseenter", () => {
    if (!isDragging) {
      btn.style.background = "#2a2a2a";
      btn.style.borderColor = "#444";
      btn.style.transform = "scale(1.05)";
    }
  });

  btn.addEventListener("mouseleave", () => {
    if (!isDragging) {
      btn.style.background = "#1a1a1a";
      btn.style.borderColor = "#333";
      btn.style.transform = "scale(1)";
    }
  });

  shadow.appendChild(btn);
  document.documentElement.appendChild(container);
}

function hideMiniBtn(): void {
  const btn = getMiniBtn();
  if (btn) {
    btn.style.display = "none";
  }
}

function showMiniBtn(): void {
  const existing = getMiniBtn();
  if (existing) {
    // Update position from saved overlay position before showing
    const savedPos = localStorage.getItem("claude-blocker-overlay-pos");
    const btnElement = existing.shadowRoot?.getElementById("mini-btn");
    if (btnElement && savedPos) {
      try {
        const pos = JSON.parse(savedPos);
        btnElement.style.top = `${pos.top}px`;
        btnElement.style.left = `${pos.left}px`;
        btnElement.style.bottom = "auto";
        btnElement.style.right = "auto";
      } catch {}
    }
    existing.style.display = "block";
  } else {
    createMiniBtn();
  }
}

function removeMiniBtn(): void {
  getMiniBtn()?.remove();
}

// ============= END MINI BUTTON =============

// Watch for our modal being removed by the page and re-add it
function setupMutationObserver(): void {
  const observer = new MutationObserver(() => {
    if (shouldBeBlocked && !getModal()) {
      // Modal was removed but should exist - re-create it
      createModal();
      if (lastKnownState) {
        renderState(lastKnownState);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function setDotColor(dot: HTMLElement, color: "green" | "red" | "gray"): void {
  const colors = {
    green: "background:#22c55e;box-shadow:0 0 8px #22c55e;",
    red: "background:#ef4444;box-shadow:0 0 8px #ef4444;",
    gray: "background:#666;box-shadow:none;",
  };
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;${colors[color]}`;
}

function renderState(state: PublicState): void {
  const shadow = getShadow();
  if (!shadow) return;

  const message = shadow.getElementById("message");
  const dot = shadow.getElementById("dot");
  const status = shadow.getElementById("status");
  const hint = shadow.getElementById("hint");
  if (!message || !dot || !status || !hint) return;

  if (!state.serverConnected) {
    message.textContent = "Server offline. Start the blocker server to continue.";
    setDotColor(dot, "red");
    status.textContent = "Server Offline";
    hint.innerHTML = `Run <span style="background:#2a2a2a;padding:2px 8px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12px;">npx claude-blocker</span> to start`;
  } else if (state.sessions === 0) {
    message.textContent = "No Claude Code sessions detected.";
    setDotColor(dot, "green");
    status.textContent = "Waiting for Claude Code";
    hint.textContent = "Open a terminal and start Claude Code";
  } else {
    message.textContent = "Your job finished!";
    setDotColor(dot, "green");
    status.textContent = `${state.sessions} session${state.sessions > 1 ? "s" : ""} idle`;
    hint.textContent = "Type a prompt in Claude Code to unblock";
  }
}

function renderError(): void {
  const shadow = getShadow();
  if (!shadow) return;

  const message = shadow.getElementById("message");
  const dot = shadow.getElementById("dot");
  const status = shadow.getElementById("status");
  const hint = shadow.getElementById("hint");
  if (!message || !dot || !status || !hint) return;

  message.textContent = "Cannot connect to extension.";
  setDotColor(dot, "red");
  status.textContent = "Extension Error";
  hint.textContent = "Try reloading the extension";
}

// Handle state updates from service worker
function handleState(state: PublicState): void {
  lastKnownState = state;

  // Always update the overlay (on all pages)
  if (overlayVisible) {
    if (!getOverlay()) {
      createOverlay();
    }
    renderOverlay(state);
  }

  if (!isBlockedDomain()) {
    shouldBeBlocked = false;
    removeModal();
    removeToast();
    return;
  }

  // Show toast notification when Claude has a question (non-blocking)
  if (state.waitingForInput > 0) {
    showToast();
  } else {
    toastDismissed = false; // Reset so next question can show toast
    removeToast();
  }

  // Show blocking modal when truly idle
  if (state.blocked) {
    shouldBeBlocked = true;
    createModal();
    renderState(state);
  } else {
    shouldBeBlocked = false;
    removeModal();
  }
}

// Request state from service worker
function requestState(): void {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Service worker not ready, retry
      setTimeout(requestState, 500);
      // Only show error modal on blocked domains
      if (isBlockedDomain()) {
        createModal();
        renderError();
      }
      return;
    }
    handleState(response);
  });
}

// Listen for broadcasts from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") {
    handleState(message);
  }
  if (message.type === "DOMAINS_UPDATED") {
    blockedDomains = message.domains;
    // Re-evaluate if we should be blocked
    if (lastKnownState) {
      handleState(lastKnownState);
    }
  }
  if (message.type === "BLOCK_ALL_UPDATED") {
    blockAllSites = message.enabled;
    // Re-evaluate if we should be blocked
    if (lastKnownState) {
      handleState(lastKnownState);
    } else {
      // If we don't have state yet and block all is enabled, request state
      if (blockAllSites) {
        setupMutationObserver();
        createModal();
        requestState();
      }
    }
  }
  if (message.type === "OVERLAY_TOGGLE") {
    overlayVisible = message.visible;
    if (overlayVisible) {
      showOverlay();
      if (lastKnownState) {
        renderOverlay(lastKnownState);
      }
    } else {
      hideOverlay();
    }
  }
});

// Initialize
async function init(): Promise<void> {
  blockedDomains = await loadDomains();
  blockAllSites = await loadBlockAllSetting();
  overlayVisible = await loadOverlayVisibility();

  // Always request state to update overlay (on all pages)
  requestState();

  // Setup blocking modal only on blocked domains
  if (isBlockedDomain()) {
    setupMutationObserver();
  }

  // Create overlay if visible, otherwise show mini button
  if (overlayVisible) {
    createOverlay();
  } else {
    createMiniBtn();
  }
}

init();
