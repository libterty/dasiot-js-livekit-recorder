export interface RecorderConfig {
  host: string;
  apiKey: string;
  apiSecret: string;
  room: string;
  s3Endpoint: string;
  s3BucketName: string;
  s3AccessKey: string;
  s3AccessSecret: string;
  s3Region: string;
}

export function getLivekitConfig() {
    return {
      host: process.env.LIVEKIT_URL!,
      apiKey: process.env.LIVEKIT_API_KEY!,
      apiSecret: process.env.LIVEKIT_API_SECRET!,
      room: process.env.LIVEKIT_ROOM_NAME!,
      s3Endpoint: process.env.S3_ENDPOINT!,
      s3BucketName: process.env.S3_BUCKET_NAME!,
      s3AccessKey: process.env.S3_ACCESS_KEY!,
      s3AccessSecret: process.env.S3_ACCESS_SECRET!,
      s3Region: process.env.S3_REGION!,
    };
  }