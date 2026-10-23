(function () {
  "use strict";

  var dismissedKey = "desi-notification-prompt-dismissed";
  var initialDelay = 10000;
  var repeatDelay = 30000;
  var permissionTimer;
  var prompt;
  var message;
  var enableButton;
  var dismissButton;

  function loadAds() {
    fetch("/api/ads", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("Ad settings request failed.");
        return response.json();
      })
      .then(function (settings) {
        [
          ["popunder", settings.popunderSrc],
          ["socialBar", settings.socialBarSrc]
        ].forEach(function (ad) {
          if (!settings[ad[0]] || !ad[1]) return;
          var script = document.createElement("script");
          script.src = ad[1];
          script.async = true;
          script.setAttribute("data-cfasync", "false");
          document.body.appendChild(script);
        });
      })
      .catch(function (error) {
        console.error("Unable to load site ad settings:", error);
      });
  }

  function createPrompt() {
    var backdrop = document.createElement("div");
    backdrop.className = "desi-notification-backdrop";
    backdrop.innerHTML =
      '<section class="desi-notification-dialog" role="dialog" aria-modal="true" aria-labelledby="desi-notification-title">' +
      '<button type="button" class="desi-notification-close" aria-label="Close">&times;</button>' +
      '<span class="desi-notification-icon"><i class="fa-solid fa-bell" aria-hidden="true"></i></span>' +
      '<h2 id="desi-notification-title">Stay up to date</h2>' +
      '<p class="desi-notification-message">Allow notifications to hear about new videos and important site updates.</p>' +
      '<div class="desi-notification-actions">' +
      '<button type="button" class="desi-notification-enable">Enable notifications</button>' +
      '<button type="button" class="desi-notification-dismiss">Maybe later</button>' +
      '</div></section>';
    document.body.appendChild(backdrop);
    prompt = backdrop;
    message = backdrop.querySelector(".desi-notification-message");
    enableButton = backdrop.querySelector(".desi-notification-enable");
    dismissButton = backdrop.querySelector(".desi-notification-dismiss");

    enableButton.addEventListener("click", enableNotifications);
    dismissButton.addEventListener("click", dismissPrompt);
    backdrop.querySelector(".desi-notification-close").addEventListener("click", dismissPrompt);
    updatePermissionMessage();
  }

  function updatePermissionMessage() {
    if (!("Notification" in window) || Notification.permission !== "denied") return;
    message.textContent =
      "Notifications are blocked. Allow them in your browser's site settings, then return here.";
    enableButton.disabled = true;
  }

  function hidePrompt() {
    if (prompt) prompt.remove();
    prompt = null;
    window.clearInterval(permissionTimer);
  }

  function dismissPrompt() {
    hidePrompt();
    try {
      window.localStorage.setItem(dismissedKey, String(Date.now()));
    } catch (error) {
      console.error("Unable to save notification prompt preference:", error);
    }
    window.setTimeout(showPrompt, repeatDelay);
  }

  function showPrompt() {
    if (!("Notification" in window) || Notification.permission === "granted") return;
    if (!prompt) createPrompt();
    if (Notification.permission === "denied") {
      updatePermissionMessage();
    }
    window.clearInterval(permissionTimer);
    permissionTimer = window.setInterval(function () {
      if (Notification.permission === "granted") {
        try {
          window.localStorage.removeItem(dismissedKey);
        } catch (error) {
          console.error("Unable to clear notification prompt preference:", error);
        }
        hidePrompt();
      } else {
        updatePermissionMessage();
      }
    }, 2000);
  }

  function schedulePrompt() {
    if (!("Notification" in window) || Notification.permission === "granted") return;
    var delay = initialDelay;
    try {
      var dismissedAt = Number(window.localStorage.getItem(dismissedKey));
      if (Number.isFinite(dismissedAt) && dismissedAt > 0) {
        delay = Math.max(initialDelay, repeatDelay - (Date.now() - dismissedAt));
      }
    } catch (error) {
      console.error("Unable to read notification prompt preference:", error);
    }
    window.setTimeout(showPrompt, delay);
  }

  function decodeVapidKey(value) {
    var padding = "=".repeat((4 - value.length % 4) % 4);
    var normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(normalized);
    var bytes = new Uint8Array(raw.length);
    for (var index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
  }

  async function enableNotifications() {
    enableButton.disabled = true;
    message.textContent = "Setting up notifications...";
    try {
      if (!("serviceWorker" in navigator)) {
        throw new Error("This browser does not support push notifications.");
      }
      var configResponse = await fetch("/api/notifications/config", { cache: "no-store" });
      if (!configResponse.ok) throw new Error("Notification settings could not be loaded.");
      var config = await configResponse.json();
      if (!config.publicKey) {
        throw new Error("Notifications are not configured on this site yet.");
      }

      var permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") {
        updatePermissionMessage();
        if (permission !== "denied") message.textContent = "Choose Allow in the browser prompt to subscribe.";
        enableButton.disabled = permission === "denied";
        return;
      }

      var registration = await navigator.serviceWorker.register("/sw.js");
      var readyRegistration = await navigator.serviceWorker.ready;
      var subscription = await readyRegistration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(config.publicKey)
        });
      }

      var saved = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON())
      });
      var result = await saved.json();
      if (!saved.ok) throw new Error(result.error || "Your subscription could not be saved.");

      window.localStorage.removeItem(dismissedKey);
      hidePrompt();
    } catch (error) {
      console.error("Notification subscription failed:", error);
      message.textContent = error.message || "Notification setup failed. Please try again.";
      enableButton.disabled = false;
    }
  }

  loadAds();
  if (document.readyState === "complete") {
    schedulePrompt();
  } else {
    window.addEventListener("load", schedulePrompt, { once: true });
  }
})();
