/**
 * JWT-based authentication — replaces express-session to work around
 * Railway/Fastly CDN stripping Set-Cookie headers.
 *
 * Tokens are signed with HS256. Secret: JWT_SECRET env var (fallback provided).
 * Expiry: 30 days.
 */
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "stock-recommender-jwt-secret-change-in-production";
const EXPIRES_IN = "30d";

export interface JwtPayload {
  inviteToken: string;
  isAdmin?: boolean;
  iat?: number;
  exp?: number;
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/** Extract Bearer token from Authorization header */
export function extractBearer(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}
