import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalEnvironmentValue = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  schema.optional(),
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL e obrigatoria"),
  APP_ORIGINS: z
    .string()
    .default("https://localhost:8100,http://localhost:4200"),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, "JWT_ACCESS_SECRET deve ter ao menos 32 caracteres"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT_REFRESH_SECRET deve ter ao menos 32 caracteres"),
  JWT_ACCESS_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  JWT_REFRESH_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  TRUST_PROXY: booleanFromString,
  PROVISIONING_SECRET: z
    .string()
    .min(32, "PROVISIONING_SECRET deve ter ao menos 32 caracteres")
    .optional(),
  MASTER_BOOTSTRAP_USERNAME: z.string().min(3).max(50).optional(),
  MASTER_BOOTSTRAP_PASSWORD_HASH: z.string().min(20).optional(),
  GEOAPIFY_API_KEY: z.string().min(20, "GEOAPIFY_API_KEY invalida").optional(),
  PUSH_VAPID_SUBJECT: optionalEnvironmentValue(z.string().trim().min(8)),
  PUSH_VAPID_PUBLIC_KEY: optionalEnvironmentValue(z.string().trim().min(20)),
  PUSH_VAPID_PRIVATE_KEY: optionalEnvironmentValue(z.string().trim().min(20)),
  PUSH_APP_URL: optionalEnvironmentValue(z.string().url()),
  PUSH_NOTIFICATION_ICON_URL: optionalEnvironmentValue(z.string().url()),
  PUSH_NOTIFICATION_BADGE_URL: optionalEnvironmentValue(z.string().url()),
  PUSH_DEFAULT_OPEN_URL: optionalEnvironmentValue(z.string().trim().startsWith('/')),
  PUSH_RIDE_OPEN_URL: optionalEnvironmentValue(z.string().trim().startsWith('/')),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  appOrigins: string[];
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessExpiresInSeconds: number;
  jwtRefreshExpiresInSeconds: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  trustProxy: false | 1;
  provisioningSecret?: string;
  masterBootstrapUsername?: string;
  masterBootstrapPasswordHash?: string;
  geoapifyApiKey?: string;
  push?: PushConfig;
};

export type PushConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
  appUrl: string;
  notificationIconUrl?: string;
  notificationBadgeUrl?: string;
  defaultOpenUrl: string;
  rideOpenUrl: string;
};

let cachedConfig: AppConfig | undefined;

export function resolveTrustProxy(
  nodeEnv: AppConfig["nodeEnv"],
  enabled: boolean,
): false | 1 {
  return nodeEnv === "production" || enabled ? 1 : false;
}

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Configuracao de ambiente invalida: ${fields}`);
  }
  const pushRequired = [
    parsed.data.PUSH_VAPID_SUBJECT, parsed.data.PUSH_VAPID_PUBLIC_KEY,
    parsed.data.PUSH_VAPID_PRIVATE_KEY, parsed.data.PUSH_APP_URL,
  ];
  if (pushRequired.some(Boolean) && !pushRequired.every(Boolean)) {
    throw new Error('Configuracao de ambiente invalida: informe todas as variaveis PUSH_VAPID_* e PUSH_APP_URL.');
  }

  cachedConfig = {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    appOrigins: parsed.data.APP_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
    jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
    jwtAccessExpiresInSeconds: parsed.data.JWT_ACCESS_EXPIRES_IN_SECONDS,
    jwtRefreshExpiresInSeconds: parsed.data.JWT_REFRESH_EXPIRES_IN_SECONDS,
    logLevel: parsed.data.LOG_LEVEL,
    trustProxy: resolveTrustProxy(
      parsed.data.NODE_ENV,
      parsed.data.TRUST_PROXY,
    ),
    provisioningSecret: parsed.data.PROVISIONING_SECRET,
    masterBootstrapUsername: parsed.data.MASTER_BOOTSTRAP_USERNAME,
    masterBootstrapPasswordHash: parsed.data.MASTER_BOOTSTRAP_PASSWORD_HASH,
    geoapifyApiKey: parsed.data.GEOAPIFY_API_KEY,
    push: parsed.data.PUSH_VAPID_SUBJECT ? {
      subject: parsed.data.PUSH_VAPID_SUBJECT,
      publicKey: parsed.data.PUSH_VAPID_PUBLIC_KEY!,
      privateKey: parsed.data.PUSH_VAPID_PRIVATE_KEY!,
      appUrl: parsed.data.PUSH_APP_URL!,
      notificationIconUrl: parsed.data.PUSH_NOTIFICATION_ICON_URL,
      notificationBadgeUrl: parsed.data.PUSH_NOTIFICATION_BADGE_URL,
      defaultOpenUrl: parsed.data.PUSH_DEFAULT_OPEN_URL ?? '/app',
      rideOpenUrl: parsed.data.PUSH_RIDE_OPEN_URL ?? '/app/corridas',
    } : undefined,
  };

  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}

export function getDatabaseUrl(): string {
  const result = z
    .string()
    .min(1, "DATABASE_URL e obrigatoria")
    .safeParse(process.env.DATABASE_URL);
  if (!result.success) {
    throw new Error("DATABASE_URL nao foi definida.");
  }
  return result.data;
}
