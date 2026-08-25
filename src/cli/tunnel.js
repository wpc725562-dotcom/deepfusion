// cli/tunnel.js — deepfusion tunnel 子命令
import os from 'node:os';
import path from 'node:path';
import { createTunnelService } from '../dshtunnel/index.js';
import { qrTerminal } from '../dshtunnel/index.js';
import * as settings from '../dshtunnel/index.js';

const home = process.env.DEEPFUSION_HOME ? path.join(process.env.DEEPFUSION_HOME) : path.join(os.homedir(), '.deepfusion');

export async function tunnelCmd(args) {
  const sub = args[0];
  if (sub === 'start') {
    const service = createTunnelService({ dshPort: 43210, port: 3082, home });
    await service.startProxy();
    console.log('📶 局域网代理已启动（端口 ' + 3082 + '）');
    const st = await service.status();
    console.log('  局域网: ' + (st.lanUrl || '(未检测到)'));
    if (st.lanUrl) console.log(await qrTerminal(st.lanUrl));
    if (args.includes('--public') || args.includes('-p')) {
      const tunnel = await service.startTunnel();
      console.log('🌐 公网: ' + tunnel);
      console.log(await qrTerminal(tunnel));
    }
    await new Promise(() => {});
  } else if (sub === 'stop') {
    const service = createTunnelService({ dshPort: 43210, port: 3082, home });
    service.stopTunnel();
    await service.dispose();
    console.log('已停止');
  } else if (sub === 'status') {
    const service = createTunnelService({ dshPort: 43210, port: 3082, home });
    await service.startProxy();
    const st = await service.status();
    const s = settings.settings;
    console.log(JSON.stringify({
      ...st,
      publicPin: s.getPublicPin(home),
      lanPin: s.getLanPin(home),
      lanAuthEnabled: s.lanAuthEnabled(home),
    }, null, 2));
    await service.dispose();
  } else {
    console.log('用法: deepfusion tunnel start|stop|status [--public]');
  }
}