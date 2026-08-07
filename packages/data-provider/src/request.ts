/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { setTokenHeader } from './headers-helpers';
import * as endpoints from './api-endpoints';
import type * as t from './types';

async function _get<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.get(url, { ...options });
  return response.data;
}

async function _getResponse<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.get(url, { ...options });
  return response as T;
}

async function _post(url: string, data?: any) {
  const response = await axios.post(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _postMultiPart(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

async function _postTTS(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
    responseType: 'arraybuffer',
  });
  return response.data;
}

async function _put(url: string, data?: any) {
  const response = await axios.put(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _delete<T>(url: string): Promise<T> {
  const response = await axios.delete(url);
  return response.data;
}

async function _deleteWithOptions<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.delete(url, { ...options });
  return response.data;
}

async function _patch(url: string, data?: any) {
  const response = await axios.patch(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

let isRefreshing = false;
let failedQueue: { resolve: (value?: any) => void; reject: (reason?: any) => void }[] = [];

const refreshToken = (retry?: boolean): Promise<t.TRefreshTokenResponse | undefined> =>
  _post(endpoints.refreshToken(retry));

const SHARE_PAGE_PATH_REGEX = /^\/share\/[^/]+\/?$/;
const SHARED_MESSAGES_PATH_REGEX = /^\/api\/share\/[^/]+$/;

const normalizePathname = (pathname: string) =>
  pathname.startsWith('/') ? pathname : `/${pathname}`;

const stripBasePath = (pathname: string) => {
  const normalizedPathname = normalizePathname(pathname);
  const baseUrl = endpoints.apiBaseUrl();
  if (!baseUrl) {
    return normalizedPathname;
  }

  const normalizedBaseUrl = normalizePathname(baseUrl);
  if (
    normalizedPathname === normalizedBaseUrl ||
    normalizedPathname.startsWith(`${normalizedBaseUrl}/`)
  ) {
    return normalizedPathname.slice(normalizedBaseUrl.length) || '/';
  }
  return normalizedPathname;
};

const isSharePage = () => SHARE_PAGE_PATH_REGEX.test(stripBasePath(window.location.pathname));

const getRequestPathname = (url?: string) => {
  if (typeof url !== 'string') {
    return '';
  }
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
};

const isSharedMessagesRequest = (url?: string, method?: string) =>
  method?.toLowerCase() === 'get' &&
  SHARED_MESSAGES_PATH_REGEX.test(stripBasePath(getRequestPathname(url)));

const dispatchTokenUpdatedEvent = (token: string) => {
  setTokenHeader(token);
  window.dispatchEvent(new CustomEvent('tokenUpdated', { detail: token }));
};

const processQueue = (error: AxiosError | null, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

const getBearerToken = (): string | null => {
  const header = axios.defaults.headers.common['Authorization'];
  if (typeof header !== 'string') {
    return null;
  }
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
};

const withAuthorization = (options: RequestInit | undefined, token: string | null): RequestInit => {
  const headers = new Headers(options?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...options, headers };
};

/**
 * Reactive token refresh for raw `fetch` calls. Generation-control routes (steer
 * arm/preempt/cancel) use `fetch` instead of axios so an `AbortSignal` can be passed
 * directly, which bypasses the axios response interceptor above. Shares its
 * `isRefreshing`/`failedQueue` single-flight lock so a 401 on either transport
 * triggers at most one `/api/auth/refresh` call.
 */
async function _authenticatedFetch(url: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(url, withAuthorization(options, getBearerToken()));
  if (response.status !== 401 || typeof window === 'undefined') {
    return response;
  }

  /** Skip refresh when the Authorization header has been cleared (e.g. during logout),
   *  but allow shared link requests to proceed so auth recovery/redirect can happen.
   *  Mirrors the axios interceptor's guard above — without it, a steer request
   *  in flight when the user logs out can resurrect a cleared token via
   *  `dispatchTokenUpdatedEvent` if the refresh cookie hasn't expired server-side yet. */
  if (
    !axios.defaults.headers.common['Authorization'] &&
    !window.location.pathname.startsWith('/share/')
  ) {
    return response;
  }

  if (isRefreshing) {
    try {
      const refreshedToken = await new Promise<string | null>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      });
      return fetch(url, withAuthorization(options, refreshedToken));
    } catch {
      return response;
    }
  }

  isRefreshing = true;
  try {
    const refreshResponse = await refreshToken();
    const refreshedToken = refreshResponse?.token ?? '';
    if (!refreshedToken) {
      processQueue(new AxiosError('Token refresh failed'), null);
      return response;
    }
    dispatchTokenUpdatedEvent(refreshedToken);
    processQueue(null, refreshedToken);
    return fetch(url, withAuthorization(options, refreshedToken));
  } catch (err) {
    processQueue(err as AxiosError, null);
    return response;
  } finally {
    isRefreshing = false;
  }
}

if (typeof window !== 'undefined') {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;
      if (!error.response) {
        return Promise.reject(error);
      }

      if (originalRequest.url?.includes('/api/auth/2fa') === true) {
        return Promise.reject(error);
      }
      if (originalRequest.url?.includes('/api/auth/logout') === true) {
        return Promise.reject(error);
      }

      /** Skip refresh when the Authorization header has been cleared (e.g. during logout),
       *  but allow the shared link data request to proceed so private shares can still
       *  recover auth/redirect without unrelated share-page queries forcing login. */
      if (
        !axios.defaults.headers.common['Authorization'] &&
        !(isSharePage() && isSharedMessagesRequest(originalRequest.url, originalRequest.method))
      ) {
        return Promise.reject(error);
      }

      if (error.response.status === 401 && !originalRequest._retry) {
        console.warn('401 error, refreshing token');
        originalRequest._retry = true;

        if (isRefreshing) {
          try {
            const token = await new Promise((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            });
            originalRequest.headers['Authorization'] = 'Bearer ' + token;
            return await axios(originalRequest);
          } catch (err) {
            return Promise.reject(err);
          }
        }

        isRefreshing = true;

        try {
          const response = await refreshToken(
            // Handle edge case where we get a blank screen if the initial 401 error is from a refresh token request
            originalRequest.url?.includes('api/auth/refresh') === true ? true : false,
          );

          const token = response?.token ?? '';

          if (token) {
            originalRequest.headers['Authorization'] = 'Bearer ' + token;
            dispatchTokenUpdatedEvent(token);
            processQueue(null, token);
            return await axios(originalRequest);
          } else {
            processQueue(error, null);
            window.location.href = endpoints.apiBaseUrl() + endpoints.buildLoginRedirectUrl();
          }
        } catch (err) {
          processQueue(err as AxiosError, null);
          return Promise.reject(err);
        } finally {
          isRefreshing = false;
        }
      }

      return Promise.reject(error);
    },
  );
}

export default {
  get: _get,
  getResponse: _getResponse,
  post: _post,
  postMultiPart: _postMultiPart,
  postTTS: _postTTS,
  put: _put,
  delete: _delete,
  deleteWithOptions: _deleteWithOptions,
  patch: _patch,
  refreshToken,
  dispatchTokenUpdatedEvent,
  authenticatedFetch: _authenticatedFetch,
};
