import { z } from "zod";

// base64url, as PushSubscription.toJSON() gives it (padding tolerated)
const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/);

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(1000),
  keys: z.object({
    // A P-256 public key (65 bytes) and a 16-byte secret
    p256dh: base64url(80, 100),
    auth: base64url(16, 32),
  }),
});

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(1000) });
