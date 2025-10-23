import type { FastifyRequest, FastifyReply } from "fastify";
import {
  verifyToken,
  generateAccessToken,
  generateRefreshToken,
  isTokenExpiringSoon,
  TOKEN_REFRESH_THRESHOLDS,
  setAuthCookies,
  type DecodedToken,
} from "../utils/jwtHelpers.js";

// Extend FastifyRequest to include user property
declare module "fastify" {
  interface FastifyRequest {
    user?: DecodedToken;
  }
}

/**
 * Authentication middleware with automatic token refresh
 * - Verifies access token
 * - Auto-refreshes access / refresh token if expiring soon
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const accessToken = request.cookies.accessToken;
    const refreshToken = request.cookies.refreshToken;

    // No access token provided
    if (!accessToken) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    let decoded: DecodedToken;
    let shouldRefreshAccess = false;
    let shouldRefreshRefresh = false;

    // Try to verify access token
    try {
      decoded = verifyToken(accessToken);

      // Check if access token is expiring soon
      if (
        isTokenExpiringSoon(accessToken, TOKEN_REFRESH_THRESHOLDS.ACCESS_TOKEN)
      ) {
        shouldRefreshAccess = true;
      }
    } catch (error) {
      // Access token expired or invalid, try refresh token
      if (!refreshToken) {
        return reply
          .status(401)
          .send({ error: "Token expired, please sign in again" });
      }

      try {
        decoded = verifyToken(refreshToken);
        shouldRefreshAccess = true; // Need new access token
      } catch (refreshError) {
        return reply
          .status(401)
          .send({ error: "Session expired, please sign in again" });
      }
    }

    // Check if refresh token needs sliding refresh (within 7 days of expiry)
    if (
      refreshToken &&
      isTokenExpiringSoon(refreshToken, TOKEN_REFRESH_THRESHOLDS.REFRESH_TOKEN)
    ) {
      shouldRefreshRefresh = true;
    }

    // Generate new tokens if needed
    if (shouldRefreshAccess || shouldRefreshRefresh) {
      const payload = {
        userId: decoded.userId,
        username: decoded.username,
        authMethod: decoded.authMethod,
      };

      setAuthCookies(reply, {
        accessToken: shouldRefreshAccess
          ? generateAccessToken(payload)
          : undefined,
        refreshToken: shouldRefreshRefresh
          ? generateRefreshToken(payload)
          : undefined,
      });
    }

    // Attach user to request
    request.user = decoded;
  } catch (error) {
    request.log.error(error);
    return reply.status(401).send({ error: "Authentication failed" });
  }
}
