import * as liveKitSdk from 'livekit-server-sdk';
import { Room, RoomEvent, RemoteParticipant, RemoteTrackPublication, Track } from '@livekit/rtc-node';
import { getLivekitConfig } from '../utils/config.js';

let activeRoom: Room | null = null;
let activeEgressClient: liveKitSdk.EgressClient | null = null;
let activeEgressId: string | null = null;

export async function getToken(config: any) {
  const at = new liveKitSdk.AccessToken(
    config.apiKey, 
    config.apiSecret, {
    identity: 'recording-bot-2',
    ttl: '10m',
  });
  at.addGrant({ roomJoin: true, room: config.room, canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

export async function connectToRoom(roomName: string): Promise<Room> {
  const config = getLivekitConfig();
  const room = new Room();

  room
    .on(RoomEvent.ParticipantConnected, handleParticipantConnected)
    .on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected)
    .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    .on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
  const token = await getToken(config)
  await room.connect(config.host, token, { autoSubscribe: true, dynacast: true });
  console.log('Connected to', roomName);
  activeRoom = room;

  // Initialize TrackEgressClient
  const egressClient = new liveKitSdk.EgressClient(config.host, config.apiKey, config.apiSecret);
  activeEgressClient = egressClient;

  return room;
}

function handleParticipantConnected(participant: RemoteParticipant) {
  console.log('Participant connected:', participant.info.identity);
}

function handleParticipantDisconnected(participant: RemoteParticipant) {
  console.log('Participant disconnected:', participant.info.identity);
}

function handleTrackSubscribed(track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  console.log('Track subscribed:', track.info.kind, 'from', participant.info.identity);
  startRecording(track, participant);
}

function handleTrackUnsubscribed(track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) {
  console.log('Track unsubscribed from', participant.info.identity);
  stopRecording();
}

export async function disconnectFromRoom() {
  if (activeRoom) {
    await activeRoom.disconnect();
    activeRoom = null;
    console.log('Disconnected from room');
  }
}

async function startRecording(track: Track, participant: RemoteParticipant) {
  if (!activeRoom || !activeEgressClient) {
    console.error('Room or EgressClient not initialized');
    return;
  }
  

  const config = getLivekitConfig();

  const filepath = `livecall/test`
  try {
    const egressInfo = await activeEgressClient.startTrackEgress(
      activeRoom.name,
      {
        filepath,
        s3: {
          accessKey: config.s3AccessKey,
          secret: config.s3AccessSecret,
          region: config.s3Region,
          bucket: config.s3BucketName,
          endpoint: config.s3Endpoint,
          forcePathStyle: true,
        }
      },
      track.info.sid
    );

    if (egressInfo.egressId) {
      activeEgressId = egressInfo.egressId;
    }
    console.log('Started recording for track:', track.sid, 'Egress ID:', egressInfo.egressId);
  } catch (error) {
    console.error('Failed to start egress:', error);
  }
}

async function stopRecording() {
  if (!activeEgressClient || !activeEgressId) {
    console.error('EgressClient not initialized or no active egress');
    return;
  }

  try {
    await activeEgressClient.stopEgress(activeEgressId);
    console.log('Stopped recording for Egress ID:', activeEgressId);
    activeEgressId = null;
  } catch (error) {
    console.error('Failed to stop egress:', error);
  }
}