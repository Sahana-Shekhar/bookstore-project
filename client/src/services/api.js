// All HTTP access goes through request(). Authentication is a session cookie that the browser
// manages (httpOnly, so JavaScript can never read the JWT). The CSRF token is kept in memory
// only: never in localStorage, sessionStorage or cookies.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let csrfToken = null;
export const setCsrfToken = (token) => {
  csrfToken = token ?? null;
};

// AuthContext registers a callback so that a 401 on a request made with a session
// (i.e. the session expired) is handled in one place.
let onUnauthorized = null;
export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function readError(res) {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {
    // Non-JSON error body; fall through to the generic message.
  }
  return `Request failed (${res.status})`;
}

/**
 * options.skipUnauthorizedHandler: for calls where a 401 is an expected answer
 * (login with wrong credentials, session restore for a guest).
 */
async function request(path, { method = 'GET', body, skipUnauthorizedHandler = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }

  if (!res.ok) {
    if (res.status === 401 && !skipUnauthorizedHandler && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, await readError(res));
  }
  return res.status === 204 ? null : res.json();
}

// ---- Catalogue ----
/** params: { q, categoryId, sort, page, pageSize }. Empty values are left out of the query string. */
export const getBooks = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return request(`/books${qs ? `?${qs}` : ''}`);
};

export const getBook = (id) => request(`/books/${encodeURIComponent(id)}`);

export const getCategories = () => request('/categories');

// ---- Auth ----
export const registerUser = (payload) =>
  request('/auth/register', { method: 'POST', body: payload, skipUnauthorizedHandler: true });

export async function loginUser(credentials) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: credentials,
    skipUnauthorizedHandler: true,
  });
  setCsrfToken(data.csrfToken);
  return data.user;
}

/** Restores the session from the cookie. Resolves to the user, or null if there is no valid session. */
export async function getCurrentUser() {
  try {
    const data = await request('/auth/me', { skipUnauthorizedHandler: true });
    setCsrfToken(data.csrfToken);
    return data.user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw err; // network or server problem: the caller decides, we do not pretend the user is logged out
  }
}

export async function logoutUser() {
  try {
    await request('/auth/logout', { method: 'POST', skipUnauthorizedHandler: true });
  } catch (err) {
    // A stale CSRF token (403) means the session changed elsewhere; refresh it once and retry.
    if (err instanceof ApiError && err.status === 403) {
      const user = await getCurrentUser();
      if (user) await request('/auth/logout', { method: 'POST', skipUnauthorizedHandler: true });
    } else {
      throw err;
    }
  }
  // Only reached when the session is really gone; on failure the token is kept so the user can retry.
  setCsrfToken(null);
}

// ---- Orders (customer) ----
// Prices, stock and totals are always decided by the server; the client only sends book ids, quantities and the address.
export const createOrder = ({ items, shippingAddress }) =>
  request('/orders', { method: 'POST', body: { items, shippingAddress } });

export const getOrders = ({ page = 1, pageSize = 10 } = {}) =>
  request(`/orders?page=${page}&pageSize=${pageSize}`);

export const getOrder = (id) => request(`/orders/${encodeURIComponent(id)}`);

export const cancelOrder = (id) => request(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
