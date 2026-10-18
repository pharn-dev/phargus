/**
 * The login script, served verbatim as `/login.js`. Plain JavaScript: no backtick, no `${`.
 * It reads the token from the URL fragment, removes the fragment from the address bar and the
 * current history entry before anything else, then POSTs it as JSON to `/session`.
 */
export const LOGIN_SCRIPT: string = String.raw`(function () {
  'use strict';

  var status = document.getElementById('status');

  function setStatus(text) {
    if (status !== null) {
      status.textContent = text;
    }
  }

  var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  var token = params.get('token');

  // Before any other work: the fragment leaves the address bar and this history entry.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  if (token === null || token === '') {
    setStatus('no login token in the link: open /login#token=<token>');
    return;
  }

  fetch('/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token }),
    credentials: 'same-origin',
    cache: 'no-store',
  }).then(
    function (response) {
      if (response.status === 204) {
        window.location.assign('/');
      } else if (response.status === 401) {
        setStatus('token rejected');
      } else {
        setStatus('login failed: HTTP ' + response.status);
      }
    },
    function () {
      setStatus('login failed: network error');
    },
  );
})();
`;
