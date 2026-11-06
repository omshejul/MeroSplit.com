/* Use the existing Django/allauth browser session, without opening the app. */
(() => {
  const emailForm = document.querySelector('#email-form');
  const codeForm = document.querySelector('#code-form');
  const error = document.querySelector('#login-error');
  const status = document.querySelector('#login-status');
  let challenge, busy = false;
  async function send(path, data) {
    const response = await fetch('/_allauth/browser/v1/auth/code/' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': emailForm.elements.csrfmiddlewaretoken.value },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.errors?.[0]?.message || 'Sign-in failed. Please try again.');
    return result;
  }
  async function submit(form, work) {
    if (busy) return;
    busy = true; error.textContent = '';
    const button = form.querySelector('button'); button.disabled = true;
    try { await work(); } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; button.disabled = false; }
  }
  emailForm.addEventListener('submit', event => {
    event.preventDefault();
    void submit(emailForm, async () => {
      const result = await send('request', { email: emailForm.elements.email.value });
      challenge = result.data.challenge_id;
      codeForm.hidden = false;
      status.textContent = 'Email sent. Enter the four-digit code below, or request a new code above.';
      codeForm.elements.code.focus();
    });
  });
  codeForm.addEventListener('submit', event => {
    event.preventDefault();
    void submit(codeForm, async () => {
      await send('confirm', { challenge_id: challenge, code: codeForm.elements.code.value });
      window.location.replace('/mcp/device');
    });
  });
})();
