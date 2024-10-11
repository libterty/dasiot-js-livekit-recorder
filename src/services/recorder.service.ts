import * as liveKitSdk from 'livekit-server-sdk';
import { RemoteTrackPublication, Track, Room, RoomEvent, RemoteParticipant, TrackKind } from '@livekit/rtc-node';
import { RecorderConfig } from '../utils/config';
import { TrackRecorder } from './trackRecorder.service';
import { EgressStatus } from 'livekit-server-sdk/dist/proto/livekit_egress';

export class Recorder {
  private rooms: Map<string, Room> = new Map();
  private tracks: Map<string, TrackRecorder> = new Map();
  private participants: Map<string, string> = new Map(); // participantIdentity -> roomName
  private egressClient: liveKitSdk.EgressClient;
  private roomService: liveKitSdk.RoomServiceClient;

  constructor(private config: RecorderConfig) {
    this.egressClient = new liveKitSdk.EgressClient(config.host, config.apiKey, config.apiSecret);
    this.roomService = new liveKitSdk.RoomServiceClient(config.host, config.apiKey, config.apiSecret);
  }

  async start() {
    console.log('Starting the recorder...');

    try {
      const rooms = await this.roomService.listRooms();
      console.log(`Found ${rooms.length} existing rooms`);

      for (const room of rooms) {
        await this.connectToRoomIfNotConnected(room.name);
      }

      this.monitorNewRooms();

      process.on('SIGINT', () => this.handleShutdown());
      process.on('SIGTERM', () => this.handleShutdown());
    } catch (error) {
      console.error('Failed to start recorder:', error);
      throw error;
    }
  }

  private async connectToRoomIfNotConnected(roomName: string) {
    if (this.rooms.has(roomName)) {
      console.log(`Already connected to room: ${roomName}, skipping`);
      return;
    }

    console.log(`Connecting to room: ${roomName}`);

    const recorderIdentity = `recorder-${roomName}`;
    this.participants.set(recorderIdentity, roomName);

    const room = new Room();

    room
      .on(RoomEvent.ParticipantConnected, (p) => this.handleParticipantConnected(p, roomName))
      .on(RoomEvent.ParticipantDisconnected, (p) => this.handleParticipantDisconnected(p, roomName))
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.handleTrackSubscribed(track, publication, participant, roomName))
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => this.handleTrackUnsubscribed(track, publication, participant, roomName));

    try {
      await room.connect(this.config.host, await this.getToken(roomName, recorderIdentity), {
        autoSubscribe: true,
        dynacast: true,
      });
      console.log(`Connected to room: ${roomName}`);
      this.rooms.set(roomName, room);

      // Store information about all participants currently in the room
      room.remoteParticipants.forEach((participant) => {
        this.participants.set(participant.identity, roomName);
        console.log(`Stored existing participant ${participant.identity} for room ${roomName}`);
      });

      // Update room metadata to indicate recorder is connected
      await this.updateRoomMetadata(room, true, EgressStatus.EGRESS_ACTIVE);
    } catch (error) {
      console.error(`Failed to connect to room ${roomName}:`, error);
      this.participants.delete(recorderIdentity);
    }
  }

  private async getToken(roomName: string, identity: string): Promise<string> {
    const at = new liveKitSdk.AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: identity,
      name: `Recorder Bot - ${roomName}`,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true });
    return at.toJwt();
  }

  private async monitorNewRooms() {
    setInterval(async () => {
      try {
        const rooms = await this.roomService.listRooms();
        console.log(`Found ${rooms.length} existing rooms`);

        for (const room of rooms) {
          await this.connectToRoomIfNotConnected(room.name);
        }
      } catch (error) {
        console.error('Failed to list rooms:', error);
      }
    }, 5000);
  }

  private handleParticipantConnected(participant: RemoteParticipant, roomName: string) {
    console.log(`Participant ${participant.identity} connected to room ${roomName}`);
    this.participants.set(participant.identity, roomName);
  }

  private handleParticipantDisconnected(participant: RemoteParticipant, roomName: string) {
    console.log(`Participant ${participant.identity} disconnected from room ${roomName}`);
    this.participants.delete(participant.identity);
    const recorder = this.tracks.get(`${roomName}-${participant.identity}`);
    if (recorder) {
      recorder.stop();
      this.tracks.delete(`${roomName}-${participant.identity}`);
    }
  }

  private handleTrackSubscribed(track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant, roomName: string) {
    console.log(`Track subscribed in room ${roomName}: ${publication.sid} (${track.kind}) from participant ${participant.identity}`);

    if (participant.identity.startsWith('recorder-')) {
      console.log("Skipping subscription for recorder's own track");
      return;
    }

    const key = `${roomName}-${participant.identity}`;
    let recorder = this.tracks.get(key);
    if (!recorder) {
      recorder = new TrackRecorder(roomName, participant.identity, this.config, this.egressClient, this);
      this.tracks.set(key, recorder);
    }

    if (track.kind === TrackKind.KIND_AUDIO) {
      recorder.setAudioTrack(track, publication);
    } else if (track.kind === TrackKind.KIND_VIDEO) {
      recorder.setVideoTrack(track, publication);
    }

    // Start recording if we have at least a video track
    if (recorder.hasVideoTrack()) {
      recorder.start();
    }
  }

  private handleTrackUnsubscribed(track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant, roomName: string) {
    const key = `${roomName}-${participant.identity}`;
    const recorder = this.tracks.get(key);
    if (recorder) {
      console.log(`Track unsubscribed in room ${roomName}: ${publication.sid} ${recorder.hasVideoTrack() ? `(${recorder.videoTrack?.kind})` : ''} from participant ${participant.identity}`);
      recorder.stop();
      this.tracks.delete(key);
    }
  }

  private async updateRoomMetadata(room: Room, isConnected: boolean, isRecording: EgressStatus) {
    try {
      let metadata = room.metadata ? JSON.parse(room.metadata) : {};
      metadata.recorderConnected = isConnected;
      metadata.recorderStatus = this.getEgressStatusKey(isRecording);

      await this.roomService.updateRoomMetadata(room.name, JSON.stringify(metadata));
      console.log(`Updated metadata for room ${room.name}: recorderConnected = ${isConnected}, isRecording = ${isRecording}`);
    } catch (error) {
      console.error(`Failed to update room metadata for ${room.name}:`, error);
    }
  }

  private getEgressStatusKey(status: EgressStatus): string {
    switch (status) {
      case EgressStatus.EGRESS_STARTING: return "STARTING";
      case EgressStatus.EGRESS_ACTIVE: return "ACTIVE";
      case EgressStatus.EGRESS_ENDING: return "ENDING";
      case EgressStatus.EGRESS_COMPLETE: return "COMPLETE";
      case EgressStatus.EGRESS_FAILED: return "FAILED";
      case EgressStatus.EGRESS_ABORTED: return "ABORTED";
      case EgressStatus.EGRESS_LIMIT_REACHED: return "LIMIT_REACHED";
      default: return "UNKNOWN";
    }
  }

  async updateRecordingStatus(roomName: string, recordingStatus: EgressStatus) {
    const room = this.rooms.get(roomName);
    if (!room) {
      console.error(`Room ${roomName} not found`);
      return;
    }
    await this.updateRoomMetadata(room, true, recordingStatus);
  }

  private async handleShutdown() {
    console.log('Shutting down recorder...');
    for (const [roomName, room] of this.rooms) {
      await this.updateRoomMetadata(room, false, EgressStatus.EGRESS_ENDING);
      room.disconnect();
    }
    process.exit(0);
  }
}