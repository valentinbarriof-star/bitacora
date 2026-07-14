// Cliente fino de la API. Todos los writes llevan el header CSRF custom
// (x-bitacora-csrf) que un form HTML de terceros no puede poner.

const CSRF = { 'x-bitacora-csrf': '1' };

async function handle(res) {
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('no autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

export async function apiGet(path) {
  return handle(await fetch(path));
}

export async function apiJson(method, path, body) {
  return handle(
    await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...CSRF },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

// Sube un blob de audio a R2. Devuelve { key, url }. x-content-type porque
// algunos blobs no siempre conservan bien el type nativo.
export async function uploadAudio(blob) {
  return handle(
    await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-content-type': blob.type, ...CSRF },
      body: blob,
    }),
  );
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST', headers: CSRF });
  location.href = '/login.html';
}
