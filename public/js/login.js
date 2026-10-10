(function () {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');
  const toggle = document.getElementById('toggle-password');
  const pwd = document.getElementById('password');

  API.get('/api/auth/me', { skipAuthRedirect: true })
    .then(() => { location.href = '/app.html'; })
    .catch(() => {});

  toggle.addEventListener('click', () => {
    const show = pwd.type === 'password';
    pwd.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Masquer' : 'Afficher';
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const login = document.getElementById('login').value.trim();
    const password = pwd.value;

    if (!login || !password) {
      showError('Merci de remplir tous les champs.');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Connexion...';
    try {
      await API.post('/api/auth/login', { login, password }, { skipAuthRedirect: true });
      location.href = '/app.html';
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
      submit.textContent = 'Se connecter';
    }
  });
})();
