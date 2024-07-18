// import { app } from 'electron';
// import path from 'node:path';
import { type Command } from './npx';
import { getAvailablePort } from './port';

export const inspectorServer: Command | null = null;
export async function start() {
  // if (inspectorServer) {
  //   await inspectorServer.kill();
  // }

  // const inspectorPath = path.join(app.getAppPath(), './node_modules/@dcl/inspector/public');

  const port = await getAvailablePort();
  // inspectorServer = npx('http-server', ['--port', port.toString()], inspectorPath);
  // await inspectorServer.waitFor(/available/i, /error/i);

  return port;
}
