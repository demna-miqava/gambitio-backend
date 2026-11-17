import type { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/auth.js";
import { pushSubscriptionSchema, pushUnsubscribeSchema } from "../schemas/pushSchemas.js";

export async function pushRoutes(fastify: FastifyInstance) {
  const limited = { rateLimit: { max: 30, timeWindow: "1 minute" } };

  /**
   * GET /api/push/key
   * The public key a browser subscribes with, or null when push
   * notifications aren't configured on this server. No sign-in needed: the
   * key is public by design (every subscribing browser gets it), and this
   * way a deploy can be checked from outside.
   */
  fastify.get("/push/key", { config: limited }, async () => {
    return { publicKey: fastify.push.publicKey };
  });

  /**
   * POST /api/push/subscriptions
   * Turns notifications on for this browser. Safe to repeat.
   */
  fastify.post(
    "/push/subscriptions",
    { preHandler: authMiddleware, config: limited },
    async (request, reply) => {
      const { endpoint, keys } = pushSubscriptionSchema.parse(request.body);
      await fastify.push.subscribe(request.user!.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
      return reply.status(201).send({ success: true });
    }
  );

  /**
   * POST /api/push/unsubscribe
   * Turns notifications off for this browser (also on sign-out).
   */
  fastify.post("/push/unsubscribe", { preHandler: authMiddleware, config: limited }, async (request) => {
    const { endpoint } = pushUnsubscribeSchema.parse(request.body);
    await fastify.push.unsubscribe(request.user!.id, endpoint);
    return { success: true };
  });
}
