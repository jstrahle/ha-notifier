/**
 * Thin fetch wrapper. Cookies (session) are sent automatically.
 *
 * Note: the Content-Type header is only set when a body is actually present.
 * Fastify rejects a request that declares `application/json` but sends an empty
 * body (FST_ERR_CTP_EMPTY_JSON_BODY -> 400), which silently broke every
 * body-less POST such as acknowledge and logout.
 */
async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (options.body != null) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message) message = data.error.message;
    } catch {
      /* response had no JSON body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  id: string;
  name: string;
  role: string;
  sms_number: string | null;
  subscriptions: SubscriptionView[];
}

export interface SubscriptionView {
  topicId: string;
  topicName: string;
  minPriority: string;
  quietStart: string | null;
  quietEnd: string | null;
  channelPref: string;
}

export interface Topic {
  id: string;
  name: string;
  dedupCooldownSeconds: number | null;
}

export interface Tenant {
  id: string;
  name: string;
}

/**
 * An action button as the client sees it.
 *
 * There is deliberately no `url`. The action's webhook URL is a secret (Home
 * Assistant: "treat a webhook ID like a password") and the server never sends it
 * here. Pressing a button calls our own API, and the server makes the signed
 * outbound call itself.
 */
export interface NotificationAction {
  id: string;
  label: string;
}

export interface ManagedUser {
  id: string;
  name: string;
  role: string;
  smsNumber: string | null;
}

export interface TopicSubscriber {
  userId: string;
  name: string;
  smsNumber: string | null;
  channelPref: string;
  minPriority: string;
  quietStart: string | null;
  quietEnd: string | null;
}

export interface Device {
  id: string;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  userId: string | null;
  ownerName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  mine: boolean;
}

export interface EscalationRule {
  id: string;
  topicId: string | null;
  minPriority: string;
  delaySeconds: number;
  nextChannel: string | null;
  nextUserId: string | null;
  stepOrder: number;
}

/**
 * One row per *alert*, not per delivery. A critical alert is sent over web push
 * and SMS simultaneously; those are two deliveries but one alert, so the
 * channels it used are listed here rather than producing duplicate rows.
 */
export interface InboxItem {
  id: string;
  title: string;
  body: string;
  priority: string;
  actions: NotificationAction[] | null;
  duplicateCount: number;
  createdAt: string;
  channels: string[];
  acknowledged: boolean;
  failed: boolean;
}

export const api = {
  login: (name: string, password: string) =>
    request<Me>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),
  logout: () => request<{ status: string }>('/v1/auth/logout', { method: 'POST' }),
  /** Revoke every session this user holds — e.g. after losing a phone. */
  logoutAll: () =>
    request<{ status: string }>('/v1/auth/logout-all', { method: 'POST' }),
  me: () => request<Me>('/v1/me'),
  topics: () => request<Topic[]>('/v1/topics'),
  messages: () => request<InboxItem[]>('/v1/messages?limit=50'),
  /** Acknowledge the alert. Clears every channel it was delivered on. */
  ackMessage: (messageId: string) =>
    request<{ status: string }>(`/v1/messages/${messageId}/ack`, { method: 'POST' }),
  /** Used by the deep link from the service worker, which knows a delivery id. */
  ackDelivery: (deliveryId: string) =>
    request<{ status: string }>(`/v1/deliveries/${deliveryId}/ack`, { method: 'POST' }),
  vapidKey: () => request<{ key: string }>('/v1/push/vapid-public-key'),
  subscribePush: (sub: PushSubscriptionJSON, platform: string) =>
    request<{ status: string }>('/v1/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: sub.keys,
        platform,
      }),
    }),
  putSubscription: (body: {
    topic_id: string;
    min_priority: string;
    quiet_start: string | null;
    quiet_end: string | null;
    channel_pref: string;
  }) => request<{ status: string }>('/v1/subscriptions', { method: 'PUT', body: JSON.stringify(body) }),

  // --- Action buttons ---
  // Exposed in the Inbox as well as in the notification, because iOS does not
  // render notification action buttons at all.
  triggerAction: (messageId: string, actionId: string) =>
    request<{ status: string; action: string }>(
      `/v1/actions/${messageId}/${actionId}`,
      { method: 'POST' },
    ),

  // --- Diagnostics ---
  // Sends straight through the SMS provider, bypassing routing entirely, so a
  // failure points at the channel rather than at subscriptions or quiet hours.
  testSms: (to?: string) =>
    request<{ status: string; to: string; provider: string }>(
      '/v1/admin/test-sms',
      { method: 'POST', body: JSON.stringify(to ? { to } : {}) },
    ),

  // --- Tenant (household) ---
  tenant: () => request<Tenant>('/v1/tenant'),
  renameTenant: (name: string) =>
    request<Tenant>('/v1/tenant', { method: 'PATCH', body: JSON.stringify({ name }) }),

  // --- My own profile (any user, no admin needed) ---
  patchMe: (body: { sms_number?: string | null; password?: string }) =>
    request<Me>('/v1/me', { method: 'PATCH', body: JSON.stringify(body) }),

  // --- My devices ---
  devices: () => request<Device[]>('/v1/push/devices'),
  deleteDevice: (id: string) =>
    request<{ status: string }>(`/v1/push/devices/${id}`, { method: 'DELETE' }),

  /** Who receives this topic, and on what channel. Admin only. */
  topicSubscribers: (topicId: string) =>
    request<TopicSubscriber[]>(`/v1/topics/${topicId}/subscribers`),

  // --- Topics (admin) ---
  // Note: no rename. Senders address topics by name, so renaming one would
  // silently orphan every automation still posting to the old name.
  createTopic: (name: string, dedup_cooldown_seconds?: number | null) =>
    request<Topic>('/v1/topics', {
      method: 'POST',
      body: JSON.stringify({ name, dedup_cooldown_seconds: dedup_cooldown_seconds ?? null }),
    }),
  deleteTopic: (id: string) =>
    request<{ status: string; name: string }>(`/v1/topics/${id}`, { method: 'DELETE' }),
  patchTopic: (id: string, body: { dedup_cooldown_seconds?: number | null }) =>
    request<Topic>(`/v1/topics/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // --- Users (admin) ---
  users: () => request<ManagedUser[]>('/v1/users'),
  createUser: (body: {
    name: string;
    password: string;
    sms_number?: string;
    role: string;
  }) => request<ManagedUser>('/v1/users', { method: 'POST', body: JSON.stringify(body) }),
  patchUser: (
    id: string,
    body: { sms_number?: string | null; role?: string; password?: string },
  ) => request<{ status: string }>(`/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteUser: (id: string) =>
    request<{ status: string; name: string }>(`/v1/users/${id}`, { method: 'DELETE' }),

  // --- API keys (self-service) ---
  apiKeys: () => request<ApiKey[]>('/v1/api-keys'),
  createApiKey: (name: string, scopes: string[] = ['notify']) =>
    request<{ id: string; name: string; key: string }>('/v1/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, scopes }),
    }),
  rotateApiKey: (id: string) =>
    request<{ id: string; name: string; key: string }>(`/v1/api-keys/${id}/rotate`, {
      method: 'POST',
    }),
  deleteApiKey: (id: string) =>
    request<{ status: string }>(`/v1/api-keys/${id}`, { method: 'DELETE' }),

  // --- Escalation rules (admin) ---
  escalationRules: () => request<EscalationRule[]>('/v1/escalation-rules'),
  // step_order is omitted on purpose: the server appends the step to the end of
  // that topic's chain. Making a person pick a step number is implementation
  // detail leaking into the UI.
  createEscalationRule: (body: {
    topic_id: string | null;
    min_priority: string;
    delay_seconds: number;
    next_channel: string | null;
    next_user_id: string | null;
  }) => request<EscalationRule>('/v1/escalation-rules', { method: 'POST', body: JSON.stringify(body) }),
  patchEscalationRule: (
    id: string,
    body: {
      min_priority?: string;
      delay_seconds?: number;
      next_channel?: string | null;
      next_user_id?: string | null;
      step_order?: number;
    },
  ) => request<EscalationRule>(`/v1/escalation-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteEscalationRule: (id: string) =>
    request<{ status: string }>(`/v1/escalation-rules/${id}`, { method: 'DELETE' }),
};
