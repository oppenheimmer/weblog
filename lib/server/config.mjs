// Server configuration, read once from the environment and validated up front.
//
// Nothing here is ever logged. `describe()` exists so startup problems can be
// diagnosed without a credential reaching a build log (CLAUDE.md §9).
const REQUIRED_R2 = ["accountId", "bucket", "accessKeyId", "secretAccessKey"];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Read R2 settings from an environment-like object.
 *
 * Accepts both the plan's `R2_*` names and the standard `AWS_*` names, because
 * a credential file written for the AWS CLI works unchanged. `R2_*` wins when
 * both are set.
 */
export function readR2Config(env = process.env) {
  const config = {
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET || "weblog-data",
    accessKeyId: env.R2_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    // Organizational only: it separates environments inside one bucket. It is
    // NOT an authorization boundary — a bucket-scoped credential reaches every
    // prefix (CLAUDE.md §3.3, Step 2).
    prefix: env.R2_PREFIX || "dev",
  };
  config.endpoint = env.R2_ENDPOINT ||
    (config.accountId ? `https://${config.accountId}.r2.cloudflarestorage.com` : undefined);
  return config;
}

/** Throw unless every required field is present. Names only, never values. */
export function assertR2Config(config) {
  const missing = REQUIRED_R2.filter((key) => !config[key]);
  if (missing.length) {
    throw new ConfigError(
      `R2 is not configured. Missing: ${missing.join(", ")}. ` +
      `Set R2_ACCOUNT_ID, R2_BUCKET and either R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY ` +
      `or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.`
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(config.bucket)) {
    throw new ConfigError(`Invalid bucket name: ${JSON.stringify(config.bucket)}.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.prefix)) {
    throw new ConfigError(`Invalid R2_PREFIX: ${JSON.stringify(config.prefix)}.`);
  }
  return config;
}

export function loadR2Config(env = process.env) {
  return assertR2Config(readR2Config(env));
}

/** Whether R2 is configured at all, for the build's "no content" fallback (§1.1). */
export function hasR2Config(env = process.env) {
  const config = readR2Config(env);
  return REQUIRED_R2.every((key) => Boolean(config[key]));
}

/** Safe for logs: presence and shape, never a secret. */
export function describe(config) {
  return {
    bucket: config.bucket,
    prefix: config.prefix,
    endpoint: config.endpoint ? config.endpoint.replace(/\/\/[^.]+\./, "//<account>.") : null,
    accessKeyId: config.accessKeyId ? `set (${config.accessKeyId.length} chars)` : "missing",
    secretAccessKey: config.secretAccessKey ? "set" : "missing",
  };
}
