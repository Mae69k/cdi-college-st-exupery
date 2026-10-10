const API = (() => {
  async function request(method, url, body, options = {}) {
    const opts = {
      method,
      headers: {},
      credentials: 'same-origin'
    };

    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw new Error('Serveur injoignable. Verifiez votre connexion.');
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    }

    if (res.status === 401 && !options.skipAuthRedirect) {
      if (!location.pathname.endsWith('index.html') && location.pathname !== '/') {
        location.href = '/';
      }
      throw new Error((data && data.error) || 'Session expiree.');
    }

    if (!res.ok) {
      throw new Error((data && data.error) || `Erreur ${res.status}`);
    }
    return data;
  }

  return {
    get: (url, options) => request('GET', url, null, options),
    post: (url, body, options) => request('POST', url, body, options),
    put: (url, body, options) => request('PUT', url, body, options),
    del: (url, options) => request('DELETE', url, null, options),
    request
  };
})();

window.API = API;
