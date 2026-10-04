const STORAGE_KEY = "ksc_tower_dev_voice_identity";

/** Must match backend `DEV_VOICE_IDENTITY_HEADER` (default in `.env.example`). */
export const DEV_VOICE_IDENTITY_HEADER = "x-ksc-voice-identity";

export function getDevVoiceIdentity(): string {
  if (!import.meta.env.DEV) return "";
  return localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
}

export function setDevVoiceIdentity(id: string): void {
  if (!import.meta.env.DEV) return;
  const t = id.trim();
  if (!t) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, t);
  }
}
