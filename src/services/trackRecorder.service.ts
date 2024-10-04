import * as liveKitSdk from 'livekit-server-sdk';
import { RemoteTrackPublication, Track } from '@livekit/rtc-node';
import { RecorderConfig } from '../utils/config';
import { EgressStatus } from 'livekit-server-sdk/dist/proto/livekit_egress';

export class TrackRecorder {
    private audioTrack: Track | null = null;
    private videoTrack: Track | null = null;
    private audioPublication: RemoteTrackPublication | null = null;
    private videoPublication: RemoteTrackPublication | null = null;
    private stopChan: AbortController;
    private egressId: string | null = null;
  
    constructor(
      private participantIdentity: string,
      private config: RecorderConfig,
      private egressClient: liveKitSdk.EgressClient
    ) {
      this.stopChan = new AbortController();
    }
  
    setAudioTrack(track: Track, publication: RemoteTrackPublication) {
      this.audioTrack = track;
      this.audioPublication = publication;
    }
  
    setVideoTrack(track: Track, publication: RemoteTrackPublication) {
      this.videoTrack = track;
      this.videoPublication = publication;
      if (this.videoTrack) {
        this.start();
      }
    }
  
    async start() {
      if (!this.videoTrack) {
        console.log(`Cannot start recording for participant ${this.participantIdentity}: missing video track`);
        return;
      }
  
      console.log(`Started recording tracks for participant ${this.participantIdentity}`);
  
      const fileName = `ingress_${this.participantIdentity}_${new Date().toISOString().replace(/:/g, '-')}.mp4`;
      const s3Key = `livecall/test/${fileName}`;
  
      const expectedS3URL = `https://${this.config.s3Endpoint}/${s3Key}`;
      console.log(`Expected S3 URL: ${expectedS3URL}`);
  
      console.log(`Starting egress for participant ${this.participantIdentity}. Bucket: ${this.config.s3BucketName}, Key: ${s3Key}, Endpoint: ${this.config.s3Endpoint}`);
  
      try {
        const res = await this.egressClient.startTrackCompositeEgress(
            this.config.room,
            {
                filepath: s3Key,
                s3: {
                    accessKey: this.config.s3AccessKey,
                    secret: this.config.s3AccessSecret,
                    bucket: this.config.s3BucketName,
                    endpoint: this.config.s3Endpoint,
                    region: this.config.s3Region,
                    forcePathStyle: this.config.s3Region === 'minio',
                },
            },
            this.audioTrack?.sid,
            this.videoTrack?.sid
        );
        if (res.egressId) {
            this.egressId = res.egressId;
        }
        console.log(`Egress started successfully for participant ${this.participantIdentity}. EgressID: ${res.egressId}`);
        this.monitorEgressStatus();
      } catch (error) {
        console.error(`Failed to start egress for participant ${this.participantIdentity}:`, error);
      }
    }
  
    private async monitorEgressStatus() {
      const ticker = setInterval(async () => {
        if (!this.egressId) return;
  
        try {
          const listRes = await this.egressClient.listEgress({
            roomName: this.config.room,
          });
  
          for (const info of listRes) {
            if (info.egressId === this.egressId) {
              console.log(`Egress status for participant ${this.participantIdentity}: ${info.status}`);
  
              this.logResourceUsage();
                EgressStatus
              if (info.status === EgressStatus.EGRESS_COMPLETE) {
                console.log(`Egress completed successfully for participant ${this.participantIdentity}`);
                clearInterval(ticker);
              } else if (info.status === EgressStatus.EGRESS_FAILED) {
                console.error(`Egress failed for participant ${this.participantIdentity}. Error: ${info.error}`);
                if (info.error?.includes('AccessDenied')) {
                  console.log('S3 access denied. Please check your credentials and bucket permissions.');
                } else if (info.error?.includes('NoSuchBucket')) {
                  console.log(`S3 bucket not found. Please check if the bucket '${this.config.s3BucketName}' exists.`);
                }
                clearInterval(ticker);
              } else if (info.status === EgressStatus.EGRESS_ABORTED) {
                console.log(`Egress aborted for participant ${this.participantIdentity}`);
                clearInterval(ticker);
              }
              break;
            }
          }
        } catch (error) {
          console.error(`Error listing egress for participant ${this.participantIdentity}:`, error);
        }
      }, 5000);
  
      this.stopChan.signal.addEventListener('abort', async () => {
        clearInterval(ticker);
        console.log(`Stop signal received for egress status monitoring of participant ${this.participantIdentity}`);
        if (this.egressId) {
          try {
            await this.egressClient.stopEgress(this.egressId);
            console.log(`Successfully stopped egress for participant ${this.participantIdentity}`);
          } catch (error) {
            console.error(`Failed to stop egress for participant ${this.participantIdentity}:`, error);
          }
        }
      });
    }
  
    private logResourceUsage() {
      const memoryUsage = process.memoryUsage();
      console.log(`Resource usage for participant ${this.participantIdentity}:`,
        `RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)} MB,`,
        `Heap Total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB,`,
        `Heap Used: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
      );
    }
  
    stop() {
      console.log(`Stopping recording for participant ${this.participantIdentity}`);
      this.stopChan.abort();
    }
  }