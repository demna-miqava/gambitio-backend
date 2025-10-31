import type { FastifyInstance } from "fastify";
import {
  notificationConnectionManager,
  gameConnectionManager,
} from "../utils/wsConnectionManager.js";
import { ChallengeService } from "../services/challengeService.js";
import type {
  ChallengeSentData,
  ChallengeDeclinedData,
  ChallengeAcceptedData,
  NotificationMessage,
} from "../models/NotificationWebSocket.js";
import { getTimeControl } from "../models/Matchmaking.js";

export class ChallengeHandler {
  private challengeService: ChallengeService;

  constructor(private fastify: FastifyInstance) {
    this.challengeService = new ChallengeService(fastify);
  }

  async handleChallengeSent(
    challengerId: number,
    challengerUsername: string,
    challengerAvatarUrl: string,
    data: ChallengeSentData
  ): Promise<void> {
    const { challengedId, color, time, increment } = data;

    const client = await this.fastify.pg.connect();
    try {
      // Step 1: Check if the challenged user is currently in a game OR if they are connected

      const challengedInGame =
        gameConnectionManager.getConnection(challengedId);
      const challengedSocket =
        notificationConnectionManager.getConnection(challengedId);
      const isUnavailable =
        !challengedSocket || challengedSocket.readyState !== 1;

      if (
        isUnavailable ||
        (challengedInGame && challengedInGame.readyState === 1)
      ) {
        // Challenged user is not connected to notifications
        const unavailableMsg: NotificationMessage = {
          type: "opponent_unavailable",
        };
        notificationConnectionManager.sendToUser(
          challengerId,
          JSON.stringify(unavailableMsg)
        );
        return;
      }

      // Step 2: Check if a challenge already exists from this challenger to this user
      const { rows: existingChallenges } = await client.query(
        `SELECT id FROM challenges
         WHERE "challengerId" = $1 AND "challengedId" = $2`,
        [challengerId, challengedId]
      );

      if (existingChallenges.length > 0) {
        // Challenge already exists
        const errorMsg: NotificationMessage = {
          type: "error",
          data: { message: "You have already sent a challenge to this user" },
        };
        notificationConnectionManager.sendToUser(
          challengerId,
          JSON.stringify(errorMsg)
        );
        return;
      }

      // Step 3: Get challenged user's info from database
      const { rows: challengedRows } = await client.query(
        `SELECT username, "avatarUrl" FROM users WHERE id = $1`,
        [challengedId]
      );

      if (!challengedRows[0]) {
        const errorMsg: NotificationMessage = {
          type: "error",
          data: { message: "Challenged user not found" },
        };
        notificationConnectionManager.sendToUser(
          challengerId,
          JSON.stringify(errorMsg)
        );
        return;
      }

      const challenged = challengedRows[0];

      // Step 4: Resolve color if random
      let finalChallengerColor: "white" | "black";
      if (color === "random") {
        // Randomly assign white or black
        finalChallengerColor = Math.random() < 0.5 ? "white" : "black";
      } else {
        finalChallengerColor = color as "white" | "black";
      }

      // Step 5: Store challenge in database with resolved color preference
      const { rows: insertedChallenge } = await client.query(
        `INSERT INTO challenges (
          "challengerId", "challengedId", "challengerUsername", "challengedUsername",
          "challengerAvatarUrl", "challengedAvatarUrl", time, increment, "challengerColor"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING "createdAt"`,
        [
          challengerId,
          challengedId,
          challengerUsername,
          challenged.username,
          challengerAvatarUrl,
          challenged.avatarUrl || "",
          time,
          increment,
          finalChallengerColor,
        ]
      );

      // Step 6: Send challenge_received to the challenged user
      const challengeReceivedMsg: NotificationMessage = {
        type: "challenge_received",
        data: {
          challengerId,
          username: challengerUsername,
          avatarUrl: challengerAvatarUrl,
          time,
          increment,
          createdAt: insertedChallenge[0].createdAt.toISOString(),
        },
      };
      notificationConnectionManager.sendToUser(
        challengedId,
        JSON.stringify(challengeReceivedMsg)
      );
    } finally {
      client.release();
    }
  }

  async handleChallengeDeclined(
    challengedId: number,
    data: ChallengeDeclinedData
  ): Promise<void> {
    const { challengerId } = data;

    const client = await this.fastify.pg.connect();
    try {
      // Step 1: Delete the challenge from database
      await client.query(
        `DELETE FROM challenges
         WHERE "challengerId" = $1 AND "challengedId" = $2`,
        [challengerId, challengedId]
      );

      // Step 2: Forward decline message to the challenger
      const declinedMsg: NotificationMessage = {
        type: "challenge_declined",
      };
      notificationConnectionManager.sendToUser(
        challengerId,
        JSON.stringify(declinedMsg)
      );
    } finally {
      client.release();
    }
  }

