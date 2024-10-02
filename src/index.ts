import dotenv from 'dotenv';
import { getLivekitConfig } from './utils/config';
import { getToken, connectToRoom, disconnectFromRoom } from './services/livekitService';

dotenv.config();

async function main() {
  try {
    const config = getLivekitConfig();
    console.log('Connecting to room:', config.room);
    const token = await getToken(config);
    console.log('token: ', token)
    await connectToRoom(config.room);

    // Keep the process running
    process.on('SIGINT', async () => {
      console.log('Disconnecting from room...');
      await disconnectFromRoom();
      process.exit(0);
    });

  } catch (error) {
    console.error('Error:', error);
  }
}

main();