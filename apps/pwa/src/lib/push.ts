import { api } from './api.js';

/** Detects the platform for storing alongside the push subscription. */
export function detectPlatform(): 'ios' | 'android' | 'desktop' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** True on iOS Safari when the app is NOT yet installed to the home screen. */
export function isIosNeedsInstall(): boolean {
  const isIos = detectPlatform() === 'ios';
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS-specific standalone flag
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Requests notification permission (must be called from a user gesture) and
 * subscribes to Web Push, registering the subscription with the server.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Push is not supported on this device');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission denied');

  const reg = await navigator.serviceWorker.ready;
  const { key } = await api.vapidKey();

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  await api.subscribePush(sub.toJSON(), detectPlatform());
}
