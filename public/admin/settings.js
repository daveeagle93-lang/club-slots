import { brandPage, DEFAULT_CLUB, isLogoUrl, loadSettings } from "../branding.js";
import { checkTheme, DEFAULT_THEME, normaliseHex, PAGE_COLOURS, PRESETS, themeTokens } from "../theme.js";
import { createApi, makeH } from "./api.js";
import { DEFAULT_MARK_SOURCE, updateDefaultIcons, updateIcons } from "./icon-image.js";
import { browserImage, bytesToBase64, LogoError, prepareLogo } from "./logo-image.js";

const OFFLINE = "We couldn't reach the server. Check your connection and try again.";
const GENERIC = "Something went wrong. Try again.";
const SETTINGS_URL = "/api/admin/settings";

/** The server's own words when it gave any (`error.message`, or a bare `message`), else ours. */
const messageOf = (data, fallback = GENERIC) => data?.error?.message ?? data?.message ?? fallback;
const formatBytes = (n) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
const sizeText = (w, h, bytes) => `${w} × ${h} px, ${formatBytes(bytes)}`;

/**
 * Wires the settings page into `#app`: club details, logo and colours, each its own form with its own Save and
 * its own messages. `image` is the decoder/canvas set `prepareLogo` needs (see logo-image.js); `now` stamps the
 * theme stylesheet URL after a save. Resolves once the first load has settled.
 */
