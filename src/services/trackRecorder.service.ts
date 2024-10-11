import * as liveKitSdk from 'livekit-server-sdk';
import { RemoteTrackPublication, Track } from '@livekit/rtc-node';
import { RecorderConfig } from '../utils/config';
import { EgressStatus } from 'livekit-server-sdk/dist/proto/livekit_egress';

const MAX_RECORDING_DURATION = 1 * 60 * 1000; // 10 minutes in milliseconds
const OVERLAP_DURATION = 10 * 1000; // 10 seconds overlap in milliseconds

export class TrackRecorder {
  public audioTrack: Track | null = null;
  public videoTrack: Track | null = null;
  public audioPublication: RemoteTrackPublication | null = null;
  public videoPublication: RemoteTrackPublication | null = null;
  public stopChan: AbortController;
  public currentEgressId: string | null = null;
  public nextEgressId: string | null = null;
  public recordingStartTime: number | null = null;
  public recordingTimer: NodeJS.Timeout | null = null;
  public overlapTimer: NodeJS.Timeout | null = null;

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

    await this.startRecording();
  }

  private async startRecording(isOverlapping: boolean = false) {
    console.log(`Starting ${isOverlapping ? 'overlapping' : 'new'} recording for participant ${this.participantIdentity} in room ${this.roomName}`);

    // Update room metadata to indicate recording has started
    await this.recorder.updateRecordingStatus(this.roomName, EgressStatus.EGRESS_STARTING);

    const fileName = `${this.roomName}/${this.participantIdentity}/ingress_${new Date().toISOString().replace(/:/g, '-')}.mp4`;
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
      
      const egressId = res.egressId!;
      console.log(`Egress started successfully for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${egressId}`);
      
      if (isOverlapping) {
        this.nextEgressId = egressId;
        this.overlapTimer = setTimeout(() => this.switchToNextEgress(), OVERLAP_DURATION);
      } else {
        this.currentEgressId = egressId;
        this.recordingStartTime = Date.now();
        this.startRecordingTimer();
      }

      this.monitorEgressStatus(egressId);
    } catch (error) {
      console.error(`Failed to start egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      await this.recorder.updateRecordingStatus(this.roomName, EgressStatus.EGRESS_FAILED);
      
      // If this was an attempt to start an overlapping recording, we should try again
      if (isOverlapping) {
        console.log('Retrying to start overlapping recording...');
        setTimeout(() => this.startRecording(true), 5000); // Retry after 5 seconds
      }
    }
  }

  private startRecordingTimer() {
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer);
    }
    this.recordingTimer = setTimeout(() => {
      console.log(`Preparing to start new egress for participant ${this.participantIdentity} in room ${this.roomName}`);
      this.startRecording(true); // Start overlapping recording
    }, MAX_RECORDING_DURATION - OVERLAP_DURATION);
  }

  private async switchToNextEgress() {
    if (this.currentEgressId) {
      try {
        await this.egressClient.stopEgress(this.currentEgressId);
        console.log(`Stopped current egress for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${this.currentEgressId}`);
      } catch (error) {
        console.error(`Failed to stop current egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      }
    }

    // Switch to the next egress
    this.currentEgressId = this.nextEgressId;
    this.nextEgressId = null;
    this.recordingStartTime = Date.now();
    
    // Start the timer for the next overlap
    this.startRecordingTimer();
  }

  private async monitorEgressStatus(egressId: string) {
    const ticker = setInterval(async () => {
      if (!egressId) {
        clearInterval(ticker);
        return;
      }

      try {
        const listRes = await this.egressClient.listEgress({
          roomName: this.roomName,
        });

        for (const info of listRes) {
          if (info.egressId === egressId) {
            const status = info.status as EgressStatus;
            console.log(`Egress status for participant ${this.participantIdentity} in room ${this.roomName} (EgressID: ${egressId}): ${status}`);

            this.logResourceUsage();

            await this.recorder.updateRecordingStatus(this.roomName, status);

            if (status === EgressStatus.EGRESS_COMPLETE) {
              console.log(`Egress completed successfully for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${egressId}`);
              clearInterval(ticker);
              this.handleEgressCompletion(egressId);
            } else if (status === EgressStatus.EGRESS_FAILED || status === EgressStatus.EGRESS_ABORTED) {
              console.error(`Egress ${status === EgressStatus.EGRESS_FAILED ? 'failed' : 'aborted'} for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${egressId}. Error: ${info.error}`);
              clearInterval(ticker);
              this.handleEgressFailure(egressId);
            }
            break;
          }
        }
      } catch (error) {
        console.error(`Error listing egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      }
    }, 5000);

    this.stopChan.signal.addEventListener('abort', () => {
      clearInterval(ticker);
    });
  }

  private handleEgressCompletion(completedEgressId: string) {
    if (completedEgressId === this.currentEgressId && !this.nextEgressId) {
      // If the current egress completed and there's no next egress, start a new recording
      this.currentEgressId = null;
      this.startRecording();
    }
  }

  private handleEgressFailure(failedEgressId: string) {
    if (failedEgressId === this.currentEgressId) {
      // If the current egress failed, start a new one immediately
      this.currentEgressId = null;
      this.startRecording();
    } else if (failedEgressId === this.nextEgressId) {
      // If the next (overlapping) egress failed, clear the timer and try again
      this.nextEgressId = null;
      if (this.overlapTimer) {
        clearTimeout(this.overlapTimer);
        this.overlapTimer = null;
      }
      this.startRecording(true);
    }
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
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer);
      this.recordingTimer = null;
    }
    if (this.overlapTimer) {
      clearTimeout(this.overlapTimer);
      this.overlapTimer = null;
    }
    this.stopAllEgress();
    this.recorder.updateRecordingStatus(this.roomName, EgressStatus.EGRESS_ENDING).catch((error: any) => {
      console.error(`Failed to update recording status for room ${this.roomName}:`, error);
    });
  }

  private async stopAllEgress() {
    if (this.currentEgressId) {
      try {
        await this.egressClient.stopEgress(this.currentEgressId);
        console.log(`Stopped current egress for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${this.currentEgressId}`);
      } catch (error) {
        console.error(`Failed to stop current egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      }
    }
    if (this.nextEgressId) {
      try {
        await this.egressClient.stopEgress(this.nextEgressId);
        console.log(`Stopped next egress for participant ${this.participantIdentity} in room ${this.roomName}. EgressID: ${this.nextEgressId}`);
      } catch (error) {
        console.error(`Failed to stop next egress for participant ${this.participantIdentity} in room ${this.roomName}:`, error);
      }
    }
  }
}