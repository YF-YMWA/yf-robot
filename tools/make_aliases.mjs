/** 给中文名的 bat 创建英文别名，避免某些环境下的编码问题。 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const MAP = {
  '启动.bat': 'start.bat',
  '停止.bat': 'stop.bat',
  '安装自启.bat': 'install_autostart.bat',
  '取消自启.bat': 'uninstall_autostart.bat',
  '设置.bat': 'setup.bat',
  '切换角色.bat': 'switch_card.bat',
  '配置扩展功能.bat': 'setup_features.bat',
  '启动桥接适配.bat': 'start_bridge.bat',
};

let count = 0;
for (const [cn, en] of Object.entries(MAP)) {
  const src = path.join(ROOT, cn);
  const dst = path.join(ROOT, en);
  if (!fs.existsSync(src)) {
    console.log(`跳过（不存在）: ${cn}`);
    continue;
  }
  fs.copyFileSync(src, dst);
  count++;
}
console.log(`已创建 ${count} 个英文别名`);
