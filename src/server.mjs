import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPengManagerApplication } from "./application.mjs";

export { createPengManagerApplication };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let application;
  try {
    application = await createPengManagerApplication();
    await application.listen();
  } catch {
    console.error("鹏经理系统启动失败；请检查本地配置与受保护的运行数据。");
    if (application) await application.stop().catch(() => { process.exitCode = 1; });
    process.exitCode = 1;
  }
  if (application?.server.listening) {
    const shutdown = () => { void application.stop().catch(() => {
      console.error("鹏经理系统未能完整停止；请运行本地诊断检查受管服务。"); process.exitCode = 1;
    }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
