/**
 * Bun Text Intelligence Starter - Backend Server
 *
 * This is a simple Bun HTTP server that provides a text intelligence API endpoint
 * powered by Deepgram's Text Intelligence service. It's designed to be easily
 * modified and extended for your own projects.
 *
 * Key Features:
 * - API endpoint: POST /api/text-intelligence
 * - Accepts text or URL in JSON body
 * - Supports multiple intelligence features: summarization, topics, sentiment, intents
 * - JWT session auth for API protection
 * - Native TypeScript support
 * - No external web framework needed
 */

import { createClient } from "@deepgram/sdk";
import { parse as parseTOML } from "@iarna/toml";
import { readFileSync } from "fs";
import { SignJWT, jwtVerify } from "jose";

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: parseInt(Bun.env.PORT || "8081"),
  host: Bun.env.HOST || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens for API protection
// ============================================================================

/**
 * Session secret for signing JWTs.
 * Auto-generated in dev mode; set SESSION_SECRET env var in production.
 */
const SESSION_SECRET =
  Bun.env.SESSION_SECRET ||
  crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");

/** Encoded secret key for jose JWT operations */
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

/** JWT expiry time (1 hour) */
const JWT_EXPIRY = "1h";

/**
 * Creates a signed JWT session token
 */