  async handleChallengeAccepted(
    challengedId: number,
    data: ChallengeAcceptedData
  ): Promise<void> {
    const { challengerId } = data;

    const client = await this.fastify.pg.connect();
    try {
      // Step 1: Check if challenger is available (not in game and connected to notifications)
      const challengerInGame =
        gameConnectionManager.getConnection(challengerId);
      const challengerSocket =
        notificationConnectionManager.getConnection(challengerId);
      const isChallengerAvailable =
        (!challengerInGame || challengerInGame.readyState !== 1) &&
        challengerSocket &&
        challengerSocket.readyState === 1;

      if (!isChallengerAvailable) {
        // Challenger is not available (in game or offline)
        // Delete the challenge from database since it's no longer valid
        await client.query(
          `DELETE FROM challenges
           WHERE "challengerId" = $1 AND "challengedId" = $2`,
          [challengerId, challengedId]
        );

        const unavailableMsg: NotificationMessage = {
          type: "opponent_unavailable",
        };
        notificationConnectionManager.sendToUser(
          challengedId,
          JSON.stringify(unavailableMsg)
        );
        return;
      }

      // Step 2: Get the challenge from database
      const { rows: challengeRows } = await client.query(
        `SELECT * FROM challenges
         WHERE "challengerId" = $1 AND "challengedId" = $2`,
        [challengerId, challengedId]
      );

      if (!challengeRows[0]) {
        // Challenge not found (maybe expired or already processed)
        const errorMsg: NotificationMessage = {
          type: "error",
          data: { message: "Challenge not found" },
        };
        notificationConnectionManager.sendToUser(
          challengedId,
          JSON.stringify(errorMsg)
        );
        return;
      }

      const challenge = challengeRows[0];
      const {
        challengerColor,
        time,
        increment,
        challengerUsername,
        challengedUsername,
        challengerAvatarUrl,
        challengedAvatarUrl,
      } = challenge;

      // Step 3: Get both users' ratings from database
      const { rows: userRows } = await client.query<{
        id: number;
        bulletRating: number;
        blitzRating: number;
        rapidRating: number;
      }>(
        `SELECT id, "bulletRating", "blitzRating", "rapidRating"
         FROM users WHERE id IN ($1, $2)`,
        [challengerId, challengedId]
      );

      const challengerData = userRows.find((u) => u.id === challengerId);
      const challengedData = userRows.find((u) => u.id === challengedId);

      if (!challengerData || !challengedData) {
        const errorMsg: NotificationMessage = {
          type: "error",
          data: { message: "User data not found" },
        };
        notificationConnectionManager.sendToUser(
          challengedId,
          JSON.stringify(errorMsg)
        );
        return;
      }

      // Step 4: Determine time control and get appropriate ratings
      const timeControl = getTimeControl(time);
      const challengerRating =
        timeControl === "bullet"
          ? challengerData.bulletRating
          : timeControl === "blitz"
          ? challengerData.blitzRating
          : challengerData.rapidRating;

      const challengedRating =
        timeControl === "bullet"
          ? challengedData.bulletRating
          : timeControl === "blitz"
          ? challengedData.blitzRating
          : challengedData.rapidRating;

      // Step 5: Assign colors based on challenge preference from database
      const finalChallengerColor: "white" | "black" = challengerColor as
        | "white"
        | "black";
      const finalChallengedColor: "white" | "black" =
        challengerColor === "white" ? "black" : "white";

      let whiteId: number;
      let blackId: number;
      let whiteUsername: string;
      let blackUsername: string;
      let whiteRating: number;
      let blackRating: number;
      let whiteAvatarUrl: string;
      let blackAvatarUrl: string;

      if (finalChallengerColor === "white") {
        whiteId = challengerId;
        blackId = challengedId;
        whiteUsername = challengerUsername;
        blackUsername = challengedUsername;
        whiteRating = challengerRating;
        blackRating = challengedRating;
        whiteAvatarUrl = challengerAvatarUrl || "";
        blackAvatarUrl = challengedAvatarUrl || "";
      } else {
        whiteId = challengedId;
        blackId = challengerId;
        whiteUsername = challengedUsername;
        blackUsername = challengerUsername;
        whiteRating = challengedRating;
        blackRating = challengerRating;
        whiteAvatarUrl = challengedAvatarUrl || "";
        blackAvatarUrl = challengerAvatarUrl || "";
      }

      // Step 6: Create game in database
      const { rows: gameRows } = await client.query(
        `INSERT INTO games (
          "whiteId", "blackId", "whiteUsername", "blackUsername",
          "whiteRating", "blackRating", "whiteAvatarUrl", "blackAvatarUrl",
          time, increment, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_progress')
        RETURNING id`,
        [
          whiteId,
          blackId,
          whiteUsername,
          blackUsername,
          whiteRating,
          blackRating,
          whiteAvatarUrl,
          blackAvatarUrl,
          time,
          increment,
        ]
      );
      const gameId = gameRows[0].id;

      // Step 7: Delete all challenges for both users (they're starting a game)
      await this.challengeService.deleteAllUserChallenges(challengerId);
      await this.challengeService.deleteAllUserChallenges(challengedId);

      // Step 8: Send match_created to challenger
      const challengerMsg: NotificationMessage = {
        type: "match_created",
        data: {
          gameId,
          opponentId: challengedId,
          opponentUsername: challengedUsername,
          opponentRating: challengedRating,
          rating: challengerRating,
          time,
          increment,
          color: finalChallengerColor,
        },
      };
      notificationConnectionManager.sendToUser(
        challengerId,
        JSON.stringify(challengerMsg)
      );

      // Step 9: Send match_created to challenged user
      const challengedMsg: NotificationMessage = {
        type: "match_created",
        data: {
          gameId,
          opponentId: challengerId,
          opponentUsername: challengerUsername,
          opponentRating: challengerRating,
          rating: challengedRating,
          time,
          increment,
          color: finalChallengedColor,
        },
      };
      notificationConnectionManager.sendToUser(
        challengedId,
        JSON.stringify(challengedMsg)
      );
    } finally {
      client.release();
    }
  }
}
