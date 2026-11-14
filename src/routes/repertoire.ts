import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { RepertoireService } from "../services/repertoireService.js";
import { MAX_LINE_PLIES } from "../game/repertoire.js";

const color = z.enum(["white", "black"]);
const name = z.string().trim().min(1).max(80);
const lineParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });

const createLineSchema = z
  .object({
    color,
    name,
    // SAN from the starting position; the server replays and normalises it
    moves: z.array(z.string().min(2).max(10)).min(1).max(MAX_LINE_PLIES),
  })
  .strict();

const updateLineSchema = z
  .object({ name: name.optional(), color: color.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.color !== undefined, "Nothing to update");

const practiceSchema = z.object({ correct: z.boolean() }).strict();
const checkQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export async function repertoireRoutes(fastify: FastifyInstance) {
  const repertoire = new RepertoireService(fastify);

  /** GET /repertoire - The signed-in player's lines, both colours */
  fastify.get("/repertoire", { preHandler: authMiddleware }, async (request) => {
    return { lines: await repertoire.list(request.user!.id) };
  });

  /** POST /repertoire - Save a line (moves in SAN from the start position) */
  fastify.post("/repertoire", { preHandler: authMiddleware }, async (request, reply) => {
    const body = createLineSchema.parse(request.body);
    const line = await repertoire.create(request.user!.id, body);
    return reply.status(201).send({ line });
  });

  /** PATCH /repertoire/:id - Rename a line or move it to the other colour */
  fastify.patch("/repertoire/:id", { preHandler: authMiddleware }, async (request) => {
    const { id } = lineParams.parse(request.params);
    const body = updateLineSchema.parse(request.body);
    return { line: await repertoire.update(request.user!.id, id, body) };
  });

  /** DELETE /repertoire/:id */
  fastify.delete("/repertoire/:id", { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = lineParams.parse(request.params);
    await repertoire.remove(request.user!.id, id);
    return reply.status(204).send();
  });

  /** POST /repertoire/:id/practice - Record a practice run ({ correct }) */
  fastify.post("/repertoire/:id/practice", { preHandler: authMiddleware }, async (request) => {
    const { id } = lineParams.parse(request.params);
    const { correct } = practiceSchema.parse(request.body);
    return { line: await repertoire.recordPractice(request.user!.id, id, correct) };
  });

  /** GET /repertoire/check?limit=20 - Where recent games left the preparation */
  fastify.get(
    "/repertoire/check",
    { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { limit } = checkQuery.parse(request.query);
      return { games: await repertoire.checkRecentGames(request.user!.id, limit) };
    }
  );
}
