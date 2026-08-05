/* Lets the temporary migration controls borrow Team Invitations' stationery UI. */
(() => {
  "use strict";

  const styleMarkers = [
    ".ryan-transfer-open{",
    ".ryan-semantic-sync-open{",
    ".ryan-v3-recovery-open{",
  ];
  const dialogs = ".ryan-transfer-dialog, .ryan-semantic-sync-dialog, .ryan-v3-recovery-dialog";
  const cards = ".ryan-transfer-card, .ryan-semantic-sync-card, .ryan-v3-recovery-card";
  const headers = ".ryan-transfer-card > header, .ryan-semantic-sync-card > header, .ryan-v3-recovery-card > header";
  const buttons = [
    ".ryan-transfer-open", ".ryan-semantic-sync-open", ".ryan-v3-recovery-open",
    ".ryan-transfer-card button", ".ryan-semantic-sync-card button", ".ryan-v3-recovery-card button",
  ].join(", ");
  const statusPanels = [
    ".ryan-transfer-status", ".ryan-transfer-preview", ".ryan-transfer-sync",
    ".ryan-semantic-sync-status", ".ryan-semantic-sync-card section",
    ".ryan-v3-recovery-card [data-status]",
  ].join(", ");
  const actionRows = ".ryan-transfer-actions, .ryan-semantic-sync-actions, .ryan-v3-recovery-actions";

  function addClass(selector, className) {
    document.querySelectorAll(selector).forEach((element) => element.classList.add(className));
  }

  function decorate() {
    addClass(buttons, "button");
  }

  function applyTheme() {
    if (document.querySelector('style[data-ryan-transfer-theme="team-invites"]')) return;
    document.querySelectorAll("style").forEach((style) => {
      if (styleMarkers.some((marker) => style.textContent.includes(marker))) style.remove();
    });
    addClass(headers, "dialog-header");
    addClass(cards, "dialog-body");
    addClass(statusPanels, "panel");
    addClass(actionRows, "dialog-footer");
    decorate();
    new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });

    const style = document.createElement("style");
    style.dataset.ryanTransferTheme = "team-invites";
    style.textContent = `
      .ryan-transfer-open{position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483000!important}
      .ryan-semantic-sync-open{position:fixed!important;left:20px!important;bottom:20px!important;z-index:2147482998!important}
      .ryan-v3-recovery-open{position:fixed!important;left:20px!important;bottom:72px!important;z-index:2147482996!important}
      ${dialogs}{width:min(720px,calc(100% - 24px))!important;max-height:min(88vh,900px)!important;margin:auto!important;overflow:auto!important}
      .ryan-transfer-dialog{z-index:2147483001!important}
      .ryan-semantic-sync-dialog{z-index:2147482999!important}
      .ryan-v3-recovery-dialog{z-index:2147482997!important}
      ${headers} h2{min-width:0!important}
      ${actionRows},.ryan-semantic-conflict-actions,.ryan-transfer-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:9px!important}
      ${statusPanels}{margin-top:14px!important;padding:13px!important}
      .ryan-transfer-preview h3,.ryan-transfer-sync h3,.ryan-semantic-sync-card h3{margin-top:0!important}
      .ryan-transfer-conflict,.ryan-semantic-conflict{display:grid!important;gap:8px!important;margin-top:12px!important}
      @media(max-width:520px){.ryan-transfer-open{right:12px!important;bottom:12px!important}.ryan-semantic-sync-open{left:12px!important;bottom:12px!important}.ryan-v3-recovery-open{left:12px!important;bottom:64px!important}}
    `;
    document.head.append(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  else applyTheme();
})();
