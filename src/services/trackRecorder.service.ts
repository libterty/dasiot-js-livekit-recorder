import * as liveKitSdk from 'livekit-server-sdk';
import { RemoteTrackPublication, Track } from '@livekit/rtc-node';
import { RecorderConfig } from '../utils/config';
import { EgressStatus } from 'livekit-server-sdk/dist/proto/livekit_egress';

export class TrackRecorder {
  public audioTrack: Track | null = null;
  public videoTrack: Track | null = null;
  private audioPublication: RemoteTrackPublication | null = null;
  private videoPublication: RemoteTrackPublication | null = null;
  private stopChan: AbortController;
  private egressId: string | null = null;

  constructor(
    private roomName: string,
    private participantIdentity: string,
    private config: RecorderConfig,
    private egressClient: liveKitSdk.EgressClient,
    private recorder: any // This should be the Recorder class, but to avoid circular dependency, we use 'any'
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
  }

  hasVideoTrack(): boolean {
    return this.videoTrack !== null;
  }

  async start() {
    if (!this.videoTrack) {
      console.log(`Cannot start recording for participant ${this.participantIdentity} in room ${this.roomName}: missing video track`);
      return;
    }

    console.log(`Started recording tracks for participant ${this.participantIdentity} in room ${this.roomName}`);

    // Update room metadata to indicate recording has started
    await this.recorder.updateRecordingStatus(this.roomName, EgressStatus.EGRESS_STARTING);

    const fileName = `ingress_${this.roomName}_${this.participantIdentity}_${new Date().toISOString().replace(/:/g, '-')}.mp4`;
    const s3Key = `livecall/test/${fileName}`;

    const expectedS3URL = `https://${this.config.s3Endpoint}/${s3Key}`;
    console.log(`Expected S3 URL: ${expectedS3URL}`);

    console.log(`Starting egress for participant ${this.participantIdentity} in room ${this.roomName}. Bucket: ${this.config.s3BucketName}, Key: ${s3Key}, Endpoint: ${this.config.s3Endpoint}`);

    try {
      const res = await this.egressClient.startTrackCompositeEgress(
        this.roomName,
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
      this.egressId = res.egressId!;
      console.log(`Egress started successfully for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${this.egressId}`);
      this.monitorEgressStatus();
    } catch (error) {
      console.error(`Failed to start egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      await this.recorder.updateRecordingStatus(this.roomName, EgressStatus.EGRESS_FAILED);
    }
  }

  private async monitorEgressStatus() {
    let lastKnownStatus: EgressStatus = EgressStatus.EGRESS_STARTING;

    const ticker = setInterval(async () => {
      if (!this.egressId) return;

      try {
        const listRes = await this.egressClient.listEgress({
          roomName: this.roomName,
        });

        for (const info of listRes) {
          if (info.egressId === this.egressId) {
            lastKnownStatus = info.status as EgressStatus;
            console.log(`Egress status for participant ${this.participantIdentity} in room ${this.roomName}: ${info.status}`);

            this.logResourceUsage();

            await this.recorder.updateRecordingStatus(this.roomName, lastKnownStatus);

            if (lastKnownStatus === EgressStatus.EGRESS_COMPLETE) {
              console.log(`Egress completed successfully for participant ${this.participantIdentity} in room ${this.roomName}`);
              clearInterval(ticker);
            } else if (lastKnownStatus === EgressStatus.EGRESS_FAILED) {
              console.error(`Egress failed for participant ${this.participantIdentity} in room ${this.roomName}. Error: ${info.error}`);
              if (info.error?.includes('AccessDenied')) {
                console.log('S3 access denied. Please check your credentials and bucket permissions.');
              } else if (info.error?.includes('NoSuchBucket')) {
                console.log(`S3 bucket not found. Please check if the bucket '${this.config.s3BucketName}' exists.`);
              }
              clearInterval(ticker);
            } else if (lastKnownStatus === EgressStatus.EGRESS_ABORTED) {
              console.log(`Egress aborted for participant ${this.participantIdentity} in room ${this.roomName}`);
              clearInterval(ticker);
            } else if (lastKnownStatus === EgressStatus.EGRESS_LIMIT_REACHED) {
              console.log(`Egress limit reached for participant ${this.participantIdentity} in room ${this.roomName}`);
              clearInterval(ticker);
            }
            break;
          }
        }

        // Check if we need to stop the egress based on lastKnownStatus
        if (
          lastKnownStatus === EgressStatus.EGRESS_COMPLETE ||
          lastKnownStatus === EgressStatus.EGRESS_FAILED ||
          lastKnownStatus === EgressStatus.EGRESS_ABORTED ||
          lastKnownStatus === EgressStatus.EGRESS_LIMIT_REACHED
        ) {
          console.log(`Stopping egress monitoring for participant ${this.participantIdentity} in room ${this.roomName} due to terminal state: ${lastKnownStatus}`);
          clearInterval(ticker);
        }
      } catch (error) {
        console.error(`Error listing egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      }
    }, 5000);

    this.stopChan.signal.addEventListener('abort', async () => {
      clearInterval(ticker);
      console.log(`Stop signal received for egress status monitoring of participant ${this.participantIdentity} in room ${this.roomName}`);
      if (this.egressId) {
        try {
          await this.egressClient.stopEgress(this.egressId);
          console.log(`Successfully stopped egress for participant ${this.participantIdentity} in room ${this.roomName}`);
        } catch (error) {
          console.error(`Failed to stop egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
        }
      }
    });
  }

  private logResourceUsage() {
    const memoryUsage = process.memoryUsage();
    console.log(`Resource usage for participant ${this.participantIdentity} in room ${this.roomName}:`,
      `RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)} MB,`,
      `Heap Total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB,`,
      `Heap Used: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
    );
  }

  stop() {
    console.log(`Stopping recording for participant ${this.participantIdentity} in room ${this.roomName}`);
    this.stopChan.abort();
    this.recorder.updateRecordingStatus(this.roomName, EgressStatus.EGRESS_ENDING).catch((error: any) => {
      console.error(`Failed to update recording status for room ${this.roomName}:`, error);
    });
  }
}