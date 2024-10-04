import dotenv from 'dotenv';
import { getLivekitConfig } from './utils/config';
// import { getToken } from './services/livekitService';
import { Recorder } from './services/recorder.service';

dotenv.config();

async function main() {
  try {
    const config = getLivekitConfig();
    console.log('Connecting to room:', config.room);
    const recorder = new Recorder(config);
    await recorder.start();

  } catch (error) {
    console.error('Error:', error);
  }
}

main();