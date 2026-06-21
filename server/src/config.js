import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL,
  netsuite: {
    accountId: process.env.NETSUITE_ACCOUNT_ID,
    clientId: process.env.NETSUITE_CLIENT_ID,
    clientSecret: process.env.NETSUITE_CLIENT_SECRET,
    redirectUri: process.env.NETSUITE_REDIRECT_URI,
    authUrl: process.env.NETSUITE_AUTH_URL,
    tokenUrl: process.env.NETSUITE_TOKEN_URL,
    restBaseUrl: process.env.NETSUITE_REST_BASE_URL,
    scopes: process.env.NETSUITE_SCOPES || "rest_webservices"
  }
};

export function requireConfig(keys) {
  const missing = keys.filter((key) => !key.split(".").reduce((value, part) => value?.[part], config));
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }
}
