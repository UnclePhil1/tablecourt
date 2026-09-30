/* Table – putting text on the clipboard.

   Its own file because two different screens need it and both of them matter if it quietly fails: the
   match code, which is how somebody joins when a link will not reach them, and the deposit address,
   which is where money goes. An address that was not really copied gets typed by hand, and a base58
   address typed by hand goes to a wallet nobody owns.

   So this never fails silently. It returns whether the text was copied, and every caller says which
   of the two happened. */
const Clip = (function () {
  /** Copy text. Returns true only if it actually reached the clipboard. */
  async function copy(text) {
    text = String(text == null ? '' : text);
    if (!text) return false;

    /* The modern way, which needs a secure context — so it is simply absent on a plain http://
       address that is not localhost, which is how this gets opened from a phone on the same network. */
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { Err.log(e, 'copy'); }

    /* The old way, which still works there. Off-screen rather than hidden: a display:none textarea
       cannot be selected, and an unselected textarea copies nothing. */
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      document.body.appendChild(t);
      t.select();
      t.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      t.remove();
      return !!ok;
    } catch (e) { Err.log(e, 'copy'); return false; }
  }

  return { copy };
})();
