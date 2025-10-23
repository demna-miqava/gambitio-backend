import jwt from "jsonwebtoken";
import type { FastifyReply } from "fastify";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const JWT_ACCESS_TOKEN_EXPIRY = "15m";
const JWT_REFRESH_TOKEN_EXPIRY = "30d";

export interface JWTPayload {
  userId: number;
  username: string;
  authMethod: "email" | "google";
}

export interface DecodedToken extends JWTPayload {
  iat: number;
  exp: number;
}

export function generateAccessToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_ACCESS_TOKEN_EXPIRY,
  });
}

export function generateRefreshToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_REFRESH_TOKEN_EXPIRY,
  });
}

export function verifyToken(token: string): DecodedToken {
  try {
    return jwt.verify(token, JWT_SECRET) as DecodedToken;
  } catch (error) {
    throw new Error("Invalid or expired token");
  }
}

export function decodeToken(token: string): DecodedToken | null {
  try {
    return jwt.decode(token) as DecodedToken;
  } catch (error) {
    return null;
  }
}

/**
 * Check if token is expiring soon (within threshold)
 * @param token - JWT token to check
 * @param thresholdMs - Time in milliseconds before expiry to trigger refresh
 */
export function isTokenExpiringSoon(
  token: string,
  thresholdMs: number
): boolean {
  const decoded = decodeToken(token);
  if (!decoded) return true;

  const expiryTime = decoded.exp * 1000;
  const currentTime = Date.now();

  return expiryTime - currentTime < thresholdMs;
}

/**
 * Get token expiry time in seconds
 */
export function getTokenExpiry(tokenType: "access" | "refresh"): number {
  if (tokenType === "access") {
    return 30 * 60; // 30 minutes in seconds
  }
  return 30 * 24 * 60 * 60; // 30 days in seconds
}

/**
 * Threshold constants for token refresh
 */
export const TOKEN_REFRESH_THRESHOLDS = {
  ACCESS_TOKEN: 5 * 60 * 1000, // 5 minutes
  REFRESH_TOKEN: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Cookie options for authentication tokens
 */
const getTokenCookieOptions = (tokenType: "access" | "refresh") => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // sameSite: "strict" as const,
  path: "/",
  maxAge: getTokenExpiry(tokenType),
});

/**
 * Set authentication cookies (access and/or refresh tokens)
 */
export function setAuthCookies(
  reply: FastifyReply,
  tokens: {
    accessToken?: string | undefined;
    refreshToken?: string | undefined;
  }
): void {
  if (tokens.accessToken) {
    reply.setCookie(
      "accessToken",
      tokens.accessToken,
      getTokenCookieOptions("access")
    );
  }

  if (tokens.refreshToken) {
    reply.setCookie(
      "refreshToken",
      tokens.refreshToken,
      getTokenCookieOptions("refresh")
    );
  }
}
