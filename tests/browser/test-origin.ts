// Browser tests default to port 4322. Set GV_TEST_PORT to run a second
// checkout's suite at the same time without the two colliding.
export const testPort = Number(process.env.GV_TEST_PORT || 4322);
export const testOrigin = `http://127.0.0.1:${testPort}`;
