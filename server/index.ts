import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  // Import after environment loading; stores and discovery use the resolved configuration.
  const [{ default: next }, { createApi }, { initPairing }] = await Promise.all([
    import('next'),
    import('./api'),
    import('./security'),
  ]);
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const frontend = next({ dev: process.env.NODE_ENV !== 'production', port, hostname: '0.0.0.0' });
  await frontend.prepare();
  const { app, sonos, networkStream } = createApi();
  const code = await initPairing();
  const handler = frontend.getRequestHandler();
  app.use((req, res) => {
    void handler(req, res);
  });
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(
      `\nCurrent · Sonos S1 controller\nPort: ${port}\nMode: ${sonos.mock ? 'MOCK — no real audio' : 'Local network'}\nPairing code: ${code}\nKeep this code private. Use your Mac’s LAN address on iPhone.\n`,
    );
    void sonos
      .discover()
      .catch(() => console.error('Discovery failed. Check network access and use Discover again.'));
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await networkStream.dispose();
    server.closeAllConnections();
    server.close();
    await frontend.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
