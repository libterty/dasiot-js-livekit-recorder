import * as liveKitSdk from 'livekit-server-sdk';
import { RemoteTrackPublication, Track, Room, RoomEvent, RemoteParticipant, TrackKind } from '@livekit/rtc-node';
import { RecorderConfig } from '../utils/config';
import { TrackRecorder } from './trackRecorder.service';

export class Recorder {
    private room: Room | null = null;
    private tracks: Map<string, TrackRecorder> = new Map();
    private egressClient: liveKitSdk.EgressClient;
  
    constructor(private config: RecorderConfig) {
      this.egressClient = new liveKitSdk.EgressClient(config.host, config.apiKey, config.apiSecret);
    }
  
    async start() {
      console.log('Starting the recorder...');
  
      const room = new Room();
  
      room
        .on(RoomEvent.ParticipantConnected, (p) => this.handleParticipantConnected(p))
        .on(RoomEvent.ParticipantDisconnected, (p) => this.handleParticipantDisconnected(p))
        .on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.handleTrackSubscribed(track, publication, participant))
        .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => this.handleTrackUnsubscribed(track, publication, participant));
  
      try {
        await room.connect(this.config.host, await this.getToken(), {
          autoSubscribe: true,
          dynacast: true,
        });
        console.log('Connected to room:', this.config.room);
        this.room = room;
      } catch (error) {
        console.error('Failed to connect to room:', error);
        throw error;
      }
  
      process.on('SIGINT', () => this.handleShutdown());
      process.on('SIGTERM', () => this.handleShutdown());
    }
  
    private async getToken(): Promise<string> {
      const at = new liveKitSdk.AccessToken(this.config.apiKey, this.config.apiSecret, {
        identity: 'recorder',
        name: 'Recorder Bot',
      });
      at.addGrant({ roomJoin: true, room: this.config.room, canPublish: false, canSubscribe: true });
      return at.toJwt();
    }
  
    private handleParticipantConnected(participant: RemoteParticipant) {
        console.log('Participant connected:', participant.info.identity);
    }
  
    private handleParticipantDisconnected(participant: RemoteParticipant) {
      console.log('Participant disconnected:', participant.identity);
      const recorder = this.tracks.get(participant.identity);
      if (recorder) {
        recorder.stop();
        this.tracks.delete(participant.identity);
      }
    }
  
    private handleTrackSubscribed(track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) {
        console.log('Track subscribed:', track.info.kind, 'from', participant.info.identity);
  
      let recorder = this.tracks.get(participant.identity);
      if (!recorder) {
        recorder = new TrackRecorder(participant.identity, this.config, this.egressClient);
        this.tracks.set(participant.identity, recorder);
      }
      Track
      if (track.kind === TrackKind.KIND_AUDIO) {
        recorder.setAudioTrack(track, publication);
      } else if (track.kind === TrackKind.KIND_VIDEO) {
        recorder.setVideoTrack(track, publication);
      }
    }
  
    private handleTrackUnsubscribed(track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) {
        console.log('Track unsubscribed from', participant.info.identity);
    }
  
    private async handleShutdown() {
      console.log('Shutting down recorder...');
      for (const recorder of this.tracks.values()) {
        recorder.stop();
      }
      if (this.room) {
        this.room.disconnect();
      }
      process.exit(0);
    }
  }