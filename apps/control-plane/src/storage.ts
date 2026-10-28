import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Artifact and scenario-bundle storage. S3-compatible in production (ADR-0019), in-memory in tests. */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  /** Deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export function memoryStore(): ObjectStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export async function s3Store(opts: S3Options): Promise<ObjectStore> {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: opts.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: opts.bucket }));
  }
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
        return { body: Buffer.from(await res.Body!.transformToByteArray()), contentType: res.ContentType ?? "application/octet-stream" };
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }));
    },
  };
}