async function createSessionToken(): Promise<string> {
  return await new SignJWT({ iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(JWT_EXPIRY)
    .sign(SESSION_SECRET_KEY);
}

/**
 * Verifies a JWT session token
 */
async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, SESSION_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables.
 * Exits with helpful message if not found.
 */
function loadApiKey(): string {
  const apiKey = Bun.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    console.error("\n\u274C ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    process.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// SETUP - Initialize Deepgram client
// ============================================================================

const deepgram = createClient(apiKey);

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Returns standard CORS headers for cross-origin requests.
 * Bun uses the CORS pattern (backend=8081, frontend=8080).
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ============================================================================
// TYPES - TypeScript interfaces for request/response
// ============================================================================

interface ErrorResponse {
  error: {
    type: "validation_error" | "processing_error";
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates text intelligence input — must have text XOR url
 */
function validateAnalysisInput(
  text: string | undefined,
  url: string | undefined
): string | null {
  if (!text && !url) {
    return "Request must contain either 'text' or 'url' field";
  }
  if (text && url) {
    return "Request must contain only one of 'text' or 'url', not both";
  }
  return null;
}

/**
 * Formats error responses in a consistent structure
 */
function formatErrorResponse(
  error: Error,
  statusCode: number = 500,
  code?: string,
  type?: string
): Response {
  const errorBody: ErrorResponse = {
    error: {
      type: (type ||
        (statusCode === 400
          ? "validation_error"
          : "processing_error")) as ErrorResponse["error"]["type"],
      code: code || (statusCode === 400 ? "INVALID_TEXT" : "ANALYSIS_FAILED"),
      message: error.message || "An error occurred during analysis",
      details: {},
    },
  };

  return Response.json(errorBody, {
    status: statusCode,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/session
 * Issues a signed JWT session token.
 */
async function handleGetSession(): Promise<Response> {
  const token = await createSessionToken();
  return Response.json({ token }, { headers: getCorsHeaders() });
}

/**
 * Validates JWT from Authorization header. Returns error Response or null if OK.
 */
async function checkAuth(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return Response.json(
      {
        error: {
          type: "AuthenticationError",
          code: "MISSING_TOKEN",
          message: "Authorization header with Bearer token is required",
        },
      },
      { status: 401, headers: getCorsHeaders() }
    );
  }
  const token = authHeader.slice(7);
  if (!(await verifySessionToken(token))) {
    return Response.json(
      {
        error: {
          type: "AuthenticationError",
          code: "INVALID_TOKEN",
          message: "Invalid or expired session token",
        },
      },
      { status: 401, headers: getCorsHeaders() }
    );
  }
  return null;
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * POST /api/text-intelligence
 * Main text intelligence endpoint.
 * Accepts JSON body with text or url, plus query params for features.
 */
async function handleAnalysis(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const body = await req.json();
    const { text, url: textUrl } = body;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...getCorsHeaders(),
    };

    // Validate input — must have text XOR url
    const validationError = validateAnalysisInput(text, textUrl);
    if (validationError) {
      return new Response(
        JSON.stringify({
          error: {
            type: "validation_error",
            code: "INVALID_TEXT",
            message: validationError,
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

    // If URL provided, validate format
    if (textUrl) {
      try {
        new URL(textUrl);
      } catch {
        return new Response(
          JSON.stringify({
            error: {
              type: "validation_error",
              code: "INVALID_URL",
              message: "Invalid URL format",
              details: {},
            },
          }),
          { status: 400, headers }
        );
      }
    }

    // Resolve text content: fetch from URL if needed
    let textContent: string;

    if (textUrl) {
      try {
        const response = await fetch(textUrl);
        if (!response.ok) {
          return new Response(
            JSON.stringify({
              error: {
                type: "validation_error",
                code: "INVALID_URL",
                message: `Failed to fetch URL: ${response.statusText}`,
                details: {},
              },
            }),
            { status: 400, headers }
          );
        }
        textContent = await response.text();
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: {
              type: "validation_error",
              code: "INVALID_URL",
              message: `Failed to fetch URL: ${(e as Error).message}`,
              details: {},
            },
          }),
          { status: 400, headers }
        );
      }
    } else {
      textContent = text;
    }

    // Check for empty text
    if (!textContent || textContent.trim().length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            type: "validation_error",
            code: "EMPTY_TEXT",
            message: "Text content cannot be empty",
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

    // Extract query parameters for intelligence features
    const options: Record<string, unknown> = {
      language: url.searchParams.get("language") || "en",
    };

    const summarize = url.searchParams.get("summarize");
    if (summarize === "true") {
      options.summarize = true;
    } else if (summarize === "v2") {
      options.summarize = "v2";
    } else if (summarize === "v1") {
      return new Response(
        JSON.stringify({
          error: {
            type: "validation_error",
            code: "INVALID_TEXT",
            message:
              "Summarization v1 is no longer supported. Please use v2 or true.",
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

    const topics = url.searchParams.get("topics");
    if (topics === "true") options.topics = true;

    const sentiment = url.searchParams.get("sentiment");
    if (sentiment === "true") options.sentiment = true;

    const intents = url.searchParams.get("intents");
    if (intents === "true") options.intents = true;

    // Call Deepgram API (SDK v4 returns { result, error })
    const { result, error } = await deepgram.read.analyzeText(
      { text: textContent },
      options
    );

    // Handle SDK errors
    if (error) {
      console.error("Deepgram API Error:", error);
      return new Response(
        JSON.stringify({
          error: {
            type: "processing_error",
            code: "INVALID_TEXT",
            message: error.message || "Failed to process text",
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

    // Return full results object (includes all requested features)
    return new Response(
      JSON.stringify({ results: result.results || {} }),
      { status: 200, headers }
    );
  } catch (err) {
    console.error("Analysis error:", err);
    return formatErrorResponse(err as Error);
  }
}

/**
 * GET /api/metadata
 * Returns metadata about this starter application from deepgram.toml
 */
function handleMetadata(): Response {
  try {
    const tomlContent = readFileSync("./deepgram.toml", "utf-8");
    const tomlConfig = parseTOML(tomlContent) as Record<string, unknown>;

    if (!tomlConfig.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(tomlConfig.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

/**
 * GET /health
 * Returns service health status
 */
function handleHealth(): Response {
  return Response.json(
    { status: "ok", service: "text-intelligence" },
    { headers: getCorsHeaders() }
  );
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

/**
 * Main request router — dispatches to individual handlers based on method + path
 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session route (unprotected)
  if (req.method === "GET" && url.pathname === "/api/session") {
    return await handleGetSession();
  }

  // Text intelligence route (auth required)
  if (req.method === "POST" && url.pathname === "/api/text-intelligence") {
    const authError = await checkAuth(req);
    if (authError) return authError;
    return handleAnalysis(req);
  }

  // Metadata route (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // Health check (unprotected)
  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth();
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: getCorsHeaders() }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`\uD83D\uDE80 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`\uD83D\uDCE1 GET  /api/session`);
console.log(`\uD83D\uDCE1 POST /api/text-intelligence (auth required)`);
console.log(`\uD83D\uDCE1 GET  /api/metadata`);
console.log(`\uD83D\uDCE1 GET  /health`);
console.log("=".repeat(70) + "\n");

Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: handleRequest,
});
