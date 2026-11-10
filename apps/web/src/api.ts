import type { Identity } from "@geohash-chat/shared";
export interface Config {
  apiUrl: string;
  local: boolean;
  region?: string;
  userPoolId?: string;
  userPoolClientId?: string;
}
export const config: Config = await fetch("/config.json", {
  cache: "no-store",
}).then(async (r) => {
  if (!r.ok) throw Error("Unable to load site configuration.");
  return r.json();
});
export const sessionKey = "geohash.chat.session";
export function token() {
  return localStorage.getItem(sessionKey) ?? "";
}
export function saveToken(value: string) {
  localStorage.setItem(sessionKey, value);
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await fetch(config.apiUrl + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? "Request failed.");
  return data;
}
let starting: Promise<Identity> | undefined;
export async function ensureGuest(): Promise<Identity> {
  if (starting) return starting;
  starting = (async () => {
    if (token()) {
      try {
        return await api<Identity>("/me");
      } catch (e) {
        if (!/expired|Invalid|Sign in/.test((e as Error).message)) throw e;
        localStorage.removeItem(sessionKey);
      }
    }
    const session = await api<{ token: string; identity: Identity }>(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          name: localStorage.getItem("geohash.chat.name") ?? "Wanderer",
        }),
      },
    );
    saveToken(session.token);
    return session.identity;
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}
