export {};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        email?: string;
        displayName?: string;
        role?: string;
        tokenType?: "clerk" | "plugin" | "guest";
        /** How the credential was presented; `cookie` is the only path that requires CSRF.
         *  `dev-open-bridged` is dev-only — the request had no credential of its own but
         *  inherited the userId of the plugin_session JWT most recently seen on the same IP
         *  (see `pluginIdentityByIp` in middleware/auth.ts). */
        authSource?: "bearer" | "cookie" | "dev-open" | "dev-open-bridged";
        /** Resolved client IP at auth time (from req.ip via trust proxy). Used for guest IP bans. */
        ip?: string;
      };
    }
  }
}
