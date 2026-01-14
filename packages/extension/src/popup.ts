export {};

interface PopupState {
  blocked: boolean;
  serverConnected: boolean;
  sessions: number;
  working: number;
  bypassActive: boolean;
}

const statusDot = document.getElementById("status-dot") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const sessionsEl = document.getElementById("sessions") as HTMLElement;
const workingEl = document.getElementById("working") as HTMLElement;
const blockBadge = document.getElementById("block-badge") as HTMLElement;
const blockStatus = document.getElementById("block-status") as HTMLElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const toggleOverlayBtn = document.getElementById("toggle-overlay-btn") as HTMLButtonElement;
const overlayIcon = document.getElementById("overlay-icon") as HTMLElement;
const overlayText = document.getElementById("overlay-text") as HTMLElement;

let overlayVisible = true;

function updateUI(state: PopupState): void {
  // Status indicator
  if (!state.serverConnected) {
    statusDot.className = "status-dot disconnected";
    statusText.textContent = "Offline";
  } else if (state.working > 0) {
    statusDot.className = "status-dot working";
    statusText.textContent = "Working";
  } else {
    statusDot.className = "status-dot connected";
    statusText.textContent = "Connected";
  }

  // Stats
  sessionsEl.textContent = String(state.sessions);
  workingEl.textContent = String(state.working);

  // Block badge
  if (state.bypassActive) {
    blockBadge.className = "block-badge bypass";
    blockStatus.textContent = "Bypass";
  } else if (state.blocked) {
    blockBadge.className = "block-badge blocked";
    blockStatus.textContent = "Blocked";
  } else {
    blockBadge.className = "block-badge open";
    blockStatus.textContent = "Open";
  }
}

function refreshState(): void {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state: PopupState) => {
    if (state) {
      updateUI(state);
    }
  });
}

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Update overlay toggle button UI
function updateOverlayButton(): void {
  if (overlayVisible) {
    overlayIcon.textContent = "👁";
    overlayText.textContent = "Hide Overlay";
    toggleOverlayBtn.classList.remove("hidden");
  } else {
    overlayIcon.textContent = "👁‍🗨";
    overlayText.textContent = "Show Overlay";
    toggleOverlayBtn.classList.add("hidden");
  }
}

// Load overlay visibility preference
chrome.storage.sync.get(["overlayVisible"], (result) => {
  overlayVisible = result.overlayVisible !== false; // Default to true
  updateOverlayButton();
});

// Toggle overlay visibility
toggleOverlayBtn.addEventListener("click", () => {
  overlayVisible = !overlayVisible;
  chrome.storage.sync.set({ overlayVisible });
  updateOverlayButton();

  // Broadcast to all tabs
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "OVERLAY_TOGGLE", visible: overlayVisible }).catch(() => {});
      }
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") {
    updateUI(message);
  }
});

refreshState();
setInterval(refreshState, 5000);
