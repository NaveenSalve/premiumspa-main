// Import the bundled JavaScript, never TypeScript source files at runtime.
import { createApp } from '../dist-server/vercel.mjs';

let appPromise;

export default async function handler(req, res) {
  appPromise ||= createApp().catch((error) => {
    appPromise = undefined;
    throw error;
  });
  const app = await appPromise;
  return app(req, res);
}
