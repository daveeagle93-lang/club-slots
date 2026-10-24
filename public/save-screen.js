const SIGN_IN = "/admin/login";

/**
 * The "save these now" screen, shared by the code flow and the claim flow: shows the admin secret and the recovery code the
 * server made, once. Each is only ever put into its own element: not in the address, in storage, or anywhere else.
 */
export function showSaveScreen({ document, navigator, navigate }, { secret, recoveryCode, signInUrl = SIGN_IN }) {
  const step = document.getElementById("secret-step");
  const heading = document.getElementById("secret-heading");
  const secretBlock = document.getElementById("secret");
  const recoveryBlock = document.getElementById("recovery");
  const copyStatus = document.getElementById("copy-status");
  const saved = document.getElementById("saved");
  const signIn = document.getElementById("sign-in");
  const signInHint = document.getElementById("sign-in-hint");

  secretBlock.textContent = secret;
  recoveryBlock.textContent = recoveryCode;
  step.hidden = false;
  heading.focus(); // so a screen reader reads the "shown only this once" warning before the values

  function wireCopy(button, block, name) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(block.textContent);
        copyStatus.textContent = `Copied the ${name}.`;
      } catch {
        copyStatus.textContent = `Couldn't copy automatically. Select the ${name} above and copy it yourself.`;
      }
    });
  }
  wireCopy(document.getElementById("copy"), secretBlock, "admin secret");
  wireCopy(document.getElementById("copy-recovery"), recoveryBlock, "recovery code");

  // Disabled until the box is ticked, so the values are not left behind by an early click.
  saved.addEventListener("change", () => {
    signIn.disabled = !saved.checked;
    signInHint.hidden = saved.checked;
  });
  signIn.addEventListener("click", () => navigate(signInUrl));
}