export async function init({ document, fetch, navigate, image, now = Date.now }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);
  const show = (...nodes) => root.replaceChildren(...nodes);

  try {
    if (!(await api.loadSession())) return;
  } catch {
    show(h("div", { class: "message", role: "alert" },
      h("p", {}, "We couldn't check that you're signed in. Check your connection and reload the page.")));
    return;
  }

  async function load() {
    show(h("p", { class: "message", role: "status" }, "Loading settings…"));
    let res;
    try {
      res = await api.request("GET", SETTINGS_URL);
    } catch {
      return failure();
    }
    if (res.status === 401) return;
    if (res.status !== 200 || !res.data) return failure(res);
    render(res.data);
  }

  function failure(res) {
    const retry = h("button", { type: "button", class: "button" }, "Retry");
    retry.addEventListener("click", load);
    show(h("div", { class: "message", role: "alert" },
      h("p", {}, res ? messageOf(res.data, "We couldn't load the settings. Try again.") : "We couldn't load the settings. Check your connection and try again."),
      retry));
  }

  /**
   * One form with its own error summary (focused on failure), status line (announced on success) and busy flag.
   * `sync()` is set by the section and decides which buttons are disabled; it runs whenever busy changes.
   */
  function makeSection(id, title) {
    const summary = h("p", { class: "form-error", role: "alert", tabindex: "-1" });
    const status = h("p", { class: "form-status", role: "status" });
    const form = h("form", { id, novalidate: true, "aria-labelledby": `${id}-heading` }, h("h2", { id: `${id}-heading` }, title));
    const section = {
      form, summary, status, busy: false, after: null, sync() {},
      fail(text) {
        status.textContent = "";
        summary.textContent = text;
        summary.focus();
      },
      ok(text) {
        summary.textContent = "";
        status.textContent = text;
      },
      /** One request at a time: a second submit while this runs does nothing. */
      async run(task) {
        if (section.busy) return;
        section.busy = true;
        const had = document.activeElement;
        summary.textContent = "";
        status.textContent = "";
        form.setAttribute("aria-busy", "true");
        section.sync();
        try {
          await task();
        } catch {
          section.fail(OFFLINE);
        } finally {
          section.busy = false;
          form.removeAttribute("aria-busy");
          section.sync();
          // Disabling the focused button (or removing it) drops focus to the page; hand it back so a keyboard user
          // keeps their place. `after` is where to go when the button is gone.
          const target = section.after ?? had;
          section.after = null;
          if ((document.activeElement === document.body || !document.activeElement) && target && !target.disabled && !target.hidden) target.focus();
        }
      },
    };
    return section;
  }

  // ---- Club details ----
  const DETAIL_FIELDS = [
    {
      key: "clubName", id: "club-name", label: "Club name",
      hint: "Shown in the page header, the browser tab, calendar entries and the lineup.",
      attrs: { type: "text", autocomplete: "off" },
    },
    {
      key: "privacyContact.name", id: "contact-name", label: "Privacy contact name",
      hint: "Shown to people booking, so they know who to contact about their details.",
      attrs: { type: "text", autocomplete: "off" },
    },
    {
      key: "privacyContact.email", id: "contact-email", label: "Privacy contact email",
      hint: "The contact only counts as set once it has an email address.",
      attrs: { type: "email", autocomplete: "off", autocapitalize: "off", spellcheck: "false", inputmode: "email" },
    },
    {
      key: "website", id: "website", label: "Website (optional)",
      hint: "A link starting https://, shown at the foot of the public pages.",
      attrs: { type: "url", autocomplete: "off", autocapitalize: "off", spellcheck: "false", inputmode: "url" },
    },
  ];

  function detailsSection(initial, onClubName) {
    const s = makeSection("details", "Club details");
    const fields = new Map(); // key -> { input, error }
    const children = DETAIL_FIELDS.map(({ key, id, label, hint, attrs }) => {
      const input = h("input", { id, name: id, "aria-describedby": `${id}-hint ${id}-error`, ...attrs });
      const error = h("p", { id: `${id}-error`, class: "field-error" });
      fields.set(key, { input, error });
      return h("div", { class: "field" }, h("label", { for: id }, label), input,
        h("p", { class: "note", id: `${id}-hint` }, hint), error);
    });
    const save = h("button", { type: "submit", class: "button primary" }, "Save details");
    s.sync = () => { save.disabled = s.busy; };

    const fill = (d) => {
      fields.get("clubName").input.value = d?.clubName ?? "";
      fields.get("privacyContact.name").input.value = d?.privacyContact?.name ?? "";
      fields.get("privacyContact.email").input.value = d?.privacyContact?.email ?? "";
      fields.get("website").input.value = d?.website ?? "";
      onClubName(fields.get("clubName").input.value);
    };
    const showErrors = (messages) => {
      for (const [key, { input, error }] of fields) {
        const message = typeof messages?.[key] === "string" ? messages[key] : "";
        error.textContent = message;
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    };
    fields.get("clubName").input.addEventListener("input", (e) => onClubName(e.target.value));

    s.form.addEventListener("submit", (event) => {
      event.preventDefault();
      s.run(async () => {
        showErrors(null);
        const value = (key) => fields.get(key).input.value.trim();
        const res = await api.request("PUT", SETTINGS_URL, {
          clubName: value("clubName"),
          privacyContact: { name: value("privacyContact.name"), email: value("privacyContact.email") },
          website: value("website"),
        });
        if (res.status === 401) return;
        if (res.status === 200 && res.data) {
          fill(res.data);
          return s.ok("Club details saved.");
        }
        if (res.status === 400 && res.data?.fields) {
          showErrors(res.data.fields);
          return s.fail("Not saved. Check the highlighted fields.");
        }
        s.fail(`Not saved. ${messageOf(res.data)}`);
      });
    });

    s.form.append(...children, s.summary, h("div", { class: "actions" }, save), s.status);
    fill(initial);
    s.sync();
    return s;
  }

  // ---- App icons ----
  const ICON_RETRY = "app icons couldn't be updated. They'll be tried again next time you open this page.";

  /**
   * Keeps the app icons (browser tab, home screen, manifest) drawn from the current logo, or with no logo from the
   * default mark, on the current main colour. It has no form: it runs after a logo upload or removal, after a colour
   * save that changed the main colour, and when the page loads and the stored icons are missing or out of date. A
   * failure is reported on its own status line and never undoes or blocks the save that triggered it: until the icons
   * are redrawn the server serves the ones it has (for a changed logo, the bundled default ones).
   */
  function iconsSection(initial) {
    const status = h("p", { class: "form-status", id: "icon-status", role: "status", "aria-live": "polite" });
    const state = { logo: initial.logo, blob: null, primary: initial.primary };
    let latest = 0; // each update takes the next number; an older one that finds it isn't latest stops quietly

    async function logoBlob(logo) {
      if (state.blob) return state.blob;
      if (!isLogoUrl(logo.url)) throw new Error("The logo's address isn't one of ours");
      const res = await fetch(logo.url);
      if (!res.ok) throw new Error(`Logo request failed (${res.status})`);
      return res.blob();
    }

    /** `because` starts the sentence if it fails: what already succeeded, so the message is true whatever triggered this. */
    async function update(because) {
      const mine = ++latest;
      const { logo, primary } = state;
      status.textContent = "Updating app icons…";
      try {
        const run = {
          background: primary, image,
          isCurrent: () => mine === latest,
          put: async (size, body) => (await api.request("PUT", `${SETTINGS_URL}/icons/${size}`, body)).status === 200,
        };
        if (logo) await updateIcons({ ...run, logo: await logoBlob(logo), logoSha256: logo.sha256 });
        else await updateDefaultIcons(run);
        if (mine === latest) status.textContent = "App icons updated.";
      } catch {
        if (mine === latest) status.textContent = `${because} ${ICON_RETRY}`;
      }
    }

    return {
      status,
      /** A new logo (with its decoded-ready bytes, so it needn't be fetched back) or none (the default mark). */
      logoChanged(logo, blob = null) {
        state.logo = logo;
        state.blob = blob;
        return update(logo ? "The logo was saved, but the" : "The logo was removed, but the");
      },
      /** The main colour after a save or reset. Only a different colour needs new icons. */
      primaryChanged(primary) {
        if (primary === state.primary) return;
        state.primary = primary;
        return update("The colours were saved, but the");
      },
      /** The page has just loaded: redraw if the stored icons are missing or were drawn from something else (the logo, or with none the default mark). */
      heal(stored) {
        const source = state.logo?.sha256 ?? DEFAULT_MARK_SOURCE;
        if (!stored || stored.background !== state.primary || stored.logoSha256 !== source) return update("The");
      },
    };
  }

  // ---- Logo ----
  function logoSection(initial, icons) {
    const s = makeSection("logo", "Logo");
    let logo = initial;
    let candidate = null; // the processed picture waiting for "Use this logo"
    let choosing = 0; // bumped on every new choice, so a slow earlier one can't overwrite a later one
    let confirm = null;

    const current = h("div", { class: "logo-current" });
    const fileInput = h("input", { id: "logo-file", type: "file", accept: "image/png,image/jpeg,image/webp", "aria-describedby": "logo-file-hint" });
    const preview = h("div", { class: "logo-preview", hidden: true });
    const use = h("button", { type: "submit", class: "button primary", hidden: true }, "Use this logo");
    const remove = h("button", { type: "button", class: "button" }, "Remove logo");
    const confirmHost = h("div");

    s.sync = () => {
      use.disabled = s.busy;
      fileInput.disabled = s.busy;
      remove.disabled = s.busy || confirm !== null;
      for (const b of confirmHost.querySelectorAll("button")) b.disabled = s.busy;
    };

    function renderCurrent() {
      if (logo) {
        current.replaceChildren(
          ...(isLogoUrl(logo.url) ? [h("img", { class: "logo-img", src: logo.url, width: String(logo.width), height: String(logo.height), alt: "Current logo" })] : []),
          h("p", { class: "note" }, `Current logo: ${sizeText(logo.width, logo.height, logo.bytes)}`));
      } else {
        current.replaceChildren(h("p", { class: "note" }, "No logo"));
      }
      remove.hidden = !logo;
    }

    function clearCandidate() {
      candidate = null;
      preview.hidden = true;
      preview.replaceChildren();
      use.hidden = true;
    }

    function closeConfirm() {
      confirm = null;
      confirmHost.replaceChildren();
      s.sync();
    }

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      const mine = ++choosing;
      clearCandidate();
      s.ok("");
      if (!file) return;
      fileInput.value = "";
      s.ok("Preparing your picture…");
      let result;
      try {
        result = await prepareLogo(file, image);
      } catch (e) {
        if (mine === choosing) s.fail(e instanceof LogoError ? e.message : "We couldn't read that picture. Try a different one.");
        return;
      }
      if (mine !== choosing) return;
      const data = bytesToBase64(result.bytes);
      candidate = { data, ...result };
      preview.replaceChildren(
        h("img", { class: "logo-img", src: `data:${result.contentType};base64,${data}`, width: String(result.width), height: String(result.height), alt: "Preview of the new logo" }),
        h("p", { class: "note" }, `Preview: ${sizeText(result.width, result.height, result.bytes.length)}. It isn't saved until you choose Use this logo.`));
      preview.hidden = false;
      use.hidden = false;
      s.ok("Your picture is ready. Check the preview, then choose Use this logo.");
    });

    s.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const sending = candidate;
      if (!sending) return;
      s.run(async () => {
        const res = await api.request("PUT", `${SETTINGS_URL}/logo`, { data: sending.data });
        if (res.status === 401) return;
        if (res.status === 200 && res.data?.logo) {
          logo = res.data.logo;
          clearCandidate();
          renderCurrent();
          s.after = fileInput;
          s.ok("Logo saved.");
          // Not awaited: the icons are drawn in the background and have their own status line.
          icons.logoChanged(logo, new Blob([sending.bytes], { type: sending.contentType }));
          return;
        }
        if (res.status === 413) return s.fail("Not saved. The server says that picture is too large.");
        s.fail(`Not saved. ${messageOf(res.data)}`);
      });
    });

    remove.addEventListener("click", () => {
      if (s.busy || confirm) return;
      const yes = h("button", { type: "button", class: "button danger" }, "Yes, remove logo");
      const no = h("button", { type: "button", class: "button" }, "Cancel");
      no.addEventListener("click", () => {
        if (s.busy) return;
        closeConfirm();
        remove.focus();
      });
      yes.addEventListener("click", () => {
        s.run(async () => {
          const res = await api.request("DELETE", `${SETTINGS_URL}/logo`);
          if (res.status === 401) return;
          if (res.status === 200) {
            logo = null;
            closeConfirm();
            renderCurrent();
            s.after = fileInput;
            icons.logoChanged(null);
            return s.ok("Logo removed.");
          }
          s.fail(`Not removed. ${messageOf(res.data)}`);
        });
      });
      confirm = h("div", { class: "confirm", role: "group", "aria-label": "Remove the logo" },
        h("p", {}, "Remove the logo? The pages will show only the club name."),
        h("div", { class: "actions" }, yes, no));
      confirmHost.replaceChildren(confirm);
      s.sync();
      no.focus();
    });

    s.form.append(
      current,
      h("div", { class: "field" }, h("label", { for: "logo-file" }, "Choose a logo"), fileInput,
        h("p", { class: "note", id: "logo-file-hint" }, "PNG, JPEG or WebP. It is resized in your browser to fit within 512 px and under 200 KB.")),
      preview, s.summary,
      h("div", { class: "actions" }, use, remove),
      confirmHost, s.status);
    renderCurrent();
    s.sync();
    return s;
  }

  // ---- Colours ----
  function themeSection(initial, icons) {
    const s = makeSection("theme", "Colours");
    const start = {
      primary: normaliseHex(initial?.primary) ?? DEFAULT_THEME.primary,
      accent: normaliseHex(initial?.accent) ?? DEFAULT_THEME.accent,
    };
    let clubName = DEFAULT_CLUB;
    let ok = true;

    const picker = (key, id, label, hint) => {
      const input = h("input", { id, name: id, type: "color", "aria-describedby": `${id}-hint ${id}-hex ${id}-error` });
      input.value = start[key];
      const hex = h("span", { id: `${id}-hex`, class: "hex" });
      const error = h("p", { id: `${id}-error`, class: "field-error" });
      input.addEventListener("input", edited);
      const node = h("div", { class: "field" }, h("label", { for: id }, label),
        h("div", { class: "colour-row" }, input, hex), h("p", { class: "note", id: `${id}-hint` }, hint), error);
      return { key, input, hex, error, node };
    };
    const primary = picker("primary", "primary-colour", "Main colour", "Buttons, selected slots and the header band.");
    const accent = picker("accent", "accent-colour", "Accent colour", "Links and outlined buttons.");

    const presets = PRESETS.map((preset) => {
      const swatch = h("span", { class: "swatch", "aria-hidden": "true" });
      swatch.style.setProperty("--sw-primary", preset.primary);
      swatch.style.setProperty("--sw-accent", preset.accent);
      const button = h("button", { type: "button", class: "preset", "aria-pressed": "false" }, swatch, preset.name);
      button.addEventListener("click", () => {
        primary.input.value = preset.primary;
        accent.input.value = preset.accent;
        edited();
      });
      return { preset, button };
    });

    const panel = (mode, label) => {
      const club = h("span", {});
      const el = h("div", { class: `pv pv-${mode}`, "aria-hidden": "true" },
        h("div", { class: "pv-header" }, club),
        h("div", { class: "pv-body" }, h("div", { class: "pv-card" },
          h("span", { class: "pv-btn pv-primary" }, "Book a slot"),
          h("span", { class: "pv-btn pv-outline" }, "Outlined button"),
          h("span", { class: "pv-link" }, "A link"),
          h("span", { class: "pv-tiles" }, h("span", { class: "pv-tile" }, "09:00"), h("span", { class: "pv-tile selected" }, "09:20")))));
      return { mode, club, el, node: h("figure", { class: "pv-wrap" }, h("figcaption", {}, label), el) };
    };
    const panels = [panel("light", "Light"), panel("dark", "Dark")];

    // The detail block is rebuilt on every input event, so it is not a live region: a screen reader would read out
    // a stream while a picker is dragged. This element is, and it only changes when the overall result does.
    const contrast = h("div", { class: "contrast" });
    const announcement = h("p", { class: "visually-hidden", role: "status" });
    let announced = "";
    const blocked = h("p", { class: "note", id: "theme-blocked", hidden: true },
      "Save is unavailable until the contrast problems above are fixed. Try a darker main or accent colour.");
    const save = h("button", { type: "submit", class: "button primary", "aria-describedby": "theme-blocked" }, "Save colours");
    const reset = h("button", { type: "button", class: "button" }, "Reset to default colours");
    s.sync = () => {
      save.disabled = s.busy || !ok;
      reset.disabled = s.busy;
    };

    function renderContrast(check) {
      const failed = check.checks.filter((c) => !c.pass && c.blocking);
      const advice = check.checks.filter((c) => !c.pass && !c.blocking);
      const line = (c, tail) => h("li", {}, `${c.label} has a contrast of ${c.ratio.toFixed(2)}:1; ${tail(c)}`);
      const nodes = [];
      if (failed.length > 0) {
        nodes.push(h("p", {}, "These colours can't be saved yet:"),
          h("ul", {}, ...failed.map((c) => line(c, (x) => `it needs at least ${x.min}:1.`))));
      } else if (!check.ok) {
        nodes.push(h("p", {}, "These colours can't be saved yet: one of them isn't a valid colour."));
      } else {
        nodes.push(h("p", {}, "All contrast checks pass."));
      }
      if (advice.length > 0) {
        nodes.push(h("p", {}, "Advice (you can still save):"),
          h("ul", {}, ...advice.map((c) => line(c, (x) => `${x.min}:1 is recommended so the buttons stand out.`))));
      }
      contrast.setAttribute("class", check.ok ? "contrast" : "contrast fail");
      contrast.replaceChildren(...nodes);

      const state = JSON.stringify([check.invalid, failed.map((c) => c.id), advice.map((c) => c.id)]);
      if (state === announced) return;
      announced = state;
      announcement.textContent = failed.length > 0
        ? `These colours can't be saved yet: ${failed.length} contrast ${failed.length === 1 ? "check fails" : "checks fail"}. Details are below the previews.`
        : !check.ok ? "These colours can't be saved yet: one of them isn't a valid colour."
        : advice.length > 0 ? "All contrast checks pass. There is advice about the main colour below the previews."
        : "All contrast checks pass.";
    }

    /** Everything that follows from the two colours: hex text, pressed preset, both previews, contrast and Save. */
    function update() {
      const theme = { primary: primary.input.value, accent: accent.input.value };
      primary.hex.textContent = theme.primary;
      accent.hex.textContent = theme.accent;
      for (const { preset, button } of presets) {
        const match = preset.primary === normaliseHex(theme.primary) && preset.accent === normaliseHex(theme.accent);
        button.setAttribute("aria-pressed", match ? "true" : "false");
      }
      const check = checkTheme(theme);
      if (!check.invalid.length) {
        const tokens = themeTokens(theme);
        // Set per panel so the samples show both modes whatever the visitor's own colour scheme is.
        for (const { mode, el, club } of panels) {
          const page = Object.fromEntries(Object.entries(PAGE_COLOURS[mode]).map(([name, value]) => [`--${name}`, value]));
          for (const [name, value] of Object.entries({ ...page, ...tokens[mode] })) el.style.setProperty(name, value);
          club.textContent = clubName;
        }
      }
      renderContrast(check);
      ok = check.ok;
      blocked.hidden = ok;
      s.sync();
    }

    /** A change made by the admin (not a save or reset result), so any earlier "Colours saved." no longer applies. */
    function edited() {
      s.status.textContent = "";
      update();
    }

    const restyle = () => {
      document.querySelector('link[rel="stylesheet"][href^="/api/theme.css"]')?.setAttribute("href", `/api/theme.css?v=${now()}`);
    };
    const showErrors = (messages) => {
      for (const p of [primary, accent]) {
        const message = typeof messages?.[p.key] === "string" ? messages[p.key] : "";
        p.error.textContent = message;
        if (message) p.input.setAttribute("aria-invalid", "true");
        else p.input.removeAttribute("aria-invalid");
      }
    };

    s.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!ok) return;
      s.run(async () => {
        showErrors(null);
        const res = await api.request("PUT", `${SETTINGS_URL}/theme`, { primary: primary.input.value, accent: accent.input.value });
        if (res.status === 401) return;
        if (res.status === 200) {
          restyle();
          s.ok("Colours saved.");
          const saved = normaliseHex(res.data?.theme?.primary);
          if (saved) icons.primaryChanged(saved);
          return;
        }
        if (res.status === 400 && res.data?.fields) {
          showErrors(res.data.fields);
          return s.fail("Not saved. Check the highlighted colours.");
        }
        s.fail(`Not saved. ${messageOf(res.data)}`);
      });
    });

    reset.addEventListener("click", () => {
      s.run(async () => {
        showErrors(null);
        const res = await api.request("DELETE", `${SETTINGS_URL}/theme`);
        if (res.status === 401) return;
        if (res.status === 200) {
          primary.input.value = DEFAULT_THEME.primary;
          accent.input.value = DEFAULT_THEME.accent;
          update();
          restyle();
          s.ok("Colours reset to the default.");
          const reset = normaliseHex(res.data?.theme?.primary);
          if (reset) icons.primaryChanged(reset);
          return;
        }
        s.fail(`Not reset. ${messageOf(res.data)}`);
      });
    });

    s.form.append(
      h("fieldset", { class: "presets-group" }, h("legend", {}, "Start from a preset"),
        h("div", { class: "presets" }, ...presets.map((p) => p.button))),
      primary.node, accent.node,
      h("h3", {}, "Preview"),
      h("p", { class: "note" }, "Dark mode uses lightened versions of your colours automatically. These samples don't depend on your device's setting."),
      h("div", { class: "pv-grid" }, ...panels.map((p) => p.node)),
      contrast, announcement, s.summary,
      h("div", { class: "actions" }, save, reset),
      blocked, s.status);
    update();
    s.setClubName = (name) => {
      clubName = name.trim() || DEFAULT_CLUB;
      for (const p of panels) p.club.textContent = clubName;
    };
    return s;
  }

  function render(data) {
    const icons = iconsSection({ logo: data.logo ?? null, primary: normaliseHex(data.theme?.primary) ?? DEFAULT_THEME.primary });
    const theme = themeSection(data.theme, icons);
    const details = detailsSection(data, theme.setClubName);
    const logo = logoSection(data.logo ?? null, icons);
    show(
      h("a", { class: "back", href: "/admin/" }, "Back to events"),
      h("h1", {}, "Settings"),
      details.form, logo.form, icons.status, theme.form);
    icons.heal(data.icons ?? null);
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/admin/" });
  init({
    document,
    image: browserImage(window),
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}
