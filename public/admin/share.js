import { writeClipboard } from "./api.js";

const SHARE_FAILED = "Sharing isn't available here. Use Copy message or Copy link.";
const SHARE_FAILED_MESSAGE_ONLY = "Sharing isn't available here. Use Copy message.";
const COPY_FAILED = "Couldn't copy automatically. Copy the selected text manually.";

/**
 * The Share control for one event, shared by the events list, the schedule page and the "Event created" page.
 * "Copy message" is always shown. With navigator.share (phones, some desktops) a Share button that opens the native
 * share sheet comes first; without it, "Copy link" is shown too, and it also appears if sharing fails.
 * `getMessage()` and `getLink()` are called at click time, so the text always follows the event as it is now;
 * nothing is cached here. `label` (the event name) goes in the buttons' accessible names, as several controls can
 * be on one page. `copyLink: false` leaves out the "Copy link" button, for a page that already has its own.
 * `copyMessage: false` hides "Copy message" until a share fails, for a page that already has its own. Returns the
 * element to insert.
 * The message is plain text: it is only ever set with .value, textContent or handed to share and the clipboard.
 */
export function shareControls({ h, navigator, clipboard, getMessage, getLink, label, copyLink: withCopyLink = true, copyMessage: alwaysCopyMessage = true }) {
  const status = h("p", { class: "share-status", "aria-live": "polite" });
  const manual = h("div", { class: "field", hidden: true });
  const canShare = typeof navigator?.share === "function";
  let timer;

  const copyButton = (text, aria, read, makeField, hidden) => {
    const button = h("button", { type: "button", class: "button", "aria-label": aria, hidden }, text);
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      const value = read();
      if (await writeClipboard(clipboard, value)) {
        manual.hidden = true;
        status.textContent = "Copied";
        timer = setTimeout(() => { status.textContent = ""; }, 2000);
        return;
      }
      const field = makeField();
      field.value = value;
      manual.replaceChildren(field);
      manual.hidden = false;
      field.focus();
      field.select();
      status.textContent = COPY_FAILED;
    });
    return button;
  };
  const copyMessage = copyButton("Copy message", `Copy message for "${label}"`, getMessage,
    () => h("textarea", { readonly: true, rows: "8", "aria-label": `Message for "${label}"` }),
    canShare && !alwaysCopyMessage);
  const copyLinkButton = copyButton("Copy link", `Copy link for "${label}"`, getLink,
    () => h("input", { type: "text", readonly: true, "aria-label": `Booking link for "${label}"` }),
    canShare);

  const buttons = withCopyLink ? [copyMessage, copyLinkButton] : [copyMessage];
  if (canShare) {
    const share = h("button", { type: "button", class: "button", "aria-label": `Share "${label}"` }, "Share");
    // No await and no request before navigator.share: iOS Safari only opens the sheet inside the tap itself.
    let sharing = false; // a second share while one is open throws InvalidStateError, so taps in between are ignored
    share.addEventListener("click", () => {
      if (sharing) return;
      clearTimeout(timer);
      status.textContent = "";
      sharing = true;
      // Only `text`, not `url` as well: the message already ends with the link, and with both fields iOS and
      // Android WhatsApp add the url to the text again (the link twice), while some apps drop `url` altogether.
      // A synchronous throw is handled like a rejection.
      new Promise((resolve) => resolve(navigator.share({ text: getMessage() }))).catch((error) => {
        if (error?.name === "AbortError") return; // closed the sheet: nothing to report
        copyMessage.hidden = false;
        copyLinkButton.hidden = false;
        status.textContent = withCopyLink ? SHARE_FAILED : SHARE_FAILED_MESSAGE_ONLY;
      }).finally(() => { sharing = false; });
    });
    buttons.unshift(share);
  }
  return h("div", { class: "share" }, h("div", { class: "share-actions" }, ...buttons), status, manual);
}
