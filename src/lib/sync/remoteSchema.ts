import { z } from "zod";
import { EncryptedSecretEnvelopeSchema } from "@/lib/api/schemas";

const RelativePathSchema = z
  .string()
  .max(2_048)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "Remote sync paths must be safe relative paths",
  );

const WebDavProviderSchema = z
  .object({
    kind: z.literal("webdav"),
    baseUrl: z.string().url().max(2_048),
    rootPath: RelativePathSchema,
  })
  .strict();

const S3ProviderSchema = z
  .object({
    kind: z.literal("s3"),
    endpoint: z.string().url().max(2_048),
    region: z.string().trim().min(1).max(100),
    bucket: z.string().trim().min(1).max(255),
    prefix: RelativePathSchema,
    forcePathStyle: z.boolean(),
  })
  .strict();

export const SyncRemoteRequestSchema = z
  .object({
    operation: z.enum(["test", "list", "head", "get", "put"]),
    provider: z.discriminatedUnion("kind", [
      WebDavProviderSchema,
      S3ProviderSchema,
    ]),
    credentialSecret: EncryptedSecretEnvelopeSchema,
    path: RelativePathSchema.optional(),
    cursor: z.string().max(4_096).optional(),
    body: z
      .string()
      .regex(/^[A-Za-z0-9_-]*$/)
      .max(8 * 1024 * 1024)
      .optional(),
    contentType: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (["head", "get", "put"].includes(value.operation) && !value.path) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `A path is required for ${value.operation}`,
      });
    }
    if (value.operation === "put" && value.body === undefined) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "A body is required for put",
      });
    }
  });
